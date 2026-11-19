import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContinuityIssue, Job, ReviewResult } from "@/lib/types";

interface AuditStep {
  critical: { type: string; evidence: string; detail?: string }[];
}

const agentState = vi.hoisted(() => ({
  failExtraction: false,
  failAudit: false,
  auditError: "模拟审校不可用",
  scripted: false,
  auditSteps: [] as AuditStep[],
  auditCalls: 0,
  repairCalls: 0,
  repairIssues: [] as ContinuityIssue[][],
  repairFeedback: [] as string[],
  onAudit: null as (() => void | Promise<void>) | null,
  onRepair: null as (() => void | Promise<void>) | null,
  crossEdit: null as
    | { chapterIndex: number; originalText: string; replacement: string }
    | null,
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
      agentState.auditCalls += 1;
      // 给测试留出在模型调用“进行中”发起暂停/取消的窗口。
      if (agentState.onAudit) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        await agentState.onAudit();
      }
      if (agentState.failAudit) throw new Error(agentState.auditError);
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
    repairChapterPatches: async (
      ...args: Parameters<typeof actual.repairChapterPatches>
    ) => {
      if (agentState.onRepair) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        await agentState.onRepair();
      }
      if (!agentState.scripted) return actual.repairChapterPatches(...args);
      agentState.repairCalls += 1;
      const issues = args[3];
      const text = args[2];
      agentState.repairIssues.push(issues);
      agentState.repairFeedback.push(args[8] ?? "");
      const anchorOf = (evidence: string): string => {
        const trimmed = evidence.trim();
        const count = (value: string): number => text.split(value).length - 1;
        if (trimmed && count(trimmed) === 1) return trimmed;
        const withoutTail = trimmed.replace(/[。！？；,.!?;\s]+$/u, "");
        if (withoutTail && count(withoutTail) === 1) return withoutTail;
        const head = withoutTail.slice(0, 8);
        return (
          text.split("\n").find((line) => head && line.includes(head)) ??
          text.split("\n")[0]
        );
      };
      return {
        patches: issues.map((issue, index) => {
          const anchor = anchorOf(issue.evidence);
          const edits: {
            originalText: string;
            replacement: string;
            reason: string;
            chapterIndex?: number;
          }[] = [
            {
              originalText: anchor,
              replacement: `${anchor}【修复${agentState.repairCalls}】`,
              reason: "测试修复",
            },
          ];
          if (index === 0 && agentState.crossEdit) {
            edits.push({ ...agentState.crossEdit, reason: "跨章根因修复" });
          }
          return {
            issueId: issue.id ?? `issue-${index + 1}`,
            edits,
          };
        }),
        planText: "",
        regressionScope: "",
        causalBaselines: [],
      };
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
  agentState.failAudit = false;
  agentState.auditError = "模拟审校不可用";
  agentState.scripted = false;
  agentState.auditSteps = [];
  agentState.auditCalls = 0;
  agentState.repairCalls = 0;
  agentState.repairIssues = [];
  agentState.repairFeedback = [];
  agentState.onAudit = null;
  agentState.onRepair = null;
  agentState.crossEdit = null;
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

function criticalIssue(
  type: string,
  evidence: string,
  detail = "与第 4 章事实台账冲突。",
): ContinuityIssue {
  return { severity: "critical", type, evidence, detail };
}

function reviewWith(issues: ContinuityIssue[], summary = "草稿摘要"): ReviewResult {
  return {
    summary,
    issues,
    continuityOk: false,
    extractionOk: true,
  };
}

async function saveDraft(
  slug: string,
  mode: "write" | "rewrite",
  content: string,
  options: {
    index?: number;
    review?: ReviewResult;
    reason?: string;
  } = {},
): Promise<void> {
  await store.saveRejectedDraft(slug, {
    index: options.index ?? 1,
    content,
    mode,
    reason: options.reason ?? "连续性检查未通过",
    review:
      options.review ??
      reviewWith([criticalIssue("人物生死状态", "已死角色仍然开口说话")]),
  });
}

function setAuditScript(steps: AuditStep[]): void {
  agentState.scripted = true;
  agentState.auditSteps = steps;
}

function draftFilePath(slug: string, storedPath: string): string {
  return path.join(
    dataDir,
    "projects",
    slug,
    "drafts",
    path.basename(storedPath),
  );
}

async function runDraftRepair(slug: string, index = 1): Promise<Job> {
  const job = await pipeline.startJob(slug, "repair", {
    indices: [index],
    source: "draft",
  });
  return waitForJob(job.id);
}

describe("未采用草稿修复", () => {
  it("修复通过后自动写入正文并清除草稿", async () => {
    const slug = await projectWithPlan("草稿采用");
    await saveDraft(slug, "write", "这是待采用的草稿正文。");

    const finished = await runDraftRepair(slug);
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
    const finished = await runDraftRepair(slug);
    expect(finished.status, finished.error).toBe("done");

    const draftsDir = path.join(dataDir, "projects", slug, "drafts");
    const files = await readdir(draftsDir);
    expect(files.some((name) => name.startsWith("1-before-repair-"))).toBe(true);
    expect(
      finished.logs.some((line) => line.message.includes("原正文备份在")),
    ).toBe(true);
  });

  it("修复后仍不通过时保留原正文并标记人工处理", async () => {
    const slug = await projectWithPlan("草稿修复失败");
    await saveDraft(slug, "write", "仍然有问题的草稿正文。");
    agentState.failExtraction = true;

    const finished = await runDraftRepair(slug);
    expect(finished.status).toBe("done");
    expect(finished.result).toContain("1 份仍需处理");

    const detail = await store.getProjectDetail(slug);
    const chapter = detail.chapters.find((item) => item.index === 1);
    expect(chapter?.written).toBeFalsy();
    expect(detail.canon.lastChapter).toBe(0);
    const updated = detail.state.rejectedDrafts[String(1)];
    expect(updated).toBeTruthy();
    expect(updated.review.extractionOk).toBe(false);
    expect(updated.reason).toContain("需要人工处理");
    expect(
      finished.logs.some((line) => line.message.includes("原正文未改动")),
    ).toBe(true);
  });

  it("严重问题没有减少但也没有增加时保留候选稿继续修复", async () => {
    const slug = await projectWithPlan("同数继续修复");
    const content = "角色甲在车站等车，随后上车。";
    const issue = criticalIssue("时间线", content);
    await saveDraft(slug, "write", content, { review: reviewWith([issue]) });
    setAuditScript([
      { critical: [{ type: issue.type, evidence: issue.evidence }] },
      { critical: [{ type: issue.type, evidence: issue.evidence }] },
    ]);

    const finished = await runDraftRepair(slug);
    expect(finished.status, finished.error).toBe("done");
    expect(agentState.repairCalls).toBe(2);
    expect(agentState.auditCalls).toBe(2);
    expect(
      finished.logs.some((line) => line.message.includes("没有增加严重问题")),
    ).toBe(true);

    const saved = await store.getRejectedDraftContent(slug, 1);
    expect(saved?.content).toContain("【修复1】");
    expect(saved?.content).not.toContain("【修复2】");
    expect(saved?.draft.reason).toContain("需要人工处理");
    const detail = await store.getProjectDetail(slug);
    expect(detail.chapters.find((item) => item.index === 1)?.written).toBeFalsy();
  });

  it("修复后严重问题增加时拒绝新版本", async () => {
    const slug = await projectWithPlan("问题增加拒绝");
    const content = "角色乙在外地超市收银台旁接电话，随后关机。";
    const issue = criticalIssue("时间线", content);
    await saveDraft(slug, "write", content, { review: reviewWith([issue]) });
    setAuditScript([
      {
        critical: [
          { type: issue.type, evidence: issue.evidence },
          { type: "剧情因果", evidence: "角色甲突然出现在石室。", detail: "新增问题。" },
        ],
      },
    ]);

    const finished = await runDraftRepair(slug);
    expect(finished.status, finished.error).toBe("done");
    expect(agentState.repairCalls).toBe(1);

    const saved = await store.getRejectedDraftContent(slug, 1);
    expect(saved?.content.trim()).toBe(content);
    expect(saved?.draft.reason).toContain("新增 1");
    expect(saved?.draft.reason).toContain("需要人工处理");
  });

  it("严重问题数量没有减少时继续修复，下一轮解决后采用", async () => {
    const slug = await projectWithPlan("同数新问题继续");
    const content = "角色甲在车站等车，随后上车。角色乙在办公室里接电话。";
    const first = criticalIssue("时间线", "角色甲在车站等车。");
    const second = criticalIssue("人物行为", "角色乙在办公室里接电话。");
    await saveDraft(slug, "write", content, {
      review: reviewWith([first, second]),
    });
    setAuditScript([
      {
        critical: [
          { type: "剧情因果", evidence: "随后上车。" },
          { type: "世界观规则", evidence: "角色乙在办公室里接电话。" },
        ],
      },
      { critical: [] },
    ]);

    const finished = await runDraftRepair(slug);
    expect(finished.status, finished.error).toBe("done");
    expect(agentState.repairCalls).toBe(2);
    expect(agentState.auditCalls).toBe(2);

    const detail = await store.getProjectDetail(slug);
    const chapter = detail.chapters.find((item) => item.index === 1);
    expect(chapter?.written).toBe(true);
    expect(chapter?.content).toContain("【修复2】");
    expect(detail.state.rejectedDrafts[String(1)]).toBeUndefined();
  });

  it("严重问题严格减少且没有新增时采用修复稿", async () => {
    const slug = await projectWithPlan("严格减少采用");
    const content = "角色乙在外地超市收银台旁接电话，随后关机。";
    const issue = criticalIssue("时间线", content);
    await saveDraft(slug, "write", content, { review: reviewWith([issue]) });
    setAuditScript([{ critical: [] }]);

    const finished = await runDraftRepair(slug);
    expect(finished.status, finished.error).toBe("done");
    expect(agentState.repairCalls).toBe(1);
    expect(agentState.auditCalls).toBe(1);

    const detail = await store.getProjectDetail(slug);
    const chapter = detail.chapters.find((item) => item.index === 1);
    expect(chapter?.written).toBe(true);
    expect(chapter?.content).toContain("【修复1】");
    expect(detail.state.rejectedDrafts[String(1)]).toBeUndefined();
  });

  it("最多两轮，第二轮只接收最新仍未解决的问题", async () => {
    const slug = await projectWithPlan("两轮上限");
    const textA = "角色乙在外地超市收银台旁接电话。";
    const textB = "角色丙说角色乙早到了半天。";
    const textC = "角色甲把角色丁的因果转嫁给角色丙。";
    const content = `${textA}${textB}${textC}`;
    const issues = [
      criticalIssue("时间线", textA),
      criticalIssue("人物行为", textB),
      criticalIssue("世界观规则", textC),
    ];
    await saveDraft(slug, "write", content, { review: reviewWith(issues) });
    setAuditScript([
      {
        critical: [
          { type: issues[0].type, evidence: issues[0].evidence },
          { type: issues[1].type, evidence: issues[1].evidence },
        ],
      },
      { critical: [] },
    ]);

    const finished = await runDraftRepair(slug);
    expect(finished.status, finished.error).toBe("done");
    expect(agentState.repairCalls).toBe(2);
    expect(agentState.auditCalls).toBe(2);

    expect(agentState.repairIssues[0].map((item) => item.type)).toEqual([
      "时间线",
      "人物行为",
      "世界观规则",
    ]);
    expect(agentState.repairIssues[1].map((item) => item.type)).toEqual([
      "时间线",
      "人物行为",
    ]);
    expect(
      agentState.repairIssues[1].some((item) => item.evidence === textC),
    ).toBe(false);
    expect(agentState.repairFeedback).toEqual(["", ""]);

    const detail = await store.getProjectDetail(slug);
    const chapter = detail.chapters.find((item) => item.index === 1);
    expect(chapter?.written).toBe(true);
    expect(chapter?.content).toContain("【修复2】");
  });

  it("两轮后仍失败时保留第一轮最佳版本并标记人工处理", async () => {
    const slug = await projectWithPlan("两轮失败最佳版");
    const textA = "角色乙在外地超市收银台旁接电话。";
    const textB = "角色丙说角色乙早到了半天。";
    const content = `${textA}${textB}`;
    const first = criticalIssue("时间线", textA);
    const second = criticalIssue("人物行为", textB);
    await saveDraft(slug, "write", content, {
      review: reviewWith([first, second]),
    });
    setAuditScript([
      { critical: [{ type: first.type, evidence: first.evidence }] },
      { critical: [{ type: first.type, evidence: first.evidence }] },
    ]);

    const finished = await runDraftRepair(slug);
    expect(finished.status, finished.error).toBe("done");
    expect(agentState.repairCalls).toBe(2);

    const saved = await store.getRejectedDraftContent(slug, 1);
    expect(saved?.content).toContain("【修复1】");
    expect(saved?.content).not.toContain("【修复2】");
    expect(saved?.draft.reason).toContain("2→1");
    expect(saved?.draft.reason).toContain("需要人工处理");
    const detail = await store.getProjectDetail(slug);
    expect(detail.chapters.find((item) => item.index === 1)?.written).toBeFalsy();
  });

  it("修复后事实抽取失败时不采用未验证文本", async () => {
    const slug = await projectWithPlan("修复后抽取失败");
    const content = "角色乙在外地超市收银台旁接电话，随后关机。";
    const issue = criticalIssue("时间线", content);
    await saveDraft(slug, "write", content, { review: reviewWith([issue]) });
    setAuditScript([{ critical: [] }]);
    agentState.failExtraction = true;

    const finished = await runDraftRepair(slug);
    expect(finished.status, finished.error).toBe("done");
    expect(agentState.repairCalls).toBe(1);
    expect(agentState.auditCalls).toBe(0);

    const saved = await store.getRejectedDraftContent(slug, 1);
    expect(saved?.content.trim()).toBe(content);
    expect(saved?.content).not.toContain("【修复");
    expect(saved?.draft.review.extractionOk).toBe(false);
    expect(saved?.draft.reason).toContain("事实抽取失败");
    const detail = await store.getProjectDetail(slug);
    expect(detail.chapters.find((item) => item.index === 1)?.written).toBeFalsy();
  });

  it("旧格式草稿缺少审校字段时安全回退到重新审校", async () => {
    const slug = await projectWithPlan("旧格式草稿");
    const content = "旧格式草稿正文。";
    await saveDraft(slug, "write", content, {
      review: {
        summary: "旧格式",
        issues: [],
        continuityOk: false,
      } as ReviewResult,
    });
    setAuditScript([{ critical: [] }]);

    const finished = await runDraftRepair(slug);
    expect(finished.status, finished.error).toBe("done");
    expect(agentState.repairCalls).toBe(0);
    expect(agentState.auditCalls).toBe(1);

    const detail = await store.getProjectDetail(slug);
    const chapter = detail.chapters.find((item) => item.index === 1);
    expect(chapter?.written).toBe(true);
    expect(chapter?.content).toContain("旧格式草稿正文");
  });

  it("多草稿中一份失败不会影响另一份采用和其他章节", async () => {
    const slug = await projectWithPlan("多草稿隔离");
    const textA = "角色乙在外地超市收银台旁接电话。";
    const textB = "角色丙说角色乙早到了半天。";
    await saveDraft(slug, "write", textA, {
      index: 1,
      review: reviewWith([criticalIssue("时间线", textA)]),
    });
    await saveDraft(slug, "write", textB, {
      index: 2,
      review: reviewWith([criticalIssue("人物行为", textB)]),
    });
    setAuditScript([
      { critical: [{ type: "时间线", evidence: textA }] },
      { critical: [{ type: "时间线", evidence: textA }] },
      { critical: [] },
    ]);

    const job = await pipeline.startJob(slug, "repair", {
      indices: [1, 2],
      source: "draft",
    });
    const finished = await waitForJob(job.id);
    expect(finished.status, finished.error).toBe("done");
    expect(agentState.repairCalls).toBe(3);

    const detail = await store.getProjectDetail(slug);
    expect(detail.chapters.find((item) => item.index === 1)?.written).toBeFalsy();
    expect(detail.chapters.find((item) => item.index === 2)?.written).toBe(true);
    expect(detail.chapters.find((item) => item.index === 3)?.written).toBeFalsy();
    expect(detail.state.rejectedDrafts[String(1)]).toBeTruthy();
    expect(detail.state.rejectedDrafts[String(2)]).toBeUndefined();
  });

  it("原始草稿文件始终保留，不会被修复结果覆盖", async () => {
    const slug = await projectWithPlan("原始草稿保留");
    const content = "角色乙在外地超市收银台旁接电话，随后关机。";
    const issue = criticalIssue("时间线", content);
    await saveDraft(slug, "write", content, { review: reviewWith([issue]) });
    const before = await store.getRejectedDraftContent(slug, 1);
    expect(before).toBeTruthy();
    setAuditScript([
      { critical: [{ type: issue.type, evidence: issue.evidence }] },
      { critical: [{ type: issue.type, evidence: issue.evidence }] },
    ]);

    const finished = await runDraftRepair(slug);
    expect(finished.status, finished.error).toBe("done");

    const originalFile = await readFile(
      draftFilePath(slug, before!.draft.path),
      "utf8",
    );
    expect(originalFile.trim()).toBe(content);
    const after = await store.getRejectedDraftContent(slug, 1);
    expect(after?.draft.path).not.toBe(before!.draft.path);
  });

  it("草稿文件缺失时任务报错且不写正文", async () => {
    const slug = await projectWithPlan("草稿缺失");
    await saveDraft(slug, "write", "临时草稿");
    const draftsDir = path.join(dataDir, "projects", slug, "drafts");
    for (const name of await readdir(draftsDir)) {
      await rm(path.join(draftsDir, name), { force: true });
    }

    const finished = await runDraftRepair(slug);
    expect(finished.status).toBe("error");
    expect(finished.error).toContain("草稿");

    const detail = await store.getProjectDetail(slug);
    expect(detail.chapters.find((item) => item.index === 1)?.written).toBeFalsy();
  });

  it("审校服务失败时不调用修复 Agent，并保留原草稿", async () => {
    const slug = await projectWithPlan("审校失败不修复");
    const content = "角色乙在外地超市收银台旁接电话。";
    await saveDraft(slug, "write", content);
    agentState.failAudit = true;

    const finished = await runDraftRepair(slug);
    expect(finished.status, finished.error).toBe("done");
    expect(agentState.repairCalls).toBe(0);
    expect(agentState.auditCalls).toBe(1);

    const saved = await store.getRejectedDraftContent(slug, 1);
    expect(saved?.content.trim()).toBe(content);
    expect(saved?.draft.reason).toContain("连续性审校失败");
    expect(saved?.draft.reason).toContain("需要人工处理");
    expect(
      finished.logs.some((line) => line.message.includes("未调用修复 Agent")),
    ).toBe(true);
    expect(
      finished.logs.some((line) => line.message.includes("audit-failed")),
    ).toBe(true);
    expect(finished.result).toContain("1 份仍需处理");

    const detail = await store.getProjectDetail(slug);
    expect(detail.chapters.find((item) => item.index === 1)?.written).toBeFalsy();
  });

  it("审校结果无法解析时按审校失败处理", async () => {
    const slug = await projectWithPlan("审校解析失败");
    const content = "角色乙在外地超市收银台旁接电话。";
    await saveDraft(slug, "write", content);
    agentState.failAudit = true;
    agentState.auditError = "审校结果不是合法 JSON";

    const finished = await runDraftRepair(slug);
    expect(finished.status, finished.error).toBe("done");
    expect(agentState.repairCalls).toBe(0);
    expect(
      finished.logs.some((line) => line.message.includes("不是合法 JSON")),
    ).toBe(true);

    const saved = await store.getRejectedDraftContent(slug, 1);
    expect(saved?.content.trim()).toBe(content);
    expect(saved?.draft.reason).toContain("连续性审校失败");
  });

  it("首次审校期间暂停后不再调用修复 Agent", async () => {
    const slug = await projectWithPlan("首次审校暂停");
    const content = "角色乙在外地超市收银台旁接电话。";
    await saveDraft(slug, "write", content);
    setAuditScript([{ critical: [] }]);
    let running: Job | undefined;
    agentState.onAudit = () => {
      if (running) jobs.requestPause(running.id, slug);
    };

    const job = await pipeline.startJob(slug, "repair", {
      indices: [1],
      source: "draft",
    });
    running = job;
    const finished = await waitForJob(job.id);

    expect(finished.status, finished.error).toBe("paused");
    expect(agentState.auditCalls).toBe(1);
    expect(agentState.repairCalls).toBe(0);
    expect(
      finished.logs.some((line) => line.message.includes("草稿修复已暂停")),
    ).toBe(true);

    const saved = await store.getRejectedDraftContent(slug, 1);
    expect(saved?.content.trim()).toBe(content);
    const detail = await store.getProjectDetail(slug);
    expect(detail.chapters.find((item) => item.index === 1)?.written).toBeFalsy();
  });

  it("修复期间暂停后不再进入下一轮审校或修复", async () => {
    const slug = await projectWithPlan("修复期间暂停");
    const content = "角色乙在外地超市收银台旁接电话。";
    await saveDraft(slug, "write", content);
    setAuditScript([
      { critical: [{ type: "时间线", evidence: content }] },
    ]);
    let running: Job | undefined;
    agentState.onRepair = () => {
      if (running) jobs.requestPause(running.id, slug);
    };

    const job = await pipeline.startJob(slug, "repair", {
      indices: [1],
      source: "draft",
    });
    running = job;
    const finished = await waitForJob(job.id);

    expect(finished.status, finished.error).toBe("paused");
    expect(agentState.auditCalls).toBe(1);
    expect(agentState.repairCalls).toBe(1);

    const saved = await store.getRejectedDraftContent(slug, 1);
    expect(saved?.content.trim()).toBe(content);
    expect(saved?.content).not.toContain("【修复");
  });

  it("第二轮审校期间暂停后不再发起后续模型调用", async () => {
    const slug = await projectWithPlan("第二轮审校暂停");
    const content = "角色乙在外地超市收银台旁接电话。";
    await saveDraft(slug, "write", content);
    setAuditScript([
      { critical: [{ type: "时间线", evidence: content }] },
      { critical: [{ type: "时间线", evidence: content }] },
    ]);
    let running: Job | undefined;
    agentState.onAudit = () => {
      if (running && agentState.auditCalls >= 2) {
        jobs.requestPause(running.id, slug);
      }
    };

    const job = await pipeline.startJob(slug, "repair", {
      indices: [1],
      source: "draft",
    });
    running = job;
    const finished = await waitForJob(job.id);

    expect(finished.status, finished.error).toBe("paused");
    expect(agentState.auditCalls).toBe(2);
    expect(agentState.repairCalls).toBe(1);
  });

  it("作者确认跨章方案后同时修复第 4 章和第 5 章草稿", async () => {
    const created = await store.createProject({ title: "跨章决策", targetChapters: 5 });
    const slug = created.meta.slug;
    const planJob = await pipeline.startJob(slug, "plan");
    expect((await waitForJob(planJob.id)).status).toBe("done");

    const ch4text = "第4章：角色乙在外地超市收银台旁接电话，背景有收银机声音。";
    const detail0 = await store.getProjectDetail(slug);
    const ch4plan = detail0.plan.chapters.find((item) => item.index === 4);
    expect(ch4plan).toBeTruthy();
    await store.writeChapterFile(slug, 4, ch4text, {
      source: "user",
      title: ch4plan!.title,
      summary: "第4章摘要",
    });
    await store.markChapterWritten(slug, 4, "第4章摘要", reviewWith([]));

    const draftText = "第5章草稿：角色丙说角色乙上午已被带到巷口。";
    const issue = criticalIssue(
      "时间线",
      "角色丙说角色乙上午已被带到巷口。",
      "与第 4 章下午电话冲突。",
    );
    await saveDraft(slug, "write", draftText, {
      index: 5,
      review: reviewWith([issue]),
    });

    const decisions = await import("@/lib/repair-decision");
    const decision = await decisions.createRepairDecision({
      slug,
      chapterIndex: 5,
      source: "draft",
      params: { indices: [5], source: "draft" },
      jobId: "test",
      reason: "电话真相存在互斥路径",
      issues: [issue],
      options: [
        {
          label: "B 保留上午被擒，改第 4 章电话为伪造录音",
          description: "修改第 4 章电话来源，保留第 5 章时间线",
          affectedChapters: [4, 5],
          anchors: [ch4text],
        },
      ],
    });
    await decisions.confirmRepairDecision(slug, decision.id, 0);

    setAuditScript([{ critical: [] }, { critical: [] }, { critical: [] }]);
    agentState.crossEdit = {
      chapterIndex: 4,
      originalText: ch4text,
      replacement: "第4章：所谓电话其实是某组织伪造的录音。",
    };

    const job = await pipeline.startJob(slug, "repair", {
      indices: [5],
      source: "draft",
      decisionId: decision.id,
    });
    const finished = await waitForJob(job.id);
    expect(finished.status, finished.error).toBe("done");

    const detail = await store.getProjectDetail(slug);
    expect(detail.chapters.find((item) => item.index === 4)?.content).toContain(
      "伪造的录音",
    );
    const chapter5 = detail.chapters.find((item) => item.index === 5);
    expect(chapter5?.written).toBe(true);
    expect(chapter5?.content).toContain("【修复1】");
    expect(detail.state.rejectedDrafts["5"]).toBeUndefined();
  });

  it("取消任务后不再执行后续模型调用", async () => {
    const slug = await projectWithPlan("审校期间取消");
    const content = "角色乙在外地超市收银台旁接电话。";
    await saveDraft(slug, "write", content);
    setAuditScript([{ critical: [] }]);
    let running: Job | undefined;
    agentState.onAudit = () => {
      if (running) jobs.requestCancel(running.id, slug);
    };

    const job = await pipeline.startJob(slug, "repair", {
      indices: [1],
      source: "draft",
    });
    running = job;
    const finished = await waitForJob(job.id);

    expect(finished.status, finished.error).toBe("cancelled");
    expect(agentState.auditCalls).toBe(1);
    expect(agentState.repairCalls).toBe(0);

    const saved = await store.getRejectedDraftContent(slug, 1);
    expect(saved?.content.trim()).toBe(content);
  });
});
