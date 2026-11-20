import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "@/lib/types";

const agentState = vi.hoisted(() => ({
  failAudit: false,
  auditCalls: 0,
  repairCalls: 0,
}));

vi.mock("../lib/agents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/agents")>();
  return {
    ...actual,
    auditChapter: async (...args: Parameters<typeof actual.auditChapter>) => {
      agentState.auditCalls += 1;
      if (agentState.failAudit) throw new Error("模拟审校服务不可用");
      return actual.auditChapter(...args);
    },
    repairChapter: async (...args: Parameters<typeof actual.repairChapter>) => {
      agentState.repairCalls += 1;
      return actual.repairChapter(...args);
    },
  };
});

let dataDir: string;
let store: typeof import("@/lib/store");
let pipeline: typeof import("@/lib/pipeline");
let jobs: typeof import("@/lib/jobs");

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "quillmate-audit-failure-"));
  process.env.QUILLMATE_DATA_DIR = dataDir;
  agentState.failAudit = false;
  agentState.auditCalls = 0;
  agentState.repairCalls = 0;
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

describe("普通写作的审校服务失败", () => {
  it("审校异常时不调用 Repair Editor，也不写入正文", async () => {
    const slug = await projectWithPlan("普通写作审校失败");
    agentState.failAudit = true;

    const job = await pipeline.startJob(slug, "write", { count: 1 });
    const finished = await waitForJob(job.id);

    expect(finished.status, finished.error).toBe("paused");
    expect(agentState.auditCalls).toBe(1);
    expect(agentState.repairCalls).toBe(0);
    expect(
      finished.logs.some((line) => line.message.includes("未触发修复")),
    ).toBe(true);

    const detail = await store.getProjectDetail(slug);
    expect(detail.chapters.filter((chapter) => chapter.written)).toHaveLength(0);
    const draft = detail.state.rejectedDrafts["1"];
    expect(draft).toBeTruthy();
    expect(draft.reason).toContain("连续性审校服务失败");
  });
});
