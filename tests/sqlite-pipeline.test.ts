import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "@/lib/types";

let dataDir: string;
let store: typeof import("@/lib/store");
let pipeline: typeof import("@/lib/pipeline");
let jobs: typeof import("@/lib/jobs");
let connection: typeof import("@/lib/db/connection");

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "quillmate-sqlite-pipeline-"));
  process.env.QUILLMATE_DATA_DIR = dataDir;
  process.env.QUILLMATE_STORAGE = "sqlite";
  vi.resetModules();
  store = await import("@/lib/store");
  pipeline = await import("@/lib/pipeline");
  jobs = await import("@/lib/jobs");
  connection = await import("@/lib/db/connection");
  jobs.__reloadJobStoreForTests();
});

afterEach(async () => {
  connection.closeDatabase();
  vi.resetModules();
  delete process.env.QUILLMATE_DATA_DIR;
  delete process.env.QUILLMATE_STORAGE;
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

describe("SQLite 任务与写作流程", () => {
  it("架构、写作、导出和任务持久化均可用", async () => {
    const created = await store.createProject({ title: "SQLite 冒烟", targetChapters: 2 });
    const slug = created.meta.slug;

    const planJob = await pipeline.startJob(slug, "plan");
    const planDone = await waitForJob(planJob.id);
    expect(planDone.status, planDone.error).toBe("done");

    const withPlan = await store.getProjectDetail(slug);
    expect(withPlan.plan.chapters).toHaveLength(2);
    expect(withPlan.characters.length).toBeGreaterThan(0);

    const writeJob = await pipeline.startJob(slug, "write", { count: 1 });
    const writeDone = await waitForJob(writeJob.id);
    expect(writeDone.status, writeDone.error).toBe("done");

    const afterWrite = await store.getProjectDetail(slug);
    const written = afterWrite.chapters.filter((chapter) => chapter.written);
    expect(written).toHaveLength(1);

    const memory = await store.getMemory(slug);
    expect(memory.chapters[String(written[0].index)]).toBeTruthy();
    expect(memory.chapters[String(written[0].index)].source).toBe("ai");
    expect(memory.volumes.length).toBeGreaterThan(0);
    expect(
      writeDone.logs.some((line) => line.message.includes("长期记忆")),
    ).toBe(true);

    const story = await store.getStory(slug);
    expect(story.events.some((event) => event.chapter === written[0].index)).toBe(true);
    expect(
      writeDone.logs.some((line) => line.message.includes("剧情台账")),
    ).toBe(true);

    const exported = await store.exportBookFile(slug);
    expect(exported.chapters).toBe(1);

    const integrity = await store.checkProjectIntegrity(slug);
    expect(integrity.ok, JSON.stringify(integrity.issues)).toBe(true);

    jobs.__reloadJobStoreForTests();
    expect(jobs.getJob(planJob.id)?.status).toBe("done");
    expect(jobs.getJob(writeJob.id)?.status).toBe("done");
  });
});
