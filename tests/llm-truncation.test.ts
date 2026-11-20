import type OpenAI from "openai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeReply {
  content: string;
  finishReason?: string | null;
}

let dataDir: string;
let previousMaxTokens: string | undefined;
let previousProvider: string | undefined;
let previousApiKey: string | undefined;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "quillmate-llm-"));
  previousMaxTokens = process.env.LLM_MAX_TOKENS;
  previousProvider = process.env.LLM_PROVIDER;
  previousApiKey = process.env.LLM_API_KEY;
  process.env.QUILLMATE_DATA_DIR = dataDir;
  process.env.LLM_PROVIDER = "openai-compatible";
  process.env.LLM_API_KEY = "sk-test";
  vi.resetModules();
});

afterEach(async () => {
  vi.resetModules();
  delete process.env.QUILLMATE_DATA_DIR;
  if (previousMaxTokens === undefined) delete process.env.LLM_MAX_TOKENS;
  else process.env.LLM_MAX_TOKENS = previousMaxTokens;
  if (previousProvider === undefined) delete process.env.LLM_PROVIDER;
  else process.env.LLM_PROVIDER = previousProvider;
  if (previousApiKey === undefined) delete process.env.LLM_API_KEY;
  else process.env.LLM_API_KEY = previousApiKey;
  await rm(dataDir, { recursive: true, force: true });
});

async function makeClient(replies: FakeReply[]) {
  const { LLMClient } = await import("@/lib/llm");
  class FakeClient extends LLMClient {
    readonly calls: number[] = [];
    private readonly pending = [...replies];

    protected async requestCompletion(
      _messages: unknown,
      _options: unknown,
      maxTokens: number,
    ): Promise<OpenAI.Chat.Completions.ChatCompletion> {
      this.calls.push(maxTokens);
      const next = this.pending.shift();
      if (!next) throw new Error("测试没有准备更多模型响应");
      return {
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: next.content },
            finish_reason:
              next.finishReason === undefined ? "stop" : next.finishReason,
          },
        ],
        usage: { completion_tokens: 0 },
      } as unknown as OpenAI.Chat.Completions.ChatCompletion;
    }
  }
  return new FakeClient();
}

const MESSAGES = [{ role: "user" as const, content: "请只返回 JSON" }];

describe("LLM 输出截断处理", () => {
  it("非空内容 + finish_reason=length 不当作完整 JSON，提升额度后重试", async () => {
    process.env.LLM_MAX_TOKENS = "16384";
    const client = await makeClient([
      { content: '{"value":1', finishReason: "length" },
      { content: '{"value":2}', finishReason: "stop" },
    ]);
    const events: string[] = [];

    const result = await client.json<{ value: number }>(MESSAGES, {
      maxTokens: 8192,
      onProgress: (event) => events.push(event.type),
    });

    expect(result.value).toBe(2);
    expect(client.calls).toEqual([8192, 16384]);
    expect(events).toContain("truncated");
    expect(events).toContain("retrying");
  });

  it("已达到配置档位上限时停止重试，并报告输出被截断", async () => {
    process.env.LLM_MAX_TOKENS = "8192";
    const client = await makeClient([
      { content: '{"value":1', finishReason: "length" },
    ]);

    await expect(client.json(MESSAGES)).rejects.toThrow(/Tokens 上限.*截断/);
    expect(client.calls).toEqual([8192]);
  });

  it("截断后不会误进入普通 JSON 修复流程", async () => {
    process.env.LLM_MAX_TOKENS = "8192";
    const client = await makeClient([
      { content: '{"value":1', finishReason: "length" },
      { content: '{"value":2}', finishReason: "stop" },
    ]);

    await expect(client.json(MESSAGES)).rejects.toThrow(/截断/);
    expect(client.calls).toEqual([8192]);
  });

  it("普通非法 JSON 会修正，但不会增加 Tokens 预算", async () => {
    process.env.LLM_MAX_TOKENS = "16384";
    const client = await makeClient([
      { content: "not-json", finishReason: "stop" },
      { content: '{"ok":true}', finishReason: "stop" },
    ]);
    const events: string[] = [];

    const result = await client.json<{ ok: boolean }>(MESSAGES, {
      maxTokens: 8192,
      onProgress: (event) => events.push(event.type),
    });

    expect(result.ok).toBe(true);
    expect(client.calls).toEqual([8192, 8192]);
    expect(events).toContain("invalid-json");
  });

  it("完整 JSON 与正常结束原因、缺失 finish_reason 都正常返回", async () => {
    process.env.LLM_MAX_TOKENS = "8192";
    const normal = await makeClient([
      { content: '{"ok":1}', finishReason: "stop" },
    ]);
    await expect(normal.json<{ ok: number }>(MESSAGES)).resolves.toEqual({ ok: 1 });

    const missing = await makeClient([
      { content: '{"ok":2}', finishReason: null },
    ]);
    await expect(missing.json<{ ok: number }>(MESSAGES)).resolves.toEqual({ ok: 2 });
  });

  it("空内容 + 正常结束原因给出明确错误", async () => {
    process.env.LLM_MAX_TOKENS = "8192";
    const client = await makeClient([{ content: "", finishReason: "stop" }]);

    await expect(client.json(MESSAGES)).rejects.toThrow(/空内容/);
    expect(client.calls).toEqual([8192]);
  });

  it("兼容常见截断结束原因别名", async () => {
    const { isTruncatedFinishReason } = await import("@/lib/llm");
    expect(isTruncatedFinishReason("length")).toBe(true);
    expect(isTruncatedFinishReason("max_tokens")).toBe(true);
    expect(isTruncatedFinishReason("max-output-tokens")).toBe(true);
    expect(isTruncatedFinishReason("stop")).toBe(false);
    expect(isTruncatedFinishReason(null)).toBe(false);
  });
});
