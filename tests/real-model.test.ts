import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// 真实模型测试必须显式开启，并使用临时数据目录，避免读取或写入真实设置。
const enabled =
  process.env.QUILLMATE_REAL_MODEL_TESTS === "1" &&
  Boolean(process.env.LLM_API_KEY?.trim()) &&
  process.env.LLM_PROVIDER?.trim() !== "mock";

describe.skipIf(!enabled)("真实模型调用（显式开启）", () => {
  let dataDir = "";
  let previousDataDir: string | undefined;

  beforeAll(async () => {
    previousDataDir = process.env.QUILLMATE_DATA_DIR;
    dataDir = await mkdtemp(path.join(tmpdir(), "quillmate-real-model-"));
    process.env.QUILLMATE_DATA_DIR = dataDir;
    vi.resetModules();
  });

  afterAll(async () => {
    if (previousDataDir === undefined) delete process.env.QUILLMATE_DATA_DIR;
    else process.env.QUILLMATE_DATA_DIR = previousDataDir;
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it("返回合法 JSON，并记录不泄漏密钥的调用元数据", async () => {
    const { LLMClient } = await import("@/lib/llm");
    const { readPromptUsage } = await import("@/lib/prompt-store");
    const client = new LLMClient();
    expect(client.isMock).toBe(false);

    const result = await client.json<{ ok: boolean }>(
      [
        {
          role: "user",
          content: '只返回 JSON：{"ok":true}。不要附加解释。',
        },
      ],
      { agent: "auditor", temperature: 0, chapter: 1 },
    );
    expect(result.ok).toBe(true);

    const usage = await readPromptUsage(5);
    expect(usage.length).toBeGreaterThan(0);
    expect(JSON.stringify(usage)).not.toContain(process.env.LLM_API_KEY ?? "");
  }, 60000);
});
