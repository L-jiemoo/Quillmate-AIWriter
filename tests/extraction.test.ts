import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "@/lib/types";

const agentState = vi.hoisted(() => ({ failExtraction: false, calls: 0 }));

vi.mock("../lib/agents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/agents")>();
  return {
    ...actual,
    extractChapterFacts: async (...args: Parameters<typeof actual.extractChapterFacts>) => {
      agentState.calls += 1;
      if (agentState.failExtraction) throw new Error("模拟模型不可用");
      return actual.extractChapterFacts(...args);
    },
  };
});

let dataDir: string;
let store: typeof import("@/lib/store");
let pipeline: typeof import("@/lib/pipeline");
let jobs: typeof import("@/lib/jobs");

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "quillmate-extraction-"));
  process.env.QUILLMATE_DATA_DIR = dataDir;
  agentState.failExtraction = false;
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
  const deadline = Date.now() + 15000;
  for (;;) {
    const job = jobs.getJob(id);
    if (job && ["done", "error", "paused", "cancelled"].includes(job.status)) return job;
    if (Date.now() > deadline) throw new Error(`等待任务 ${id} 超时`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function projectWithPlan(title: string): Promise<string> {
  const slug = (await store.createProject({ title })).meta.slug;
  const planJob = await pipeline.startJob(slug, "plan");
  expect((await waitForJob(planJob.id)).status).toBe("done");
  return slug;
}

describe("事实抽取失败阻断", () => {
  it("连续失败时重试三次、章节不通过、正文不写入、台账不推进", async () => {
    const slug = await projectWithPlan("抽取阻断");

    agentState.failExtraction = true;
    const job = await pipeline.startJob(slug, "write", { count: 1 });
    const finished = await waitForJob(job.id);

    expect(finished.status).toBe("paused");
    expect(agentState.calls).toBe(3);

    const detail = await store.getProjectDetail(slug);
    expect(detail.chapters.filter((chapter) => chapter.written)).toHaveLength(0);
    expect(detail.canon.lastChapter).toBe(0);

    const draft = detail.state.rejectedDrafts["1"];
    expect(draft).toBeTruthy();
    expect(draft.reason).toContain("事实抽取失败");
    expect(draft.review.extractionOk).toBe(false);
    expect(draft.review.extractionAttempts).toBe(3);
    expect(
      draft.review.issues.some((issue) => issue.type === "事实抽取失败"),
    ).toBe(true);

    await expect(
      readFile(path.join(dataDir, "projects", slug, "chapters", "1.md"), "utf8"),
    ).rejects.toThrow();
  });

  it("模型恢复后重试可以继续写作并通过", async () => {
    const slug = await projectWithPlan("抽取恢复");

    agentState.failExtraction = true;
    const failed = await pipeline.startJob(slug, "write", { count: 1 });
    const paused = await waitForJob(failed.id);
    expect(paused.status).toBe("paused");

    agentState.failExtraction = false;
    agentState.calls = 0;
    const retried = await pipeline.retryJob(slug, failed.id);
    const done = await waitForJob(retried.id);
    expect(done.status, done.error).toBe("done");
    expect(agentState.calls).toBe(1);

    const detail = await store.getProjectDetail(slug);
    const written = detail.chapters.filter((chapter) => chapter.written);
    expect(written).toHaveLength(1);
    expect(detail.canon.lastChapter).toBe(written[0].index);
    expect(detail.state.reviews[String(written[0].index)].extractionOk).toBe(true);
  });
});

describe("长期记忆重建", () => {
  it("章节抽取失败时保留已有记忆", async () => {
    const slug = await projectWithPlan("记忆回滚");
    const write = await pipeline.startJob(slug, "write", { count: 1 });
    expect((await waitForJob(write.id)).status).toBe("done");
    const before = await store.getMemory(slug);
    const beforeStory = await store.getStory(slug);
    expect(Object.keys(before.chapters)).toHaveLength(1);
    expect(beforeStory.events.length).toBeGreaterThan(0);

    agentState.failExtraction = true;
    const rebuild = await pipeline.startJob(slug, "memory");
    const failed = await waitForJob(rebuild.id);
    expect(failed.status).toBe("error");

    const after = await store.getMemory(slug);
    expect(after).toEqual(before);
    expect(await store.getStory(slug)).toEqual(beforeStory);
  });

  it("重建时保留人工修正的章节记忆", async () => {
    const slug = await projectWithPlan("记忆人工保留");
    const write = await pipeline.startJob(slug, "write", { count: 1 });
    expect((await waitForJob(write.id)).status).toBe("done");

    const memory = await store.getMemory(slug);
    memory.chapters["1"].source = "manual";
    memory.chapters["1"].summary = "手工修正的章节摘要";
    await store.saveMemory(slug, memory);

    const rebuild = await pipeline.startJob(slug, "memory");
    const done = await waitForJob(rebuild.id);
    expect(done.status, done.error).toBe("done");

    const after = await store.getMemory(slug);
    expect(after.chapters["1"].source).toBe("manual");
    expect(after.chapters["1"].summary).toBe("手工修正的章节摘要");
    const story = await store.getStory(slug);
    expect(story.events.some((event) => event.chapter === 1)).toBe(true);
  });
});
