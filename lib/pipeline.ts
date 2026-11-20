import {
  auditChapter,
  auditRepairRegression,
  confirmRepairRegressions,
  extendPlan,
  extractChapterFacts,
  generateCharacters,
  generatePlan,
  RepairNeedsAuthorDecisionError,
  RepairPlanRejectedError,
  repairChapter,
  repairChapterPatches,
  type RegressionAuditResult,
  type RepairDecisionOptionPlan,
  writeChapter,
} from "./agents";
import { parseAuditReport } from "./audit";
import {
  canonForChapter,
  countCritical,
  emptyCanon,
  groundExtractedFacts,
  isCanonEmpty,
  mergeCanon,
  mergeIssues,
  reconcileCanonWithChapters,
  validateCanon,
} from "./canon";
import { getRuntimeConfig } from "./config";
import {
  acquireProjectSlot,
  clearJobControl,
  flushJob,
  getJob,
  isPauseRequested,
  JOB_HEARTBEAT_MS,
  JOB_TIMEOUT_MS,
  JobCancelledError,
  logJob,
  releaseProjectSlot,
  throwIfCancelled,
  touchProjectLock,
} from "./jobs";
import {
  aggregateBook,
  aggregateVolumes,
  applyChapterMemory,
  buildChapterMemory,
  buildEffectiveMemory,
  buildMemoryContext,
} from "./memory";
import {
  emptyPlanLedger,
  formatPlanContext,
  mergePlanLedgers,
  reconcileChapterPlan,
} from "./plan-ledger";
import { promptVersionInfo } from "./prompt-store";
import { findPublishEntry } from "./publish-ledger";
import { loginFanqie, publishFanqie } from "./publishers/fanqie";
import { describeAcceptance, evaluateRepair } from "./repair-acceptance";
import type { CausalBaseline } from "./repair-causal";
import { compareCriticalIssues, filterSeedIssues } from "./repair-compare";
import type { IssueComparison } from "./repair-compare";
import { collectRepairEvidence } from "./repair-context";
import {
  buildRepairBaseline,
  compareToBaseline,
  groupIssuesByRootCause,
  summarizeConfirmations,
} from "./repair-iteration";
import {
  createRepairDecision,
  getRepairDecision,
  confirmRepairDecision,
} from "./repair-decision";
import {
  applyRepairPatchesAcross,
  describePatchBatch,
  hashText,
  RepairPatchError,
  withIssueIds,
  type AppliedChapterBatch,
  type AppliedPatchBatch,
  type PatchChapter,
} from "./repair-patch";
import { reviewSuspicions } from "./review";
import {
  applyChapterStory,
  buildEffectiveStory,
  buildStoryContext,
  storyChecks,
} from "./story";
import {
  appendChapters,
  appendPublishRecord,
  commitArchitecture,
  commitCanonRebuild,
  exportBookFile,
  getAuditReport,
  getMemory,
  getProjectDetail,
  getProjectFile,
  getPublishLedger,
  getRejectedDraftContent,
  getStory,
  getWrittenChapters,
  markChapterRepaired,
  markChapterWritten,
  recordPublishOutcome,
  saveCanon,
  saveMemory,
  savePlanLedger,
  saveStory,
  saveRejectedDraft,
  saveRepairBackup,
  writeAuditReport,
  writeChapterFile,
} from "./store";
import { countWords, errorMessage, nowIso } from "./utils";
import type {
  CanonFacts,
  ChapterMemory,
  ChapterPlan,
  Character,
  ContinuityIssue,
  ExtractedFacts,
  ExtractedStory,
  Job,
  JobParams,
  ProjectDetail,
  ProjectMemory,
  ProjectMeta,
  ReviewResult,
  StoryLedger,
} from "./types";

const JOB_LABELS: Record<Job["type"], string> = {
  plan: "生成架构与角色",
  extend: "补充章节大纲",
  write: "自动写作",
  rewrite: "重写章节",
  repair: "定点修复",
  recanon: "重建事实台账",
  memory: "重建长期记忆与剧情台账",
  audit: "总体审校",
  export: "导出全书",
  "fanqie-login": "登录番茄",
  "fanqie-publish": "发布到番茄",
};

export async function startJob(
  slug: string,
  type: Job["type"],
  params: JobParams = {},
): Promise<Job> {
  await getProjectFile(slug);
  // 锁与任务创建必须同步完成；中间不能再有 await，否则两个请求都能通过检查。
  const job = acquireProjectSlot(slug, type, params);
  // 任务在后台自行推进，HTTP 只返回 job 快照；前端靠 /api/jobs/[id] 轮询日志。
  // 这里刻意不 await，否则长任务会一直占住请求。
  void runJob(job, params);
  return job;
}

export async function retryJob(slug: string, id: string): Promise<Job> {
  const job = getJob(id);
  if (!job || job.slug !== slug) {
    throw new Error("任务不存在或不属于当前项目");
  }
  if (
    job.status !== "error" &&
    job.status !== "cancelled" &&
    job.status !== "interrupted" &&
    job.status !== "paused"
  ) {
    throw new Error("只有失败、取消、中断或暂停的任务可以重试");
  }
  return startJob(slug, job.type, job.params);
}

function formatDuration(ms: number): string {
  if (ms >= 60000) return `${Math.round(ms / 60000)} 分钟`;
  return `${Math.max(1, Math.round(ms / 1000))} 秒`;
}

const EXTRACTION_MAX_ATTEMPTS = 3;
const EXTRACTION_RETRY_DELAY_MS = 400;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 事实抽取是审校的前置条件：模型偶发返回非法 JSON 时重试，
// 连续失败必须让本章失败，不能用空台账继续审校。
async function extractFactsWithRetry(
  job: Job,
  meta: ProjectMeta,
  bible: string,
  chapter: ChapterPlan,
  text: string,
  canon: CanonFacts,
): Promise<{ facts: ExtractedFacts; attempts: number }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= EXTRACTION_MAX_ATTEMPTS; attempt += 1) {
    throwIfCancelled(job);
    try {
      const raw = await extractChapterFacts(meta, bible, chapter, text, canon);
      return { facts: groundExtractedFacts(raw, text), attempts: attempt };
    } catch (error) {
      lastError = error;
      logJob(
        job,
        `第 ${chapter.index} 章事实抽取失败（第 ${attempt}/${EXTRACTION_MAX_ATTEMPTS} 次）：${errorMessage(error)}`,
      );
      if (attempt < EXTRACTION_MAX_ATTEMPTS) {
        await delay(EXTRACTION_RETRY_DELAY_MS * attempt);
      }
    }
  }
  throw new Error(
    `事实抽取连续 ${EXTRACTION_MAX_ATTEMPTS} 次失败：${errorMessage(lastError)}`,
  );
}

async function runJob(job: Job, params: JobParams): Promise<void> {
  job.status = "running";
  job.startedAt = nowIso();
  job.updatedAt = job.startedAt;
  await flushJob(job);
  logJob(job, `任务开始：${JOB_LABELS[job.type]}`);

  const runtime = getRuntimeConfig();
  if (runtime.provider === "mock") {
    logJob(job, "当前为 mock 模式，将生成示例内容；可在「模型设置」页填写 API Key 接入真实模型。");
  }

  // 任务级超时：到点后设置取消标志，各章节循环在下一个检查点停止。
  // 这样不会在模型调用进行中强行丢弃线程，避免写入半成品。
  const timeoutTimer = setTimeout(() => {
    if (job.status !== "running" || job.cancelRequested) return;
    job.cancelRequested = true;
    job.cancelReason = "timeout";
    logJob(
      job,
      `任务运行超过 ${formatDuration(JOB_TIMEOUT_MS)}，准备停止；已完成章节会保留。`,
    );
  }, JOB_TIMEOUT_MS);
  (timeoutTimer as unknown as { unref?: () => void }).unref?.();

  // 锁文件心跳：跨进程存活证明。进程崩溃后心跳停止，其他进程可回收锁。
  const heartbeatTimer = setInterval(() => {
    try {
      touchProjectLock(job.slug, job.id);
    } catch {
      // 心跳失败不应中断写作任务，下一次心跳会重试。
    }
  }, JOB_HEARTBEAT_MS);
  (heartbeatTimer as unknown as { unref?: () => void }).unref?.();

  try {
    throwIfCancelled(job);
    let paused = false;
    switch (job.type) {
      case "plan":
        await runPlan(job);
        break;
      case "extend":
        await runExtend(job, params.count ?? 10);
        break;
      case "write":
        paused = await runWrite(job, params.count ?? 1);
        break;
      case "rewrite":
        paused = await runRewrite(
          job,
          params.indices ?? [],
          params.instruction ?? "",
          params.useReview === true,
        );
        break;
      case "repair":
        paused =
          params.source === "draft"
            ? await runDraftRepair(job, params.indices ?? [])
            : await runRepair(
                job,
                params.indices ?? [],
                params.source === "review" ? "review" : "audit",
              );
        break;
      case "recanon":
        await runRecanon(job);
        break;
      case "memory":
        await runMemoryRebuild(job);
        break;
      case "audit":
        await runAudit(job);
        break;
      case "export":
        await runExport(job);
        break;
      case "fanqie-login":
        await runFanqieLogin(job);
        break;
      case "fanqie-publish":
        await runFanqiePublish(job);
        break;
    }
    throwIfCancelled(job);
    if (paused) {
      job.status = "paused";
      logJob(job, "任务已暂停");
    } else {
      job.status = "done";
      logJob(job, "任务完成");
    }
  } catch (error) {
    // 后台任务是脱离请求执行的，异常必须先写回 job 对象；
    // 否则前端轮询只能看到任务停在 running，用户会误以为还在生成。
    if (error instanceof JobCancelledError) {
      job.status = error.reason === "timeout" ? "error" : "cancelled";
      job.error =
        error.reason === "timeout"
          ? `任务超时（超过 ${formatDuration(JOB_TIMEOUT_MS)}）`
          : "任务已取消";
      logJob(job, job.error);
    } else {
      job.status = "error";
      job.error = errorMessage(error);
      logJob(job, `任务失败：${job.error}`);
    }
  } finally {
    clearTimeout(timeoutTimer);
    clearInterval(heartbeatTimer);
    job.endedAt = nowIso();
    job.updatedAt = job.endedAt;
    // 任务进入任何终态（完成/失败/暂停/取消）都必须释放项目锁和控制文件。
    releaseProjectSlot(job.slug, job.id);
    clearJobControl(job.id);
    await flushJob(job);
  }
}

async function runPlan(job: Job): Promise<void> {
  const detail = await getProjectDetail(job.slug);
  // 只有完全没有正文、且台账仍是空壳时才建立初始基线，绝不覆盖已有事实。
  const seedCanon =
    detail.state.written.length === 0 && isCanonEmpty(detail.canon);
  logJob(job, "架构师正在分阶段构思世界观、主线、章节细纲与计划台账…");
  const generated = await generatePlan(detail.meta, {
    onProgress: (message) => logJob(job, message),
  });
  throwIfCancelled(job);
  logJob(
    job,
    `细纲已生成（${generated.plan.chapters.length} 章），正在创建人物档案；全部完成前不会写入任何文件…`,
  );

  const characters = await generateCharacters(detail.meta, generated, {
    onProgress: (message) => logJob(job, message),
  });
  throwIfCancelled(job);

  const committed = await commitArchitecture(
    job.slug,
    generated,
    characters,
    { seedCanon },
  );
  logJob(
    job,
    `计划台账已登记：${generated.planLedger?.events.length ?? 0} 个计划事件、${generated.planLedger?.foreshadows.length ?? 0} 条计划伏笔（均未视为已发生）。`,
  );
  job.result = `已生成 ${committed.plan.chapters.length} 章细纲、${committed.characters.length} 位角色`;
  logJob(
    job,
    `架构已统一提交：${committed.plan.chapters.length} 章细纲、${committed.characters.length} 位角色（更新 ${committed.updatedCharacters} 位，保留 ${committed.preservedCharacters} 位已有/手动人物卡）。`,
  );
  if (committed.seededCanon) {
    logJob(
      job,
      `已建立架构初始事实台账：${committed.characters.length} 位人物（状态未知，待正文确认）；物品、期限和规则将在正文抽取后补充。`,
    );
  }
  logJob(
    job,
    `角色：${committed.characters.map((item) => item.name).join("、")}；主线大纲已同步章节细纲。`,
  );
}

async function runExtend(job: Job, requested: number): Promise<void> {
  const count = Math.max(1, Math.min(50, Math.round(Number(requested) || 10)));
  const detail = await getProjectDetail(job.slug);

  if (!detail.plan.chapters.length) {
    throw new Error("还没有章节大纲，请先生成架构与角色");
  }

  // 新章节从现有最大序号往后接，不复用中间空缺，避免和已发布章节撞号。
  const startIndex = Math.max(...detail.plan.chapters.map((chapter) => chapter.index)) + 1;
  // 只带最近 6 章摘要进入续排提示词，既保证连贯性，又控制上下文长度。
  const summaries = Object.keys(detail.state.summaries)
    .map(Number)
    .sort((a, b) => a - b)
    .slice(-6)
    .map((index) => `第 ${index} 章：${detail.state.summaries[String(index)]}`);

  logJob(
    job,
    `现有 ${detail.plan.chapters.length} 章大纲，正在从第 ${startIndex} 章起补充 ${count} 章…`,
  );

  const [memory, storedStory] = await Promise.all([
    getMemory(job.slug),
    getStory(job.slug),
  ]);
  const story = buildEffectiveStory(detail, memory, storedStory);
  const lastPlanned = detail.plan.chapters[detail.plan.chapters.length - 1];
  const storyRetrieval = buildStoryContext(
    detail,
    {
      index: startIndex,
      title: "",
      summary: lastPlanned?.summary ?? "",
      keyBeats: lastPlanned?.keyBeats ?? [],
    },
    memory,
    story,
  );
  logJob(
    job,
    `续排上下文：事实台账 ${detail.canon.characters.length} 位人物 / ${detail.canon.items.length} 件物品，人物卡 ${detail.characters.length} 位，剧情台账 ${storyRetrieval.text.length} 字。`,
  );

  const extended = await extendPlan(
    detail.meta,
    detail.plan,
    detail.bible,
    detail.outlineMd,
    summaries,
    count,
    {
      canon: detail.canon,
      characters: detail.characters,
      storyContext: storyRetrieval.text,
    },
    { onProgress: (message) => logJob(job, message) },
  );
  throwIfCancelled(job);
  const chapters = extended.chapters;
  const nextLedger = mergePlanLedgers(
    detail.planLedger ?? emptyPlanLedger(detail.meta.updatedAt),
    extended.planLedger,
  );
  // 章节、主线大纲和计划台账在同一次提交里落盘。
  const plan = await appendChapters(job.slug, chapters, nextLedger);

  job.result = `新增 ${chapters.length} 章大纲`;
  logJob(
    job,
    `已补充 ${chapters.length} 章，当前大纲共 ${plan.chapters.length} 章，主线大纲已同步更新`,
  );
}

function assertCanonReady(detail: ProjectDetail): void {
  // 已有正文却没有台账（或台账落后于正文）时，写作/重写会失去事实约束。
  // 与其带着空台账硬写，不如要求先重建；mock 模式没有真实事实可抽，跳过。
  if (getRuntimeConfig().provider === "mock") return;
  const written = detail.chapters.filter(
    (chapter) => chapter.written && chapter.content.trim(),
  );
  if (!written.length) return;
  const latest = Math.max(...written.map((chapter) => chapter.index));
  if (detail.canon.lastChapter < latest) {
    throw new Error(
      `已有第 ${latest} 章正文，但事实台账只覆盖到第 ${detail.canon.lastChapter || "0"} 章。请先到「连续性」页点击「重建事实台账」，再开始写作或重写。`,
    );
  }
}

function markDetailChapterWritten(
  detail: ProjectDetail,
  index: number,
  content: string,
  summary: string,
): void {
  const chapter = detail.chapters.find((item) => item.index === index);
  if (chapter) {
    chapter.content = content;
    chapter.written = true;
    chapter.words = countWords(content);
  }
  if (!detail.state.written.includes(index)) {
    detail.state.written = [...detail.state.written, index].sort((a, b) => a - b);
  }
  detail.state.summaries[String(index)] = summary;
}

async function persistChapterMemory(
  job: Job,
  detail: ProjectDetail,
  stored: ProjectMemory,
  chapterMemory: ChapterMemory | undefined,
): Promise<ProjectMemory> {
  if (!chapterMemory) return stored;
  try {
    const next = applyChapterMemory(detail, stored, chapterMemory);
    await saveMemory(job.slug, next);
    logJob(
      job,
      `第 ${chapterMemory.index} 章长期记忆已更新：${chapterMemory.events.length} 个事件、${chapterMemory.characters.length} 位人物。`,
    );
    return next;
  } catch (error) {
    // 记忆是增强能力，失败不能回滚已经通过检查的正文和台账；旧记忆保持原样。
    logJob(
      job,
      `第 ${chapterMemory.index} 章长期记忆更新失败，已有记忆保持不变：${errorMessage(error)}`,
    );
    return stored;
  }
}

async function persistChapterStory(
  job: Job,
  detail: ProjectDetail,
  memory: ProjectMemory,
  stored: StoryLedger,
  chapterMemory: ChapterMemory | undefined,
  extracted: ExtractedStory | undefined,
): Promise<StoryLedger> {
  if (!chapterMemory) return stored;
  try {
    const next = applyChapterStory(
      detail,
      memory,
      stored,
      chapterMemory.index,
      extracted,
      chapterMemory,
    );
    await saveStory(job.slug, next);
    logJob(
      job,
      `第 ${chapterMemory.index} 章剧情台账已更新：${next.states.length} 条人物状态、${next.relations.length} 条关系、${next.events.length} 个事件、${next.foreshadows.length} 条伏笔。`,
    );
    const checks = storyChecks(detail, next);
    for (const issue of checks.slice(0, 3)) {
      logJob(job, `剧情台账${issue.severity === "critical" ? "严重提示" : "提示"}：${issue.message}`);
    }
    return next;
  } catch (error) {
    // 与长期记忆一致：增强数据保存失败不能回滚已通过检查的正文和事实台账。
    logJob(
      job,
      `第 ${chapterMemory.index} 章剧情台账更新失败，已有台账保持不变：${errorMessage(error)}`,
    );
    return stored;
  }
}

function logMemoryRetrieval(
  job: Job,
  chapterIndex: number,
  retrieval: ReturnType<typeof buildMemoryContext>,
): void {
  logJob(
    job,
    `第 ${chapterIndex} 章长期记忆检索：命中 ${retrieval.chapterIndices.length} 个历史章节、${
      retrieval.openForeshadows.length
    } 个未回收伏笔，约 ${retrieval.tokenEstimate} tokens${
      retrieval.truncated ? "（已按预算截断）" : ""
    }。`,
  );
}

function logStoryRetrieval(
  job: Job,
  chapterIndex: number,
  retrieval: ReturnType<typeof buildStoryContext>,
): void {
  logJob(
    job,
    `第 ${chapterIndex} 章剧情台账检索：命中 ${retrieval.chapterIndices.length} 个历史章节，约 ${retrieval.tokenEstimate} tokens${
      retrieval.truncated ? "（已按预算截断）" : ""
    }。`,
  );
}

function logPromptProfile(job: Job): void {
  const runtime = getRuntimeConfig();
  const writer = promptVersionInfo("writer");
  const auditor = promptVersionInfo("auditor");
  logJob(
    job,
    `提示词与模型：写作 ${writer.promptVersion}，审校 ${auditor.promptVersion}；模型 ${runtime.model}，温度 ${runtime.temperature}，单次最多 ${runtime.maxTokens} tokens。`,
  );
}

function clipRecord(value: string, size = 60): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact.length > size ? `${compact.slice(0, size)}…` : compact;
}

// 记录每一处补丁修改，方便事后审查；正文版本与备份仍保留完整差异。
function logPatchBatch(job: Job, index: number, batch: AppliedPatchBatch): void {
  logJob(job, `第 ${index} 章补丁校验通过：${describePatchBatch(batch)}。`);
  for (const record of batch.records) {
    logJob(
      job,
      `第 ${index} 章修改 [${record.issueId}] 第 ${record.paragraph + 1} 段：${clipRecord(
        record.removed,
      )} → ${clipRecord(record.added)}（${record.reason}）`,
    );
  }
}

// 问题明确引用、但当前没有正文可用于核对的此前章节：证据不足，不能自动改稿。
function missingReferencedChapters(
  detail: ProjectDetail,
  currentIndex: number,
  issues: ContinuityIssue[],
): number[] {
  const refs = new Set<number>();
  for (const issue of issues) {
    const text = `${issue.evidence}\n${issue.detail}\n${issue.sourceEvidence ?? ""}`;
    for (const match of text.matchAll(/第\s*(\d+)\s*章/gu)) {
      const parsed = Number.parseInt(match[1], 10);
      if (Number.isInteger(parsed) && parsed > 0) refs.add(parsed);
    }
    if (issue.sourceChapter) refs.add(issue.sourceChapter);
  }
  const written = new Set(
    detail.chapters
      .filter((chapter) => chapter.written && chapter.content.trim())
      .map((chapter) => chapter.index),
  );
  return [...refs]
    .filter((ref) => ref !== currentIndex && ref < currentIndex && !written.has(ref))
    .sort((a, b) => a - b);
}

function formatReviewFeedback(review: ReviewResult | undefined): string {
  const critical = (review?.issues ?? []).filter(
    (issue) => issue.severity === "critical",
  );
  if (!critical.length) return "";
  return critical
    .slice(0, 8)
    .map((issue, index) => {
      const evidence = issue.evidence.trim();
      return `${index + 1}. [${issue.type}] ${issue.detail}${evidence ? `\n   证据：${evidence}` : ""}`;
    })
    .join("\n");
}

interface VerifyChapterInput {
  job: Job;
  project: ProjectDetail;
  meta: ProjectMeta;
  bible: string;
  characters: Character[];
  chapter: ChapterPlan;
  text: string;
  canon: CanonFacts;
  memory: ProjectMemory;
  story: StoryLedger;
  previousEnding: string;
  previousSummaries: string[];
  nextOpening: string;
  nextSummary: string;
  mode: "write" | "rewrite";
  rewriteInstruction: string;
  reviewFeedback: string;
  // 定点修复需要“只审校不自动修”的基线检查时设为 0。
  maxRepairs?: number;
  // 候选稿审校时复用修复前检索到的原文证据。
  evidenceContext?: string;
}

interface VerifyChapterResult {
  text: string;
  review: ReviewResult;
  canon: CanonFacts;
  passed: boolean;
  // 审校服务失败不等于正文有问题：该标记用于阻止自动修复并保留最佳稿。
  auditFailed?: boolean;
  memory?: ChapterMemory;
  story?: ExtractedStory;
  // 本轮审校发现的既定事实冲突（死亡状态、物品归属、时间线、伏笔等）。
  factConflicts?: ContinuityIssue[];
  // Repair Agent 证据不足，要求作者决定。
  needsAuthorDecision?: boolean;
}

async function verifyChapter(input: VerifyChapterInput): Promise<VerifyChapterResult> {
  const previousContext = [
    input.previousEnding ? `上一章结尾：\n${input.previousEnding}` : "",
    ...input.previousSummaries.map((summary, index) => `前情摘要 ${index + 1}：${summary}`),
  ]
    .filter(Boolean)
    .join("\n\n");
  const nextContext = [
    input.nextOpening ? `下一章开头：\n${input.nextOpening}` : "",
    input.nextSummary ? `下一章摘要：${input.nextSummary}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  // 重写/修复旧章时，审校和修复只看截至本章的台账；后文事实只用于前后衔接。
  const auditCanon = canonForChapter(input.canon, input.chapter.index);
  const storyContext = buildStoryContext(
    input.project,
    input.chapter,
    input.memory,
    input.story,
  ).text;
  const previousChapters = input.project.chapters
    .filter(
      (chapter) =>
        chapter.index < input.chapter.index &&
        chapter.written &&
        chapter.content.trim(),
    )
    .sort((a, b) => b.index - a.index)
    .slice(0, 3);

  let currentText = input.text;
  let best: VerifyChapterResult | null = null;
  let needsAuthorDecision = false;
  let evidenceContext = input.evidenceContext ?? "";
  // 严重问题最多修三轮；只有 critical 会触发修复，warning 留给人工参考。
  const maxRepairs = Math.max(0, Math.min(3, input.maxRepairs ?? 3));

  // 每一轮都基于“本章写作前的事实台账”重新检查。
  // 不能把本章自己抽取到的事实先并进去，否则“吴副官复活”会被自己的抽取结果掩盖。
  for (let attempt = 0; attempt <= maxRepairs; attempt += 1) {
    throwIfCancelled(input.job);
    // 暂停只影响后续轮次：当前章节仍完成一次检查并写回，避免留下半成品。
    if (isPauseRequested(input.job) && attempt > 0) break;

    let extracted: ExtractedFacts;
    let extractionAttempts = 0;
    try {
      const extraction = await extractFactsWithRetry(
        input.job,
        input.meta,
        input.bible,
        input.chapter,
        currentText,
        auditCanon,
      );
      extracted = extraction.facts;
      extractionAttempts = extraction.attempts;
    } catch (error) {
      // 取消/超时由任务层处理，不能被误判成抽取失败。
      if (error instanceof JobCancelledError) throw error;
      const message = errorMessage(error);
      logJob(
        input.job,
        `第 ${input.chapter.index} 章事实抽取失败，本章不进入审校；草稿将保留，台账不更新。`,
      );
      return {
        text: currentText,
        review: {
          summary: input.chapter.summary,
          issues: [
            {
              severity: "critical",
              type: "事实抽取失败",
              evidence: "",
              detail: `事实抽取连续 ${EXTRACTION_MAX_ATTEMPTS} 次失败，本章未经完整事实检查，不能通过：${message}`,
            },
          ],
          continuityOk: false,
          repaired: attempt > 0,
          repairAttempts: attempt,
          extractionOk: false,
          extractionError: message,
          extractionAttempts: EXTRACTION_MAX_ATTEMPTS,
        },
        canon: input.canon,
        passed: false,
      };
    }

    const chapterMemory = buildChapterMemory(
      input.chapter.index,
      extracted.summary || input.chapter.summary,
      extracted,
      "ai",
    );
    const checks = reviewSuspicions({
      project: input.project,
      chapter: input.chapter,
      text: currentText,
      canon: auditCanon,
      memory: input.memory,
      story: input.story,
      previousEnding: input.previousEnding,
      previousChapters,
      extracted: extracted.story,
      chapterMemory,
    });

    let audit: ReviewResult;
    try {
      audit = await auditChapter(
        input.meta,
        auditCanon,
        input.project.characters,
        input.chapter,
        currentText,
        previousContext,
        checks.suspicions,
        nextContext,
        storyContext,
        evidenceContext,
      );
    } catch (error) {
      if (error instanceof JobCancelledError) throw error;
      // 审校服务失败不是正文问题：不得把“审校失败”传给 Repair Editor，
      // 只能保留原稿或此前已验证的最佳稿，等待人工重试。
      logJob(
        input.job,
        `第 ${input.chapter.index} 章连续性审校服务失败（不是正文问题），停止自动修复并保留${
          best ? "当前最佳稿" : "原稿"
        }等待重试：${errorMessage(error)}`,
      );
      if (best) return { ...best, auditFailed: true };
      return {
        text: currentText,
        review: {
          summary: extracted.summary || input.chapter.summary,
          issues: [
            {
              severity: "critical",
              type: "审校失败",
              evidence: "",
              detail: `连续性审校调用失败，本章未经检查：${errorMessage(error)}`,
            },
          ],
          continuityOk: false,
          repaired: attempt > 0,
          repairAttempts: attempt,
          extractionOk: true,
          extractionAttempts,
        },
        canon: input.canon,
        passed: false,
        auditFailed: true,
        story: undefined,
      };
    }

    // 取消/超时发生在模型调用期间时，先停在合并与写回之前，避免留下半成品。
    throwIfCancelled(input.job);

    // 冲突判定用截至本章的台账；持久化仍合并进完整台账，避免后文事实被覆盖或丢失。
    const merged = mergeCanon(
      auditCanon,
      extracted,
      input.chapter.index,
      input.mode,
    );
    const mergedFull =
      auditCanon === input.canon
        ? merged
        : mergeCanon(input.canon, extracted, input.chapter.index, input.mode);
    // 普通自动线索只作为审校提示；数据级严重矛盾（如伏笔先回收后埋设）强制保留。
    const issues = mergeIssues(audit.issues, merged.conflicts, checks.hardIssues);
    const factConflicts = mergeIssues(merged.conflicts, checks.hardIssues).filter(
      (issue) => issue.severity === "critical",
    );
    const critical = countCritical(issues);
    const review: ReviewResult = {
      summary: extracted.summary || audit.summary || input.chapter.summary,
      issues,
      continuityOk: critical === 0,
      repaired: attempt > 0,
      repairAttempts: attempt,
      extractionOk: true,
      extractionAttempts,
    };
    const memory = buildChapterMemory(
      input.chapter.index,
      review.summary,
      extracted,
      "ai",
    );

    // 修复失败时保留“严重问题最少”的一版，避免越修越乱；
    // 严重问题数打平时保留更晚的修复版本，否则后续修复会被全部丢弃。
    const bestCritical = best ? countCritical(best.review.issues) : Number.POSITIVE_INFINITY;
    const preferLater = best ? attempt > (best.review.repairAttempts ?? 0) : false;
    if (!best || critical < bestCritical || (critical === bestCritical && preferLater)) {
      best = {
        text: currentText,
        review,
        canon: review.continuityOk ? mergedFull.canon : input.canon,
        passed: review.continuityOk,
        memory,
        story: extracted.story,
        factConflicts,
      };
    }

    if (review.continuityOk) {
      if (attempt > 0) {
        logJob(input.job, `第 ${input.chapter.index} 章经 ${attempt} 轮定点修复后通过连续性检查`);
      }
      return best;
    }

    if (attempt >= maxRepairs) break;

    const blocking = issues.filter((issue) => issue.severity === "critical");
    logJob(
      input.job,
      `第 ${input.chapter.index} 章发现 ${critical} 个严重连续性问题，尝试定点修复（第 ${attempt + 1} 轮）…`,
    );
    evidenceContext = collectRepairEvidence({
      project: input.project,
      chapter: input.chapter,
      issues: blocking,
      characters: input.characters,
      canon: auditCanon,
      story: input.story,
    }).text;
    try {
      const repaired = await repairChapter(
        input.meta,
        input.chapter,
        currentText,
        blocking,
        auditCanon,
        input.previousEnding,
        input.nextOpening,
        input.rewriteInstruction,
        input.reviewFeedback,
        { evidenceContext },
      );
      if (!repaired.trim()) throw new Error("修复返回空正文");
      currentText = repaired;
    } catch (error) {
      if (error instanceof RepairNeedsAuthorDecisionError) {
        needsAuthorDecision = true;
        logJob(
          input.job,
          `第 ${input.chapter.index} 章修复证据不足，需要作者决定，未修改正文：${error.message}`,
        );
        break;
      }
      logJob(input.job, `第 ${input.chapter.index} 章定点修复失败：${errorMessage(error)}`);
      break;
    }
  }

  if (best) {
    return needsAuthorDecision ? { ...best, needsAuthorDecision } : best;
  }
  return {
    text: currentText,
    review: {
      summary: input.chapter.summary,
      issues: [
        {
          severity: "critical",
          type: "审校失败",
          evidence: "",
          detail: "连续性检查未完成",
        },
      ],
      continuityOk: false,
      repaired: false,
      repairAttempts: 0,
    },
    canon: input.canon,
    passed: false,
    story: undefined,
    needsAuthorDecision,
  };
}

interface VerifyDraftChapterInput extends VerifyChapterInput {
  seedIssues?: ContinuityIssue[];
  seedReview?: ReviewResult;
  maxRepairs?: number;
  // 作者确认的跨章修复方向与允许修改的此前章节原文。
  authorDirective?: string;
  crossChapters?: Record<number, string>;
  crossAnchors?: Record<number, string[]>;
  crossChapterContext?: string;
}

type DraftStopReason =
  | "passed"
  | "max-repairs"
  | "no-improvement"
  | "new-critical"
  | "increased"
  | "repair-failed"
  | "patch-rejected"
  | "extraction-failed"
  | "audit-failed"
  | "needs-author-decision"
  | "paused";

interface VerifyDraftChapterResult extends VerifyChapterResult {
  repairCalls: number;
  extractionFailed: boolean;
  comparison?: IssueComparison;
  stopReason: DraftStopReason;
  seedStatus: "used" | "fallback";
  // 修复前的严重问题基线，用于统一验收。
  initialIssues: ContinuityIssue[];
  initialCriticalCount: number;
  finalCriticalCount: number;
  // 修复方案要求扩大回归审校时，汇总后的范围说明。
  regressionScope: string;
  // 第一轮修复前提取的因果结构，供修复后回归审校对比。
  causalBaselines: CausalBaseline[];
  // 跨章修复后各此前章节的最新文本（仅在通过验收时使用）。
  crossTexts: Record<number, string>;
  decisionReason?: string;
  decisionOptions?: RepairDecisionOptionPlan[];
}

// 草稿修复是独立流程：先修再验，最多两轮；正常写作的 verifyChapter 不变。
async function verifyDraftChapter(
  input: VerifyDraftChapterInput,
): Promise<VerifyDraftChapterResult> {
  const previousContext = [
    input.previousEnding ? `上一章结尾：\n${input.previousEnding}` : "",
    ...input.previousSummaries.map((summary, index) => `前情摘要 ${index + 1}：${summary}`),
  ]
    .filter(Boolean)
    .join("\n\n");
  const nextContext = [
    input.nextOpening ? `下一章开头：\n${input.nextOpening}` : "",
    input.nextSummary ? `下一章摘要：${input.nextSummary}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const auditCanon = canonForChapter(input.canon, input.chapter.index);
  const storyContext = buildStoryContext(
    input.project,
    input.chapter,
    input.memory,
    input.story,
  ).text;
  const previousChapters = input.project.chapters
    .filter(
      (chapter) =>
        chapter.index < input.chapter.index &&
        chapter.written &&
        chapter.content.trim(),
    )
    .sort((a, b) => b.index - a.index)
    .slice(0, 3);

  const maxRepairs = Math.max(1, Math.min(2, input.maxRepairs ?? 2));
  const seedIssues = input.seedIssues ?? [];
  const seedStatus: "used" | "fallback" = seedIssues.length ? "used" : "fallback";
  const maxAudits = seedStatus === "used" ? maxRepairs : maxRepairs + 1;
  let currentText = input.text;
  let best: VerifyChapterResult | null = null;
  let evidenceContext = seedIssues.length
    ? collectRepairEvidence({
        project: input.project,
        chapter: input.chapter,
        issues: seedIssues,
        characters: input.characters,
        canon: auditCanon,
        story: input.story,
      }).text
    : input.evidenceContext ?? "";
  let comparison: IssueComparison | undefined;
  let repairCalls = 0;
  let extractionFailed = false;
  let needsAuthorDecision = false;
  let regressionScope = "";
  let causalBaselines: CausalBaseline[] = [];
  let crossTexts: Record<number, string> = { ...(input.crossChapters ?? {}) };
  let decisionReason: string | undefined;
  let decisionOptions: RepairDecisionOptionPlan[] | undefined;
  let stopReason: DraftStopReason = "max-repairs";
  let initialIssues: ContinuityIssue[] = seedIssues;
  let initialCriticalCount = countCritical(seedIssues);
  let finalCriticalCount = initialCriticalCount;

  const fallback = (): VerifyDraftChapterResult => {
    const review =
      input.seedReview ??
      ({
        summary: input.chapter.summary,
        issues: seedIssues,
        continuityOk: false,
        repaired: false,
        repairAttempts: 0,
      } satisfies ReviewResult);
    const critical = countCritical(review.issues);
    return {
      text: input.text,
      review,
      canon: input.canon,
      passed: false,
      auditFailed: false,
      repairCalls,
      extractionFailed,
      needsAuthorDecision,
      comparison,
      stopReason,
      seedStatus,
      initialIssues,
      initialCriticalCount,
      finalCriticalCount: critical,
      regressionScope,
      causalBaselines,
      crossTexts: { ...(input.crossChapters ?? {}) },
      decisionReason,
      decisionOptions,
    };
  };

  const finish = (): VerifyDraftChapterResult =>
    best
      ? {
          ...best,
          auditFailed: false,
          repairCalls,
          extractionFailed,
          needsAuthorDecision,
          comparison,
          stopReason,
          seedStatus,
          initialIssues,
          initialCriticalCount,
          finalCriticalCount,
          regressionScope,
          causalBaselines,
          crossTexts: { ...crossTexts },
          decisionReason,
          decisionOptions,
        }
      : fallback();

  const pauseStop = (): VerifyDraftChapterResult => {
    stopReason = "paused";
    logJob(
      input.job,
      `第 ${input.chapter.index} 章草稿修复已暂停，停止后续模型调用；原草稿${
        best ? "和已通过验证的最佳版本" : ""
      }保持不变。`,
    );
    return finish();
  };

  const logStop = () => {
    if (comparison) {
      logJob(
        input.job,
        `第 ${input.chapter.index} 章修复对比：严重问题 ${comparison.beforeCount}→${comparison.afterCount}（已解决 ${comparison.resolved.length}，仍存在 ${comparison.remaining.length}，新增 ${comparison.added.length}）；${stopReason === "increased" ? "问题数量增加" : stopReason === "new-critical" ? "出现新的严重问题" : "没有取得改善"}，保留最佳草稿并停止自动修复。`,
      );
    }
  };

  const repairRound = async (
    blocking: ContinuityIssue[],
    logStart = true,
  ): Promise<boolean> => {
    const nextRound = repairCalls + 1;
    if (logStart) {
      logJob(
        input.job,
        `第 ${input.chapter.index} 章基于最新审校问题尝试定点修复（第 ${nextRound} 轮）…`,
      );
    }
    const collected = collectRepairEvidence({
      project: input.project,
      chapter: input.chapter,
      issues: blocking,
      characters: input.characters,
      canon: auditCanon,
      story: input.story,
    });
    evidenceContext = collected.text;
    const missingRefs = missingReferencedChapters(
      input.project,
      input.chapter.index,
      blocking,
    );
    if (missingRefs.length) {
      needsAuthorDecision = true;
      stopReason = "needs-author-decision";
      logJob(
        input.job,
        `第 ${input.chapter.index} 章的问题引用了没有正文的此前章节（第 ${missingRefs.join(
          "、",
        )} 章），证据不足；草稿保持不变，需要作者决定或补齐该章节正文。`,
      );
      return false;
    }
    try {
      const stagedIssues = withIssueIds(blocking);
      const crossIndexes = Object.keys(crossTexts).map(Number);
      const plan = await repairChapterPatches(
        input.meta,
        input.chapter,
        currentText,
        stagedIssues,
        auditCanon,
        input.previousEnding,
        input.nextOpening,
        input.rewriteInstruction,
        "",
        {
          draftRepair: true,
          evidenceContext,
          authorDirective: input.authorDirective,
          crossChapterContext: input.crossChapterContext,
          affectedChapters: [input.chapter.index, ...crossIndexes],
        },
      );
      const patchChapters: PatchChapter[] = [
        {
          index: input.chapter.index,
          text: currentText,
          extraAuthorizedAnchors: plan.authorizedAnchors,
        },
        ...crossIndexes.map((index) => ({
          index,
          text: crossTexts[index],
          extraAuthorizedAnchors: input.crossAnchors?.[index],
        })),
      ];
      const batches = applyRepairPatchesAcross({
        chapters: patchChapters,
        targetIndex: input.chapter.index,
        patches: plan.patches,
        issues: stagedIssues,
      });
      for (const batch of batches) {
        logPatchBatch(input.job, batch.chapterIndex, batch);
        if (batch.chapterIndex === input.chapter.index) {
          currentText = batch.text;
        } else {
          crossTexts = { ...crossTexts, [batch.chapterIndex]: batch.text };
        }
      }
      if (plan.regressionScope) regressionScope = plan.regressionScope;
      // 多轮修复时只保留第一轮的原始结构，后续轮次是在已修改稿上继续修。
      if (!causalBaselines.length) causalBaselines = plan.causalBaselines ?? [];
      repairCalls = nextRound;
      throwIfCancelled(input.job);
      return true;
    } catch (error) {
      if (error instanceof JobCancelledError) throw error;
      if (error instanceof RepairNeedsAuthorDecisionError) {
        needsAuthorDecision = true;
        decisionReason = error.message;
        decisionOptions = error.options.length ? error.options : undefined;
        stopReason = "needs-author-decision";
        logJob(
          input.job,
          `第 ${input.chapter.index} 章修复证据不足，需要作者决定：${error.message}`,
        );
        return false;
      }
      if (
        error instanceof RepairPatchError ||
        error instanceof RepairPlanRejectedError
      ) {
        stopReason = "patch-rejected";
        logJob(
          input.job,
          `第 ${input.chapter.index} 章修复补丁未通过校验，整批未应用，草稿保持不变：${error.message}`,
        );
        return false;
      }
      logJob(
        input.job,
        `第 ${input.chapter.index} 章定点修复失败：${errorMessage(error)}`,
      );
      stopReason = "repair-failed";
      return false;
    }
  };

  if (seedStatus === "used") {
    logJob(
      input.job,
      `第 ${input.chapter.index} 章根据原草稿审校问题直接修复（第 1 轮）…`,
    );
    if (!(await repairRound(seedIssues, false))) return fallback();
    if (isPauseRequested(input.job)) return pauseStop();
  }

  for (let auditIndex = 0; auditIndex < maxAudits; auditIndex += 1) {
    throwIfCancelled(input.job);
    if (isPauseRequested(input.job)) return pauseStop();

    let extracted: ExtractedFacts;
    let extractionAttempts = 0;
    try {
      const extraction = await extractFactsWithRetry(
        input.job,
        input.meta,
        input.bible,
        input.chapter,
        currentText,
        auditCanon,
      );
      extracted = extraction.facts;
      extractionAttempts = extraction.attempts;
    } catch (error) {
      if (error instanceof JobCancelledError) throw error;
      extractionFailed = true;
      stopReason = "extraction-failed";
      const message = errorMessage(error);
      logJob(
        input.job,
        `第 ${input.chapter.index} 章事实抽取失败，未验证的修复稿不会被采用；保留最佳草稿并交由人工处理。`,
      );
      const result = finish();
      return {
        ...result,
        review: {
          ...result.review,
          extractionOk: false,
          extractionError: message,
          extractionAttempts: EXTRACTION_MAX_ATTEMPTS,
        },
      };
    }

    // 模型调用结束后立即检查取消和暂停，避免暂停后又发起审校/修复请求。
    throwIfCancelled(input.job);
    if (isPauseRequested(input.job)) return pauseStop();

    const chapterMemory = buildChapterMemory(
      input.chapter.index,
      extracted.summary || input.chapter.summary,
      extracted,
      "ai",
    );
    const checks = reviewSuspicions({
      project: input.project,
      chapter: input.chapter,
      text: currentText,
      canon: auditCanon,
      memory: input.memory,
      story: input.story,
      previousEnding: input.previousEnding,
      previousChapters,
      extracted: extracted.story,
      chapterMemory,
    });

    let audit: ReviewResult;
    try {
      audit = await auditChapter(
        input.meta,
        auditCanon,
        input.project.characters,
        input.chapter,
        currentText,
        previousContext,
        checks.suspicions,
        nextContext,
        storyContext,
        evidenceContext,
      );
    } catch (error) {
      if (error instanceof JobCancelledError) throw error;
      // 审校服务失败不代表正文存在可修复问题：直接停止，不把“审校失败”
      // 当作 critical 问题交给 Repair Editor，也不改写草稿。
      stopReason = "audit-failed";
      logJob(
        input.job,
        `第 ${input.chapter.index} 章连续性审校服务失败（不是正文问题），未调用修复 Agent；保留${
          best ? "已通过验证的最佳草稿" : "原草稿"
        }等待重试：${errorMessage(error)}`,
      );
      return { ...finish(), auditFailed: true };
    }

    throwIfCancelled(input.job);
    if (isPauseRequested(input.job)) return pauseStop();

    const merged = mergeCanon(
      auditCanon,
      extracted,
      input.chapter.index,
      input.mode,
    );
    const mergedFull =
      auditCanon === input.canon
        ? merged
        : mergeCanon(input.canon, extracted, input.chapter.index, input.mode);
    const issues = mergeIssues(audit.issues, merged.conflicts, checks.hardIssues);
    const factConflicts = mergeIssues(merged.conflicts, checks.hardIssues).filter(
      (issue) => issue.severity === "critical",
    );
    const critical = countCritical(issues);
    const review: ReviewResult = {
      summary: extracted.summary || audit.summary || input.chapter.summary,
      issues,
      continuityOk: critical === 0,
      repaired: repairCalls > 0,
      repairAttempts: repairCalls,
      extractionOk: true,
      extractionAttempts,
    };
    const memory = buildChapterMemory(
      input.chapter.index,
      review.summary,
      extracted,
      "ai",
    );
    const candidate: VerifyChapterResult = {
      text: currentText,
      review,
      canon: review.continuityOk ? mergedFull.canon : input.canon,
      passed: review.continuityOk,
      memory,
      story: extracted.story,
      factConflicts,
    };

    if (!best && seedStatus === "fallback") {
      best = candidate;
      initialIssues = issues;
      initialCriticalCount = critical;
      finalCriticalCount = critical;
      if (review.continuityOk) {
        stopReason = "passed";
        return finish();
      }
      if (repairCalls >= maxRepairs) {
        stopReason = "max-repairs";
        break;
      }
      if (!(await repairRound(issues.filter((issue) => issue.severity === "critical")))) {
        break;
      }
      if (isPauseRequested(input.job)) return pauseStop();
      continue;
    }

    if (seedStatus === "used" && auditIndex === 0) {
      comparison = compareCriticalIssues(
        seedIssues,
        review.issues,
        input.characters,
      );
      if (review.continuityOk) {
        best = candidate;
        finalCriticalCount = 0;
        stopReason = "passed";
        logJob(
          input.job,
          `第 ${input.chapter.index} 章草稿修复第 1 轮后通过连续性检查。`,
        );
        return finish();
      }
      // 第一轮只要求“不增加严重问题”即可保留候选稿继续修；
      // 换词后同一问题被重新计数时，严格减少条件会让任务永远卡在 1→1。
      const notWorse = comparison.afterCount <= comparison.beforeCount;
      if (!comparison.improved && !notWorse) {
        stopReason = "increased";
        logStop();
        return fallback();
      }
      best = candidate;
      finalCriticalCount = critical;
      if (comparison.improved) {
        logJob(
          input.job,
          `第 ${input.chapter.index} 章草稿修复第 1 轮有改善：严重问题 ${comparison.beforeCount}→${comparison.afterCount}，已解决 ${comparison.resolved.length}，新增 ${comparison.added.length}。`,
        );
      } else {
        logJob(
          input.job,
          `第 ${input.chapter.index} 章草稿修复第 1 轮没有增加严重问题：${comparison.beforeCount}→${comparison.afterCount}，已解决 ${comparison.resolved.length}，新增 ${comparison.added.length}；保留候选稿继续修复。`,
        );
      }
      if (repairCalls >= maxRepairs) {
        stopReason = "max-repairs";
        break;
      }
      if (!(await repairRound(issues.filter((issue) => issue.severity === "critical")))) {
        break;
      }
      if (isPauseRequested(input.job)) return pauseStop();
      continue;
    }

    const previousBest = best;
    if (!previousBest) break;
    comparison = compareCriticalIssues(
      previousBest.review.issues,
      review.issues,
      input.characters,
    );
    if (review.continuityOk) {
      best = candidate;
      finalCriticalCount = 0;
      stopReason = "passed";
      logJob(
        input.job,
        `第 ${input.chapter.index} 章草稿经 ${repairCalls} 轮修复后通过连续性检查。`,
      );
      return finish();
    }
    if (!comparison.improved) {
      stopReason =
        comparison.afterCount > comparison.beforeCount
          ? "increased"
          : comparison.added.length
            ? "new-critical"
            : "no-improvement";
      logStop();
      break;
    }
    best = candidate;
    finalCriticalCount = critical;
    logJob(
      input.job,
      `第 ${input.chapter.index} 章草稿修复第 ${repairCalls} 轮有改善：严重问题 ${comparison.beforeCount}→${comparison.afterCount}，已解决 ${comparison.resolved.length}，新增 ${comparison.added.length}。`,
    );
    if (repairCalls >= maxRepairs) {
      stopReason = "max-repairs";
      break;
    }
    if (!(await repairRound(issues.filter((issue) => issue.severity === "critical")))) {
      break;
    }
    if (isPauseRequested(input.job)) return pauseStop();
  }

  return finish();
}

async function runWrite(job: Job, requested: number): Promise<boolean> {
  const count = Math.max(1, Math.min(50, Math.round(Number(requested) || 1)));
  const detail = await getProjectDetail(job.slug);
  const pending = detail.chapters.filter((chapter) => !chapter.written).slice(0, count);

  if (!pending.length) {
    logJob(job, "没有待写章节：请先生成架构，或调整目标章节数。");
    return false;
  }

  assertCanonReady(detail);
  logPromptProfile(job);

  const history = Object.keys(detail.state.summaries)
    .map(Number)
    .sort((a, b) => a - b)
    .map((index) => detail.state.summaries[String(index)])
    .filter((item): item is string => Boolean(item));

  const takeEnding = (text: string): string => {
    const trimmed = text.trim();
    return trimmed.length > 1500 ? `……${trimmed.slice(-1500)}` : trimmed;
  };

  // 从已写章节里找到当前待写章节之前最近的一章，作为第一段的承接原文。
  // 不能只看摘要：摘要写“主角逃出地牢”，原文结尾可能是“刀尖停在喉前”，
  // 两种信息对下一章开头的约束力完全不同。
  const previousWritten = detail.chapters
    .filter(
      (chapter) =>
        chapter.written && chapter.content.trim() && chapter.index < pending[0].index,
    )
    .sort((a, b) => b.index - a.index)[0];
  let previousEnding = previousWritten ? takeEnding(previousWritten.content) : "";
  let canon = detail.canon;
  let memory = await getMemory(job.slug);
  let story = buildEffectiveStory(detail, memory, await getStory(job.slug));
  let planLedger = detail.planLedger ?? emptyPlanLedger(detail.meta.updatedAt);
  let paused = false;

  // 逐章串行：每章写完立即落盘并更新摘要，任务中途失败时，
  // 已完成的章节仍然保留，history 和上一章结尾也会持续传给下一章。
  for (const chapter of pending) {
    throwIfCancelled(job);
    const chapterPlan = detail.plan.chapters.find((item) => item.index === chapter.index);
    if (!chapterPlan) continue;

    logJob(job, `开始写第 ${chapter.index} 章《${chapter.title}》…`);
    const retrieval = buildMemoryContext(detail, chapterPlan, memory);
    logMemoryRetrieval(job, chapter.index, retrieval);
    const storyRetrieval = buildStoryContext(detail, chapterPlan, memory, story);
    logStoryRetrieval(job, chapter.index, storyRetrieval);
    const planContext = formatPlanContext(planLedger, chapterPlan);
    logJob(
      job,
      planContext
        ? `第 ${chapter.index} 章计划台账已注入（计划不代表已发生）。`
        : `第 ${chapter.index} 章没有登记计划台账。`,
    );
    let text = await writeChapter(
      detail.meta,
      detail.bible,
      detail.characters,
      chapterPlan,
      previousEnding,
      history.slice(-6),
      {
        canon: canonForChapter(canon, chapter.index),
        memoryContext: retrieval.text,
        storyContext: storyRetrieval.text,
        planContext,
      },
    );
    if (!text.trim()) throw new Error(`第 ${chapter.index} 章正文为空，请重试`);

    logJob(job, `初稿完成，约 ${text.replace(/\s+/g, "").length} 字，开始抽取事实并审校…`);
    const result = await verifyChapter({
      job,
      project: detail,
      meta: detail.meta,
      bible: detail.bible,
      characters: detail.characters,
      chapter: chapterPlan,
      text,
      canon,
      memory,
      story,
      previousEnding,
      previousSummaries: history.slice(-2),
      nextOpening: "",
      nextSummary: "",
      mode: "write",
      rewriteInstruction: "",
      reviewFeedback: "",
    });
    throwIfCancelled(job);
    text = result.text;

    if (!result.passed) {
      const critical = result.review.issues.filter(
        (issue) => issue.severity === "critical",
      ).length;
      const extractionFailed = result.review.extractionOk === false;
      const auditFailed = result.auditFailed === true;
      const decisionRequired = result.needsAuthorDecision === true;
      const draft = await saveRejectedDraft(job.slug, {
        index: chapter.index,
        content: text,
        mode: "write",
        reason: decisionRequired
          ? "自动修复证据不足，需要作者决定"
          : auditFailed
            ? "连续性审校服务失败，未能确认正文质量"
            : extractionFailed
              ? "事实抽取失败，未进入审校"
              : `连续性检查未通过：${critical} 个严重问题`,
        review: result.review,
      });
      paused = true;
      job.result = `第 ${chapter.index} 章未写入正文，草稿已保存`;
      logJob(
        job,
        decisionRequired
          ? `第 ${chapter.index} 章自动修复证据不足，需要作者决定，未写入正文；草稿保存在 ${draft.path}。后续自动写作已暂停。`
          : auditFailed
            ? `第 ${chapter.index} 章连续性审校服务失败（不是正文问题），未触发修复也未写入正文；草稿保存在 ${draft.path}。后续自动写作已暂停，请检查模型配置后重试。`
            : extractionFailed
              ? `第 ${chapter.index} 章事实抽取失败，未写入正文；草稿保存在 ${draft.path}，原有台账未改动。后续自动写作已暂停，请检查模型配置后重试。`
              : `第 ${chapter.index} 章仍有 ${critical} 个严重连续性问题，未写入正文；草稿保存在 ${draft.path}。后续自动写作已暂停，请人工处理后再继续。`,
      );
      break;
    }

    await writeChapterFile(job.slug, chapter.index, text, {
      source: "ai-write",
      title: chapterPlan.title,
      summary: result.review.summary,
      note: "AI 自动写作",
    });
    previousEnding = takeEnding(text);
    await markChapterWritten(job.slug, chapter.index, result.review.summary, result.review);
    markDetailChapterWritten(detail, chapter.index, text, result.review.summary);
    canon = result.canon;
    await saveCanon(job.slug, canon);
    memory = await persistChapterMemory(job, detail, memory, result.memory);
    story = await persistChapterStory(job, detail, memory, story, result.memory, result.story);
    const reconciled = reconcileChapterPlan({
      ledger: planLedger,
      chapter: chapter.index,
      chapterMemory: result.memory,
      extracted: result.story,
      storyEvents: story.events,
      canon,
    });
    planLedger = reconciled.ledger;
    await savePlanLedger(job.slug, planLedger);
    if (reconciled.changes.length) {
      logJob(
        job,
        `第 ${chapter.index} 章计划执行对比：${reconciled.changes.slice(0, 5).join("；")}${reconciled.changes.length > 5 ? "；……" : ""}`,
      );
    }
    history.push(result.review.summary);

    const issueCount = result.review.issues.length;
    const repairedNote = result.review.repaired
      ? `，自动修复 ${result.review.repairAttempts ?? 0} 轮`
      : "";
    logJob(
      job,
      `第 ${chapter.index} 章完成，连续性检查通过${
        issueCount ? `（${issueCount} 条问题）` : ""
      }${repairedNote}`,
    );
  }

  if (!paused) logJob(job, "本轮自动写作完成，事实台账已同步");
  return paused;
}

async function runRewrite(
  job: Job,
  requested: number[],
  instruction: string,
  useReview: boolean,
): Promise<boolean> {
  const detail = await getProjectDetail(job.slug);
  const requestedSet = new Set(requested);
  const targets = detail.chapters
    .filter((chapter) => requestedSet.has(chapter.index))
    .sort((a, b) => a.index - b.index);

  if (!targets.length) {
    throw new Error("没有找到要重写的章节，请检查章节号");
  }

  const found = new Set(targets.map((chapter) => chapter.index));
  const missing = [...requestedSet]
    .filter((index) => !found.has(index))
    .sort((a, b) => a - b);
  if (missing.length) {
    throw new Error(`以下章节不在当前大纲中：第 ${missing.join("、")} 章`);
  }

  const empty = targets.filter((chapter) => !chapter.written || !chapter.content.trim());
  if (empty.length) {
    throw new Error(
      `以下章节还没有正文，无法重写：${empty
        .map((chapter) => `第 ${chapter.index} 章`)
        .join("、")}`,
    );
  }

  assertCanonReady(detail);
  logPromptProfile(job);

  const takeEnding = (text: string): string => {
    const trimmed = text.trim();
    return trimmed.length > 1500 ? `……${trimmed.slice(-1500)}` : trimmed;
  };
  const takeOpening = (text: string): string => {
    const trimmed = text.trim();
    return trimmed.length > 800 ? `${trimmed.slice(0, 800)}……` : trimmed;
  };

  // 本次任务内已重写的正文优先于磁盘旧稿，供后续目标章节读取前后衔接。
  const rewritten = new Map<number, string>();
  const contentOf = (chapter: { index: number; content: string }): string =>
    rewritten.get(chapter.index) ?? chapter.content;

  logJob(
    job,
    `准备重写第 ${targets.map((chapter) => chapter.index).join("、")} 章${
      instruction.trim() ? `；重写要求：${instruction.trim()}` : ""
    }${useReview ? "；将参考上一版严重审校问题" : ""}…`,
  );

  let canon = detail.canon;
  let memory = await getMemory(job.slug);
  let story = buildEffectiveStory(detail, memory, await getStory(job.slug));
  let planLedger = detail.planLedger ?? emptyPlanLedger(detail.meta.updatedAt);
  let paused = false;

  for (const target of targets) {
    throwIfCancelled(job);
    const chapterPlan = detail.plan.chapters.find((item) => item.index === target.index);
    if (!chapterPlan) continue;

    const previous = detail.chapters
      .filter((chapter) => chapter.index < target.index && contentOf(chapter).trim())
      .sort((a, b) => b.index - a.index)[0];
    const previousEnding = previous ? takeEnding(contentOf(previous)) : "";

    // 只参考不会被本次重写的下一章。若下一章也在重写范围内，
    // 它会由后续循环重新生成，不需要用旧开头约束当前章。
    const next = detail.chapters
      .filter(
        (chapter) =>
          chapter.index > target.index &&
          !requestedSet.has(chapter.index) &&
          chapter.written &&
          chapter.content.trim(),
      )
      .sort((a, b) => a.index - b.index)[0];
    const nextOpening = next ? takeOpening(next.content) : "";
    const nextSummary = next
      ? detail.state.summaries[String(next.index)] ??
        detail.plan.chapters.find((item) => item.index === next.index)?.summary ??
        ""
      : "";

    const priorSummaries = Object.keys(detail.state.summaries)
      .map(Number)
      .filter((index) => index < target.index)
      .sort((a, b) => a - b)
      .map((index) => detail.state.summaries[String(index)])
      .filter((item): item is string => Boolean(item));

    const targetReview = useReview ? detail.state.reviews[String(target.index)] : undefined;
    const reviewFeedback = formatReviewFeedback(targetReview);
    const reviewCritical =
      targetReview?.issues.filter((issue) => issue.severity === "critical").length ?? 0;

    logJob(job, `开始重写第 ${target.index} 章《${target.title}》…`);
    if (useReview) {
      logJob(
        job,
        reviewFeedback
          ? `第 ${target.index} 章将参考上一版 ${reviewCritical} 条严重审校问题`
          : `第 ${target.index} 章没有严重审校记录，本次按普通重写进行`,
      );
    }
    const retrieval = buildMemoryContext(detail, chapterPlan, memory);
    logMemoryRetrieval(job, target.index, retrieval);
    const storyRetrieval = buildStoryContext(detail, chapterPlan, memory, story);
    logStoryRetrieval(job, target.index, storyRetrieval);
    const planContext = formatPlanContext(planLedger, chapterPlan);
    let text = await writeChapter(
      detail.meta,
      detail.bible,
      detail.characters,
      chapterPlan,
      previousEnding,
      priorSummaries.slice(-6),
      {
        mode: "rewrite",
        rewriteInstruction: instruction,
        reviewFeedback,
        nextOpening,
        canon: canonForChapter(canon, target.index),
        memoryContext: retrieval.text,
        storyContext: storyRetrieval.text,
        planContext,
      },
    );
    if (!text.trim()) throw new Error(`第 ${target.index} 章正文为空，请重试`);

    logJob(
      job,
      `第 ${target.index} 章初稿完成，约 ${text.replace(/\s+/g, "").length} 字，开始抽取事实并审校…`,
    );
    const result = await verifyChapter({
      job,
      project: detail,
      meta: detail.meta,
      bible: detail.bible,
      characters: detail.characters,
      chapter: chapterPlan,
      text,
      canon,
      memory,
      story,
      previousEnding,
      previousSummaries: priorSummaries.slice(-2),
      nextOpening,
      nextSummary,
      mode: "rewrite",
      rewriteInstruction: instruction,
      reviewFeedback,
    });
    throwIfCancelled(job);
    text = result.text;

    if (!result.passed) {
      const critical = result.review.issues.filter(
        (issue) => issue.severity === "critical",
      ).length;
      const extractionFailed = result.review.extractionOk === false;
      const auditFailed = result.auditFailed === true;
      const decisionRequired = result.needsAuthorDecision === true;
      const draft = await saveRejectedDraft(job.slug, {
        index: target.index,
        content: text,
        mode: "rewrite",
        reason: decisionRequired
          ? "自动修复证据不足，需要作者决定"
          : auditFailed
            ? "连续性审校服务失败，未能确认重写稿质量"
            : extractionFailed
              ? "事实抽取失败，未进入审校"
              : `重写未通过连续性检查：${critical} 个严重问题`,
        review: result.review,
      });
      paused = true;
      job.result = `第 ${target.index} 章重写未通过，原稿保留`;
      logJob(
        job,
        decisionRequired
          ? `第 ${target.index} 章自动修复证据不足，需要作者决定，未覆盖原稿；草稿保存在 ${draft.path}。重写已暂停。`
          : auditFailed
            ? `第 ${target.index} 章连续性审校服务失败（不是正文问题），未触发修复也未覆盖原稿；草稿保存在 ${draft.path}。重写已暂停，请检查模型配置后重试。`
            : extractionFailed
              ? `第 ${target.index} 章事实抽取失败，未覆盖原稿；草稿保存在 ${draft.path}，原有台账未改动。重写已暂停，请检查模型配置后重试。`
              : `第 ${target.index} 章重写仍有 ${critical} 个严重连续性问题，未覆盖原稿；草稿保存在 ${draft.path}。重写已暂停，请人工处理后再继续。`,
      );
      break;
    }

    await writeChapterFile(job.slug, target.index, text, {
      source: "ai-rewrite",
      title: chapterPlan.title,
      summary: result.review.summary,
      note: instruction.trim() ? `AI 重写：${instruction.trim()}` : "AI 重写",
    });
    rewritten.set(target.index, text);
    await markChapterWritten(job.slug, target.index, result.review.summary, result.review);
    markDetailChapterWritten(detail, target.index, text, result.review.summary);

    // 重写会覆盖旧稿；只由旧稿确立、且新正文里不再出现的人物状态需要降级，
    // 否则“幽灵死亡”会继续约束后续章节。
    const reconciled = reconcileCanonWithChapters(result.canon, [
      { index: target.index, content: text },
    ]);
    canon = reconciled.canon;
    if (reconciled.changes.length) {
      logJob(
        job,
        `第 ${target.index} 章重写后对账：${reconciled.changes.join("；")}`,
      );
    }
    await saveCanon(job.slug, canon);
    memory = await persistChapterMemory(job, detail, memory, result.memory);
    story = await persistChapterStory(job, detail, memory, story, result.memory, result.story);
    const planReconciled = reconcileChapterPlan({
      ledger: planLedger,
      chapter: target.index,
      chapterMemory: result.memory,
      extracted: result.story,
      storyEvents: story.events,
      canon,
    });
    planLedger = planReconciled.ledger;
    await savePlanLedger(job.slug, planLedger);
    if (planReconciled.changes.length) {
      logJob(
        job,
        `第 ${target.index} 章计划执行对比：${planReconciled.changes.slice(0, 5).join("；")}${planReconciled.changes.length > 5 ? "；……" : ""}`,
      );
    }

    const issueCount = result.review.issues.length;
    const repairedNote = result.review.repaired
      ? `，自动修复 ${result.review.repairAttempts ?? 0} 轮`
      : "";
    logJob(
      job,
      `第 ${target.index} 章重写完成，连续性检查通过${
        issueCount ? `（${issueCount} 条问题）` : ""
      }${repairedNote}`,
    );
  }

  if (!paused) {
    job.result = `已重写 ${targets.length} 章`;
    logJob(
      job,
      `重写完成，共 ${targets.length} 章；事实台账已更新。章节细纲与主线大纲不会自动重写，后续写作会以事实台账为准。`,
    );
  }
  return paused;
}

async function runRepair(
  job: Job,
  requested: number[],
  source: "audit" | "review" = "audit",
): Promise<boolean> {
  const detail = await getProjectDetail(job.slug);
  const requestedSet = new Set(requested);
  const targets = detail.chapters
    .filter(
      (chapter) =>
        requestedSet.has(chapter.index) && chapter.written && chapter.content.trim(),
    )
    .sort((a, b) => a.index - b.index);

  if (!targets.length) {
    throw new Error("没有找到可定点修复的章节");
  }

  assertCanonReady(detail);
  logPromptProfile(job);

  const audit =
    source === "audit"
      ? parseAuditReport((await getAuditReport(job.slug)).content)
      : null;
  if (source === "audit" && (!audit || !audit.chapters.length)) {
    throw new Error("还没有总体审校记录，请先运行总体审校全书");
  }

  const takeEnding = (text: string): string => {
    const trimmed = text.trim();
    return trimmed.length > 1500 ? `……${trimmed.slice(-1500)}` : trimmed;
  };
  const takeOpening = (text: string): string => {
    const trimmed = text.trim();
    return trimmed.length > 800 ? `${trimmed.slice(0, 800)}……` : trimmed;
  };

  // 同一任务里前面的修复结果要立刻供后面章节衔接。
  const repaired = new Map<number, string>();
  const contentOf = (chapter: { index: number; content: string }): string =>
    repaired.get(chapter.index) ?? chapter.content;

  logJob(
    job,
    `准备按${source === "audit" ? "总体审校记录" : "章节审校遗留问题"}定点修复第 ${targets
      .map((chapter) => chapter.index)
      .join("、")} 章…`,
  );

  let canon = detail.canon;
  let memory = await getMemory(job.slug);
  let story = buildEffectiveStory(detail, memory, await getStory(job.slug));
  let planLedger = detail.planLedger ?? emptyPlanLedger(detail.meta.updatedAt);
  let remainingCritical = 0;
  let repairedCount = 0;
  let rejectedCount = 0;
  let paused = false;
  const decision = job.params.decisionId
    ? await getRepairDecision(job.slug, job.params.decisionId)
    : undefined;

  for (const target of targets) {
    throwIfCancelled(job);
    if (isPauseRequested(job)) {
      paused = true;
      break;
    }

    const sourceIssues =
      source === "audit"
        ? audit?.chapters.find((chapter) => chapter.index === target.index)?.issues ?? []
        : detail.state.reviews[String(target.index)]?.issues ?? [];
    if (!sourceIssues.length) {
      logJob(
        job,
        source === "audit"
          ? `第 ${target.index} 章在总体审校记录中没有问题，跳过；如需检查最新章节，请重新运行总体审校。`
          : `第 ${target.index} 章没有章节审校遗留问题，跳过。`,
      );
      continue;
    }

    // 可忽略项只展示，不进入修复提示词；定点修复只处理严重和建议。
    const fixable = sourceIssues.filter((issue) => issue.severity !== "ignore");
    if (!fixable.length) {
      logJob(job, `第 ${target.index} 章只有可忽略问题，跳过。`);
      continue;
    }

    const chapterPlan =
      detail.plan.chapters.find((item) => item.index === target.index) ?? {
        index: target.index,
        title: target.title,
        summary: "",
        keyBeats: [],
      };

    const previous = detail.chapters
      .filter(
        (chapter) =>
          chapter.index < target.index && chapter.written && contentOf(chapter).trim(),
      )
      .sort((a, b) => b.index - a.index)[0];
    const previousEnding = previous ? takeEnding(contentOf(previous)) : "";

    const next = detail.chapters
      .filter(
        (chapter) =>
          chapter.index > target.index && chapter.written && chapter.content.trim(),
      )
      .sort((a, b) => a.index - b.index)[0];
    const nextOpening = next ? takeOpening(contentOf(next)) : "";
    const nextSummary = next
      ? detail.state.summaries[String(next.index)] ??
        detail.plan.chapters.find((item) => item.index === next.index)?.summary ??
        ""
      : "";

    const priorSummaries = Object.keys(detail.state.summaries)
      .map(Number)
      .filter((index) => index < target.index)
      .sort((a, b) => a - b)
      .map((index) => detail.state.summaries[String(index)])
      .filter((item): item is string => Boolean(item));

    const sourceLabel = source === "audit" ? "总体审校记录" : "章节审校遗留问题";

    // 1) 基线审校：先确认原正文当前真实存在的问题，不能直接相信旧报告。
    logJob(job, `第 ${target.index} 章先对原正文做基线审校，确认真正需要修复的问题…`);
    const baseline = await verifyChapter({
      job,
      project: detail,
      meta: detail.meta,
      bible: detail.bible,
      characters: detail.characters,
      chapter: chapterPlan,
      text: target.content,
      canon,
      memory,
      story,
      previousEnding,
      previousSummaries: priorSummaries.slice(-2),
      nextOpening,
      nextSummary,
      mode: "rewrite",
      rewriteInstruction: `根据${sourceLabel}做定点修复。`,
      reviewFeedback: "",
      maxRepairs: 0,
    });
    throwIfCancelled(job);
    if (isPauseRequested(job)) {
      paused = true;
      job.result = `已暂停：第 ${target.index} 章未开始修复，原稿未改动`;
      logJob(
        job,
        `第 ${target.index} 章基线审校后任务已暂停，未生成候选稿，原正文保持不变。`,
      );
      break;
    }
    if (baseline.auditFailed || baseline.review.extractionOk === false) {
      paused = true;
      job.result = `第 ${target.index} 章基线审校未完成，原稿未改动`;
      logJob(
        job,
        `第 ${target.index} 章基线审校或事实抽取失败（不是正文问题），无法确认问题是否真实存在；原稿保持不变，已暂停。`,
      );
      break;
    }
    // 只有最新基线确认的问题才获得修改授权；旧报告只用于提示与追踪。
    const baselineIssues = baseline.review.issues.filter(
      (issue) => issue.severity !== "ignore",
    );
    const beforeCritical = baselineIssues.filter(
      (issue) => issue.severity === "critical",
    );
    const hasSourceCritical = fixable.some((issue) => issue.severity === "critical");
    if (!beforeCritical.length && hasSourceCritical) {
      logJob(
        job,
        `第 ${target.index} 章基线审校未复现来源记录中的严重问题，为避免按过期意见改稿，原稿保持不变，跳过本章。`,
      );
      continue;
    }
    if (!baselineIssues.length) {
      logJob(
        job,
        `第 ${target.index} 章基线审校没有确认任何需要修改的问题，原稿保持不变，跳过本章。`,
      );
      continue;
    }
    const allowNoBaseline = beforeCritical.length === 0;

    // 2) 生成候选补丁：按根因分组，每组最多 3 个问题，避免一次性改动过多。
    const sortedIssues = [...baselineIssues].sort((a, b) =>
      a.severity === b.severity ? 0 : a.severity === "critical" ? -1 : 1,
    );
    const issues = withIssueIds(sortedIssues);
    const critical = issues.filter((issue) => issue.severity === "critical").length;
    const warnings = issues.length - critical;
    const ignored = sourceIssues.length - fixable.length;
    const ignoredNote = ignored ? `，另有 ${ignored} 条可忽略不处理` : "";
    const repairBaseline = buildRepairBaseline({
      jobId: job.id,
      chapterIndex: target.index,
      text: target.content,
      issues,
    });

    logJob(
      job,
      `开始定点修复第 ${target.index} 章《${target.title}》…（${critical} 严重 / ${warnings} 建议${ignoredNote}；基线 ${repairBaseline.chapterVersion}）`,
    );

    // 按问题检索相关章节原文，修复与独立审校共用同一份证据。
    const evidence = collectRepairEvidence({
      project: detail,
      chapter: chapterPlan,
      issues,
      characters: detail.characters,
      canon: canonForChapter(canon, target.index),
      story,
    });
    if (evidence.snippets.length) {
      logJob(
        job,
        `第 ${target.index} 章检索到 ${evidence.snippets.length} 段相关原文证据（第 ${evidence.snippets
          .map((item) => item.chapter)
          .join("、")} 章）。`,
      );
    }
    const missingRefs = missingReferencedChapters(detail, target.index, issues);
    if (missingRefs.length) {
      rejectedCount += 1;
      logJob(
        job,
        `第 ${target.index} 章的问题引用了没有正文的此前章节（第 ${missingRefs.join(
          "、",
        )} 章），无法核对原文，证据不足；未修改正文，需要作者决定或补齐该章节正文。`,
      );
      continue;
    }

    const decisionOption =
      decision &&
      decision.chapterIndex === target.index &&
      decision.chosenIndex !== undefined
        ? decision.options[decision.chosenIndex]
        : undefined;
    if (decisionOption) {
      logJob(
        job,
        `第 ${target.index} 章按作者确认方案「${decisionOption.label}」执行跨章修复。`,
      );
    }
    // 只有作者已确认的方案才允许真正修改此前章节；未确认时跨章上下文只用于制定方案。
    const crossCandidates = new Set<number>(decisionOption?.affectedChapters ?? []);
    const crossChapters: Record<number, string> = {};
    const crossAnchors: Record<number, string[]> = {};
    const crossHashes = new Map<number, string>();
    const crossBaselines = new Map<number, ContinuityIssue[]>();
    for (const index of crossCandidates) {
      if (index === target.index) continue;
      const chapter = detail.chapters.find(
        (item) => item.index === index && item.written && item.content.trim(),
      );
      if (!chapter) continue;
      crossChapters[index] = chapter.content;
      crossAnchors[index] = decisionOption?.anchors ?? [];
      crossHashes.set(index, hashText(chapter.content));
    }
    if (Object.keys(crossChapters).length) {
      logJob(
        job,
        `第 ${target.index} 章跨章方案涉及第 ${Object.keys(crossChapters)
          .map(Number)
          .join("、")} 章，先做基线审校…`,
      );
      let baselineFailed = false;
      for (const index of Object.keys(crossChapters).map(Number)) {
        const sourceChapter = detail.chapters.find((item) => item.index === index);
        if (!sourceChapter) continue;
        const baseline = await verifyChapter({
          job,
          project: detail,
          meta: detail.meta,
          bible: detail.bible,
          characters: detail.characters,
          chapter:
            detail.plan.chapters.find((item) => item.index === index) ?? {
              index,
              title: sourceChapter.title,
              summary: "",
              keyBeats: [],
            },
          text: sourceChapter.content,
          canon,
          memory,
          story,
          previousEnding: "",
          previousSummaries: [],
          nextOpening: "",
          nextSummary: "",
          mode: "rewrite",
          rewriteInstruction: "跨章修复前的基线审校。",
          reviewFeedback: "",
          maxRepairs: 0,
        });
        if (baseline.auditFailed || baseline.review.extractionOk === false) {
          paused = true;
          job.result = `已暂停：第 ${index} 章基线审校未完成`;
          logJob(
            job,
            `第 ${index} 章跨章修复基线审校失败（不是正文问题），原正文未改动；已暂停。`,
          );
          baselineFailed = true;
          break;
        }
        crossBaselines.set(
          index,
          baseline.review.issues.filter((issue) => issue.severity !== "ignore"),
        );
      }
      if (baselineFailed) break;
    }
    // 未确认方案时也提供问题引用的此前章节原文，帮助方案阶段判断是否需要跨章修复。
    const contextSources: Record<number, string> = { ...crossChapters };
    if (!decisionOption) {
      for (const issue of issues) {
        const issueText = `${issue.evidence}\n${issue.detail}\n${issue.sourceEvidence ?? ""}`;
        for (const match of issueText.matchAll(/第\s*(\d+)\s*章/gu)) {
          const ref = Number.parseInt(match[1], 10);
          if (
            !Number.isInteger(ref) ||
            ref <= 0 ||
            ref >= target.index ||
            contextSources[ref]
          ) {
            continue;
          }
          const chapter = detail.chapters.find(
            (item) => item.index === ref && item.written && item.content.trim(),
          );
          if (chapter) contextSources[ref] = chapter.content.slice(0, 6000);
        }
      }
    }
    const crossChapterContext = Object.entries(contextSources)
      .map(([index, text]) => `第 ${index} 章：\n${text.slice(0, 6000)}`)
      .join("\n\n");
    const authorDirective = decisionOption
      ? `方案：${decisionOption.label}\n${decisionOption.description}\n涉及章节：第 ${decisionOption.affectedChapters.join("、")} 章\n必须保留/修改的原文锚点：\n${decisionOption.anchors
          .map((anchor) => `- ${anchor}`)
          .join("\n")}`
      : undefined;

    // 写回前用于检测正文是否被用户在修复期间修改。
    const baselineHash = hashText(target.content);

    let text: string;
    let regressionScope = "";
    let causalBaselines: CausalBaseline[] = [];
    let changedChapters: AppliedChapterBatch[] = [];
    // 跨章方案必须一次性完成授权章节的补丁；单章修复才按根因分组累积 V1。
    const allowsGroupedRepair = Object.keys(crossChapters).length === 0;
    const repairGroups = allowsGroupedRepair
      ? groupIssuesByRootCause(issues)
      : [{ key: "all", issues }];
    try {
      let candidateText = target.content;
      for (const [groupIndex, group] of repairGroups.entries()) {
        if (repairGroups.length > 1) {
          logJob(
            job,
            `第 ${target.index} 章按根因分组修复（第 ${groupIndex + 1}/${repairGroups.length} 组，${group.issues.length} 个问题）…`,
          );
        }
        const plan = await repairChapterPatches(
          detail.meta,
          chapterPlan,
          candidateText,
          group.issues,
          canonForChapter(canon, target.index),
          previousEnding,
          nextOpening,
          `根据${sourceLabel}做定点修复：只修改与这些问题直接相关的段落，其余原文尽量保持不动。`,
          "",
          {
            evidenceContext: evidence.text,
            authorDirective,
            crossChapterContext,
            affectedChapters: [
              target.index,
              ...Object.keys(crossChapters).map(Number),
            ],
          },
        );
        const patchChapters: PatchChapter[] = [
          {
            index: target.index,
            text: candidateText,
            extraAuthorizedAnchors: plan.authorizedAnchors,
          },
          ...Object.keys(crossChapters).map((key) => {
            const index = Number(key);
            return {
              index,
              text: crossChapters[index],
              extraAuthorizedAnchors: crossAnchors[index],
            };
          }),
        ];
        const batches = applyRepairPatchesAcross({
          chapters: patchChapters,
          targetIndex: target.index,
          patches: plan.patches,
          issues: group.issues,
        });
        const targetBatch = batches.find(
          (batch) => batch.chapterIndex === target.index,
        );
        if (!targetBatch) {
          throw new RepairPatchError(
            "UNCOVERED_ISSUE",
            "补丁没有修改目标章节，无法解决当前章节问题",
          );
        }
        for (const batch of batches) {
          logPatchBatch(job, batch.chapterIndex, batch);
        }
        changedChapters.push(...batches);
        candidateText = targetBatch.text;
        if (plan.regressionScope) {
          regressionScope = [regressionScope, plan.regressionScope]
            .filter(Boolean)
            .join("；");
        }
        causalBaselines = [...causalBaselines, ...(plan.causalBaselines ?? [])];
      }
      text = candidateText;
    } catch (error) {
      if (error instanceof RepairNeedsAuthorDecisionError) {
        if (!decisionOption && error.options.length) {
          const created = await createRepairDecision({
            slug: job.slug,
            chapterIndex: target.index,
            source,
            params: { indices: [target.index], source },
            jobId: job.id,
            reason: error.message,
            issues,
            options: error.options,
          });
          paused = true;
          job.result = `第 ${target.index} 章需要作者确认修复方向`;
          logJob(
            job,
            `第 ${target.index} 章冲突涉及更早章节，已生成 ${created.options.length} 个互斥修复方案等待作者确认（决策 ${created.id}）；原正文未改动。`,
          );
          break;
        }
        rejectedCount += 1;
        logJob(
          job,
          `第 ${target.index} 章修复证据不足，需要作者决定；未生成候选稿，原正文保持不变：${error.message}`,
        );
        continue;
      }
      if (
        error instanceof RepairPatchError ||
        error instanceof RepairPlanRejectedError
      ) {
        rejectedCount += 1;
        logJob(
          job,
          `第 ${target.index} 章修复补丁未通过校验，整批未应用，原正文保持不变：${error.message}`,
        );
        continue;
      }
      throw new Error(`第 ${target.index} 章定点修复调用失败：${errorMessage(error)}`);
    }
    if (!text.trim()) throw new Error(`第 ${target.index} 章定点修复返回空正文`);

    // 3) 独立审校候选稿：只审校，不再自动续修，确保写回的正是被验收的文本。
    logJob(job, `第 ${target.index} 章候选稿完成，开始独立审校…`);
    const result = await verifyChapter({
      job,
      project: detail,
      meta: detail.meta,
      bible: detail.bible,
      characters: detail.characters,
      chapter: chapterPlan,
      text,
      canon,
      memory,
      story,
      previousEnding,
      previousSummaries: priorSummaries.slice(-2),
      nextOpening,
      nextSummary,
      mode: "rewrite",
      rewriteInstruction: `根据${sourceLabel}做定点修复。`,
      reviewFeedback: "",
      maxRepairs: 0,
      evidenceContext: evidence.text,
    });
    throwIfCancelled(job);
    let candidateText = result.text;

    if (isPauseRequested(job)) {
      const draft = await saveRejectedDraft(job.slug, {
        index: target.index,
        content: candidateText,
        mode: "rewrite",
        reason: "候选稿审校完成后任务暂停，未写入正文",
        review: result.review,
      });
      paused = true;
      job.result = `已暂停：第 ${target.index} 章候选稿保存在草稿`;
      logJob(
        job,
        `第 ${target.index} 章候选稿审校后任务已暂停，候选稿保存在 ${draft.path}，原正文未改动。`,
      );
      break;
    }

    // 审校或抽取失败时无法验收：保存候选稿，原正文保持不变。
    if (result.auditFailed || result.review.extractionOk === false) {
      const reason = result.auditFailed
        ? "连续性审校服务失败，修复稿未经审校，未覆盖原稿"
        : "事实抽取失败，无法确认修复稿是否破坏既定事实，未覆盖原稿";
      const draft = await saveRejectedDraft(job.slug, {
        index: target.index,
        content: candidateText,
        mode: "rewrite",
        reason,
        review: result.review,
      });
      paused = true;
      job.result = `第 ${target.index} 章修复稿未覆盖原稿，草稿已保存`;
      logJob(
        job,
        `第 ${target.index} 章${result.auditFailed ? "连续性审校服务失败" : "事实抽取失败"}（不是正文问题），修复稿未通过验收也未覆盖原稿；候选稿保存在 ${draft.path}。修复已暂停，请检查模型配置后重试。`,
      );
      break;
    }

    // 4) 新增严重问题必须由独立调用确认；只有 confirmed_new 才进入第二轮。
    let ignoredAdded: ContinuityIssue[] = [];
    let ignoredAddedKeys = new Set<string>();
    if (allowsGroupedRepair) {
      const baselineComparison = compareToBaseline(
        repairBaseline,
        result.review,
        detail.characters,
      );
      const addedCritical = baselineComparison.added.filter(
        (issue) => issue.severity === "critical",
      );
      if (addedCritical.length) {
        logJob(
          job,
          `第 ${target.index} 章候选稿出现 ${addedCritical.length} 个疑似新增严重问题，交给独立确认…`,
        );
        const confirmations = await confirmRepairRegressions({
          meta: detail.meta,
          chapter: chapterPlan,
          originalText: target.content,
          candidateText,
          baseline: repairBaseline,
          newIssues: addedCritical,
          evidenceContext: evidence.text,
        });
        const outcome = summarizeConfirmations(confirmations);
        if (outcome.schemeFailure) {
          const draft = await saveRejectedDraft(job.slug, {
            index: target.index,
            content: candidateText,
            mode: "rewrite",
            reason: "第一次修复方案本身不成立（新增问题属于方案级失败），未写入正文，需要作者重新选择方案",
            review: result.review,
          });
          rejectedCount += 1;
          logJob(
            job,
            `第 ${target.index} 章新增问题表明第一次修复方案本身不成立，停止在错误方案上继续打补丁；候选稿保存在 ${draft.path}。`,
          );
          continue;
        }
        if (outcome.uncertain.length) {
          const draft = await saveRejectedDraft(job.slug, {
            index: target.index,
            content: candidateText,
            mode: "rewrite",
            reason: `新增严重问题无法独立确认（${outcome.uncertain.length} 个 uncertain），需要作者确认`,
            review: result.review,
          });
          paused = true;
          job.result = `第 ${target.index} 章需要作者确认新增问题`;
          logJob(
            job,
            `第 ${target.index} 章有 ${outcome.uncertain.length} 个新增严重问题无法确认是否由本次修复引入，已停止自动修复；候选稿保存在 ${draft.path}。`,
          );
          break;
        }
        ignoredAdded = outcome.ignored;
        ignoredAddedKeys = new Set(
          ignoredAdded.map((issue) => `${issue.type}|${issue.evidence}|${issue.detail}`),
        );
        if (!outcome.confirmedNew.length) {
          logJob(
            job,
            `第 ${target.index} 章疑似新增严重问题经独立确认均非本次修复引入（pre_existing/false_positive），不阻断验收。`,
          );
        } else {
          logJob(
            job,
            `第 ${target.index} 章确认 ${outcome.confirmedNew.length} 个新增严重问题，进入第二轮定点修复（只处理这些新增问题）。`,
          );
          const round2Issues = withIssueIds(outcome.confirmedNew);
          const protectedIds = baselineComparison.resolved
            .map((issue) => issue.id)
            .filter((id): id is string => Boolean(id));
          const round2Directive = [
            authorDirective,
            `第二轮只允许修复新增问题：${round2Issues
              .map((issue) => issue.id)
              .join("、")}；不得重新处理已解决的原问题：${
              protectedIds.join("、") || "无"
            }；不得修改第一轮授权锚点之外的段落。`,
          ]
            .filter(Boolean)
            .join("\n");
          try {
            const plan2 = await repairChapterPatches(
              detail.meta,
              chapterPlan,
              candidateText,
              round2Issues,
              canonForChapter(canon, target.index),
              previousEnding,
              nextOpening,
              "第二轮只修复第一次修复新增的严重问题，不得重做已解决的原问题。",
              "",
              {
                evidenceContext: evidence.text,
                authorDirective: round2Directive,
                affectedChapters: [target.index],
              },
            );
            const [batch2] = applyRepairPatchesAcross({
              chapters: [
                {
                  index: target.index,
                  text: candidateText,
                  extraAuthorizedAnchors: plan2.authorizedAnchors,
                },
              ],
              targetIndex: target.index,
              patches: plan2.patches,
              issues: round2Issues,
            });
            if (!batch2) {
              throw new RepairPatchError(
                "UNCOVERED_ISSUE",
                "第二轮补丁没有修改目标章节",
              );
            }
            logPatchBatch(job, batch2.chapterIndex, batch2);
            candidateText = batch2.text;
            causalBaselines = [
              ...causalBaselines,
              ...(plan2.causalBaselines ?? []),
            ];
            if (plan2.regressionScope) {
              regressionScope = [regressionScope, plan2.regressionScope]
                .filter(Boolean)
                .join("；");
            }
          } catch (error) {
            const draft = await saveRejectedDraft(job.slug, {
              index: target.index,
              content: candidateText,
              mode: "rewrite",
              reason: `第二轮修复未生成可用补丁：${errorMessage(error)}`,
              review: result.review,
            });
            rejectedCount += 1;
            logJob(
              job,
              `第 ${target.index} 章第二轮修复未生成可用补丁，停止自动修复；候选稿保存在 ${draft.path}。`,
            );
            continue;
          }
          logJob(job, `第 ${target.index} 章第二轮候选稿完成，重新独立审校…`);
          const second = await verifyChapter({
            job,
            project: detail,
            meta: detail.meta,
            bible: detail.bible,
            characters: detail.characters,
            chapter: chapterPlan,
            text: candidateText,
            canon,
            memory,
            story,
            previousEnding,
            previousSummaries: priorSummaries.slice(-2),
            nextOpening,
            nextSummary,
            mode: "rewrite",
            rewriteInstruction: "第二轮定点修复后的独立审校。",
            reviewFeedback: "",
            maxRepairs: 0,
            evidenceContext: evidence.text,
          });
          throwIfCancelled(job);
          if (isPauseRequested(job)) {
            const draft = await saveRejectedDraft(job.slug, {
              index: target.index,
              content: second.text,
              mode: "rewrite",
              reason: "第二轮候选稿审校完成后任务暂停，未写入正文",
              review: second.review,
            });
            paused = true;
            job.result = `已暂停：第 ${target.index} 章第二轮候选稿保存在草稿`;
            logJob(
              job,
              `第 ${target.index} 章第二轮候选稿审校后任务已暂停，候选稿保存在 ${draft.path}，原正文未改动。`,
            );
            break;
          }
          if (second.auditFailed || second.review.extractionOk === false) {
            const draft = await saveRejectedDraft(job.slug, {
              index: target.index,
              content: second.text,
              mode: "rewrite",
              reason: "第二轮候选稿审校或事实抽取失败，未覆盖原稿",
              review: second.review,
            });
            paused = true;
            job.result = `第 ${target.index} 章第二轮候选稿未覆盖原稿`;
            logJob(
              job,
              `第 ${target.index} 章第二轮候选稿审校或抽取失败（不是正文问题），未写入正文；候选稿保存在 ${draft.path}。`,
            );
            break;
          }
          candidateText = second.text;
          const secondComparison = compareToBaseline(
            repairBaseline,
            second.review,
            detail.characters,
          );
          const secondAdded = secondComparison.added.filter(
            (issue) =>
              issue.severity === "critical" &&
              !ignoredAddedKeys.has(`${issue.type}|${issue.evidence}|${issue.detail}`),
          );
          const stillNew = compareCriticalIssues(
            round2Issues,
            second.review.issues,
            detail.characters,
          ).remaining;
          if (
            secondComparison.remaining.length ||
            secondAdded.length ||
            stillNew.length
          ) {
            const draft = await saveRejectedDraft(job.slug, {
              index: target.index,
              content: candidateText,
              mode: "rewrite",
              reason: `第二轮修复仍未通过验收：原问题遗留 ${secondComparison.remaining.length}，新增 ${secondAdded.length}，第二轮问题未解决 ${stillNew.length}`,
              review: second.review,
            });
            rejectedCount += 1;
            logJob(
              job,
              `第 ${target.index} 章第二轮修复仍未通过验收（原问题遗留 ${secondComparison.remaining.length}，新增 ${secondAdded.length}，未解决 ${stillNew.length}），停止自动修复；候选稿保存在 ${draft.path}。`,
            );
            continue;
          }
          Object.assign(result, second);
          logJob(
            job,
            `第 ${target.index} 章第二轮修复完成：原始严重问题与确认的新增问题均已解决，停止自动修复（不进行第三轮）。`,
          );
        }
      }
    }

    // 5) 统一验收：原问题全部解决、无新增严重问题或警告、事实未被破坏。
    const acceptance = evaluateRepair({
      before: issues,
      after: result.review.issues.filter(
        (issue) => !ignoredAddedKeys.has(`${issue.type}|${issue.evidence}|${issue.detail}`),
      ),
      characters: detail.characters,
      extractionOk: true,
      auditFailed: false,
      factConflicts: result.factConflicts,
      allowNoBaseline,
    });

    if (!acceptance.accepted) {
      const draft = await saveRejectedDraft(job.slug, {
        index: target.index,
        content: candidateText,
        mode: "rewrite",
        reason: `定点修复未通过验收（${acceptance.status}）：${describeAcceptance(acceptance)}`,
        review: result.review,
      });
      rejectedCount += 1;
      logJob(
        job,
        `第 ${target.index} 章定点修复未通过验收（${acceptance.status}）：${describeAcceptance(acceptance)}；原正文保持不变，候选稿保存在 ${draft.path}。`,
      );
      continue;
    }

    // 跨章方案修改的此前章节也必须独立审校并通过验收。
    const changedCross = changedChapters.filter(
      (batch) => batch.chapterIndex !== target.index,
    );
    const crossResults = new Map<number, VerifyChapterResult>();
    let crossRejected = false;
    for (const batch of changedCross) {
      const sourceChapter = detail.chapters.find(
        (item) => item.index === batch.chapterIndex,
      );
      if (!sourceChapter) continue;
      const crossPlan =
        detail.plan.chapters.find((item) => item.index === batch.chapterIndex) ?? {
          index: batch.chapterIndex,
          title: sourceChapter.title,
          summary: "",
          keyBeats: [],
        };
      logJob(
        job,
        `第 ${target.index} 章按方案修改了第 ${batch.chapterIndex} 章，开始独立审校…`,
      );
      const audited = await verifyChapter({
        job,
        project: detail,
        meta: detail.meta,
        bible: detail.bible,
        characters: detail.characters,
        chapter: crossPlan,
        text: batch.text,
        canon,
        memory,
        story,
        previousEnding: "",
        previousSummaries: [],
        nextOpening: "",
        nextSummary: "",
        mode: "rewrite",
        rewriteInstruction: "跨章根因修复后的独立审校。",
        reviewFeedback: "",
        maxRepairs: 0,
        evidenceContext: evidence.text,
      });
      throwIfCancelled(job);
      if (audited.auditFailed || audited.review.extractionOk === false) {
        const draft = await saveRejectedDraft(job.slug, {
          index: target.index,
          content: candidateText,
          mode: "rewrite",
          reason: `跨章修改第 ${batch.chapterIndex} 章时审校或事实抽取失败，未采用任何修改`,
          review: result.review,
        });
        paused = true;
        job.result = `已暂停：第 ${batch.chapterIndex} 章跨章审校未完成`;
        logJob(
          job,
          `第 ${batch.chapterIndex} 章跨章修改后的审校或抽取失败（不是正文问题），所有正文未改动；候选稿保存在 ${draft.path}，已暂停。`,
        );
        crossRejected = true;
        break;
      }
      const crossAcceptance = evaluateRepair({
        before: crossBaselines.get(batch.chapterIndex) ?? [],
        after: audited.review.issues,
        characters: detail.characters,
        extractionOk: true,
        auditFailed: false,
        factConflicts: audited.factConflicts,
        allowNoBaseline: true,
      });
      if (!crossAcceptance.accepted) {
        const draft = await saveRejectedDraft(job.slug, {
          index: target.index,
          content: candidateText,
          mode: "rewrite",
          reason: `跨章修改第 ${batch.chapterIndex} 章未通过验收（${crossAcceptance.status}）：${describeAcceptance(crossAcceptance)}`,
          review: { ...result.review, issues: [...result.review.issues, ...audited.review.issues] },
        });
        rejectedCount += 1;
        logJob(
          job,
          `第 ${batch.chapterIndex} 章跨章修改未通过验收（${crossAcceptance.status}）：${describeAcceptance(crossAcceptance)}；所有正文未改动，候选稿保存在 ${draft.path}。`,
        );
        crossRejected = true;
        break;
      }
      crossResults.set(batch.chapterIndex, audited);
    }
    if (crossRejected) {
      if (paused) break;
      continue;
    }

    // 5) 修复后回归审校：来源章节因果、相邻章节、人物时间线和伏笔生命周期。
    logJob(job, `第 ${target.index} 章通过问题验收，执行修复后回归审校…`);
    let regression: RegressionAuditResult;
    try {
      regression = await auditRepairRegression(
        detail.meta,
        canonForChapter(canon, target.index),
        detail.characters,
        chapterPlan,
        target.content,
        candidateText,
        evidence.text,
        previousEnding,
        nextOpening,
        regressionScope,
        causalBaselines,
      );
    } catch (error) {
      if (error instanceof JobCancelledError) throw error;
      const draft = await saveRejectedDraft(job.slug, {
        index: target.index,
        content: candidateText,
        mode: "rewrite",
        reason: "修复后回归审校失败，无法确认是否引入新矛盾，未覆盖原稿",
        review: result.review,
      });
      paused = true;
      job.result = `第 ${target.index} 章修复稿未覆盖原稿，草稿已保存`;
      logJob(
        job,
        `第 ${target.index} 章修复后回归审校服务失败（不是正文问题），候选稿未覆盖原稿；修复稿保存在 ${draft.path}。修复已暂停，请检查模型配置后重试。`,
      );
      break;
    }
    throwIfCancelled(job);
    if (isPauseRequested(job)) {
      const draft = await saveRejectedDraft(job.slug, {
        index: target.index,
        content: candidateText,
        mode: "rewrite",
        reason: "修复已通过问题验收，但任务暂停，候选稿未写入正文",
        review: result.review,
      });
      paused = true;
      job.result = `已暂停：第 ${target.index} 章修复稿保存在草稿`;
      logJob(
        job,
        `第 ${target.index} 章回归审校完成前任务已暂停，候选稿保存在 ${draft.path}，原正文未改动。`,
      );
      break;
    }

    // 回归审校中的 warning/ignore 只记录，不因为数组非空就阻断写回。
    const regressionCritical = regression.issues.filter(
      (issue) => issue.severity === "critical",
    );
    const regressionAcceptance = evaluateRepair({
      before: issues,
      after: [
        ...result.review.issues.filter(
          (issue) =>
            !ignoredAddedKeys.has(`${issue.type}|${issue.evidence}|${issue.detail}`),
        ),
        ...regressionCritical,
      ],
      characters: detail.characters,
      extractionOk: true,
      auditFailed: false,
      factConflicts: [...(result.factConflicts ?? []), ...regressionCritical],
      // 基线是否为空已由问题验收阶段判定；回归阶段只检查新增问题和因果变化。
      allowNoBaseline: true,
      causalChanges: regression.causalChanges,
      causalVerified: regression.causalVerified,
    });
    if (regression.issues.length > regressionCritical.length) {
      logJob(
        job,
        `第 ${target.index} 章回归审校另有 ${regression.issues.length - regressionCritical.length} 条 warning/ignore，已记录，不阻断写回。`,
      );
    }
    if (regressionCritical.length || !regressionAcceptance.accepted) {
      const draft = await saveRejectedDraft(job.slug, {
        index: target.index,
        content: candidateText,
        mode: "rewrite",
        reason: `修复后回归审校未通过（${regressionAcceptance.status}）：${describeAcceptance(regressionAcceptance)}`,
        review: {
          ...result.review,
          issues: [...result.review.issues, ...regressionCritical],
        },
      });
      rejectedCount += 1;
      logJob(
        job,
        `第 ${target.index} 章修复后回归审校未通过（${regressionAcceptance.status}）：${describeAcceptance(regressionAcceptance)}；未覆盖原稿，候选稿保存在 ${draft.path}。`,
      );
      continue;
    }

    // 6) 写回前重新读取正文并比对哈希：修复期间用户手改过则拒绝覆盖。
    const latest = await getProjectDetail(job.slug);
    const currentChapter = latest.chapters.find(
      (chapter) => chapter.index === target.index,
    );
    if (hashText(currentChapter?.content ?? "") !== baselineHash) {
      const draft = await saveRejectedDraft(job.slug, {
        index: target.index,
        content: candidateText,
        mode: "rewrite",
        reason:
          "修复期间正文已被修改（原文哈希不一致），未覆盖新内容；请基于最新正文重新审校修复",
        review: result.review,
      });
      rejectedCount += 1;
      logJob(
        job,
        `第 ${target.index} 章修复期间正文已被修改，哈希与修复开始时不一致；未覆盖用户新内容，候选稿保存在 ${draft.path}，请重新审校修复。`,
      );
      continue;
    }
    let crossHashConflict = false;
    for (const batch of changedCross) {
      const live = latest.chapters.find(
        (chapter) => chapter.index === batch.chapterIndex,
      );
      if (hashText(live?.content ?? "") !== (crossHashes.get(batch.chapterIndex) ?? "")) {
        const draft = await saveRejectedDraft(job.slug, {
          index: target.index,
          content: candidateText,
          mode: "rewrite",
          reason: `修复期间第 ${batch.chapterIndex} 章正文已被修改（哈希不一致），未采用跨章修改`,
          review: result.review,
        });
        rejectedCount += 1;
        crossHashConflict = true;
        logJob(
          job,
          `第 ${batch.chapterIndex} 章在跨章修复期间已被修改，哈希不一致；所有正文未改动，候选稿保存在 ${draft.path}。`,
        );
        break;
      }
    }
    if (crossHashConflict) continue;

    // 7) 只有通过统一验收、回归审校和哈希校验才备份并写回正式正文。
    for (const batch of changedCross) {
      const sourceChapter = detail.chapters.find(
        (item) => item.index === batch.chapterIndex,
      );
      const audited = crossResults.get(batch.chapterIndex);
      if (!sourceChapter || !audited) continue;
      const crossPlan =
        detail.plan.chapters.find((item) => item.index === batch.chapterIndex) ?? {
          index: batch.chapterIndex,
          title: sourceChapter.title,
          summary: "",
          keyBeats: [],
        };
      const crossBackup = await saveRepairBackup(
        job.slug,
        batch.chapterIndex,
        sourceChapter.content,
      );
      await writeChapterFile(job.slug, batch.chapterIndex, batch.text, {
        source: "ai-repair",
        title: crossPlan.title,
        summary: audited.review.summary,
        note: "跨章根因修复（作者确认方案）",
      });
      repaired.set(batch.chapterIndex, batch.text);
      await markChapterWritten(
        job.slug,
        batch.chapterIndex,
        audited.review.summary,
        audited.review,
      );
      await markChapterRepaired(job.slug, batch.chapterIndex);
      markDetailChapterWritten(
        detail,
        batch.chapterIndex,
        batch.text,
        audited.review.summary,
      );
      logJob(
        job,
        `第 ${batch.chapterIndex} 章按作者确认方案完成跨章修复并写回，原稿备份在 ${crossBackup}。`,
      );
    }
    const backupPath = await saveRepairBackup(job.slug, target.index, target.content);

    await writeChapterFile(job.slug, target.index, candidateText, {
      source: "ai-repair",
      title: chapterPlan.title,
      summary: result.review.summary,
      note: `定点修复（${sourceLabel}）`,
    });
    repaired.set(target.index, candidateText);
    await markChapterWritten(job.slug, target.index, result.review.summary, result.review);
    await markChapterRepaired(job.slug, target.index);
    markDetailChapterWritten(detail, target.index, candidateText, result.review.summary);

    let candidateCanon = result.canon;
    for (const batch of changedCross) {
      const audited = crossResults.get(batch.chapterIndex);
      if (audited) candidateCanon = audited.canon;
    }
    const reconciled = reconcileCanonWithChapters(candidateCanon, [
      ...changedCross.map((batch) => ({
        index: batch.chapterIndex,
        content: batch.text,
      })),
      { index: target.index, content: candidateText },
    ]);
    canon = reconciled.canon;
    if (reconciled.changes.length) {
      logJob(
        job,
        `第 ${target.index} 章定点修复后对账：${reconciled.changes.join("；")}`,
      );
    }
    await saveCanon(job.slug, canon);
    for (const batch of changedCross) {
      const audited = crossResults.get(batch.chapterIndex);
      if (!audited) continue;
      memory = await persistChapterMemory(job, detail, memory, audited.memory);
      story = await persistChapterStory(
        job,
        detail,
        memory,
        story,
        audited.memory,
        audited.story,
      );
    }
    memory = await persistChapterMemory(job, detail, memory, result.memory);
    story = await persistChapterStory(job, detail, memory, story, result.memory, result.story);
    // 修复后的正文同样要与计划台账对账；只记录计划执行情况，不改写正文。
    for (const index of [...changedCross.map((batch) => batch.chapterIndex), target.index]) {
      const audited = index === target.index ? result : crossResults.get(index);
      if (!audited) continue;
      const planReconciled = reconcileChapterPlan({
        ledger: planLedger,
        chapter: index,
        chapterMemory: audited.memory,
        extracted: audited.story,
        storyEvents: story.events,
        canon,
      });
      planLedger = planReconciled.ledger;
    }
    await savePlanLedger(job.slug, planLedger);
    remainingCritical += countCritical(result.review.issues);
    repairedCount += 1;
    logJob(
      job,
      `第 ${target.index} 章定点修复通过验收并写回正文：${describeAcceptance(acceptance)}；原稿备份在 ${backupPath}。`,
    );
  }

  if (paused) {
    job.result = `已暂停：写回 ${repairedCount} 章正文，${rejectedCount} 章未通过验收`;
    logJob(
      job,
      `已暂停定点修复：共写回 ${repairedCount} 章正文，${rejectedCount} 章未通过验收且原稿未改动；剩余章节未处理，稍后可再次启动继续修复。`,
    );
    return true;
  }

  job.result = rejectedCount
    ? `已改写 ${repairedCount} 章正文，${rejectedCount} 章未通过验收`
    : remainingCritical
      ? `已改写 ${repairedCount} 章正文，仍有 ${remainingCritical} 个严重问题`
      : `已完成 ${repairedCount} 章正文定点修复`;
  logJob(
    job,
    `定点修复完成，共写回 ${repairedCount} 章正文${
      rejectedCount ? `，${rejectedCount} 章未通过验收、原稿未改动` : ""
    }；${
      source === "audit"
        ? "总体审校报告是修复前的快照，如需最新全书结论请重新运行总体审校。"
        : "遗留问题已更新到章节审校。"
    }`,
  );
  return false;
}

async function runDraftRepair(job: Job, requested: number[]): Promise<boolean> {
  const detail = await getProjectDetail(job.slug);
  const requestedSet = new Set(requested);
  const drafts = Object.values(detail.state.rejectedDrafts ?? {})
    .filter((draft) => requestedSet.has(draft.index))
    .sort((a, b) => a.index - b.index);

  if (!drafts.length) throw new Error("没有找到可修复的未采用草稿");

  assertCanonReady(detail);
  logPromptProfile(job);

  const takeEnding = (text: string): string => {
    const trimmed = text.trim();
    return trimmed.length > 1500 ? `……${trimmed.slice(-1500)}` : trimmed;
  };
  const takeOpening = (text: string): string => {
    const trimmed = text.trim();
    return trimmed.length > 800 ? `${trimmed.slice(0, 800)}……` : trimmed;
  };

  let canon = detail.canon;
  let memory = await getMemory(job.slug);
  let story = buildEffectiveStory(detail, memory, await getStory(job.slug));
  let planLedger = detail.planLedger ?? emptyPlanLedger(detail.meta.updatedAt);
  let adopted = 0;
  let failed = 0;
  let paused = false;

  logJob(
    job,
    `准备让修复 Agent 处理第 ${drafts.map((draft) => draft.index).join("、")} 章未采用草稿…`,
  );

  for (const requestedDraft of drafts) {
    throwIfCancelled(job);
    if (isPauseRequested(job)) {
      paused = true;
      break;
    }

    const chapterPlan = detail.plan.chapters.find(
      (chapter) => chapter.index === requestedDraft.index,
    );
    if (!chapterPlan) {
      failed += 1;
      logJob(
        job,
        `第 ${requestedDraft.index} 章不在当前大纲中，草稿无法采用，请先恢复对应章节细纲。`,
      );
      continue;
    }

    const retrieved = await getRejectedDraftContent(job.slug, requestedDraft.index);
    if (!retrieved) {
      failed += 1;
      logJob(job, `第 ${requestedDraft.index} 章未采用草稿已不存在，跳过。`);
      continue;
    }
    const draft = retrieved.draft;
    const existing = detail.chapters.find(
      (chapter) => chapter.index === requestedDraft.index,
    );
    // 草稿修复期间若正式正文被手改，采用草稿时不能覆盖用户新内容。
    const baselineHash = hashText(existing?.content ?? "");
    const previous = detail.chapters
      .filter(
        (chapter) =>
          chapter.index < requestedDraft.index &&
          chapter.written &&
          chapter.content.trim(),
      )
      .sort((a, b) => b.index - a.index)[0];
    const next = detail.chapters
      .filter(
        (chapter) =>
          chapter.index > requestedDraft.index &&
          chapter.written &&
          chapter.content.trim(),
      )
      .sort((a, b) => a.index - b.index)[0];
    const previousEnding = previous ? takeEnding(previous.content) : "";
    const nextOpening = next ? takeOpening(next.content) : "";
    const nextSummary = next
      ? detail.state.summaries[String(next.index)] ??
        detail.plan.chapters.find((chapter) => chapter.index === next.index)?.summary ??
        ""
      : "";
    const priorSummaries = Object.keys(detail.state.summaries)
      .map(Number)
      .filter((index) => index < requestedDraft.index)
      .sort((a, b) => a - b)
      .map((index) => detail.state.summaries[String(index)])
      .filter((item): item is string => Boolean(item));
    const savedIssues = draft.review?.issues ?? [];
    const seedCandidates = savedIssues.filter(
      (issue) =>
        issue.severity === "critical" &&
        issue.type !== "事实抽取失败" &&
        issue.type !== "审校失败",
    );
    const seedFilter = filterSeedIssues(seedCandidates, retrieved.content);
    const canSeed =
      draft.review?.extractionOk !== false &&
      seedCandidates.length > 0 &&
      seedFilter.active.length === seedCandidates.length;
    if (canSeed) {
      logJob(
        job,
        `第 ${requestedDraft.index} 章沿用原草稿审校的 ${seedCandidates.length} 个严重问题直接修复（最多 2 轮）…`,
      );
    } else if (seedCandidates.length) {
      logJob(
        job,
        `第 ${requestedDraft.index} 章原审校记录有 ${seedFilter.stale.length} 个问题与当前草稿不匹配，先重新审校原稿再修复，避免按过期意见改稿。`,
      );
    } else {
      logJob(
        job,
        `第 ${requestedDraft.index} 章没有可用的旧审校问题，先重新审校原稿再修复。`,
      );
    }

    const decision = job.params.decisionId
      ? await getRepairDecision(job.slug, job.params.decisionId)
      : undefined;
    const decisionOption =
      decision &&
      decision.chapterIndex === requestedDraft.index &&
      decision.chosenIndex !== undefined
        ? decision.options[decision.chosenIndex]
        : undefined;
    const crossChapters: Record<number, string> = {};
    const crossAnchors: Record<number, string[]> = {};
    const crossBaselines = new Map<number, ContinuityIssue[]>();
    const crossHashes = new Map<number, string>();
    let crossBaselineFailed = false;
    if (decisionOption) {
      logJob(
        job,
        `第 ${requestedDraft.index} 章按作者确认方案「${decisionOption.label}」执行跨章修复。`,
      );
      for (const index of decisionOption.affectedChapters) {
        if (index === requestedDraft.index) continue;
        const sourceChapter = detail.chapters.find(
          (item) => item.index === index && item.written && item.content.trim(),
        );
        if (!sourceChapter) continue;
        crossChapters[index] = sourceChapter.content;
        crossAnchors[index] = decisionOption.anchors;
        crossHashes.set(index, hashText(sourceChapter.content));
        logJob(
          job,
          `第 ${requestedDraft.index} 章跨章修复前，先对第 ${index} 章做基线审校…`,
        );
        const baseline = await verifyChapter({
          job,
          project: detail,
          meta: detail.meta,
          bible: detail.bible,
          characters: detail.characters,
          chapter:
            detail.plan.chapters.find((item) => item.index === index) ?? {
              index,
              title: sourceChapter.title,
              summary: "",
              keyBeats: [],
            },
          text: sourceChapter.content,
          canon,
          memory,
          story,
          previousEnding: "",
          previousSummaries: [],
          nextOpening: "",
          nextSummary: "",
          mode: "rewrite",
          rewriteInstruction: "跨章修复前的基线审校。",
          reviewFeedback: "",
          maxRepairs: 0,
        });
        if (baseline.auditFailed || baseline.review.extractionOk === false) {
          crossBaselineFailed = true;
          paused = true;
          job.result = `已暂停：第 ${index} 章基线审校未完成`;
          logJob(
            job,
            `第 ${index} 章跨章修复基线审校失败（不是正文问题），原正文与草稿均未改动；已暂停。`,
          );
          break;
        }
        crossBaselines.set(
          index,
          baseline.review.issues.filter((issue) => issue.severity !== "ignore"),
        );
      }
    }
    if (crossBaselineFailed) break;
    const crossChapterContext = Object.entries(crossChapters)
      .map(([index, text]) => `第 ${index} 章：\n${text.slice(0, 6000)}`)
      .join("\n\n");
    const authorDirective = decisionOption
      ? `方案：${decisionOption.label}\n${decisionOption.description}\n涉及章节：第 ${decisionOption.affectedChapters.join("、")} 章\n必须保留/修改的原文锚点：\n${decisionOption.anchors
          .map((anchor) => `- ${anchor}`)
          .join("\n")}`
      : undefined;

    logJob(
      job,
      `开始修复第 ${requestedDraft.index} 章《${chapterPlan.title}》未采用草稿…`,
    );
    const result = await verifyDraftChapter({
      job,
      project: detail,
      meta: detail.meta,
      bible: detail.bible,
      characters: detail.characters,
      chapter: chapterPlan,
      text: retrieved.content,
      canon,
      memory,
      story,
      previousEnding,
      previousSummaries: priorSummaries.slice(-2),
      nextOpening,
      nextSummary,
      mode: draft.mode,
      rewriteInstruction: "这是未采用草稿，只修复审校指出的问题，不要重写无关段落。",
      reviewFeedback: "",
      seedIssues: canSeed ? seedFilter.active : [],
      seedReview: draft.review,
      maxRepairs: 2,
      authorDirective,
      crossChapters,
      crossAnchors,
      crossChapterContext,
    });
    throwIfCancelled(job);
    if (!result.text.trim()) {
      throw new Error(`第 ${requestedDraft.index} 章草稿修复返回空正文`);
    }

    // 暂停必须立即生效：不再发起下一轮审校/修复，也不改写草稿文件。
    if (result.stopReason === "paused") {
      paused = true;
      logJob(
        job,
        `第 ${requestedDraft.index} 章草稿修复已暂停，后续模型调用未执行；草稿与正文均未改动。`,
      );
      break;
    }

    // 冲突根源在更早章节时，模型给出互斥方案：保存决策并暂停，等作者确认后带 decisionId 重跑。
    if (
      result.needsAuthorDecision &&
      !decisionOption &&
      result.decisionOptions?.length
    ) {
      const created = await createRepairDecision({
        slug: job.slug,
        chapterIndex: requestedDraft.index,
        source: "draft",
        params: { indices: [requestedDraft.index], source: "draft" },
        jobId: job.id,
        reason: result.decisionReason ?? "冲突根源在更早章节，需要作者确认修复方向",
        issues: result.initialIssues,
        options: result.decisionOptions,
      });
      const updated = await saveRejectedDraft(job.slug, {
        index: requestedDraft.index,
        content: result.text,
        mode: draft.mode,
        reason: `需要作者确认修复方向：${created.reason}`,
        review: result.review,
      });
      detail.state.rejectedDrafts[String(requestedDraft.index)] = updated;
      paused = true;
      job.result = `第 ${requestedDraft.index} 章需要作者确认修复方向`;
      logJob(
        job,
        `第 ${requestedDraft.index} 章冲突涉及更早章节，已生成 ${created.options.length} 个互斥修复方案等待作者确认（决策 ${created.id}）；草稿未写入正文。`,
      );
      break;
    }

    const extractionFailed =
      result.extractionFailed || result.review.extractionOk === false;
    const auditFailed =
      result.auditFailed === true || result.stopReason === "audit-failed";
    // 草稿修复也走统一验收；有实际修复轮次时，即使数量减少也不能直接采用。
    const acceptance = evaluateRepair({
      before: result.initialIssues,
      after: result.review.issues,
      characters: detail.characters,
      extractionOk: !extractionFailed,
      auditFailed,
      factConflicts: result.factConflicts,
      needsAuthorDecision: result.needsAuthorDecision === true,
    });
    const acceptanceRequired = result.repairCalls > 0;

    if (!result.passed || (acceptanceRequired && !acceptance.accepted)) {
      const critical = countCritical(result.review.issues);
      // 迭代过程的“最后对比”和最终文本的验收对比可能不同，两者都要保留。
      const comparisonText = result.comparison
        ? `严重问题 ${result.initialCriticalCount}→${result.finalCriticalCount}；最后对比：已解决 ${result.comparison.resolved.length}，仍存在 ${result.comparison.remaining.length}，新增 ${result.comparison.added.length}`
        : `仍有 ${critical} 个严重问题`;
      const reason = result.needsAuthorDecision
        ? `自动修复暂停：修复证据不足，需要作者决定（${comparisonText}）`
        : auditFailed
          ? "自动修复未完成：连续性审校失败，已保留最佳草稿，需要人工处理"
          : extractionFailed
            ? "自动修复未完成：修复后事实抽取失败，已保留最佳草稿，需要人工处理"
            : `自动修复未通过统一验收（${acceptance.status}），需要人工处理：${comparisonText}${acceptance.reasons.length ? `；${acceptance.reasons.join("")}` : ""}`;
      const updated = await saveRejectedDraft(job.slug, {
        index: requestedDraft.index,
        content: result.text,
        mode: draft.mode,
        reason,
        review: result.review,
      });
      detail.state.rejectedDrafts[String(requestedDraft.index)] = updated;
      failed += 1;
      const outcome = auditFailed
        ? `第 ${requestedDraft.index} 章草稿修复连续性审校失败`
        : extractionFailed
          ? `第 ${requestedDraft.index} 章草稿修复后事实抽取失败`
          : `第 ${requestedDraft.index} 章草稿修复未通过验收（${acceptance.status}）`;
      logJob(
        job,
        `${outcome}，未写入正文；repair-editor 调用 ${result.repairCalls} 次，停止原因：${result.stopReason}。${comparisonText}。新草稿保存在 ${updated.path}，原正文未改动。`,
      );
      continue;
    }

    // 修复后回归审校：不能只看修改段落，还要核对来源章节因果、相邻章节、时间线与伏笔。
    logJob(job, `第 ${requestedDraft.index} 章草稿通过问题验收，执行修复后回归审校…`);
    const regressionEvidence = collectRepairEvidence({
      project: detail,
      chapter: chapterPlan,
      issues: result.initialIssues,
      characters: detail.characters,
      canon: canonForChapter(canon, requestedDraft.index),
      story,
    });
    let regression: RegressionAuditResult;
    try {
      regression = await auditRepairRegression(
        detail.meta,
        canonForChapter(canon, requestedDraft.index),
        detail.characters,
        chapterPlan,
        retrieved.content,
        result.text,
        regressionEvidence.text,
        previousEnding,
        nextOpening,
        result.regressionScope,
        result.causalBaselines,
      );
    } catch (error) {
      if (error instanceof JobCancelledError) throw error;
      const updated = await saveRejectedDraft(job.slug, {
        index: requestedDraft.index,
        content: result.text,
        mode: draft.mode,
        reason: "修复后回归审校失败，无法确认是否引入新矛盾，未写入正文",
        review: result.review,
      });
      detail.state.rejectedDrafts[String(requestedDraft.index)] = updated;
      failed += 1;
      logJob(
        job,
        `第 ${requestedDraft.index} 章修复后回归审校服务失败（不是正文问题），未写入正文；草稿保存在 ${updated.path}。`,
      );
      continue;
    }
    throwIfCancelled(job);
    if (isPauseRequested(job)) {
      const updated = await saveRejectedDraft(job.slug, {
        index: requestedDraft.index,
        content: result.text,
        mode: draft.mode,
        reason: "修复已通过问题验收，但任务暂停，草稿未写入正文",
        review: result.review,
      });
      detail.state.rejectedDrafts[String(requestedDraft.index)] = updated;
      paused = true;
      logJob(
        job,
        `第 ${requestedDraft.index} 章回归审校完成前任务已暂停，草稿保存在 ${updated.path}，原正文未改动。`,
      );
      break;
    }

    // 回归 warning/ignore 只记录；只有 critical 才进入验收。
    const regressionCritical = regression.issues.filter(
      (issue) => issue.severity === "critical",
    );
    const mergedIssues = [...result.review.issues, ...regressionCritical];
    const regressionAcceptance = evaluateRepair({
      before: result.initialIssues,
      after: mergedIssues,
      characters: detail.characters,
      extractionOk: true,
      auditFailed: false,
      factConflicts: [...(result.factConflicts ?? []), ...regressionCritical],
      allowNoBaseline: true,
      causalChanges: regression.causalChanges,
      causalVerified: regression.causalVerified,
    });
    if (regression.issues.length > regressionCritical.length) {
      logJob(
        job,
        `第 ${requestedDraft.index} 章回归审校另有 ${regression.issues.length - regressionCritical.length} 条 warning/ignore，已记录，不阻断采用。`,
      );
    }
    if (regressionCritical.length || !regressionAcceptance.accepted) {
      const updated = await saveRejectedDraft(job.slug, {
        index: requestedDraft.index,
        content: result.text,
        mode: draft.mode,
        reason: `修复后回归审校未通过（${regressionAcceptance.status}）：${describeAcceptance(regressionAcceptance)}`,
        review: { ...result.review, issues: mergedIssues },
      });
      detail.state.rejectedDrafts[String(requestedDraft.index)] = updated;
      failed += 1;
      logJob(
        job,
        `第 ${requestedDraft.index} 章修复后回归审校未通过（${regressionAcceptance.status}）：${describeAcceptance(
          regressionAcceptance,
        )}；未写入正文，草稿保存在 ${updated.path}。`,
      );
      continue;
    }

    // 作者确认的跨章方案会同时修改此前章节：每个被改章节都要独立审校并通过验收。
    const changedCross = Object.keys(crossChapters)
      .map(Number)
      .filter((index) => result.crossTexts[index] !== crossChapters[index]);
    const crossResults = new Map<number, VerifyChapterResult>();
    let crossRejected = false;
    for (const index of changedCross) {
      const candidateText = result.crossTexts[index];
      const sourceChapter = detail.chapters.find((item) => item.index === index);
      if (!sourceChapter) continue;
      const crossPlan =
        detail.plan.chapters.find((item) => item.index === index) ?? {
          index,
          title: sourceChapter.title,
          summary: "",
          keyBeats: [],
        };
      logJob(
        job,
        `第 ${requestedDraft.index} 章按方案修改了第 ${index} 章，开始独立审校…`,
      );
      const audited = await verifyChapter({
        job,
        project: detail,
        meta: detail.meta,
        bible: detail.bible,
        characters: detail.characters,
        chapter: crossPlan,
        text: candidateText,
        canon,
        memory,
        story,
        previousEnding: "",
        previousSummaries: [],
        nextOpening: "",
        nextSummary: "",
        mode: "rewrite",
        rewriteInstruction: "跨章根因修复后的独立审校。",
        reviewFeedback: "",
        maxRepairs: 0,
        evidenceContext: regressionEvidence.text,
      });
      throwIfCancelled(job);
      if (audited.auditFailed || audited.review.extractionOk === false) {
        paused = true;
        const updated = await saveRejectedDraft(job.slug, {
          index: requestedDraft.index,
          content: result.text,
          mode: draft.mode,
          reason: `跨章修改第 ${index} 章时审校或事实抽取失败，未采用任何修改`,
          review: result.review,
        });
        detail.state.rejectedDrafts[String(requestedDraft.index)] = updated;
        job.result = `已暂停：第 ${index} 章跨章审校未完成`;
        logJob(
          job,
          `第 ${index} 章跨章修改后的审校或抽取失败（不是正文问题），草稿与所有正文均未改动；已暂停。`,
        );
        crossRejected = true;
        break;
      }
      const crossAcceptance = evaluateRepair({
        before: crossBaselines.get(index) ?? [],
        after: audited.review.issues,
        characters: detail.characters,
        extractionOk: true,
        auditFailed: false,
        factConflicts: audited.factConflicts,
        allowNoBaseline: true,
      });
      if (!crossAcceptance.accepted) {
        const updated = await saveRejectedDraft(job.slug, {
          index: requestedDraft.index,
          content: result.text,
          mode: draft.mode,
          reason: `跨章修改第 ${index} 章未通过验收（${crossAcceptance.status}）：${describeAcceptance(crossAcceptance)}`,
          review: { ...result.review, issues: [...result.review.issues, ...audited.review.issues] },
        });
        detail.state.rejectedDrafts[String(requestedDraft.index)] = updated;
        failed += 1;
        logJob(
          job,
          `第 ${index} 章跨章修改未通过验收（${crossAcceptance.status}）：${describeAcceptance(crossAcceptance)}；所有正文均未改动，草稿保存在 ${updated.path}。`,
        );
        crossRejected = true;
        break;
      }
      crossResults.set(index, audited);
    }
    if (crossRejected) {
      if (paused) break;
      continue;
    }

    // 采用前重新读取正式正文，确认修复期间没有被用户修改。
    const latest = await getProjectDetail(job.slug);
    const latestChapter = latest.chapters.find(
      (chapter) => chapter.index === requestedDraft.index,
    );
    if (hashText(latestChapter?.content ?? "") !== baselineHash) {
      const updated = await saveRejectedDraft(job.slug, {
        index: requestedDraft.index,
        content: result.text,
        mode: draft.mode,
        reason:
          "修复期间正式正文已被修改（原文哈希不一致），未采用草稿；请基于最新正文重新处理",
        review: result.review,
      });
      detail.state.rejectedDrafts[String(requestedDraft.index)] = updated;
      failed += 1;
      logJob(
        job,
        `第 ${requestedDraft.index} 章修复期间正式正文已被修改，哈希不一致；未采用草稿，原正文未改动，草稿保存在 ${updated.path}。`,
      );
      continue;
    }
    let crossHashConflict = false;
    for (const index of changedCross) {
      const live = latest.chapters.find((chapter) => chapter.index === index);
      if (hashText(live?.content ?? "") !== (crossHashes.get(index) ?? "")) {
        const updated = await saveRejectedDraft(job.slug, {
          index: requestedDraft.index,
          content: result.text,
          mode: draft.mode,
          reason: `修复期间第 ${index} 章正文已被修改（哈希不一致），未采用跨章修改`,
          review: result.review,
        });
        detail.state.rejectedDrafts[String(requestedDraft.index)] = updated;
        failed += 1;
        crossHashConflict = true;
        logJob(
          job,
          `第 ${index} 章在跨章修复期间已被修改，哈希不一致；所有正文未改动，草稿保存在 ${updated.path}。`,
        );
        break;
      }
    }
    if (crossHashConflict) continue;

    // 跨章修改先写回根因章节，再写回目标章节。
    for (const index of changedCross) {
      const sourceChapter = detail.chapters.find((item) => item.index === index);
      const audited = crossResults.get(index);
      if (!sourceChapter || !audited) continue;
      const crossPlan =
        detail.plan.chapters.find((item) => item.index === index) ?? {
          index,
          title: sourceChapter.title,
          summary: "",
          keyBeats: [],
        };
      const crossBackup = await saveRepairBackup(job.slug, index, sourceChapter.content);
      await writeChapterFile(job.slug, index, result.crossTexts[index], {
        source: "ai-repair",
        title: crossPlan.title,
        summary: audited.review.summary,
        note: "跨章根因修复（作者确认方案）",
      });
      await markChapterWritten(job.slug, index, audited.review.summary, audited.review);
      await markChapterRepaired(job.slug, index);
      markDetailChapterWritten(detail, index, result.crossTexts[index], audited.review.summary);
      logJob(
        job,
        `第 ${index} 章按作者确认方案完成跨章修复并写回，原稿备份在 ${crossBackup}。`,
      );
    }

    const wasWritten = Boolean(existing?.written && existing.content.trim());
    const backupPath = wasWritten
      ? await saveRepairBackup(job.slug, requestedDraft.index, existing!.content)
      : "";
    await writeChapterFile(job.slug, requestedDraft.index, result.text, {
      source: "ai-repair",
      title: chapterPlan.title,
      summary: result.review.summary,
      note: "从未采用草稿修复",
    });
    await markChapterWritten(
      job.slug,
      requestedDraft.index,
      result.review.summary,
      result.review,
    );
    markDetailChapterWritten(
      detail,
      requestedDraft.index,
      result.text,
      result.review.summary,
    );
    delete detail.state.rejectedDrafts[String(requestedDraft.index)];

    let candidateCanon = result.canon;
    for (const index of changedCross) {
      const audited = crossResults.get(index);
      if (audited) candidateCanon = audited.canon;
    }
    const changedContents = [
      ...changedCross.map((index) => ({
        index,
        content: result.crossTexts[index],
      })),
      { index: requestedDraft.index, content: result.text },
    ];
    const reconciled = reconcileCanonWithChapters(candidateCanon, changedContents);
    canon = reconciled.canon;
    if (reconciled.changes.length) {
      logJob(
        job,
        `第 ${requestedDraft.index} 章草稿采用后对账：${reconciled.changes.join("；")}`,
      );
    }
    await saveCanon(job.slug, canon);
    for (const index of changedCross) {
      const audited = crossResults.get(index);
      if (!audited) continue;
      memory = await persistChapterMemory(job, detail, memory, audited.memory);
      story = await persistChapterStory(
        job,
        detail,
        memory,
        story,
        audited.memory,
        audited.story,
      );
    }
    memory = await persistChapterMemory(job, detail, memory, result.memory);
    story = await persistChapterStory(
      job,
      detail,
      memory,
      story,
      result.memory,
      result.story,
    );
    for (const index of [...changedCross, requestedDraft.index]) {
      const audited = index === requestedDraft.index ? result : crossResults.get(index);
      if (!audited) continue;
      const planReconciled = reconcileChapterPlan({
        ledger: planLedger,
        chapter: index,
        chapterMemory: audited.memory,
        extracted: audited.story,
        storyEvents: story.events,
        canon,
      });
      planLedger = planReconciled.ledger;
    }
    await savePlanLedger(job.slug, planLedger);

    adopted += 1;
    const repairedNote = result.review.repaired
      ? `，自动修复 ${result.review.repairAttempts ?? 0} 轮`
      : "";
    logJob(
      job,
      `第 ${requestedDraft.index} 章草稿修复通过并已采用${repairedNote}${
        backupPath ? `；原正文备份在 ${backupPath}` : ""
      }。`,
    );
  }

  if (paused) {
    job.result = `已暂停：采用 ${adopted} 份草稿`;
    logJob(job, `已暂停草稿修复：本次采用 ${adopted} 份草稿，剩余草稿未处理。`);
    return true;
  }

  job.result = failed
    ? `已采用 ${adopted} 份草稿，${failed} 份仍需处理`
    : `已采用 ${adopted} 份草稿`;
  logJob(
    job,
    failed
      ? `草稿修复完成：采用 ${adopted} 份，${failed} 份仍有问题，已更新草稿，原正文未改动。`
      : `草稿修复完成：采用 ${adopted} 份，台账与记忆已同步。`,
  );
  return false;
}

async function runRecanon(job: Job): Promise<void> {
  const detail = await getProjectDetail(job.slug);
  const written = detail.chapters
    .filter((chapter) => chapter.written && chapter.content.trim())
    .sort((a, b) => a.index - b.index);

  if (!written.length) {
    logJob(job, "没有已写章节，无需重建事实台账。");
    return;
  }

  if (getRuntimeConfig().provider === "mock") {
    logJob(job, "当前为 mock 模式，跳过事实抽取；配置真实模型后再重建。");
    return;
  }

  logJob(
    job,
    `将从 ${written.length} 章正文中逐章抽取事实；这是重建旧项目台账的初始化操作，耗时取决于章节数量与模型速度。`,
  );

  let canon = emptyCanon();
  let planLedger = detail.planLedger ?? emptyPlanLedger(detail.meta.updatedAt);
  const summaries: Record<string, string> = {};
  const failures: { index: number; title: string; error: string }[] = [];
  let conflicts = 0;
  let warnings = 0;

  for (const chapter of written) {
    throwIfCancelled(job);
    const chapterPlan =
      detail.plan.chapters.find((item) => item.index === chapter.index) ?? {
        index: chapter.index,
        title: chapter.title,
        summary: "",
        keyBeats: [],
      };

    logJob(job, `正在抽取第 ${chapter.index} 章《${chapter.title}》的事实…`);
    try {
      const extraction = await extractFactsWithRetry(
        job,
        detail.meta,
        detail.bible,
        chapterPlan,
        chapter.content,
        canon,
      );
      throwIfCancelled(job);
      const merged = mergeCanon(canon, extraction.facts, chapter.index, "write");
      canon = merged.canon;

      const criticalConflicts = merged.conflicts.filter(
        (issue) => issue.severity === "critical",
      );
      const warningConflicts = merged.conflicts.filter(
        (issue) => issue.severity === "warning",
      );
      if (criticalConflicts.length) {
        conflicts += criticalConflicts.length;
        for (const issue of criticalConflicts.slice(0, 3)) {
          logJob(job, `第 ${chapter.index} 章与台账冲突：${issue.detail}`);
        }
      }
      if (warningConflicts.length) {
        warnings += warningConflicts.length;
        for (const issue of warningConflicts.slice(0, 2)) {
          logJob(job, `第 ${chapter.index} 章台账提示：${issue.detail}`);
        }
      }

      if (extraction.facts.summary.trim()) {
        // 只暂存摘要，等全部章节成功后再和台账一起提交。
        summaries[String(chapter.index)] = extraction.facts.summary;
      }
      // 历史正文中已有证据的计划，只有在本次抽取结果中匹配后才升级状态。
      const chapterMemory = buildChapterMemory(
        chapter.index,
        extraction.facts.summary || chapterPlan.summary,
        extraction.facts,
        "ai",
      );
      planLedger = reconcileChapterPlan({
        ledger: planLedger,
        chapter: chapter.index,
        chapterMemory,
        extracted: extraction.facts.story,
        canon,
      }).ledger;
      logJob(job, `第 ${chapter.index} 章处理完成（暂存在内存，未写入正式台账）`);
    } catch (error) {
      if (error instanceof JobCancelledError) throw error;
      const message = errorMessage(error);
      failures.push({ index: chapter.index, title: chapter.title, error: message });
      logJob(
        job,
        `第 ${chapter.index} 章事实抽取失败：${message}；正式台账保持不变。`,
      );
    }
  }

  if (failures.length) {
    const detailText = failures
      .slice(0, 5)
      .map((item) => `第 ${item.index} 章《${item.title}》：${item.error}`)
      .join("；");
    job.result = `事实台账重建未完成：${failures.length} 章失败`;
    throw new Error(
      `事实台账重建失败，共 ${failures.length} 章抽取失败，原台账未改动：${detailText}${
        failures.length > 5 ? "…" : ""
      }`,
    );
  }

  const validation = validateCanon(canon, written);
  for (const issue of validation.slice(0, 10)) {
    logJob(job, `台账校验${issue.severity === "critical" ? "失败" : "提示"}：${issue.message}`);
  }
  const criticalIssues = validation.filter((issue) => issue.severity === "critical");
  if (criticalIssues.length) {
    job.result = "事实台账重建校验未通过";
    throw new Error(
      `事实台账重建校验未通过，原台账未改动：${criticalIssues
        .slice(0, 5)
        .map((issue) => issue.message)
        .join("；")}`,
    );
  }

  // 所有章节成功并通过校验后才统一提交，正式台账在此之前保持原样。
  await commitCanonRebuild(job.slug, canon, summaries);
  await savePlanLedger(job.slug, planLedger);
  job.result = `已从 ${written.length} 章重建事实台账`;
  logJob(
    job,
    `事实台账重建完成并已提交：${canon.characters.length} 个人物、${canon.items.length} 件物品、${canon.timeline.deadlines.length} 条期限。`,
  );
  if (conflicts) {
    logJob(
      job,
      `发现 ${conflicts} 处前后冲突；台账保留了最早确立的事实，请到「连续性」页人工确认相关章节。`,
    );
  }
  if (warnings) {
    logJob(
      job,
      `另有 ${warnings} 条台账提示（证据不足或仅提及名字），已忽略相关可疑状态更新。`,
    );
  }
}

async function runMemoryRebuild(job: Job): Promise<void> {
  const detail = await getProjectDetail(job.slug);
  const written = detail.chapters
    .filter((chapter) => chapter.written && chapter.content.trim())
    .sort((a, b) => a.index - b.index);
  if (!written.length) {
    logJob(job, "没有已写章节，无法重建长期记忆。");
    return;
  }

  const stored = await getMemory(job.slug);
  const storedStory = await getStory(job.slug);
  logJob(
    job,
    `将逐章抽取章节记忆与剧情台账，共 ${written.length} 章；全部成功后才提交，失败时已有记忆和台账保持不变。`,
  );

  let canon = emptyCanon();
  let planLedger = detail.planLedger ?? emptyPlanLedger(detail.meta.updatedAt);
  const generated: ChapterMemory[] = [];
  const generatedStories = new Map<number, ExtractedStory | undefined>();
  const storyMemories = new Map<number, ChapterMemory | undefined>();
  let preserved = 0;

  for (const chapter of written) {
    throwIfCancelled(job);
    const chapterPlan =
      detail.plan.chapters.find((item) => item.index === chapter.index) ?? {
        index: chapter.index,
        title: chapter.title,
        summary: "",
        keyBeats: [],
      };
    logJob(job, `正在生成第 ${chapter.index} 章《${chapter.title}》的长期记忆…`);
    const extraction = await extractFactsWithRetry(
      job,
      detail.meta,
      detail.bible,
      chapterPlan,
      chapter.content,
      canon,
    );
    throwIfCancelled(job);
    const merged = mergeCanon(canon, extraction.facts, chapter.index, "write");
    canon = merged.canon;

    const manual = stored.chapters[String(chapter.index)];
    if (manual?.source === "manual") {
      preserved += 1;
      generatedStories.set(chapter.index, undefined);
      storyMemories.set(chapter.index, manual);
      logJob(job, `第 ${chapter.index} 章是手工记忆，保留原文，不覆盖。`);
      continue;
    }
    const chapterMemory = buildChapterMemory(
      chapter.index,
      extraction.facts.summary || chapterPlan.summary,
      extraction.facts,
      "ai",
    );
    generated.push(chapterMemory);
    generatedStories.set(chapter.index, extraction.facts.story);
    storyMemories.set(chapter.index, chapterMemory);
  }

  // 先基于现有记忆补齐基础条目，再用本次 AI 结果覆盖非手工章节，最后重算分卷/全书。
  const next = buildEffectiveMemory(detail, stored);
  for (const memory of generated) {
    next.chapters[String(memory.index)] = memory;
  }
  const updatedAt = nowIso();
  next.volumes = aggregateVolumes(detail, next.chapters, stored.volumes, updatedAt);
  next.book = aggregateBook(detail, next.volumes, stored.book, updatedAt);
  next.updatedAt = updatedAt;
  await saveMemory(job.slug, next);

  let story = buildEffectiveStory(detail, next, storedStory);
  for (const chapter of written) {
    story = applyChapterStory(
      detail,
      next,
      story,
      chapter.index,
      generatedStories.get(chapter.index),
      storyMemories.get(chapter.index),
    );
  }

  // 用本次重建的实际记忆与剧情事件重算计划执行状态；只更新计划台账。
  for (const chapter of written) {
    planLedger = reconcileChapterPlan({
      ledger: planLedger,
      chapter: chapter.index,
      chapterMemory: storyMemories.get(chapter.index),
      extracted: generatedStories.get(chapter.index),
      storyEvents: story.events,
      canon,
    }).ledger;
  }
  try {
    await savePlanLedger(job.slug, planLedger);
    logJob(job, "计划台账已按正文重建结果更新执行状态。");
  } catch (error) {
    logJob(
      job,
      `计划台账保存失败，长期记忆和剧情台账已更新，旧计划台账保持不变：${errorMessage(error)}`,
    );
  }

  let storySaved = true;
  try {
    await saveStory(job.slug, story);
    logJob(
      job,
      `剧情台账重建完成并已提交：${story.states.length} 条人物状态、${story.relations.length} 条关系、${story.events.length} 个事件、${story.foreshadows.length} 条伏笔。`,
    );
    const checks = storyChecks(detail, story);
    if (checks.length) {
      logJob(
        job,
        `剧情台账检查发现 ${checks.length} 条待核对提示，请到「剧情台账」页查看。`,
      );
    }
  } catch (error) {
    storySaved = false;
    logJob(
      job,
      `剧情台账保存失败，长期记忆已更新，旧剧情台账保持不变：${errorMessage(error)}`,
    );
  }

  job.result = storySaved
    ? `已重建 ${generated.length} 章长期记忆与剧情台账`
    : `已重建 ${generated.length} 章长期记忆；剧情台账保存失败`;
  logJob(
    job,
    `长期记忆重建完成并已提交：${generated.length} 章 AI 记忆${
      preserved ? `，保留 ${preserved} 章手工记忆` : ""
    }；分卷与全书摘要已重新聚合。`,
  );
}

async function runAudit(job: Job): Promise<void> {
  const detail = await getProjectDetail(job.slug);
  const written = detail.chapters
    .filter((chapter) => chapter.written && chapter.content.trim())
    .sort((a, b) => a.index - b.index);

  if (!written.length) {
    logJob(job, "没有已写章节，无法总体审校。");
    return;
  }

  logPromptProfile(job);

  if (getRuntimeConfig().provider === "mock") {
    logJob(job, "当前为 mock 模式，跳过总体审校；配置真实模型后再试。");
    return;
  }

  logJob(
    job,
    `将逐章抽取事实并审校全书 ${written.length} 章；使用“截至上一章”的临时台账和剧情台账，只读，不修改正文和正式台账。`,
  );

  const takeEnding = (text: string): string => {
    const trimmed = text.trim();
    return trimmed.length > 1500 ? `……${trimmed.slice(-1500)}` : trimmed;
  };
  const takeOpening = (text: string): string => {
    const trimmed = text.trim();
    return trimmed.length > 800 ? `${trimmed.slice(0, 800)}……` : trimmed;
  };

  let canon = emptyCanon();
  const storedMemory = await getMemory(job.slug);
  const storedStory = await getStory(job.slug);
  let auditMemory = buildEffectiveMemory(detail, storedMemory);
  let auditStory = buildEffectiveStory(detail, auditMemory, storedStory);
  const runtime = getRuntimeConfig();
  const auditor = promptVersionInfo("auditor");
  const summaries: { index: number; summary: string }[] = [];
  let critical = 0;
  let warnings = 0;
  let ignored = 0;
  let failed = 0;
  const report: string[] = [
    `# 《${detail.meta.title}》总体审校报告`,
    "",
    `- 审校时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`,
    `- 审校章节：${written.length} 章`,
    `- 模型：${runtime.model}`,
    `- 温度：${runtime.temperature}`,
    `- 最大 tokens：${runtime.maxTokens}`,
    `- 审校提示词版本：${auditor.promptVersion}`,
    `- 内置提示词版本：${auditor.baseVersion}`,
    "",
  ];

  for (let i = 0; i < written.length; i += 1) {
    throwIfCancelled(job);
    const chapter = written[i];
    const chapterPlan =
      detail.plan.chapters.find((item) => item.index === chapter.index) ?? {
        index: chapter.index,
        title: chapter.title,
        summary: "",
        keyBeats: [],
      };
    const previous = written[i - 1];
    const next = written[i + 1];
    const previousEnding = previous ? takeEnding(previous.content) : "";
    const nextOpening = next ? takeOpening(next.content) : "";
    const nextSummary = next
      ? detail.state.summaries[String(next.index)] ??
        detail.plan.chapters.find((item) => item.index === next.index)?.summary ??
        ""
      : "";
    const previousContext = [
      previousEnding ? `上一章结尾：\n${previousEnding}` : "",
      ...summaries
        .slice(-2)
        .map((item) => `第 ${item.index} 章摘要：${item.summary}`),
    ]
      .filter(Boolean)
      .join("\n\n");
    const nextContext = [
      nextOpening ? `下一章开头：\n${nextOpening}` : "",
      nextSummary ? `下一章摘要：${nextSummary}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const storyContext = buildStoryContext(
      detail,
      chapterPlan,
      auditMemory,
      auditStory,
    ).text;
    const previousChapters = written
      .slice(Math.max(0, i - 3), i)
      .map((item) => ({ index: item.index, content: item.content }));

    logJob(job, `审校第 ${chapter.index} 章《${chapter.title}》…`);

    let extracted: ExtractedFacts;
    const extractionIssues: ContinuityIssue[] = [];
    let extractedOk = true;
    try {
      const extraction = await extractFactsWithRetry(
        job,
        detail.meta,
        detail.bible,
        chapterPlan,
        chapter.content,
        canon,
      );
      extracted = extraction.facts;
    } catch (error) {
      if (error instanceof JobCancelledError) throw error;
      failed += 1;
      extractedOk = false;
      const message = errorMessage(error);
      logJob(job, `第 ${chapter.index} 章事实抽取失败，本章审校结果不可靠：${message}`);
      extracted = {
        summary: "",
        characters: [],
        items: [],
        timeline: null,
        rules: [],
      };
      // 总体审校是只读报告，但也不能在抽取失败时输出“未发现问题”。
      extractionIssues.push({
        severity: "critical",
        type: "事实抽取失败",
        evidence: "",
        detail: `事实抽取连续 ${EXTRACTION_MAX_ATTEMPTS} 次失败，本章未经完整事实检查：${message}`,
      });
    }

    const chapterMemory = buildChapterMemory(
      chapter.index,
      extracted.summary || chapterPlan.summary,
      extracted,
      "ai",
    );
    const checks = reviewSuspicions({
      project: detail,
      chapter: chapterPlan,
      text: chapter.content,
      canon,
      memory: auditMemory,
      story: auditStory,
      previousEnding,
      previousChapters,
      extracted: extracted.story,
      chapterMemory,
    });

    let audit: ReviewResult;
    try {
      audit = await auditChapter(
        detail.meta,
        canon,
        detail.characters,
        chapterPlan,
        chapter.content,
        previousContext,
        checks.suspicions,
        nextContext,
        storyContext,
      );
    } catch (error) {
      failed += 1;
      logJob(job, `第 ${chapter.index} 章审校调用失败：${errorMessage(error)}`);
      audit = {
        summary: "",
        issues: [
          {
            severity: "critical",
            type: "审校失败",
            evidence: "",
            detail: `总体审校调用失败，本章未经检查：${errorMessage(error)}`,
          },
        ],
        continuityOk: false,
      };
    }

    throwIfCancelled(job);
    const merged = mergeCanon(canon, extracted, chapter.index, "write");
    // 普通自动线索只作为审校提示；数据级严重矛盾强制保留。
    const issues = mergeIssues(
      audit.issues,
      merged.conflicts,
      extractionIssues,
      checks.hardIssues,
    );
    const criticalIssues = issues.filter((issue) => issue.severity === "critical");
    const warningIssues = issues.filter((issue) => issue.severity === "warning");
    const ignoredIssues = issues.filter((issue) => issue.severity === "ignore");
    critical += criticalIssues.length;
    warnings += warningIssues.length;
    ignored += ignoredIssues.length;

    // 临时台账继续向后推进，下一章才能拿到“截至本章”的事实；抽取失败时不推进。
    canon = merged.canon;
    if (extractedOk) {
      auditMemory = applyChapterMemory(detail, auditMemory, chapterMemory);
      auditStory = applyChapterStory(
        detail,
        auditMemory,
        auditStory,
        chapter.index,
        extracted.story,
        chapterMemory,
      );
    }
    const summary = extracted.summary || chapterPlan.summary || "";
    if (summary) summaries.push({ index: chapter.index, summary });

    report.push(`## 第 ${chapter.index} 章《${chapter.title}》`, "");
    if (!issues.length) {
      logJob(job, `第 ${chapter.index} 章：未发现明显连续性问题`);
      report.push("未发现明显连续性问题。", "");
    } else {
      logJob(
        job,
        `第 ${chapter.index} 章：${criticalIssues.length} 处严重，${warningIssues.length} 条建议${
          ignoredIssues.length ? `，${ignoredIssues.length} 条可忽略` : ""
        }`,
      );
      for (const issue of criticalIssues.slice(0, 3)) {
        logJob(job, `第 ${chapter.index} 章【严重·${issue.type}】${issue.detail}`);
      }
      for (const issue of warningIssues.slice(0, 2)) {
        logJob(job, `第 ${chapter.index} 章【建议·${issue.type}】${issue.detail}`);
      }
      for (const issue of issues) {
        // 报告同时被解析成按章卡片；压平换行，保证一条问题始终是一行。
        const type = issue.type.replace(/\s+/g, " ").trim() || "其他";
        const detail = issue.detail.replace(/\s+/g, " ").trim();
        const evidence = issue.evidence.replace(/\s+/g, " ").trim();
        const severityLabel =
          issue.severity === "critical"
            ? "严重"
            : issue.severity === "warning"
              ? "建议"
              : "可忽略";
        report.push(`- **${severityLabel} · ${type}**：${detail}`);
        if (evidence) report.push(`  - 证据：${evidence}`);
      }
      report.push("");
    }
  }

  const reportPath = await writeAuditReport(job.slug, report.join("\n"));
  const ignoredNote = ignored ? `，${ignored} 条可忽略` : "";
  job.result = `总体审校完成：${written.length} 章，${critical} 处严重，${warnings} 条建议${ignoredNote}`;
  logJob(
    job,
    `总体审校完成：${written.length} 章，${critical} 处严重，${warnings} 条建议${ignoredNote}${
      failed ? `（${failed} 次模型调用失败）` : ""
    }。`,
  );
  logJob(job, `审校只读，未修改正文、台账和审校记录；详细报告：${reportPath}`);
}

async function runExport(job: Job): Promise<void> {
  throwIfCancelled(job);
  const result = await exportBookFile(job.slug);
  job.result = result.relativePath;
  logJob(job, `已生成全书文件：${result.relativePath}（${result.chapters} 章，约 ${result.words} 字）`);
}

async function runFanqieLogin(job: Job): Promise<void> {
  throwIfCancelled(job);
  logJob(job, "即将打开浏览器窗口，请在其中完成番茄作家专区的扫码或验证码登录。");
  await loginFanqie(
    (message) => logJob(job, message),
    () => throwIfCancelled(job),
  );
  job.result = "登录会话已保存";
}

async function runFanqiePublish(job: Job): Promise<void> {
  throwIfCancelled(job);
  const file = await getProjectFile(job.slug);
  const config = file.publish.fanqie;
  if (!config.bookName.trim()) throw new Error("请先在「发布」页填写番茄书名");
  if (job.params.confirmPublish !== true) {
    throw new Error("发布操作需要二次确认，请从发布页重新发起");
  }

  const written = await getWrittenChapters(job.slug);
  // 永久台账才是幂等依据；日志被裁剪或清空都不会让已发布章节重新提交。
  const ledger = await getPublishLedger(job.slug);
  const published = new Set<number>();
  const uncertain = new Set<number>();
  for (const chapter of written) {
    const entry = findPublishEntry(ledger, config.bookId, config.bookName, chapter.index);
    if (entry?.status === "published") published.add(chapter.index);
    else if (entry?.status === "uncertain") uncertain.add(chapter.index);
  }

  const chapters = written.filter(
    (chapter) => !published.has(chapter.index) && !uncertain.has(chapter.index),
  );
  const skipped = written.length - chapters.length;
  if (skipped > 0) {
    logJob(
      job,
      `已跳过 ${skipped} 个已发布或待人工确认的章节${
        uncertain.size ? `（其中 ${uncertain.size} 章待人工确认）` : ""
      }`,
    );
  }

  if (!chapters.length) {
    logJob(job, "没有新的已写章节需要发布；所有已写章节都已提交过。");
    job.result = "无新章节需要发布";
    return;
  }

  logJob(
    job,
    `准备将 ${chapters.length} 章发布到番茄小说《${config.bookName}》${
      config.autoSubmit ? "（自动提交发布）" : "（仅保存草稿）"
    }…`,
  );

  const confirmed = new Set<number>();
  try {
    await publishFanqie({
      ...config,
      chapters,
      onChapterPublished: async (index) => {
        if (!config.autoSubmit) return;
        confirmed.add(index);
        await appendPublishRecord(job.slug, {
          platform: "fanqie",
          at: nowIso(),
          chapters: [index],
          status: "success",
          mode: "publish",
          message: "已自动提交发布",
        });
        await recordPublishOutcome(job.slug, {
          bookId: config.bookId,
          bookName: config.bookName,
          chapter: index,
          status: "published",
          jobId: job.id,
          message: "已自动提交发布",
        });
      },
      onChapterUncertain: async (index, message) => {
        uncertain.add(index);
        await recordPublishOutcome(job.slug, {
          bookId: config.bookId,
          bookName: config.bookName,
          chapter: index,
          status: "uncertain",
          jobId: job.id,
          message,
        }).catch((error) => {
          logJob(job, `第 ${index} 章待确认状态记录失败：${errorMessage(error)}`);
        });
        logJob(
          job,
          `第 ${index} 章提交结果不确定，已标记为待人工确认；请到番茄后台核对后处理。`,
        );
      },
      onLog: (message) => logJob(job, message),
      checkCancelled: () => throwIfCancelled(job),
    });

    if (config.autoSubmit) {
      job.result = `已提交 ${chapters.length} 章`;
      logJob(
        job,
        "流程完成；番茄后台通常需要数十分钟到 1 小时审核上线，请自行确认状态。",
      );
    } else {
      // 草稿模式没有逐章成功回调，只能在整批流程结束后记一条草稿记录；
      // 草稿不计入“已发布”，下次仍会作为待发布章节处理。
      await appendPublishRecord(job.slug, {
        platform: "fanqie",
        at: nowIso(),
        chapters: chapters.map((chapter) => chapter.index),
        status: "success",
        mode: "draft",
        message: "已保存为草稿",
      });
      job.result = "已保存草稿";
      logJob(job, "流程完成；请到番茄后台确认草稿并手动发布。");
    }
  } catch (error) {
    // 每成功一章已在 onChapterPublished 里单独记账；这里只补记既未成功、
    // 也不属于“待确认”的章节，避免把已成功或结果不明的章节误标为失败。
    const remaining = chapters.filter(
      (chapter) => !confirmed.has(chapter.index) && !uncertain.has(chapter.index),
    );
    if (remaining.length) {
      await appendPublishRecord(job.slug, {
        platform: "fanqie",
        at: nowIso(),
        chapters: remaining.map((chapter) => chapter.index),
        status: "failed",
        mode: config.autoSubmit ? "publish" : "draft",
        message: errorMessage(error),
      }).catch(() => undefined);
    }
    throw error;
  }
}
