import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContinuityIssue, Job, ReviewResult } from "@/lib/types";

interface AuditStep {
  critical: { type: string; evidence: string; detail?: string }[];
}

const agentState = vi.hoisted(() => ({
  failExtraction: false,
  failExtractionAfter: null as number | null,
  extractionCalls: 0,
  scripted: false,
  auditSteps: [] as AuditStep[],
  auditCalls: 0,
  repairCalls: 0,
  repairIssues: [] as ContinuityIssue[][],
  scriptedRegression: false,
  regressionSteps: [] as AuditStep[],
  regressionCalls: 0,
  onAudit: null as (() => void | Promise<void>) | null,
}));

vi.mock("../lib/agents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/agents")>();
  return {
    ...actual,
    extractChapterFacts: async (
      ...args: Parameters<typeof actual.extractChapterFacts>
    ) => {
      agentState.extractionCalls += 1;
      if (
        agentState.failExtraction ||
        (agentState.failExtractionAfter !== null &&
          agentState.extractionCalls > agentState.failExtractionAfter)
      ) {
        throw new Error("模拟模型不可用");
      }
      return actual.extractChapterFacts(...args);
    },
    auditChapter: async (...args: Parameters<typeof actual.auditChapter>) => {
      agentState.auditCalls += 1;
      if (agentState.onAudit) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        await agentState.onAudit();
      }
      if (!agentState.scripted) return actual.auditChapter(...args);
      const step = agentState.auditSteps.shift();
      if (!step) throw new Error("模拟审校脚本已用完");
      const chapter = args[3];
      return {
        summary: chapter.summary,
        issues: step.critical.map((item) => ({
          severity: "critical" as const,
          type: item.type,
          evidence: item.evidence,
          detail: item.detail ?? "与第 4 章事实台账冲突。",
        })),
        continuityOk: step.critical.length === 0,
      };
    },
    repairChapter: async (...args: Parameters<typeof actual.repairChapter>) => {
      agentState.repairCalls += 1;
      agentState.repairIssues.push(args[3]);
      return `${args[2]}\n【修复${agentState.repairCalls}】`;
    },
    auditRepairRegression: async (
      ...args: Parameters<typeof actual.auditRepairRegression>
    ) => {
      agentState.regressionCalls += 1;
      if (!agentState.scriptedRegression) {
        return actual.auditRepairRegression(...args);
      }
      const step = agentState.regressionSteps.shift();
      if (!step) throw new Error("模拟回归审校脚本已用完");
      const chapter = args[3];
      return {
        summary: chapter.summary,
        issues: step.critical.map((item) => ({
          severity: "critical" as const,
          type: item.type,
          evidence: item.evidence,
          detail: item.detail ?? "修复后新增矛盾。",
        })),
        continuityOk: step.critical.length === 0,
        extractionOk: true,
      };
    },
  };
});

let dataDir: string;
let store: typeof import("@/lib/store");
let pipeline: typeof import("@/lib/pipeline");
let jobs: typeof import("@/lib/jobs");

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "quillmate-repair-body-"));
  process.env.QUILLMATE_DATA_DIR = dataDir;
  agentState.failExtraction = false;
  agentState.failExtractionAfter = null;
  agentState.extractionCalls = 0;
  agentState.scripted = false;
  agentState.auditSteps = [];
  agentState.auditCalls = 0;
  agentState.repairCalls = 0;
  agentState.repairIssues = [];
  agentState.scriptedRegression = false;
  agentState.regressionSteps = [];
  agentState.regressionCalls = 0;
  agentState.onAudit = null;
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

function criticalIssue(
  type: string,
  evidence: string,
  detail = "与第 4 章事实台账冲突。",
): ContinuityIssue {
  return { severity: "critical", type, evidence, detail };
}

function reviewWith(issues: ContinuityIssue[]): ReviewResult {
  return {
    summary: "章节摘要",
    issues,
    continuityOk: issues.every((issue) => issue.severity !== "critical"),
    extractionOk: true,
  };
}

// 建好项目与大纲，并写入第 1 章正文和带严重问题的审校记录。
async function projectWithWrittenChapter(
  title: string,
  content: string,
  issues: ContinuityIssue[],
): Promise<string> {
  const slug = (await store.createProject({ title, targetChapters: 3 })).meta.slug;
  const planJob = await pipeline.startJob(slug, "plan");
  expect((await waitForJob(planJob.id)).status).toBe("done");

  const detail = await store.getProjectDetail(slug);
  const chapter = detail.plan.chapters.find((item) => item.index === 1);
  expect(chapter).toBeTruthy();
  await store.writeChapterFile(slug, 1, content, {
    source: "ai-write",
    title: chapter!.title,
    summary: "章节摘要",
    note: "测试正文",
  });
  await store.markChapterWritten(slug, 1, "章节摘要", reviewWith(issues));
  return slug;
}

async function chapterContent(slug: string, index = 1): Promise<string | undefined> {
  const detail = await store.getProjectDetail(slug);
  return detail.chapters.find((item) => item.index === index)?.content;
}

async function runBodyRepair(slug: string, index = 1): Promise<Job> {
  const job = await pipeline.startJob(slug, "repair", {
    indices: [index],
    source: "review",
  });
  return waitForJob(job.id);
}

describe("正文定点修复验收", () => {
  it("原问题全部解决且没有新增时写回正文", async () => {
    const problem = criticalIssue("时间线", "陈玉华在省城超市收银台旁接电话。");
    const slug = await projectWithWrittenChapter(
      "正文修复通过",
      "陈玉华在省城超市收银台旁接电话。",
      [problem],
    );
    agentState.scripted = true;
    agentState.auditSteps = [
      { critical: [{ type: problem.type, evidence: problem.evidence }] },
      { critical: [] },
    ];

    const finished = await runBodyRepair(slug);
    expect(finished.status, finished.error).toBe("done");
    expect(agentState.auditCalls).toBe(2);
    expect(agentState.repairCalls).toBe(1);

    const detail = await store.getProjectDetail(slug);
    const chapter = detail.chapters.find((item) => item.index === 1);
    expect(chapter?.written).toBe(true);
    expect(chapter?.content).toContain("【修复1】");
    expect(detail.state.rejectedDrafts[String(1)]).toBeUndefined();
  });

  it("修复引入新的严重问题时拒绝写回，原文字节级不变", async () => {
    const original = "陈玉华在省城超市收银台旁接电话。";
    const problem = criticalIssue("时间线", original);
    const slug = await projectWithWrittenChapter("正文修复新问题", original, [problem]);
    const stored = await chapterContent(slug);
    agentState.scripted = true;
    agentState.auditSteps = [
      { critical: [{ type: problem.type, evidence: problem.evidence }] },
      {
        critical: [
          { type: problem.type, evidence: problem.evidence },
          { type: "剧情因果", evidence: "陈默突然出现在石室。" },
        ],
      },
    ];

    const finished = await runBodyRepair(slug);
    expect(finished.status, finished.error).toBe("done");
    expect(agentState.repairCalls).toBe(1);

    const detail = await store.getProjectDetail(slug);
    const chapter = detail.chapters.find((item) => item.index === 1);
    expect(chapter?.content).toBe(stored);
    const draft = await store.getRejectedDraftContent(slug, 1);
    expect(draft?.draft.reason).toContain("未通过验收");
    expect(draft?.draft.reason).toContain("新增 1");
    expect(finished.logs.some((line) => line.message.includes("原正文保持不变"))).toBe(
      true,
    );
  });

  it("原问题没有全部解决时拒绝写回", async () => {
    const original = "陈玉华在省城超市收银台旁接电话。";
    const problem = criticalIssue("时间线", original);
    const slug = await projectWithWrittenChapter("正文修复未解决", original, [problem]);
    const stored = await chapterContent(slug);
    agentState.scripted = true;
    agentState.auditSteps = [
      { critical: [{ type: problem.type, evidence: problem.evidence }] },
      { critical: [{ type: problem.type, evidence: problem.evidence }] },
    ];

    const finished = await runBodyRepair(slug);
    expect(finished.status, finished.error).toBe("done");

    const detail = await store.getProjectDetail(slug);
    expect(detail.chapters.find((item) => item.index === 1)?.content).toBe(stored);
    const draft = await store.getRejectedDraftContent(slug, 1);
    expect(draft?.draft.reason).toContain("REJECTED_UNRESOLVED");
  });

  it("候选稿审校失败时不覆盖原文，保存草稿并暂停", async () => {
    const original = "陈玉华在省城超市收银台旁接电话。";
    const problem = criticalIssue("时间线", original);
    const slug = await projectWithWrittenChapter("正文修复审校失败", original, [problem]);
    const stored = await chapterContent(slug);
    agentState.scripted = true;
    agentState.auditSteps = [
      { critical: [{ type: problem.type, evidence: problem.evidence }] },
    ];
    // 第二次审校时脚本用完，会抛错，模拟审校服务失败。
    const finished = await runBodyRepair(slug);
    expect(finished.status, finished.error).toBe("paused");

    const detail = await store.getProjectDetail(slug);
    expect(detail.chapters.find((item) => item.index === 1)?.content).toBe(stored);
    const draft = await store.getRejectedDraftContent(slug, 1);
    expect(draft?.draft.reason).toContain("审校");
  });

  it("基线审校失败时不调用修复 Agent，原稿不动", async () => {
    const original = "陈玉华在省城超市收银台旁接电话。";
    const problem = criticalIssue("时间线", original);
    const slug = await projectWithWrittenChapter("正文修复基线失败", original, [problem]);
    const stored = await chapterContent(slug);
    // 不设置脚本时使用真实 mock 审校（无问题），这里通过清空脚本来触发“脚本用完”不可行，
    // 改为让抽取直接失败，验证不会进入修复。
    agentState.failExtraction = true;

    const finished = await runBodyRepair(slug);
    expect(finished.status, finished.error).toBe("paused");
    expect(agentState.repairCalls).toBe(0);

    const detail = await store.getProjectDetail(slug);
    expect(detail.chapters.find((item) => item.index === 1)?.content).toBe(stored);
  });

  it("删除前文关键证据来规避矛盾时，回归审校拒绝写回", async () => {
    const original = "陈玉华在省城超市收银台旁接电话。";
    const problem = criticalIssue("伏笔连续性", original);
    const slug = await projectWithWrittenChapter("回归删除证据", original, [problem]);
    const stored = await chapterContent(slug);
    agentState.scripted = true;
    agentState.auditSteps = [
      { critical: [{ type: problem.type, evidence: problem.evidence }] },
      { critical: [] },
    ];
    agentState.scriptedRegression = true;
    agentState.regressionSteps = [
      {
        critical: [
          {
            type: "伏笔连续性",
            evidence: "修复稿删除了第 4 章已经埋设的电话内容。",
            detail: "通过删除前文关键证据规避矛盾，伏笔生命周期被破坏。",
          },
        ],
      },
    ];

    const finished = await runBodyRepair(slug);
    expect(finished.status, finished.error).toBe("done");
    expect(agentState.regressionCalls).toBe(1);

    const detail = await store.getProjectDetail(slug);
    expect(detail.chapters.find((item) => item.index === 1)?.content).toBe(stored);
    const draft = await store.getRejectedDraftContent(slug, 1);
    expect(draft?.draft.reason).toContain("回归审校未通过");
    expect(draft?.draft.reason).toContain("伏笔");
  });

  it("修复导致新时间线冲突时拒绝写回", async () => {
    const original = "陈玉华在省城超市收银台旁接电话。";
    const problem = criticalIssue("时间线", original);
    const slug = await projectWithWrittenChapter("回归时间线", original, [problem]);
    const stored = await chapterContent(slug);
    agentState.scripted = true;
    agentState.auditSteps = [
      { critical: [{ type: problem.type, evidence: problem.evidence }] },
      { critical: [] },
    ];
    agentState.scriptedRegression = true;
    agentState.regressionSteps = [
      {
        critical: [
          {
            type: "时间线",
            evidence: "修复后陈玉华同时出现在省城和阴巷。",
            detail: "与第 4 章时间线冲突。",
          },
        ],
      },
    ];

    const finished = await runBodyRepair(slug);
    expect(finished.status, finished.error).toBe("done");

    const detail = await store.getProjectDetail(slug);
    expect(detail.chapters.find((item) => item.index === 1)?.content).toBe(stored);
    const draft = await store.getRejectedDraftContent(slug, 1);
    expect(draft?.draft.reason).toContain("REJECTED_FACT_CONFLICT");
  });

  it("回归审校服务失败时不覆盖原文并暂停", async () => {
    const original = "陈玉华在省城超市收银台旁接电话。";
    const problem = criticalIssue("时间线", original);
    const slug = await projectWithWrittenChapter("回归审校失败", original, [problem]);
    const stored = await chapterContent(slug);
    agentState.scripted = true;
    agentState.auditSteps = [
      { critical: [{ type: problem.type, evidence: problem.evidence }] },
      { critical: [] },
    ];
    agentState.scriptedRegression = true;
    agentState.regressionSteps = [];

    const finished = await runBodyRepair(slug);
    expect(finished.status, finished.error).toBe("paused");

    const detail = await store.getProjectDetail(slug);
    expect(detail.chapters.find((item) => item.index === 1)?.content).toBe(stored);
    const draft = await store.getRejectedDraftContent(slug, 1);
    expect(draft?.draft.reason).toContain("回归审校失败");
  });

  it("基线审校期间暂停后不再调用修复 Agent，原文不变", async () => {
    const original = "陈玉华在省城超市收银台旁接电话。";
    const problem = criticalIssue("时间线", original);
    const slug = await projectWithWrittenChapter("正文修复暂停", original, [problem]);
    const stored = await chapterContent(slug);
    agentState.scripted = true;
    agentState.auditSteps = [
      { critical: [{ type: problem.type, evidence: problem.evidence }] },
    ];
    let running: Job | undefined;
    agentState.onAudit = () => {
      if (running) jobs.requestPause(running.id, slug);
    };

    const job = await pipeline.startJob(slug, "repair", {
      indices: [1],
      source: "review",
    });
    running = job;
    const finished = await waitForJob(job.id);

    expect(finished.status, finished.error).toBe("paused");
    expect(agentState.repairCalls).toBe(0);
    const detail = await store.getProjectDetail(slug);
    expect(detail.chapters.find((item) => item.index === 1)?.content).toBe(stored);
  });

  it("候选稿事实抽取失败时不覆盖原文", async () => {
    const original = "陈玉华在省城超市收银台旁接电话。";
    const problem = criticalIssue("时间线", original);
    const slug = await projectWithWrittenChapter("正文修复抽取失败", original, [problem]);
    const stored = await chapterContent(slug);
    agentState.scripted = true;
    agentState.auditSteps = [
      { critical: [{ type: problem.type, evidence: problem.evidence }] },
      { critical: [] },
    ];

    // 第 1 次抽取用于基线；从第 2 次（候选稿）开始失败。
    agentState.failExtractionAfter = 1;

    const finished = await runBodyRepair(slug);

    expect(finished.status, finished.error).toBe("paused");
    const detail = await store.getProjectDetail(slug);
    expect(detail.chapters.find((item) => item.index === 1)?.content).toBe(stored);
    const draft = await store.getRejectedDraftContent(slug, 1);
    expect(draft?.draft.reason).toContain("事实抽取失败");
  });
});
