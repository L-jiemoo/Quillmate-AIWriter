import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyCanon, validateCanon } from "@/lib/canon";
import type { Job } from "@/lib/types";

const agentState = vi.hoisted(() => ({
  provider: "mock" as "mock" | "openai-compatible",
  failChapters: [] as number[],
  calls: 0,
}));

vi.mock("../lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/config")>();
  return {
    ...actual,
    getRuntimeConfig: () => ({
      ...actual.getRuntimeConfig(),
      provider: agentState.provider,
    }),
  };
});

vi.mock("../lib/agents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/agents")>();
  return {
    ...actual,
    extractChapterFacts: async (...args: Parameters<typeof actual.extractChapterFacts>) => {
      agentState.calls += 1;
      const chapter = args[2];
      if (agentState.failChapters.includes(chapter.index)) {
        throw new Error("模拟模型不可用");
      }
      if (agentState.provider === "mock") {
        return actual.extractChapterFacts(...args);
      }
      // 重建测试不访问真实模型，返回只含摘要的合成事实。
      return {
        summary: `重抽-${chapter.index}`,
        characters: [],
        items: [],
        timeline: null,
        rules: [],
      };
    },
  };
});

let dataDir: string;
let store: typeof import("@/lib/store");
let pipeline: typeof import("@/lib/pipeline");
let jobs: typeof import("@/lib/jobs");

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "quillmate-recanon-"));
  process.env.QUILLMATE_DATA_DIR = dataDir;
  agentState.provider = "mock";
  agentState.failChapters = [];
  agentState.calls = 0;
  vi.resetModules();
  store = await import("@/lib/store");
  pipeline = await import("@/lib/pipeline");
  jobs = await import("@/lib/jobs");
  jobs.__reloadJobStoreForTests();
});

afterEach(async () => {
  vi.resetModules();
  delete process.env.QUILLMATE_DATA_DIR;
  await rm(dataDir, { recursive: true, force: true });
});

async function waitForJob(id: string): Promise<Job> {
  const deadline = Date.now() + 20000;
  for (;;) {
    const job = jobs.getJob(id);
    if (job && ["done", "error", "paused", "cancelled"].includes(job.status)) return job;
    if (Date.now() > deadline) throw new Error(`等待任务 ${id} 超时`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function projectWithWrittenChapters(title: string, count: number): Promise<string> {
  const slug = (await store.createProject({ title })).meta.slug;
  const planJob = await pipeline.startJob(slug, "plan");
  expect((await waitForJob(planJob.id)).status).toBe("done");
  const writeJob = await pipeline.startJob(slug, "write", { count });
  expect((await waitForJob(writeJob.id)).status).toBe("done");
  const detail = await store.getProjectDetail(slug);
  expect(detail.chapters.filter((chapter) => chapter.written)).toHaveLength(count);
  return slug;
}

describe("事实台账整体重建", () => {
  it("中途失败时不改动正式台账和摘要，并给出失败章节", async () => {
    const slug = await projectWithWrittenChapters("重建失败", 2);
    const canonPath = path.join(dataDir, "projects", slug, "canon.json");
    const statePath = path.join(dataDir, "projects", slug, "state.json");
    const beforeCanon = await readFile(canonPath, "utf8");
    const beforeState = await readFile(statePath, "utf8");

    agentState.provider = "openai-compatible";
    agentState.failChapters = [2];
    const job = await pipeline.startJob(slug, "recanon");
    const finished = await waitForJob(job.id);

    expect(finished.status).toBe("error");
    expect(finished.error).toContain("第 2 章");
    expect(finished.error).toContain("原台账未改动");
    expect(
      finished.logs.some((log) => log.message.includes("正式台账保持不变")),
    ).toBe(true);

    expect(await readFile(canonPath, "utf8")).toBe(beforeCanon);
    expect(await readFile(statePath, "utf8")).toBe(beforeState);
  });

  it("全部章节成功后统一提交台账与摘要", async () => {
    const slug = await projectWithWrittenChapters("重建成功", 2);

    agentState.provider = "openai-compatible";
    const job = await pipeline.startJob(slug, "recanon");
    const finished = await waitForJob(job.id);
    expect(finished.status, finished.error).toBe("done");
    expect(finished.result).toContain("已从 2 章重建");
    expect(
      finished.logs.some((log) => log.message.includes("已提交")),
    ).toBe(true);

    const detail = await store.getProjectDetail(slug);
    expect(detail.canon.lastChapter).toBe(2);
    expect(detail.state.summaries["1"]).toBe("重抽-1");
    expect(detail.state.summaries["2"]).toBe("重抽-2");

    const integrity = await store.checkProjectIntegrity(slug);
    expect(integrity.ok, JSON.stringify(integrity.issues)).toBe(true);
  });

  it("校验函数能识别台账落后、超前和重复条目", () => {
    const character = {
      name: "甲",
      aliases: [],
      status: "alive" as const,
      location: "",
      note: "",
      statusChapter: 1,
      chapter: 1,
    };

    const lagging = { ...emptyCanon(), lastChapter: 0 };
    expect(
      validateCanon(lagging, [{ index: 1 }]).find((issue) => issue.code === "canon-lagging")
        ?.severity,
    ).toBe("critical");

    const ahead = { ...emptyCanon(), lastChapter: 3 };
    expect(
      validateCanon(ahead, [{ index: 1 }]).find((issue) => issue.code === "canon-ahead")
        ?.severity,
    ).toBe("critical");

    const duplicated = {
      ...emptyCanon(),
      lastChapter: 1,
      characters: [character, { ...character }],
    };
    expect(
      validateCanon(duplicated, [{ index: 1 }]).some(
        (issue) => issue.code === "duplicate-character",
      ),
    ).toBe(true);
  });
});
