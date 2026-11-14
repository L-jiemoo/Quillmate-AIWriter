import OpenAI from "openai";
import { getRuntimeConfig } from "./config";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

function extractJson<T>(raw: string): T {
  // 兼容三类常见输出：纯 JSON、```json 围栏、正文前后夹带解释。
  // 先剥围栏，失败后再从第一个 { 截到最后一个 } 尝试解析。
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  try {
    return JSON.parse(text) as T;
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1)) as T;
    }
    throw new Error("模型返回的内容不是合法 JSON");
  }
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

  async chat(messages: ChatMessage[], options: { json?: boolean } = {}): Promise<string> {
    return this.complete(messages, options, this.config.maxTokens, 0);
  }

  private async complete(
    messages: ChatMessage[],
    options: { json?: boolean },
    maxTokens: number,
    attempt: number,
  ): Promise<string> {
    const client = this.getClient();
    const response = await client.chat.completions.create({
      model: this.config.model,
      messages,
      temperature: this.config.temperature,
      max_tokens: maxTokens,
      ...(options.json ? { response_format: { type: "json_object" as const } } : {}),
    });

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

  async json<T>(messages: ChatMessage[]): Promise<T> {
    const raw = await this.chat(messages, { json: true });
    try {
      return extractJson<T>(raw);
    } catch {
      // 部分模型即使开启 json 模式也会夹带解释文字；追加一轮“只返回修正后的 JSON”
      // 再解析一次，比直接让整个写作任务失败更稳。
      const repaired = await this.chat(
        [
          ...messages,
          { role: "assistant", content: raw },
          {
            role: "user",
            content: "上面的输出不是合法 JSON。请只输出修正后的合法 JSON，不要附加任何解释。",
          },
        ],
        { json: true },
      );
      return extractJson<T>(repaired);
    }
  }
}
