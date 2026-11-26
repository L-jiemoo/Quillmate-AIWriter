import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { foreshadowClassifyMessages } from "@/lib/prompts";
import type { LLMClient } from "@/lib/llm";
import type { Job, ProjectMeta } from "@/lib/types";

let dataDir: string;
let store: typeof import("@/lib/store");
let pipeline: typeof import("@/lib/pipeline");
let jobs: typeof import("@/lib/jobs");
let agents: typeof import("@/lib/agents");
let previousProvider: string | undefined;
let previousApiKey: string | undefined;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "quillmate-foreshadow-"));
  previousProvider = process.env.LLM_PROVIDER;
  previousApiKey = process.env.LLM_API_KEY;
  process.env.QUILLMATE_DATA_DIR = dataDir;
  delete process.env.LLM_PROVIDER;
  delete process.env.LLM_API_KEY;
  vi.resetModules();
  store = await import("@/lib/store");
  pipeline = await import("@/lib/pipeline");
  jobs = await import("@/lib/jobs");
  agents = await import("@/lib/agents");
  jobs.__reloadJobStoreForTests();
});

afterEach(async () => {
  vi.resetModules();
  delete process.env.QUILLMATE_DATA_DIR;
  if (previousProvider === undefined) delete process.env.LLM_PROVIDER;
  else process.env.LLM_PROVIDER = previousProvider;
  if (previousApiKey === undefined) delete process.env.LLM_API_KEY;
  else process.env.LLM_API_KEY = previousApiKey;
  await rm(dataDir, { recursive: true, force: true });
});

function meta(): ProjectMeta {
  return {
    slug: "foreshadow-test",
    title: "伏笔分类测试",
    genre: "悬疑",
    tone: "冷峻",
    idea: "",
    author: "",
    language: "中文",
    targetChapters: 2,
    wordsPerChapter: 2000,
    createdAt: "2026-11-20T00:00:00.000Z",
    updatedAt: "2026-11-20T00:00:00.000Z",
  };
}

async function waitForJob(id: string): Promise<Job> {
  const deadline = Date.now() + 20000;
  for (;;) {
    const job = jobs.getJob(id);
    if (job && ["done", "error", "paused", "cancelled"].includes(job.status)) return job;
    if (Date.now() > deadline) throw new Error(`等待任务 ${id} 超时`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("伏笔自动分类提示词", () => {
  it("带上伏笔原文、埋设章节和证据要求", () => {
    const text = foreshadowClassifyMessages(
      meta(),
      [{ id: "fs-1", text: "旧玉佩的裂痕", plantedChapter: 2 }],
      "第 2 章：玉佩裂开一道口子",
      5,
    )
      .map((message) => message.content)
      .join("\n");

    expect(text).toContain("旧玉佩的裂痕");
    expect(text).toContain("[fs-1]");
    expect(text).toContain("第 2 章：玉佩裂开一道口子");
    expect(text).toContain("拿不准一律 open");
    expect(text).toContain('"verdict"');
    expect(text).toContain("每条伏笔都必须出现在输出里");
  });
});

describe("伏笔自动分类调用", () => {
  it("按批调用模型并合并全部结论", async () => {
    process.env.LLM_PROVIDER = "openai-compatible";
    process.env.LLM_API_KEY = "sk-test";
    const calls: string[] = [];
    const client = {
      json: async (messages: Array<{ content: string }>) => {
        const text = messages.map((message) => message.content).join("\n");
        calls.push(text);
        const ids = [...text.matchAll(/\[(fs-\d+)\]/gu)].map((match) => match[1]);
        return {
          items: ids.map((id) => ({
            id,
            verdict: "resolved",
            chapter: 3,
            evidence: "第 3 章交代了玉佩的来历",
            confidence: "high",
          })),
        };
      },
    } as unknown as LLMClient;

    const foreshadows = Array.from({ length: 26 }, (_, index) => ({
      id: `fs-${index + 1}`,
      text: `伏笔${index + 1}`,
      plantedChapter: 1,
    }));
    const verdicts = await agents.classifyForeshadows(
      meta(),
      foreshadows,
      "第 1 章：开篇",
      3,
      { client },
    );

    expect(calls).toHaveLength(2);
    expect(verdicts).toHaveLength(26);
    expect(verdicts.every((item) => item.verdict === "resolved")).toBe(true);
    expect(verdicts[0].confidence).toBe("high");
  });

  it("mock 模式不把伏笔误标成已回收", async () => {
    const slug = (await store.createProject({ title: "伏笔分类", targetChapters: 2 })).meta.slug;
    const planJob = await pipeline.startJob(slug, "plan");
    expect((await waitForJob(planJob.id)).status).toBe("done");
    const writeJob = await pipeline.startJob(slug, "write", { count: 1, indices: [1] });
    expect((await waitForJob(writeJob.id)).status).toBe("done");

    const { normalizeStory } = await import("@/lib/story");
    await store.saveStory(
      slug,
      normalizeStory({
        foreshadows: [
          {
            id: "fs-manual",
            text: "旧玉佩的裂痕",
            plantedChapter: 1,
            status: "developing",
            source: "manual",
          },
        ],
      }),
    );

    const job = await pipeline.startJob(slug, "foreshadow");
    const finished = await waitForJob(job.id);
    expect(finished.status, finished.error).toBe("done");
    expect(finished.result).toContain("仍待回收 1 条");

    const story = await store.getStory(slug);
    const record = story.foreshadows.find((item) => item.id === "fs-manual");
    expect(record?.status).toBe("developing");
    expect(finished.logs.some((line) => line.message.includes("自动分类完成"))).toBe(true);
  });

  it("没有大纲时拒绝分类", async () => {
    const slug = (await store.createProject({ title: "空项目" })).meta.slug;
    const job = await pipeline.startJob(slug, "foreshadow");
    const finished = await waitForJob(job.id);

    expect(finished.status).toBe("error");
    expect(finished.error).toContain("还没有章节大纲");
  });
});
