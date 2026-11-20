import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "quillmate-settings-tiers-"));
  process.env.QUILLMATE_DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(async () => {
  vi.resetModules();
  delete process.env.QUILLMATE_DATA_DIR;
  await rm(dataDir, { recursive: true, force: true });
});

describe("设置页三档 Tokens 持久化", () => {
  it("读取旧配置时安全归一化到最近档位", async () => {
    await writeFile(
      path.join(dataDir, "settings.json"),
      JSON.stringify({
        provider: "openai-compatible",
        baseUrl: "https://example.com/v1",
        model: "test-model",
        apiKey: "sk-test",
        temperature: 0.5,
        maxTokens: 20000,
      }),
      "utf8",
    );
    const settings = await import("@/lib/settings");
    expect((await settings.readSettings())?.maxTokens).toBe(16384);
  });

  it("写入时只保存三档数值", async () => {
    const settings = await import("@/lib/settings");
    await settings.writeSettings({
      provider: "openai-compatible",
      baseUrl: "https://example.com/v1",
      model: "test-model",
      apiKey: "sk-test",
      temperature: 0.5,
      maxTokens: 4096,
    });
    const saved = JSON.parse(
      await readFile(path.join(dataDir, "settings.json"), "utf8"),
    ) as { maxTokens: number };
    expect(saved.maxTokens).toBe(8192);
  });

  it("设置接口把旧数值归一化后保存", async () => {
    const route = await import("@/app/api/settings/route");
    const response = await route.PUT(
      new Request("http://localhost/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "openai-compatible",
          baseUrl: "https://example.com/v1",
          model: "test-model",
          apiKey: "sk-test",
          temperature: 0.5,
          maxTokens: 20000,
        }),
      }),
    );
    expect(response.status).toBe(200);
    const data = (await response.json()) as {
      saved: { maxTokens: number };
      effective: { maxTokens: number };
    };
    expect(data.saved.maxTokens).toBe(16384);
    expect(data.effective.maxTokens).toBe(16384);
  });
});
