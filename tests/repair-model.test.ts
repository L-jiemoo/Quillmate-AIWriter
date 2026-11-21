import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChapterPlan, ContinuityIssue, ProjectMeta } from "@/lib/types";

const meta: ProjectMeta = {
  slug: "test",
  title: "测试小说",
  genre: "测试",
  tone: "测试",
  idea: "测试",
  author: "测试",
  language: "zh-CN",
  targetChapters: 10,
  wordsPerChapter: 2000,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const chapter: ChapterPlan = {
  index: 1,
  title: "第一章",
  summary: "角色乙接电话。",
  keyBeats: ["接电话"],
};

const issue: ContinuityIssue = {
  id: "issue-1",
  severity: "critical",
  type: "时间线",
  evidence: "角色乙在外地超市收银台旁接电话。",
  detail: "与第 4 章事实冲突。",
};

describe("修复模型覆盖", () => {
  let dataDir = "";
  const calls: Array<{ model?: string }> = [];

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "quillmate-repair-model-"));
    process.env.QUILLMATE_DATA_DIR = dataDir;
    process.env.LLM_PROVIDER = "openai-compatible";
    process.env.LLM_API_KEY = "test-key";
    process.env.LLM_REPAIR_MODEL = "deepseek-reasoner";
    calls.length = 0;
    vi.resetModules();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env.QUILLMATE_DATA_DIR;
    delete process.env.LLM_PROVIDER;
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_REPAIR_MODEL;
    await rm(dataDir, { recursive: true, force: true });
  });

  it("补丁阶段也使用单独配置的修复模型", async () => {
    const { LLMClient } = await import("@/lib/llm");
    const { repairChapterPatches } = await import("@/lib/agents");
    vi.spyOn(LLMClient.prototype, "json").mockImplementation(
      async (_messages, options) => {
        calls.push({ model: options?.model });
        return {
          patches: [
            {
              issueId: "issue-1",
              edits: [
                {
                  originalText: "角色乙在外地超市收银台旁接电话。",
                  replacement: "角色乙在巷口接电话。",
                  reason: "修复对应问题",
                },
              ],
            },
          ],
        } as never;
      },
    );

    await repairChapterPatches(
      meta,
      chapter,
      "角色乙在外地超市收银台旁接电话。",
      [issue],
      {
        characters: [],
        items: [],
        timeline: { currentDay: "", deadlines: [] },
        rules: [],
        lastChapter: 0,
        updatedAt: "",
      },
      "",
      "",
      "",
      "",
      { twoStage: false },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toBe("deepseek-reasoner");
  });
});
