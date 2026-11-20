import OpenAI from "openai";
import { getRuntimeConfig } from "./config";
import { extractJson } from "./model-json";
import {
  applyPromptOverrides,
  hashPromptMessages,
  recordPromptUsage,
} from "./prompt-store";
import type { PromptAgent } from "./prompt-registry";
import { errorMessage } from "./utils";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMCallOptions {
  json?: boolean;
  temperature?: number;
  agent?: PromptAgent;
  chapter?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestTimeoutMs(): number {
  const raw = Number(process.env.LLM_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw > 0) return Math.round(raw);
  return 180000;
}

// 单次模型请求的上限：避免网络挂起时后台任务一直停在 running。
// 连接类错误仍会按 complete() 的退避策略重试。
const REQUEST_TIMEOUT_MS = requestTimeoutMs();

// 连接中断、限流和服务端 5xx 都属于可重试错误；鉴权、参数错误重试没有意义。
function isRetryableError(error: unknown): boolean {
  if (error instanceof OpenAI.APIConnectionError) return true;
  if (error instanceof OpenAI.APIError) {
    const status = error.status ?? 0;
    return status === 429 || status >= 500;
  }
  return false;
}

export class LLMClient {
  // 每次创建实例时读取运行时配置，所以设置页保存后，新任务会立即使用新模型；
  // 同一个实例内复用 client，避免一章生成过程中反复建立连接。
  private readonly config = getRuntimeConfig();
  private client: OpenAI | null = null;

  get isMock(): boolean {
    return this.config.provider === "mock";
  }

  private getClient(): OpenAI {
    if (!this.client) {
      if (!this.config.apiKey) {
        throw new Error("还没有配置 API Key，请打开「模型设置」页填写，或在 .env.local 设置 LLM_API_KEY");
      }
      this.client = new OpenAI({
        apiKey: this.config.apiKey,
        baseURL: this.config.baseUrl,
      });
    }
    return this.client;
  }

  private prepare(messages: ChatMessage[], agent?: PromptAgent): ChatMessage[] {
    return agent ? applyPromptOverrides(agent, messages) : messages;
  }

  private async recordUsage(
    messages: ChatMessage[],
    options: LLMCallOptions,
  ): Promise<void> {
    if (!options.agent) return;
    await recordPromptUsage({
      agent: options.agent,
      promptHash: hashPromptMessages(messages),
      model: this.config.model,
      provider: this.config.provider,
      temperature: options.temperature ?? this.config.temperature,
      maxTokens: this.config.maxTokens,
      ...(options.chapter ? { chapter: options.chapter } : {}),
      messageChars: messages.reduce((sum, message) => sum + message.content.length, 0),
    });
  }

  async chat(
    messages: ChatMessage[],
    options: LLMCallOptions = {},
  ): Promise<string> {
    return this.complete(
      this.prepare(messages, options.agent),
      options,
      this.config.maxTokens,
      0,
    );
  }

  private async complete(
    messages: ChatMessage[],
    options: LLMCallOptions,
    maxTokens: number,
    attempt: number,
  ): Promise<string> {
    // 附加规则已经在 prepare 中合并；这里只记录本次实际发送的提示词指纹。
    await this.recordUsage(messages, options);
    // 长任务里一次瞬时断连就会毁掉整章；这里对连接错误做带退避的重试。
    const maxAttempts = 4;
    let response: OpenAI.Chat.Completions.ChatCompletion;
    for (let attemptNo = 1; ; attemptNo += 1) {
      try {
        response = await this.getClient().chat.completions.create(
          {
            model: this.config.model,
            messages,
            // 事实抽取/审校需要稳定复现，允许调用方覆盖默认的高温创作参数。
            temperature: options.temperature ?? this.config.temperature,
            max_tokens: maxTokens,
            ...(options.json ? { response_format: { type: "json_object" as const } } : {}),
          },
          { timeout: REQUEST_TIMEOUT_MS },
        );
        break;
      } catch (error) {
        if (attemptNo >= maxAttempts || !isRetryableError(error)) {
          if (error instanceof OpenAI.APIConnectionError) {
            throw new Error(
              `无法连接模型服务（${this.config.baseUrl}），已尝试 ${maxAttempts} 次：${error.message}`,
            );
          }
          throw error;
        }
        // 丢弃旧连接，下一次 getClient() 会重新建连。
        this.client = null;
        await sleep(800 * 2 ** (attemptNo - 1));
      }
    }

    const choice = response.choices[0];
    const content = choice?.message?.content?.trim();
    if (content) return content;

    const finishReason = choice?.finish_reason ?? "unknown";
    const usage = response.usage as
      | {
          completion_tokens?: number;
          completion_tokens_details?: { reasoning_tokens?: number };
        }
      | undefined;
    const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens ?? 0;

    // 推理型模型（如 deepseek-flash / reasoner）可能把输出额度全部耗在思考上，
    // 正文为空且 finish_reason=length。提高上限重试一次通常就能拿到结果。
    if (finishReason === "length" && attempt === 0) {
      const nextMax = Math.min(Math.max(maxTokens * 4, 16384), 32768);
      if (nextMax > maxTokens) {
        return this.complete(messages, options, nextMax, attempt + 1);
      }
    }

    if (finishReason === "length" && reasoningTokens > 0) {
      throw new Error(
        `模型返回了空内容：${maxTokens} tokens 的输出额度被推理过程耗尽（推理 ${reasoningTokens} tokens）。请改用非推理模型（如 deepseek-chat），或在「模型设置」把单次最大 tokens 调到 32768 后重试。`,
      );
    }

    throw new Error(
      `模型返回了空内容（finish_reason=${finishReason}）。请检查模型名称是否支持对话接口，或在「模型设置」换一个模型。`,
    );
  }

  async json<T>(messages: ChatMessage[], options: LLMCallOptions = {}): Promise<T> {
    // 附加规则只合并一次，JSON 修正请求沿用同一份已合并提示词。
    const prepared = this.prepare(messages, options.agent);
    const raw = await this.complete(
      prepared,
      { ...options, json: true },
      this.config.maxTokens,
      0,
    );
    let firstError: unknown = null;
    try {
      return extractJson<T>(raw);
    } catch (error) {
      firstError = error;
    }

    // 部分模型即使开启 json 模式也会夹带解释文字或漏逗号；本地修复失败后，
    // 用低温再请求一轮“只返回修正后的 JSON”，比让整个写作任务失败更稳。
    const repaired = await this.complete(
      [
        ...prepared,
        { role: "assistant", content: raw },
        {
          role: "user",
          content: `上面的输出不是合法 JSON：${errorMessage(firstError)}。请重点检查错误位置附近是否漏写英文逗号、是否出现尾随逗号、字符串引号是否闭合；只输出修正后的完整 JSON，不要省略内容，也不要附加解释或 Markdown 代码围栏。`,
        },
      ],
      { ...options, json: true, temperature: 0 },
      this.config.maxTokens,
      0,
    );

    try {
      return extractJson<T>(repaired);
    } catch (error) {
      throw new Error(
        `模型连续两次返回了不合法的 JSON。${errorMessage(error)} 已自动尝试修复；请重试本任务，或在「模型设置」中换用输出更稳定的模型。`,
      );
    }
  }
}
