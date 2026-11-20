import OpenAI from "openai";
import { getRuntimeConfig } from "./config";
import { extractJson } from "./model-json";
import {
  applyPromptOverrides,
  hashPromptMessages,
  recordPromptUsage,
} from "./prompt-store";
import type { PromptAgent } from "./prompt-registry";
import { nextOutputTokens, normalizeOutputTokens } from "./token-tiers";
import { errorMessage } from "./utils";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type LLMProgressEventType =
  | "connection-retry"
  | "truncated"
  | "retrying"
  | "invalid-json";

export interface LLMProgressEvent {
  type: LLMProgressEventType;
  model: string;
  maxTokens: number;
  attempt: number;
  message: string;
}

export interface LLMCallOptions {
  json?: boolean;
  temperature?: number;
  agent?: PromptAgent;
  chapter?: number;
  // 任务级输出预算；不能超过用户在设置中选择的档位。
  maxTokens?: number;
  onProgress?: (event: LLMProgressEvent) => void;
}

export interface CompletionResult {
  content: string;
  finishReason: string | null;
  maxTokens: number;
  reasoningTokens: number;
}

export class LLMOutputTruncatedError extends Error {
  readonly content: string;
  readonly finishReason: string;
  readonly maxTokens: number;
  readonly attempts: number;

  constructor(input: {
    content: string;
    finishReason: string;
    maxTokens: number;
    attempts: number;
  }) {
    const retry = input.attempts > 1 ? `，已自动尝试 ${input.attempts} 次` : "";
    super(
      `模型输出达到 Tokens 上限，内容被截断（当前预算 ${input.maxTokens} Tokens${retry}，finish_reason=${input.finishReason}）。请提高「单次最大 Tokens」档位，或减少每批生成的内容。`,
    );
    this.name = "LLMOutputTruncatedError";
    this.content = input.content;
    this.finishReason = input.finishReason;
    this.maxTokens = input.maxTokens;
    this.attempts = input.attempts;
  }
}

// 不同 OpenAI 兼容供应商对“达到输出上限”的命名不完全一致。
export function isTruncatedFinishReason(reason: unknown): boolean {
  if (typeof reason !== "string") return false;
  const key = reason.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return [
    "length",
    "max_tokens",
    "max_output_tokens",
    "token_limit",
    "output_limit",
    "truncated",
    "incomplete",
  ].includes(key);
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

function isTokenLimitRejection(error: unknown): boolean {
  if (!(error instanceof OpenAI.APIError)) return false;
  if (error.status !== 400 && error.status !== 422) return false;
  return /max[_ ]?tokens|max(?:imum)?[_ ]?output|output[_ ]?limit|token[_ ]?limit/i.test(
    error.message,
  );
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

  private budget(options: LLMCallOptions): number {
    const configured = normalizeOutputTokens(this.config.maxTokens);
    const requested = Number(options.maxTokens);
    if (!Number.isFinite(requested) || requested <= 0) return configured;
    return Math.min(configured, Math.max(1, Math.round(requested)));
  }

  private async recordUsage(
    messages: ChatMessage[],
    options: LLMCallOptions,
    maxTokens: number,
  ): Promise<void> {
    if (!options.agent) return;
    await recordPromptUsage({
      agent: options.agent,
      promptHash: hashPromptMessages(messages),
      model: this.config.model,
      provider: this.config.provider,
      temperature: options.temperature ?? this.config.temperature,
      maxTokens,
      ...(options.chapter ? { chapter: options.chapter } : {}),
      messageChars: messages.reduce((sum, message) => sum + message.content.length, 0),
    });
  }

  private report(
    options: LLMCallOptions,
    event: Omit<LLMProgressEvent, "model">,
  ): void {
    options.onProgress?.({ ...event, model: this.config.model });
  }

  async chat(
    messages: ChatMessage[],
    options: LLMCallOptions = {},
  ): Promise<string> {
    const prepared = this.prepare(messages, options.agent);
    const result = await this.complete(prepared, options, this.budget(options), 0);
    if (isTruncatedFinishReason(result.finishReason)) {
      throw new LLMOutputTruncatedError({
        content: result.content,
        finishReason: String(result.finishReason),
        maxTokens: result.maxTokens,
        attempts: 1,
      });
    }
    return result.content;
  }

  protected async complete(
    messages: ChatMessage[],
    options: LLMCallOptions,
    maxTokens: number,
    emptyRetry: number,
  ): Promise<CompletionResult> {
    // 附加规则已经在 prepare 中合并；这里只记录本次实际发送的提示词指纹。
    await this.recordUsage(messages, options, maxTokens);
    // 长任务里一次瞬时断连就会毁掉整章；这里对连接错误做带退避的重试。
    const maxAttempts = 4;
    let response: OpenAI.Chat.Completions.ChatCompletion;
    for (let attemptNo = 1; ; attemptNo += 1) {
      try {
        response = await this.requestCompletion(messages, options, maxTokens);
        break;
      } catch (error) {
        if (isTokenLimitRejection(error)) {
          throw new Error(
            `模型「${this.config.model}」不接受 ${maxTokens} Tokens 的输出额度，请降低「单次最大 Tokens」档位或更换模型。`,
          );
        }
        if (attemptNo >= maxAttempts || !isRetryableError(error)) {
          if (error instanceof OpenAI.APIConnectionError) {
            throw new Error(
              `无法连接模型服务（${this.config.baseUrl}），已尝试 ${maxAttempts} 次：${error.message}`,
            );
          }
          if (error instanceof OpenAI.APIError) {
            throw new Error(
              `模型接口请求失败（${error.status ? `HTTP ${error.status}` : "网络错误"}）：${error.message}`,
            );
          }
          throw error;
        }
        this.report(options, {
          type: "connection-retry",
          maxTokens,
          attempt: attemptNo,
          message: `模型接口请求失败，正在第 ${attemptNo} 次重试（预算 ${maxTokens} Tokens）…`,
        });
        // 丢弃旧连接，下一次 getClient() 会重新建连。
        this.client = null;
        await sleep(800 * 2 ** (attemptNo - 1));
      }
    }

    const choice = response.choices[0];
    const content = choice?.message?.content?.trim() ?? "";
    const finishReason = choice?.finish_reason ?? null;
    const usage = response.usage as
      | {
          completion_tokens?: number;
          completion_tokens_details?: { reasoning_tokens?: number };
        }
      | undefined;
    const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens ?? 0;

    if (content) {
      return { content, finishReason, maxTokens, reasoningTokens };
    }

    const truncated = isTruncatedFinishReason(finishReason);
    // 推理型模型（如 deepseek-flash / reasoner）可能把输出额度全部耗在思考上，
    // 正文为空且 finish_reason=length。提高上限重试一次通常就能拿到结果，
    // 但不能突破用户选择的档位。
    if (truncated && emptyRetry === 0) {
      const configured = normalizeOutputTokens(this.config.maxTokens);
      const nextMax = Math.min(Math.max(maxTokens * 4, 16384), configured);
      if (nextMax > maxTokens) {
        return this.complete(messages, options, nextMax, emptyRetry + 1);
      }
    }

    if (truncated && reasoningTokens > 0) {
      throw new Error(
        `模型返回了空内容：${maxTokens} Tokens 的输出额度被推理过程耗尽（推理 ${reasoningTokens} Tokens）。请改用非推理模型（如 deepseek-chat），或在「模型设置」提高输出档位后重试。`,
      );
    }

    if (truncated) {
      throw new Error(
        `模型返回了空内容，且 finish_reason=${finishReason}（输出达到 ${maxTokens} Tokens 上限）。请提高「单次最大 Tokens」档位或改用输出更稳定的模型。`,
      );
    }

    throw new Error(
      `模型返回了空内容（finish_reason=${finishReason ?? "unknown"}）。请检查模型名称是否支持对话接口，或在「模型设置」换一个模型。`,
    );
  }

  // 抽出网络请求，便于测试注入可控的模型响应。
  protected async requestCompletion(
    messages: ChatMessage[],
    options: LLMCallOptions,
    maxTokens: number,
  ): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    return this.getClient().chat.completions.create(
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
  }

  async json<T>(messages: ChatMessage[], options: LLMCallOptions = {}): Promise<T> {
    // 附加规则只合并一次，JSON 修正请求沿用同一份已合并提示词。
    const prepared = this.prepare(messages, options.agent);
    const configured = normalizeOutputTokens(this.config.maxTokens);
    let budget = this.budget(options);
    let truncationAttempts = 0;
    let raw = "";
    let lastInvalid: unknown = null;

    // 截断与非法 JSON 分开处理：截断只能提高额度重试，不能拿残缺内容去做普通修复。
    for (;;) {
      const result = await this.complete(prepared, { ...options, json: true }, budget, 0);
      raw = result.content;
      if (isTruncatedFinishReason(result.finishReason)) {
        truncationAttempts += 1;
        const next = nextOutputTokens(budget, configured);
        if (next && truncationAttempts <= 2) {
          this.report(options, {
            type: "truncated",
            maxTokens: budget,
            attempt: truncationAttempts,
            message: `模型输出被 ${budget} Tokens 上限截断，准备提高额度重试…`,
          });
          this.report(options, {
            type: "retrying",
            maxTokens: next,
            attempt: truncationAttempts,
            message: `第 ${truncationAttempts}/2 次截断重试，输出预算提高到 ${next} Tokens…`,
          });
          budget = next;
          continue;
        }
        throw new LLMOutputTruncatedError({
          content: result.content,
          finishReason: String(result.finishReason),
          maxTokens: result.maxTokens,
          attempts: truncationAttempts,
        });
      }
      try {
        return extractJson<T>(result.content);
      } catch (error) {
        lastInvalid = error;
        break;
      }
    }

    // 部分模型即使开启 json 模式也会夹带解释文字或漏逗号；本地修复失败后，
    // 用低温再请求一轮“只返回修正后的 JSON”。这里保持原额度，不因格式错误加预算。
    this.report(options, {
      type: "invalid-json",
      maxTokens: budget,
      attempt: 1,
      message: `模型返回的 JSON 不合法，正在请求模型修正（预算保持 ${budget} Tokens）…`,
    });
    const repaired = await this.complete(
      [
        ...prepared,
        { role: "assistant", content: raw },
        {
          role: "user",
          content: `上面的输出不是合法 JSON：${errorMessage(lastInvalid)}。请重点检查错误位置附近是否漏写英文逗号、是否出现尾随逗号、字符串引号是否闭合；只输出修正后的完整 JSON，不要省略内容，也不要附加解释或 Markdown 代码围栏。`,
        },
      ],
      { ...options, json: true, temperature: 0 },
      budget,
      0,
    );

    if (isTruncatedFinishReason(repaired.finishReason)) {
      throw new LLMOutputTruncatedError({
        content: repaired.content,
        finishReason: String(repaired.finishReason),
        maxTokens: repaired.maxTokens,
        attempts: truncationAttempts + 1,
      });
    }

    try {
      return extractJson<T>(repaired.content);
    } catch (error) {
      throw new Error(
        `模型连续两次返回了不合法的 JSON。${errorMessage(error)} 已自动尝试修复；请重试本任务，或在「模型设置」中换用输出更稳定的模型。`,
      );
    }
  }
}
