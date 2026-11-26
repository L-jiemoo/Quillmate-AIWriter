import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "@/lib/types";

let dataDir: string;
let store: typeof import("@/lib/store");
let jobs: typeof import("@/lib/jobs");
let pipeline: typeof import("@/lib/pipeline");

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "quillmate-jobs-"));
  process.env.QUILLMATE_DATA_DIR = dataDir;
  delete process.env.QUILLMATE_JOB_TIMEOUT_MS;
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
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function newProject(title: string): Promise<string> {
  return (await store.createProject({ title })).meta.slug;
}

describe("项目级任务锁", () => {
  it("并发启动同一项目时只成功一个", async () => {
    const slug = await newProject("并发锁");
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => pipeline.startJob(slug, "plan")),
    );

    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<Job> => result.status === "fulfilled",
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(4);
    for (const result of rejected) {
      expect(result.reason).toBeInstanceOf(jobs.JobConflictError);
    }

    const winner = fulfilled[0].value;
    expect(jobs.getActiveJob(slug)?.id).toBe(winner.id);
    await waitForJob(winner.id);
    expect(jobs.getActiveJob(slug)).toBeUndefined();
  });

  it("任务完成后释放锁，可以启动下一个任务", async () => {
    const slug = await newProject("锁释放");
    const first = await pipeline.startJob(slug, "export");
    const done = await waitForJob(first.id);
    expect(done.status).toBe("done");
    expect(jobs.getActiveJob(slug)).toBeUndefined();

    const second = await pipeline.startJob(slug, "export");
    expect(jobs.getActiveJob(slug)?.id).toBe(second.id);
    await waitForJob(second.id);
  });
});

describe("任务持久化与重启恢复", () => {
  it("重启后未完成任务标记为 interrupted，并保留参数", async () => {
    const slug = await newProject("重启恢复");
    const job = jobs.acquireProjectSlot(slug, "write", {
      count: 2,
      indices: [1, 3],
      instruction: "加强冲突",
      useReview: true,
      source: "review",
    });
    job.status = "running";
    job.startedAt = new Date().toISOString();
    job.updatedAt = job.startedAt;
    await jobs.persistJob(job);
    // 模拟原进程已退出：锁文件不存在，重启恢复应标记为 interrupted。
    jobs.releaseProjectSlot(slug, job.id);

    jobs.__reloadJobStoreForTests();

    const restored = jobs.getJob(job.id);
    expect(restored?.status).toBe("interrupted");
    expect(restored?.error).toContain("重启");
    expect(restored?.params).toMatchObject({
      count: 2,
      indices: [1, 3],
      instruction: "加强冲突",
      useReview: true,
      source: "review",
    });
    expect(jobs.getInterruptedJobs(slug).map((item) => item.id)).toContain(job.id);
    expect(jobs.getActiveJob(slug)).toBeUndefined();

    await jobs.flushJob(restored!);
    const raw = JSON.parse(
      await readFile(path.join(dataDir, "jobs", `${job.id}.json`), "utf8"),
    ) as Job;
    expect(raw.status).toBe("interrupted");
  });

  it("中断记录只回放最后一个中断任务，之后跑过新任务就不再回放", async () => {
    const slug = await newProject("中断后继续");
    const interrupted = jobs.acquireProjectSlot(slug, "write", { count: 1 });
    interrupted.status = "running";
    interrupted.startedAt = new Date().toISOString();
    interrupted.updatedAt = interrupted.startedAt;
    await jobs.persistJob(interrupted);
    jobs.releaseProjectSlot(slug, interrupted.id);

    jobs.__reloadJobStoreForTests();
    expect(jobs.getInterruptedJobs(slug).map((item) => item.id)).toEqual([
      interrupted.id,
    ]);

    // 中断之后又跑了一次别的任务：旧的中断记录不应再反复出现在任务台。
    const next = jobs.acquireProjectSlot(slug, "audit", {});
    next.status = "done";
    next.createdAt = new Date(Date.now() + 1000).toISOString();
    next.updatedAt = next.createdAt;
    await jobs.persistJob(next);
    jobs.releaseProjectSlot(slug, next.id);

    expect(jobs.getInterruptedJobs(slug)).toEqual([]);
  });

  it("任务完成后落盘包含开始和结束时间", async () => {
    const slug = await newProject("落盘");
    const job = await pipeline.startJob(slug, "export");
    const done = await waitForJob(job.id);
    await jobs.flushJob(done);

    const raw = JSON.parse(
      await readFile(path.join(dataDir, "jobs", `${job.id}.json`), "utf8"),
    ) as Job;
    expect(raw.status).toBe("done");
    expect(raw.startedAt).toBeTruthy();
    expect(raw.endedAt).toBeTruthy();
    expect(raw.logs.length).toBeGreaterThan(0);
  });
});

describe("取消与重试", () => {
  it("暂停中的任务可以立即取消并释放锁", async () => {
    const slug = await newProject("取消暂停");
    const job = jobs.acquireProjectSlot(slug, "repair", { indices: [1] });
    job.status = "paused";
    job.pauseRequested = true;
    job.endedAt = new Date().toISOString();
    job.updatedAt = job.endedAt;
    await jobs.persistJob(job);
    jobs.releaseProjectSlot(slug, job.id);

    const cancelled = jobs.requestCancel(job.id, slug);
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.endedAt).toBeTruthy();
    expect(jobs.getActiveJob(slug)).toBeUndefined();
  });

  it("运行中的任务可被端到端取消并释放锁", async () => {
    const slug = await newProject("取消运行端到端");
    const job = await pipeline.startJob(slug, "plan");

    const cancelled = jobs.requestCancel(job.id, slug);
    expect(cancelled?.cancelRequested).toBe(true);

    const finished = await waitForJob(job.id);
    expect(finished.status).toBe("cancelled");
    expect(finished.error).toBe("任务已取消");
    expect(jobs.getActiveJob(slug)).toBeUndefined();
  });

  it("取消请求写入控制文件，执行进程在检查点抛出取消错误", async () => {
    const slug = await newProject("取消运行");
    const job = jobs.acquireProjectSlot(slug, "plan");
    job.status = "running";
    job.startedAt = new Date().toISOString();
    job.updatedAt = job.startedAt;
    await jobs.persistJob(job);

    const returned = jobs.requestCancel(job.id, slug);
    expect(returned?.status).toBe("running");
    expect(returned?.cancelRequested).toBe(true);
    expect(() => jobs.throwIfCancelled(returned!)).toThrow(jobs.JobCancelledError);

    jobs.releaseProjectSlot(slug, job.id);
    jobs.clearJobControl(job.id);
    returned!.status = "cancelled";
    returned!.endedAt = new Date().toISOString();
    await jobs.flushJob(returned!);
  });

  it("失败任务可以按原参数重试", async () => {
    const slug = await newProject("重试");
    const failed = jobs.acquireProjectSlot(slug, "write", {
      count: 2,
      indices: [1, 3],
      instruction: "更紧凑",
      useReview: true,
      source: "review",
    });
    failed.status = "error";
    failed.error = "模拟失败";
    failed.endedAt = new Date().toISOString();
    jobs.releaseProjectSlot(slug, failed.id);
    await jobs.flushJob(failed);

    const retried = await pipeline.retryJob(slug, failed.id);
    expect(retried.type).toBe("write");
    expect(retried.params).toMatchObject({
      count: 2,
      indices: [1, 3],
      instruction: "更紧凑",
      useReview: true,
      source: "review",
    });
    expect(jobs.getActiveJob(slug)?.id).toBe(retried.id);
    await waitForJob(retried.id);
    expect(jobs.getActiveJob(slug)).toBeUndefined();
  });

  it("未失败的任务不能重试", async () => {
    const slug = await newProject("不可重试");
    const job = jobs.acquireProjectSlot(slug, "plan");
    await expect(pipeline.retryJob(slug, job.id)).rejects.toThrow(/只有失败/);
    jobs.releaseProjectSlot(slug, job.id);
    job.status = "cancelled";
    await jobs.flushJob(job);
  });
});
