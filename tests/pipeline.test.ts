import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "@/lib/types";

let dataDir: string;
let store: typeof import("@/lib/store");
let pipeline: typeof import("@/lib/pipeline");
let jobs: typeof import("@/lib/jobs");

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "quillmate-pipeline-"));
  process.env.QUILLMATE_DATA_DIR = dataDir;
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
    if (job && ["done", "error", "paused"].includes(job.status)) return job;
    if (Date.now() > deadline) throw new Error(`等待任务 ${id} 超时`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("mock 全流程冒烟", () => {
  it("架构 → 写作一章 → 导出，且数据完整性通过", async () => {
    const created = await store.createProject({ title: "冒烟测试" });
    const slug = created.meta.slug;

    const planJob = await pipeline.startJob(slug, "plan");
    const planDone = await waitForJob(planJob.id);
    expect(planDone.status, planDone.error).toBe("done");

    const withPlan = await store.getProjectDetail(slug);
    expect(withPlan.plan.chapters.length).toBeGreaterThan(0);
    expect(withPlan.characters.length).toBeGreaterThan(0);
    expect(withPlan.planLedger?.events).toHaveLength(withPlan.plan.chapters.length);
    expect(withPlan.planLedger?.events.every((event) => event.status === "planned")).toBe(
      true,
    );

    const writeJob = await pipeline.startJob(slug, "write", { count: 1 });
    const writeDone = await waitForJob(writeJob.id);
    expect(writeDone.status, writeDone.error).toBe("done");

    const afterWrite = await store.getProjectDetail(slug);
    const written = afterWrite.chapters.filter((chapter) => chapter.written);
    expect(written).toHaveLength(1);
    expect(afterWrite.canon.lastChapter).toBe(written[0].index);

    const memory = await store.getMemory(slug);
    expect(memory.chapters[String(written[0].index)]).toBeTruthy();
    expect(memory.chapters[String(written[0].index)].source).toBe("ai");
    expect(memory.chapters[String(written[0].index)].events.length).toBeGreaterThan(0);
    expect(memory.volumes.length).toBeGreaterThan(0);
    expect(
      writeDone.logs.some((line) => line.message.includes("长期记忆")),
    ).toBe(true);

    const story = await store.getStory(slug);
    expect(story.events.some((event) => event.chapter === written[0].index)).toBe(true);
    expect(
      writeDone.logs.some((line) => line.message.includes("剧情台账")),
    ).toBe(true);

    const planLedger = await store.getPlanLedger(slug);
    const planEvent = planLedger.events.find(
      (event) => event.chapter === written[0].index,
    );
    expect(planEvent?.actualChapter).toBe(written[0].index);
    expect(planEvent?.status).not.toBe("planned");
    expect(
      writeDone.logs.some((line) => line.message.includes("计划台账已注入")),
    ).toBe(true);
    expect(
      writeDone.logs.some((line) => line.message.includes("计划执行对比")),
    ).toBe(true);

    const exported = await store.exportBookFile(slug);
    expect(exported.chapters).toBe(1);
    expect(exported.words).toBeGreaterThan(0);

    const integrity = await store.checkProjectIntegrity(slug);
    expect(integrity.ok, JSON.stringify(integrity.issues)).toBe(true);
  });
});
