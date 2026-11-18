import {
  auditChapter,
  extendPlan,
  extractChapterFacts,
  generateCharacters,
  generatePlan,
  repairChapter,
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
import { promptVersionInfo } from "./prompt-store";
import { findPublishEntry } from "./publish-ledger";
import { loginFanqie, publishFanqie } from "./publishers/fanqie";
import { compareCriticalIssues, filterSeedIssues } from "./repair-compare";
import type { IssueComparison } from "./repair-compare";
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
  logJob(job, "架构师正在构思世界观、主线与章节细纲…");
  const generated = await generatePlan(detail.meta);
  throwIfCancelled(job);
  logJob(
    job,
    `细纲已生成（${generated.plan.chapters.length} 章），正在创建人物档案；全部完成前不会写入任何文件…`,
  );

  const characters = await generateCharacters(detail.meta, generated);
  throwIfCancelled(job);

  const committed = await commitArchitecture(
    job.slug,
    generated,
    characters,
    { seedCanon },
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

  const chapters = await extendPlan(
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
  );
  throwIfCancelled(job);
  // appendChapters 现在会在一次提交里同步 plan.json、outline.md 和项目元数据。
  const plan = await appendChapters(job.slug, chapters);

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
}

interface VerifyChapterResult {
  text: string;
  review: ReviewResult;
  canon: CanonFacts;
  passed: boolean;
  memory?: ChapterMemory;
  story?: ExtractedStory;
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
  // 严重问题最多修三轮；只有 critical 会触发修复，warning 留给人工参考。
  const maxRepairs = 3;

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
      );
    } catch (error) {
      // 审校不可用时不能假装通过：标记为需要复查，并暂停后续自动写作。
      logJob(input.job, `第 ${input.chapter.index} 章连续性审校失败，已标记为待复查`);
      audit = {
        summary: extracted.summary,
        issues: [
          {
            severity: "critical",
            type: "审校失败",
            evidence: "",
            detail: `连续性审校调用失败，本章未经检查：${errorMessage(error)}`,
          },
        ],
        continuityOk: false,
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
      );
      if (!repaired.trim()) throw new Error("修复返回空正文");
      currentText = repaired;
    } catch (error) {
      logJob(input.job, `第 ${input.chapter.index} 章定点修复失败：${errorMessage(error)}`);
      break;
    }
  }

  return (
    best ?? {
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
    }
  );
}

interface VerifyDraftChapterInput extends VerifyChapterInput {
  seedIssues?: ContinuityIssue[];
  seedReview?: ReviewResult;
  maxRepairs?: number;
}

type DraftStopReason =
  | "passed"
  | "max-repairs"
  | "no-improvement"
  | "new-critical"
  | "increased"
  | "repair-failed"
  | "extraction-failed"
  | "paused";

interface VerifyDraftChapterResult extends VerifyChapterResult {
  repairCalls: number;
  extractionFailed: boolean;
  comparison?: IssueComparison;
  stopReason: DraftStopReason;
  seedStatus: "used" | "fallback";
  initialCriticalCount: number;
  finalCriticalCount: number;
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
  let comparison: IssueComparison | undefined;
  let repairCalls = 0;
  let extractionFailed = false;
  let stopReason: DraftStopReason = "max-repairs";
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
      repairCalls,
      extractionFailed,
      comparison,
      stopReason,
      seedStatus,
      initialCriticalCount,
      finalCriticalCount: critical,
    };
  };

  const finish = (): VerifyDraftChapterResult =>
    best
      ? {
          ...best,
          repairCalls,
          extractionFailed,
          comparison,
          stopReason,
          seedStatus,
          initialCriticalCount,
          finalCriticalCount,
        }
      : fallback();

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
        "",
        { draftRepair: true },
      );
      if (!repaired.trim()) throw new Error("修复返回空正文");
      currentText = repaired;
      repairCalls = nextRound;
      throwIfCancelled(input.job);
      return true;
    } catch (error) {
      if (error instanceof JobCancelledError) throw error;
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
    if (isPauseRequested(input.job)) {
      stopReason = "paused";
      return fallback();
    }
  }

  for (let auditIndex = 0; auditIndex < maxAudits; auditIndex += 1) {
    throwIfCancelled(input.job);
    if (isPauseRequested(input.job) && auditIndex > 0) {
      stopReason = "paused";
      break;
    }

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
      );
    } catch (error) {
      logJob(input.job, `第 ${input.chapter.index} 章连续性审校失败，已标记为待复查`);
      audit = {
        summary: extracted.summary,
        issues: [
          {
            severity: "critical",
            type: "审校失败",
            evidence: "",
            detail: `连续性审校调用失败，本章未经检查：${errorMessage(error)}`,
          },
        ],
        continuityOk: false,
      };
    }

    throwIfCancelled(input.job);

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
    };

    if (!best && seedStatus === "fallback") {
      best = candidate;
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
      if (!comparison.accepted) {
        stopReason =
          comparison.afterCount > comparison.beforeCount
            ? "increased"
            : comparison.added.length
              ? "new-critical"
              : "no-improvement";
        logStop();
        return fallback();
      }
      best = candidate;
      finalCriticalCount = critical;
      logJob(
        input.job,
        `第 ${input.chapter.index} 章草稿修复第 1 轮有改善：严重问题 ${comparison.beforeCount}→${comparison.afterCount}，已解决 ${comparison.resolved.length}，新增 ${comparison.added.length}。`,
      );
      if (repairCalls >= maxRepairs) {
        stopReason = "max-repairs";
        break;
      }
      if (!(await repairRound(issues.filter((issue) => issue.severity === "critical")))) {
        break;
      }
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
    if (!comparison.accepted) {
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
      const draft = await saveRejectedDraft(job.slug, {
        index: chapter.index,
        content: text,
        mode: "write",
        reason: extractionFailed
          ? "事实抽取失败，未进入审校"
          : `连续性检查未通过：${critical} 个严重问题`,
        review: result.review,
      });
      paused = true;
      job.result = `第 ${chapter.index} 章未写入正文，草稿已保存`;
      logJob(
        job,
        extractionFailed
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
      const draft = await saveRejectedDraft(job.slug, {
        index: target.index,
        content: text,
        mode: "rewrite",
        reason: extractionFailed
          ? "事实抽取失败，未进入审校"
          : `重写未通过连续性检查：${critical} 个严重问题`,
        review: result.review,
      });
      paused = true;
      job.result = `第 ${target.index} 章重写未通过，原稿保留`;
      logJob(
        job,
        extractionFailed
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
  let remainingCritical = 0;
  let repairedCount = 0;
  let paused = false;

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

    // 一章可能有多条问题；严重优先，最多一次修 20 条，避免提示词过长。
    const issues = [...fixable]
      .sort((a, b) =>
        a.severity === b.severity ? 0 : a.severity === "critical" ? -1 : 1,
      )
      .slice(0, 20);
    const critical = issues.filter((issue) => issue.severity === "critical").length;
    const warnings = issues.length - critical;
    const ignored = sourceIssues.length - fixable.length;
    const sourceLabel = source === "audit" ? "总体审校记录" : "章节审校遗留问题";
    const ignoredNote = ignored ? `，另有 ${ignored} 条可忽略不处理` : "";
    const cappedNote =
      fixable.length > issues.length
        ? `，可修复问题共 ${fixable.length} 条，先处理前 ${issues.length} 条`
        : "";

    logJob(
      job,
      `开始定点修复第 ${target.index} 章《${target.title}》…（${critical} 严重 / ${warnings} 建议${ignoredNote}${cappedNote}）`,
    );

    let text: string;
    try {
      text = await repairChapter(
        detail.meta,
        chapterPlan,
        target.content,
        issues,
        canonForChapter(canon, target.index),
        previousEnding,
        nextOpening,
        `根据${sourceLabel}做定点修复：只修改与这些问题直接相关的段落，其余原文尽量保持不动。`,
        "",
      );
    } catch (error) {
      throw new Error(`第 ${target.index} 章定点修复调用失败：${errorMessage(error)}`);
    }
    if (!text.trim()) throw new Error(`第 ${target.index} 章定点修复返回空正文`);

    logJob(job, `第 ${target.index} 章修复稿完成，开始重新抽取事实并审校…`);
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
    });
    throwIfCancelled(job);
    text = result.text;

    // 定点修复的目标就是正文本身：先备份原稿，再把修复稿写回章节。
    // 检查仍有遗留问题时也写回，问题会进入章节审校记录，供继续处理。
    const backupPath = await saveRepairBackup(job.slug, target.index, target.content);

    await writeChapterFile(job.slug, target.index, text, {
      source: "ai-repair",
      title: chapterPlan.title,
      summary: result.review.summary,
      note: `定点修复（${sourceLabel}）`,
    });
    repaired.set(target.index, text);
    await markChapterWritten(job.slug, target.index, result.review.summary, result.review);
    await markChapterRepaired(job.slug, target.index);
    markDetailChapterWritten(detail, target.index, text, result.review.summary);

    const reconciled = reconcileCanonWithChapters(result.canon, [
      { index: target.index, content: text },
    ]);
    canon = reconciled.canon;
    if (reconciled.changes.length) {
      logJob(
        job,
        `第 ${target.index} 章定点修复后对账：${reconciled.changes.join("；")}`,
      );
    }
    await saveCanon(job.slug, canon);
    memory = await persistChapterMemory(job, detail, memory, result.memory);
    story = await persistChapterStory(job, detail, memory, story, result.memory, result.story);
    repairedCount += 1;

    if (result.passed) {
      logJob(
        job,
        `第 ${target.index} 章定点修复完成，已写回正文，连续性检查通过；原稿备份在 ${backupPath}。`,
      );
    } else {
      const criticalLeft = result.review.issues.filter(
        (issue) => issue.severity === "critical",
      ).length;
      remainingCritical += criticalLeft;
      logJob(
        job,
        `第 ${target.index} 章定点修复完成，已写回正文；连续性检查仍有 ${criticalLeft} 个严重问题，${
          source === "audit"
            ? "已记入章节审校，可在「遗留修复」继续处理或重新运行总体审校"
            : "已更新到章节审校的遗留修复"
        }。原稿备份在 ${backupPath}。`,
      );
    }
  }

  if (paused) {
    job.result = `已暂停：写回 ${repairedCount} 章正文，剩余章节未处理`;
    logJob(
      job,
      `已暂停定点修复：共写回 ${repairedCount} 章正文，剩余章节未处理；稍后可再次启动继续修复。`,
    );
    return true;
  }

  job.result = remainingCritical
    ? `已改写 ${repairedCount} 章正文，仍有 ${remainingCritical} 个严重问题`
    : `已完成 ${repairedCount} 章正文定点修复`;
  logJob(
    job,
    `定点修复完成，共写回 ${repairedCount} 章正文；${
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
    });
    throwIfCancelled(job);
    if (!result.text.trim()) {
      throw new Error(`第 ${requestedDraft.index} 章草稿修复返回空正文`);
    }

    if (!result.passed) {
      const critical = countCritical(result.review.issues);
      const extractionFailed =
        result.extractionFailed || result.review.extractionOk === false;
      const comparisonText = result.comparison
        ? `严重问题 ${result.initialCriticalCount}→${result.finalCriticalCount}（最后对比：已解决 ${result.comparison.resolved.length}，仍存在 ${result.comparison.remaining.length}，新增 ${result.comparison.added.length}）`
        : `仍有 ${critical} 个严重问题`;
      const reason = extractionFailed
        ? "自动修复未完成：修复后事实抽取失败，已保留最佳草稿，需要人工处理"
        : `自动修复未完成，需要人工处理：${comparisonText}`;
      const updated = await saveRejectedDraft(job.slug, {
        index: requestedDraft.index,
        content: result.text,
        mode: draft.mode,
        reason,
        review: result.review,
      });
      detail.state.rejectedDrafts[String(requestedDraft.index)] = updated;
      failed += 1;
      const outcome = extractionFailed
        ? `第 ${requestedDraft.index} 章草稿修复后事实抽取失败`
        : `第 ${requestedDraft.index} 章草稿修复后仍未通过`;
      logJob(
        job,
        `${outcome}，未写入正文；repair-editor 调用 ${result.repairCalls} 次，停止原因：${result.stopReason}。新草稿保存在 ${updated.path}，原正文未改动。`,
      );
      continue;
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

    if (wasWritten) {
      const reconciled = reconcileCanonWithChapters(result.canon, [
        { index: requestedDraft.index, content: result.text },
      ]);
      canon = reconciled.canon;
      if (reconciled.changes.length) {
        logJob(
          job,
          `第 ${requestedDraft.index} 章草稿采用后对账：${reconciled.changes.join("；")}`,
        );
      }
    } else {
      canon = result.canon;
    }
    await saveCanon(job.slug, canon);
    memory = await persistChapterMemory(job, detail, memory, result.memory);
    story = await persistChapterStory(
      job,
      detail,
      memory,
      story,
      result.memory,
      result.story,
    );

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
