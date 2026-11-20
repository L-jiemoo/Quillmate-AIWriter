import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "@/lib/types";

let dataDir: string;
let store: typeof import("@/lib/store");
let jobs: typeof import("@/lib/jobs");
let pipeline: typeof import("@/lib/pipeline");

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "quillmate-timeout-"));
  process.env.QUILLMATE_DATA_DIR = dataDir;
  // 必须在导入 jobs 之前设置，JOB_TIMEOUT_MS 在模块加载时读取。
  process.env.QUILLMATE_JOB_TIMEOUT_MS = "1";
  vi.resetModules();
  store = await import("@/lib/store");
  jobs = await import("@/lib/jobs");
  pipeline = await import("@/lib/pipeline");
  jobs.__reloadJobStoreForTests();
});

afterEach(async () => {
  vi.resetModules();
  delete process.env.QUILLMATE_DATA_DIR;
  delete process.env.QUILLMATE_JOB_TIMEOUT_MS;
  await rm(dataDir, { recursive: true, force: true });
});

async function waitForJob(id: string): Promise<Job> {
  const deadline = Date.now() + 15000;
  for (;;) {
    const job = jobs.getJob(id);
    if (job && ["done", "error", "paused", "cancelled", "interrupted"].includes(job.status)) {
      return job;
    }
    if (Date.now() > deadline) throw new Error(`等待任务 ${id} 超时`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("任务超时", () => {
  it("超过上限后自动停止、标记失败并释放锁", async () => {
    expect(jobs.JOB_TIMEOUT_MS).toBe(1);

    const slug = (await store.createProject({ title: "超时" })).meta.slug;
    const job = await pipeline.startJob(slug, "plan");
    const finished = await waitForJob(job.id);

    expect(finished.status).toBe("error");
    expect(finished.error).toContain("超时");
    expect(finished.endedAt).toBeTruthy();
    expect(jobs.getActiveJob(slug)).toBeUndefined();
  });
});
