import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type OpenAI from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "quillmate-llm-model-"));
  process.env.QUILLMATE_DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(async () => {
  vi.resetModules();
  delete process.env.QUILLMATE_DATA_DIR;
  await rm(dataDir, { recursive: true, force: true });
});

describe("单次调用模型覆盖", () => {
  it("传入 model 时只影响本次请求，未传入时沿用主模型", async () => {
    const { LLMClient } = await import("@/lib/llm");
    class FakeClient extends LLMClient {
      readonly seen: Array<string | undefined> = [];
      protected async requestCompletion(
        _messages: unknown,
        options: { model?: string },
      ): Promise<OpenAI.Chat.Completions.ChatCompletion> {
        this.seen.push(options.model);
        return {
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop",
            },
          ],
          usage: { completion_tokens: 0 },
        } as unknown as OpenAI.Chat.Completions.ChatCompletion;
      }
    }

    const client = new FakeClient();
    await client.chat([{ role: "user", content: "hi" }], {
      model: "deepseek-reasoner",
    });
    await client.chat([{ role: "user", content: "hi" }]);

    expect(client.seen[0]).toBe("deepseek-reasoner");
    // 没有覆盖时不下发 model，由 LLMClient 回落到主模型。
    expect(client.seen[1]).toBeUndefined();
  });
});
