import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job, ReviewResult } from "@/lib/types";

const agentState = vi.hoisted(() => ({
  failExtraction: false,
  flatAudit: false,
  repairCalls: 0,
}));

vi.mock("../lib/agents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/agents")>();
  return {
    ...actual,
    extractChapterFacts: async (
      ...args: Parameters<typeof actual.extractChapterFacts>
    ) => {
      if (agentState.failExtraction) throw new Error("模拟模型不可用");
      return actual.extractChapterFacts(...args);
    },
    auditChapter: async (...args: Parameters<typeof actual.auditChapter>) => {
      if (!agentState.flatAudit) return actual.auditChapter(...args);
      const chapter = args[3];
      const text = args[4];
      return {
        summary: chapter.summary,
        issues: [1, 2, 3].map((index) => ({
          severity: "critical" as const,
          type: `固定问题${index}`,
          evidence: `当前文本结尾：${text.slice(-12)}`,
          detail: "每轮都保持 3 个严重问题。",
        })),
        continuityOk: false,
      };
    },
    repairChapter: async (...args: Parameters<typeof actual.repairChapter>) => {
      if (!agentState.flatAudit) return actual.repairChapter(...args);
      agentState.repairCalls += 1;
      return `${args[2]}\n【修复${agentState.repairCalls}】`;
    },
  };
});

let dataDir: string;
let store: typeof import("@/lib/store");
let pipeline: typeof import("@/lib/pipeline");
let jobs: typeof import("@/lib/jobs");

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "quillmate-draft-repair-"));
  process.env.QUILLMATE_DATA_DIR = dataDir;
  agentState.failExtraction = false;
  agentState.flatAudit = false;
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
  const deadline = Date.now() + 20000;
  for (;;) {
    const job = jobs.getJob(id);
    if (job && ["done", "error", "paused", "cancelled"].includes(job.status)) return job;
    if (Date.now() > deadline) throw new Error(`等待任务 ${id} 超时`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function projectWithPlan(title: string): Promise<string> {
  const slug = (await store.createProject({ title, targetChapters: 3 })).meta.slug;
  const planJob = await pipeline.startJob(slug, "plan");
  expect((await waitForJob(planJob.id)).status).toBe("done");
  return slug;
}

function draftReview(summary = "草稿摘要"): ReviewResult {
  return {
    summary,
    issues: [
      {
        severity: "critical",
        type: "人物生死状态",
        evidence: "已死角色仍然开口说话",
        detail: "需要改掉已死角色以活人身份行动的部分。",
      },
    ],
    continuityOk: false,
    extractionOk: true,
  };
}

async function saveDraft(
  slug: string,
  mode: "write" | "rewrite",
  content: string,
): Promise<void> {
  await store.saveRejectedDraft(slug, {
    index: 1,
    content,
    mode,
    reason: "连续性检查未通过：1 个严重问题",
    review: draftReview(),
  });
}

describe("未采用草稿修复", () => {
  it("修复通过后自动写入正文并清除草稿", async () => {
    const slug = await projectWithPlan("草稿采用");
    await saveDraft(slug, "write", "这是待采用的草稿正文。");

    const job = await pipeline.startJob(slug, "repair", {
      indices: [1],
      source: "draft",
    });
    const finished = await waitForJob(job.id);
    expect(finished.status, finished.error).toBe("done");

    const detail = await store.getProjectDetail(slug);
    const chapter = detail.chapters.find((item) => item.index === 1);
    expect(chapter?.written).toBe(true);
    expect(chapter?.content).toContain("待采用的草稿正文");
    expect(detail.state.rejectedDrafts[String(1)]).toBeUndefined();
    expect(detail.canon.lastChapter).toBe(1);
    expect(
      finished.logs.some((line) => line.message.includes("草稿修复通过并已采用")),
    ).toBe(true);
  });

  it("重写稿采用前备份原正文", async () => {
    const slug = await projectWithPlan("重写草稿备份");
    const writeJob = await pipeline.startJob(slug, "write", { count: 1 });
    expect((await waitForJob(writeJob.id)).status).toBe("done");
    const before = await store.getProjectDetail(slug);
    const original = before.chapters.find((item) => item.index === 1)?.content ?? "";
    expect(original.trim().length).toBeGreaterThan(0);

    await saveDraft(slug, "rewrite", "重写后的草稿正文。");
    const job = await pipeline.startJob(slug, "repair", {
      indices: [1],
      source: "draft",
    });
    const finished = await waitForJob(job.id);
    expect(finished.status, finished.error).toBe("done");

    const draftsDir = path.join(dataDir, "projects", slug, "drafts");
    const files = await readdir(draftsDir);
    expect(files.some((name) => name.startsWith("1-before-repair-"))).toBe(true);
    expect(
      finished.logs.some((line) => line.message.includes("原正文备份在")),
    ).toBe(true);
  });

  it("修复后仍不通过时更新草稿，不覆盖正文", async () => {
    const slug = await projectWithPlan("草稿修复失败");
    await saveDraft(slug, "write", "仍然有问题的草稿正文。");
    agentState.failExtraction = true;

    const job = await pipeline.startJob(slug, "repair", {
      indices: [1],
      source: "draft",
    });
    const finished = await waitForJob(job.id);
    expect(finished.status).toBe("done");
    expect(finished.result).toContain("1 份仍需处理");

    const detail = await store.getProjectDetail(slug);
    const chapter = detail.chapters.find((item) => item.index === 1);
    expect(chapter?.written).toBeFalsy();
    expect(detail.canon.lastChapter).toBe(0);
    const updated = detail.state.rejectedDrafts[String(1)];
    expect(updated).toBeTruthy();
    expect(updated.review.extractionOk).toBe(false);
    expect(
      finished.logs.some((line) => line.message.includes("原正文未改动")),
    ).toBe(true);
  });

  it("严重问题数打平时保留最后一轮修复文本", async () => {
    const slug = await projectWithPlan("打平保留修复");
    await saveDraft(slug, "write", "原始草稿正文。");
    agentState.flatAudit = true;

    const job = await pipeline.startJob(slug, "repair", {
      indices: [1],
      source: "draft",
    });
    const finished = await waitForJob(job.id);
    expect(finished.status, finished.error).toBe("done");

    const saved = await store.getRejectedDraftContent(slug, 1);
    expect(saved?.content).toContain("【修复3】");
    expect(saved?.draft.review.repairAttempts).toBe(3);
    expect(saved?.draft.review.repaired).toBe(true);
    const detail = await store.getProjectDetail(slug);
    expect(detail.chapters.find((item) => item.index === 1)?.written).toBeFalsy();
  });

  it("草稿文件缺失时任务报错且不写正文", async () => {
    const slug = await projectWithPlan("草稿缺失");
    await store.saveRejectedDraft(slug, {
      index: 1,
      content: "临时草稿",
      mode: "write",
      reason: "测试",
      review: draftReview(),
    });
    const draftsDir = path.join(dataDir, "projects", slug, "drafts");
    for (const name of await readdir(draftsDir)) {
      await rm(path.join(draftsDir, name), { force: true });
    }

    const job = await pipeline.startJob(slug, "repair", {
      indices: [1],
      source: "draft",
    });
    const finished = await waitForJob(job.id);
    expect(finished.status).toBe("error");
    expect(finished.error).toContain("草稿");

    const detail = await store.getProjectDetail(slug);
    expect(detail.chapters.find((item) => item.index === 1)?.written).toBeFalsy();
  });
});
