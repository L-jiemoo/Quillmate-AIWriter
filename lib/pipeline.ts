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
  deadNameSuspicions,
  emptyCanon,
  groundExtractedFacts,
  mergeCanon,
  mergeIssues,
  openingRepeatSuspicion,
  reconcileCanonWithChapters,
} from "./canon";
import { getRuntimeConfig } from "./config";
import { createJob, logJob } from "./jobs";
import { loginFanqie, publishFanqie } from "./publishers/fanqie";
import {
  appendChapters,
  appendOutlineSection,
  appendPublishRecord,
  exportBookFile,
  getAuditReport,
  getProjectDetail,
  getProjectFile,
  getWrittenChapters,
  markChapterRepaired,
  markChapterWritten,
  saveCanon,
  saveCharacters,
  savePlan,
  saveRejectedDraft,
  saveRepairBackup,
  updateChapterSummary,
  writeAuditReport,
  writeChapterFile,
} from "./store";
import { errorMessage, nowIso } from "./utils";
import type {
  CanonFacts,
  ChapterPlan,
  Character,
  ExtractedFacts,
  Job,
  ProjectDetail,
  ProjectMeta,
  ReviewResult,
} from "./types";

const JOB_LABELS: Record<Job["type"], string> = {
  plan: "生成架构与角色",
  extend: "补充章节大纲",
  write: "自动写作",
  rewrite: "重写章节",
  repair: "定点修复",
  recanon: "重建事实台账",
  audit: "总体审校",
  export: "导出全书",
  "fanqie-login": "登录番茄",
  "fanqie-publish": "发布到番茄",
};

interface JobParams {
  count?: number;
  indices?: number[];
  instruction?: string;
  useReview?: boolean;
  // 定点修复的问题来源：总体审校报告，或章节审校里的遗留问题。
  source?: "audit" | "review";
}

export async function startJob(
  slug: string,
  type: Job["type"],
  params: JobParams = {},
): Promise<Job> {
  await getProjectFile(slug);
  const job = createJob(slug, type);
  // 任务在后台自行推进，HTTP 只返回 job 快照；前端靠 /api/jobs/[id] 轮询日志。
  // 这里刻意不 await，否则长任务会一直占住请求。
  void runJob(job, params);
  return job;
}

async function runJob(job: Job, params: JobParams): Promise<void> {
  job.status = "running";
  job.updatedAt = nowIso();
  logJob(job, `任务开始：${JOB_LABELS[job.type]}`);

  const runtime = getRuntimeConfig();
  if (runtime.provider === "mock") {
    logJob(job, "当前为 mock 模式，将生成示例内容；可在「模型设置」页填写 API Key 接入真实模型。");
  }

  try {
    let paused = false;
    switch (job.type) {
      case "plan":
        await runPlan(job);
        break;
      case "extend":
        await runExtend(job, params.count ?? 10);
        break;
      case "write":
        await runWrite(job, params.count ?? 1);
        break;
      case "rewrite":
        await runRewrite(
          job,
          params.indices ?? [],
          params.instruction ?? "",
          params.useReview === true,
        );
        break;
      case "repair":
        paused = await runRepair(
          job,
          params.indices ?? [],
          params.source === "review" ? "review" : "audit",
        );
        break;
      case "recanon":
        await runRecanon(job);
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
    job.status = "error";
    job.error = errorMessage(error);
    logJob(job, `任务失败：${job.error}`);
  } finally {
    job.updatedAt = nowIso();
  }
}

async function runPlan(job: Job): Promise<void> {
  const file = await getProjectFile(job.slug);
  logJob(job, "架构师正在构思世界观、主线与章节细纲…");
  const generated = await generatePlan(file.meta);
  await savePlan(job.slug, generated.plan, generated.bible, generated.outlineMd);
  logJob(job, `已生成 ${generated.plan.chapters.length} 章细纲`);

  logJob(job, "角色设计师正在创建人物档案…");
  const characters = await generateCharacters(file.meta, generated);
  await saveCharacters(job.slug, characters);
  logJob(job, `已生成 ${characters.length} 位角色：${characters.map((item) => item.name).join("、")}`);
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

  const chapters = await extendPlan(
    detail.meta,
    detail.plan,
    detail.bible,
    detail.outlineMd,
    summaries,
    count,
  );
  const plan = await appendChapters(job.slug, chapters);
  await appendOutlineSection(job.slug, chapters);

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
  meta: ProjectMeta;
  bible: string;
  characters: Character[];
  chapter: ChapterPlan;
  text: string;
  canon: CanonFacts;
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

  let currentText = input.text;
  let best: VerifyChapterResult | null = null;
  // 严重问题最多修三轮；只有 critical 会触发修复，warning 留给人工参考。
  const maxRepairs = 3;

  // 每一轮都基于“本章写作前的事实台账”重新检查。
  // 不能把本章自己抽取到的事实先并进去，否则“吴副官复活”会被自己的抽取结果掩盖。
  for (let attempt = 0; attempt <= maxRepairs; attempt += 1) {
    // 暂停只影响后续轮次：当前章节仍完成一次检查并写回，避免留下半成品。
    if (input.job.pauseRequested && attempt > 0) break;

    const mechanical = [
      ...deadNameSuspicions(auditCanon, currentText, input.chapter.index),
      ...openingRepeatSuspicion(input.previousEnding, currentText),
    ];

    let extracted;
    try {
      extracted = groundExtractedFacts(
        await extractChapterFacts(
          input.meta,
          input.bible,
          input.chapter,
          currentText,
          auditCanon,
        ),
        currentText,
      );
    } catch (error) {
      logJob(input.job, `第 ${input.chapter.index} 章事实抽取失败：${errorMessage(error)}`);
      extracted = {
        summary: "",
        characters: [],
        items: [],
        timeline: null,
        rules: [],
      };
    }

    let audit: ReviewResult;
    try {
      audit = await auditChapter(
        input.meta,
        auditCanon,
        input.chapter,
        currentText,
        previousContext,
        mechanical,
        nextContext,
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
    const issues = mergeIssues(audit.issues, merged.conflicts, mechanical);
    const critical = countCritical(issues);
    const review: ReviewResult = {
      summary: extracted.summary || audit.summary || input.chapter.summary,
      issues,
      continuityOk: critical === 0,
      repaired: attempt > 0,
      repairAttempts: attempt,
    };

    // 修复失败时保留“严重问题最少”的一版，避免越修越乱。
    if (!best || critical < countCritical(best.review.issues)) {
      best = {
        text: currentText,
        review,
        canon: review.continuityOk ? mergedFull.canon : input.canon,
        passed: review.continuityOk,
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
    }
  );
}

async function runWrite(job: Job, requested: number): Promise<void> {
  const count = Math.max(1, Math.min(50, Math.round(Number(requested) || 1)));
  const detail = await getProjectDetail(job.slug);
  const pending = detail.chapters.filter((chapter) => !chapter.written).slice(0, count);

  if (!pending.length) {
    logJob(job, "没有待写章节：请先生成架构，或调整目标章节数。");
    return;
  }

  assertCanonReady(detail);

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
  let paused = false;

  // 逐章串行：每章写完立即落盘并更新摘要，任务中途失败时，
  // 已完成的章节仍然保留，history 和上一章结尾也会持续传给下一章。
  for (const chapter of pending) {
    const chapterPlan = detail.plan.chapters.find((item) => item.index === chapter.index);
    if (!chapterPlan) continue;

    logJob(job, `开始写第 ${chapter.index} 章《${chapter.title}》…`);
    let text = await writeChapter(
      detail.meta,
      detail.bible,
      detail.characters,
      chapterPlan,
      previousEnding,
      history.slice(-6),
      { canon: canonForChapter(canon, chapter.index) },
    );
    if (!text.trim()) throw new Error(`第 ${chapter.index} 章正文为空，请重试`);

    logJob(job, `初稿完成，约 ${text.replace(/\s+/g, "").length} 字，开始抽取事实并审校…`);
    const result = await verifyChapter({
      job,
      meta: detail.meta,
      bible: detail.bible,
      characters: detail.characters,
      chapter: chapterPlan,
      text,
      canon,
      previousEnding,
      previousSummaries: history.slice(-2),
      nextOpening: "",
      nextSummary: "",
      mode: "write",
      rewriteInstruction: "",
      reviewFeedback: "",
    });
    text = result.text;

    if (!result.passed) {
      const critical = result.review.issues.filter(
        (issue) => issue.severity === "critical",
      ).length;
      const draft = await saveRejectedDraft(job.slug, {
        index: chapter.index,
        content: text,
        mode: "write",
        reason: `连续性检查未通过：${critical} 个严重问题`,
        review: result.review,
      });
      paused = true;
      job.result = `第 ${chapter.index} 章未写入正文，草稿已保存`;
      logJob(
        job,
        `第 ${chapter.index} 章仍有 ${critical} 个严重连续性问题，未写入正文；草稿保存在 ${draft.path}。后续自动写作已暂停，请人工处理后再继续。`,
      );
      break;
    }

    await writeChapterFile(job.slug, chapter.index, text);
    previousEnding = takeEnding(text);
    await markChapterWritten(job.slug, chapter.index, result.review.summary, result.review);
    canon = result.canon;
    await saveCanon(job.slug, canon);
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
}

async function runRewrite(
  job: Job,
  requested: number[],
  instruction: string,
  useReview: boolean,
): Promise<void> {
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
  let paused = false;

  for (const target of targets) {
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
      },
    );
    if (!text.trim()) throw new Error(`第 ${target.index} 章正文为空，请重试`);

    logJob(
      job,
      `第 ${target.index} 章初稿完成，约 ${text.replace(/\s+/g, "").length} 字，开始抽取事实并审校…`,
    );
    const result = await verifyChapter({
      job,
      meta: detail.meta,
      bible: detail.bible,
      characters: detail.characters,
      chapter: chapterPlan,
      text,
      canon,
      previousEnding,
      previousSummaries: priorSummaries.slice(-2),
      nextOpening,
      nextSummary,
      mode: "rewrite",
      rewriteInstruction: instruction,
      reviewFeedback,
    });
    text = result.text;

    if (!result.passed) {
      const critical = result.review.issues.filter(
        (issue) => issue.severity === "critical",
      ).length;
      const draft = await saveRejectedDraft(job.slug, {
        index: target.index,
        content: text,
        mode: "rewrite",
        reason: `重写未通过连续性检查：${critical} 个严重问题`,
        review: result.review,
      });
      paused = true;
      job.result = `第 ${target.index} 章重写未通过，原稿保留`;
      logJob(
        job,
        `第 ${target.index} 章重写仍有 ${critical} 个严重连续性问题，未覆盖原稿；草稿保存在 ${draft.path}。重写已暂停，请人工处理后再继续。`,
      );
      break;
    }

    await writeChapterFile(job.slug, target.index, text);
    rewritten.set(target.index, text);
    await markChapterWritten(job.slug, target.index, result.review.summary, result.review);
    detail.state.summaries[String(target.index)] = result.review.summary;

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
  let remainingCritical = 0;
  let repairedCount = 0;
  let paused = false;

  for (const target of targets) {
    if (job.pauseRequested) {
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
      meta: detail.meta,
      bible: detail.bible,
      characters: detail.characters,
      chapter: chapterPlan,
      text,
      canon,
      previousEnding,
      previousSummaries: priorSummaries.slice(-2),
      nextOpening,
      nextSummary,
      mode: "rewrite",
      rewriteInstruction: `根据${sourceLabel}做定点修复。`,
      reviewFeedback: "",
    });
    text = result.text;

    // 定点修复的目标就是正文本身：先备份原稿，再把修复稿写回章节。
    // 检查仍有遗留问题时也写回，问题会进入章节审校记录，供继续处理。
    const backupPath = await saveRepairBackup(job.slug, target.index, target.content);

    await writeChapterFile(job.slug, target.index, text);
    repaired.set(target.index, text);
    await markChapterWritten(job.slug, target.index, result.review.summary, result.review);
    await markChapterRepaired(job.slug, target.index);
    detail.state.summaries[String(target.index)] = result.review.summary;

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
  let conflicts = 0;
  let warnings = 0;
  let failed = 0;

  for (const chapter of written) {
    const chapterPlan =
      detail.plan.chapters.find((item) => item.index === chapter.index) ?? {
        index: chapter.index,
        title: chapter.title,
        summary: "",
        keyBeats: [],
      };

    logJob(job, `正在抽取第 ${chapter.index} 章《${chapter.title}》的事实…`);
    try {
      const extracted = groundExtractedFacts(
        await extractChapterFacts(
          detail.meta,
          detail.bible,
          chapterPlan,
          chapter.content,
          canon,
        ),
        chapter.content,
      );
      const merged = mergeCanon(canon, extracted, chapter.index, "write");
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

      if (extracted.summary.trim()) {
        // 重建台账时顺便把摘要换成“只依据正文抽取”的版本，修掉摘要里凭空出现的人名。
        await updateChapterSummary(job.slug, chapter.index, extracted.summary);
      }
      await saveCanon(job.slug, canon);
    } catch (error) {
      failed += 1;
      logJob(job, `第 ${chapter.index} 章事实抽取失败：${errorMessage(error)}`);
    }
  }

  job.result = `已从 ${written.length - failed} 章重建事实台账`;
  logJob(
    job,
    `事实台账重建完成：${canon.characters.length} 个人物、${canon.items.length} 件物品、${canon.timeline.deadlines.length} 条期限。`,
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
  if (failed) {
    logJob(job, `有 ${failed} 章抽取失败，台账可能不完整，可稍后重试。`);
  }
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

  if (getRuntimeConfig().provider === "mock") {
    logJob(job, "当前为 mock 模式，跳过总体审校；配置真实模型后再试。");
    return;
  }

  logJob(
    job,
    `将逐章抽取事实并审校全书 ${written.length} 章；使用“截至上一章”的临时台账，只读，不修改正文和正式台账。`,
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
    "",
  ];

  for (let i = 0; i < written.length; i += 1) {
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

    logJob(job, `审校第 ${chapter.index} 章《${chapter.title}》…`);

    const mechanical = [
      ...deadNameSuspicions(canon, chapter.content, chapter.index),
      ...openingRepeatSuspicion(previousEnding, chapter.content),
    ];

    let extracted: ExtractedFacts;
    try {
      extracted = groundExtractedFacts(
        await extractChapterFacts(
          detail.meta,
          detail.bible,
          chapterPlan,
          chapter.content,
          canon,
        ),
        chapter.content,
      );
    } catch (error) {
      failed += 1;
      logJob(job, `第 ${chapter.index} 章事实抽取失败：${errorMessage(error)}`);
      extracted = {
        summary: "",
        characters: [],
        items: [],
        timeline: null,
        rules: [],
      };
    }

    let audit: ReviewResult;
    try {
      audit = await auditChapter(
        detail.meta,
        canon,
        chapterPlan,
        chapter.content,
        previousContext,
        mechanical,
        nextContext,
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

    const merged = mergeCanon(canon, extracted, chapter.index, "write");
    const issues = mergeIssues(audit.issues, merged.conflicts, mechanical);
    const criticalIssues = issues.filter((issue) => issue.severity === "critical");
    const warningIssues = issues.filter((issue) => issue.severity === "warning");
    const ignoredIssues = issues.filter((issue) => issue.severity === "ignore");
    critical += criticalIssues.length;
    warnings += warningIssues.length;
    ignored += ignoredIssues.length;

    // 临时台账继续向后推进，下一章才能拿到“截至本章”的事实。
    canon = merged.canon;
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
  const result = await exportBookFile(job.slug);
  job.result = result.relativePath;
  logJob(job, `已生成全书文件：${result.relativePath}（${result.chapters} 章，约 ${result.words} 字）`);
}

async function runFanqieLogin(job: Job): Promise<void> {
  logJob(job, "即将打开浏览器窗口，请在其中完成番茄作家专区的扫码或验证码登录。");
  await loginFanqie((message) => logJob(job, message));
  job.result = "登录会话已保存";
}

async function runFanqiePublish(job: Job): Promise<void> {
  const file = await getProjectFile(job.slug);
  const config = file.publish.fanqie;
  if (!config.bookName.trim()) throw new Error("请先在「发布」页填写番茄书名");

  const detail = await getProjectDetail(job.slug);
  // 发布记录就是幂等依据：只有 fanqie + success + mode=publish 才算“已发布”，
  // 草稿记录不跳过，否则用户改完草稿后无法再次提交。
  const published = new Set<number>();
  for (const record of detail.state.publishHistory ?? []) {
    if (record.platform !== "fanqie" || record.status !== "success" || record.mode !== "publish") {
      continue;
    }
    for (const index of record.chapters) published.add(index);
  }

  const written = await getWrittenChapters(job.slug);
  const chapters = written.filter((chapter) => !published.has(chapter.index));
  const skipped = written.length - chapters.length;
  if (skipped > 0) logJob(job, `已跳过 ${skipped} 个此前发布成功的章节`);

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
      },
      onLog: (message) => logJob(job, message),
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
    // 每成功一章已在 onChapterPublished 里单独记账；这里只补记“未确认”的章节，
    // 避免任务中途失败时把已经提交成功的章节误标为失败。
    const remaining = chapters.filter((chapter) => !confirmed.has(chapter.index));
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
