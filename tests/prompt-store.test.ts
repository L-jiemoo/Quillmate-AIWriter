import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dataDir: string;
let store: typeof import("@/lib/prompt-store");

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "quillmate-prompts-"));
  process.env.QUILLMATE_DATA_DIR = dataDir;
  vi.resetModules();
  store = await import("@/lib/prompt-store");
});

afterEach(async () => {
  vi.resetModules();
  delete process.env.QUILLMATE_DATA_DIR;
  await rm(dataDir, { recursive: true, force: true });
});

describe("提示词版本与调用记录", () => {
  it("创建附加规则后追加到 system，并可回滚到旧版和恢复内置", async () => {
    const messages = [
      { role: "system" as const, content: "基础系统提示" },
      { role: "user" as const, content: "基础任务" },
    ];
    const first = await store.createPromptVersion({
      agent: "writer",
      mode: "system",
      instructions: "必须检查伏笔是否回收。",
      label: "加强伏笔",
    });
    expect(store.promptVersionInfo("writer").overrideId).toBe(first.id);

    const applied = store.applyPromptOverrides("writer", messages);
    expect(applied[0].content).toContain("必须检查伏笔是否回收");
    expect(applied[0].content).toContain("基础系统提示");
    expect(messages[0].content).toBe("基础系统提示");

    const second = await store.createPromptVersion({
      agent: "writer",
      mode: "user",
      instructions: "最后检查一次人物动机。",
      label: "人物动机",
    });
    const userApplied = store.applyPromptOverrides("writer", messages);
    expect(userApplied[0].content).toBe("基础系统提示");
    expect(userApplied[1].content).toContain("最后检查一次人物动机");

    await store.setActivePromptVersion("writer", first.id);
    expect(store.promptVersionInfo("writer").overrideId).toBe(first.id);
    expect(store.applyPromptOverrides("writer", messages)[0].content).toContain(
      "必须检查伏笔是否回收",
    );

    await store.setActivePromptVersion("writer", second.id);
    await store.setActivePromptVersion("writer", null);
    expect(store.promptVersionInfo("writer").overrideId).toBeUndefined();
    expect(store.applyPromptOverrides("writer", messages)[1].content).toBe(
      "基础任务",
    );
  });

  it("记录模型参数和指纹，损坏的 JSONL 行会被跳过", async () => {
    const messages = [{ role: "system", content: "基础提示" }];
    const hash = store.hashPromptMessages(messages);
    await store.recordPromptUsage({
      agent: "auditor",
      promptHash: hash,
      model: "deepseek-chat",
      provider: "openai-compatible",
      temperature: 0.1,
      maxTokens: 8192,
      chapter: 3,
      messageChars: 8,
    });
    await appendFile(store.PROMPT_USAGE_FILE, "{bad json\n", "utf8");

    const usage = await store.readPromptUsage(10);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      agent: "auditor",
      model: "deepseek-chat",
      temperature: 0.1,
      maxTokens: 8192,
      chapter: 3,
      promptHash: hash,
      promptVersion: "builtin:2026.11.17-p6",
    });
    expect(JSON.stringify(usage)).not.toContain("apiKey");
  });

  it("拒绝空附加规则和未知 Agent", async () => {
    await expect(
      store.createPromptVersion({
        agent: "writer",
        mode: "system",
        instructions: "   ",
      }),
    ).rejects.toThrow("附加提示词不能为空");
    await expect(
      store.createPromptVersion({
        agent: "not-an-agent" as never,
        mode: "system",
        instructions: "规则",
      }),
    ).rejects.toThrow("未知的提示词 Agent");
  });
});
