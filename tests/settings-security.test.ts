import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "quillmate-settings-"));
  process.env.QUILLMATE_DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(async () => {
  vi.resetModules();
  delete process.env.QUILLMATE_DATA_DIR;
  await rm(dataDir, { recursive: true, force: true });
});

describe("敏感设置存储", () => {
  it("原子写入设置文件，不残留临时文件", async () => {
    const settings = await import("@/lib/settings");
    await settings.writeSettings({
      provider: "openai-compatible",
      baseUrl: "https://example.com/v1",
      model: "test-model",
      apiKey: "sk-test-1234567890",
      temperature: 0.5,
      maxTokens: 4096,
      storyContextChars: 3200,
    });

    const file = path.join(dataDir, "settings.json");
    const saved = JSON.parse(await readFile(file, "utf8")) as { apiKey: string };
    expect(saved.apiKey).toBe("sk-test-1234567890");

    const entries = await readdir(dataDir);
    expect(entries).toEqual(["settings.json"]);
  });

  it("公开设置只包含掩码和是否已配置", async () => {
    const settings = await import("@/lib/settings");
    const raw = {
      provider: "openai-compatible" as const,
      baseUrl: "https://example.com/v1",
      model: "test-model",
      apiKey: "sk-test-1234567890",
      temperature: 0.5,
      maxTokens: 4096,
      storyContextChars: 3200,
    };
    const publicSettings = settings.toPublicSettings(raw);
    const serialized = JSON.stringify(publicSettings);
    expect(serialized).not.toContain(raw.apiKey);
    expect(publicSettings.apiKeySet).toBe(true);
    expect(publicSettings.apiKeyPreview).toBe("sk-…7890");
    expect(settings.previewKey("short")).toBe("••••");
  });
});
