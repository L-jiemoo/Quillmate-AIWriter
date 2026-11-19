import { normalizeExtractedFacts, normalizeReviewResult } from "./canon";
import { getRuntimeConfig } from "./config";
import { LLMClient } from "./llm";
import {
  groundExtractedMemory,
  normalizeExtractedMemory,
} from "./memory";
import {
  groundExtractedStory,
  normalizeExtractedStory,
} from "./story";
import { mockChapter, mockCharacters, mockExtendedChapters, mockPlan, mockReview } from "./mock";
import { assertValidChapterPlans, parseChapterIndex } from "./plan-validation";
import {
  architectMessages,
  auditMessages,
  chapterRepairMessages,
  chapterRepairPatchMessages,
  chapterRepairPlanMessages,
  repairRegressionMessages,
  characterMessages,
  extendMessages,
  factExtractorMessages,
  titleRepairMessages,
  writerMessages,
} from "./prompts";
import {
  normalizeRepairPatches,
  type RepairPatch,
} from "./repair-patch";
import { normalizeCharacter } from "./store";
import type {
  CanonFacts,
  ChapterPlan,
  ChapterWriteOptions,
  Character,
  ContinuityIssue,
  ExtractedFacts,
  ProjectMeta,
  ProjectPlan,
  ReviewResult,
} from "./types";
import type { GeneratedPlan } from "./mock";

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function arr(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isMock(): boolean {
  return getRuntimeConfig().provider === "mock";
}

export async function generatePlan(meta: ProjectMeta): Promise<GeneratedPlan> {
  if (isMock()) return mockPlan(meta);

  const llm = new LLMClient();
  const data = await llm.json<Record<string, unknown>>(architectMessages(meta), {
    agent: "architect",
  });
  const rawChapters = Array.isArray(data.chapters) ? data.chapters : [];
  if (!rawChapters.length) {
    throw new Error("架构师没有返回章节细纲，请重试或更换模型");
  }

  const hasAnyIndex = rawChapters.some((item) => {
    const record = (item ?? {}) as Record<string, unknown>;
    return (
      record.index !== undefined &&
      record.index !== null &&
      !(typeof record.index === "string" && !record.index.trim())
    );
  });

  const chapters: ChapterPlan[] = rawChapters
    .map((item, position) => {
      const record = (item ?? {}) as Record<string, unknown>;
      const parsed = parseChapterIndex(record.index);
      if (hasAnyIndex && parsed === null) {
        throw new Error(
          `架构师返回的章节序号不合法：第 ${position + 1} 项为 ${String(record.index)}，必须是大于 0 的整数`,
        );
      }
      return {
        // 全部章节都没给序号时按数组顺序补号；混用有效/无效序号则直接报错。
        index: parsed ?? position + 1,
        title: str(record.title).trim(),
        summary: str(record.summary).trim(),
        keyBeats: arr(record.keyBeats ?? record.key_beats),
      };
    })
    .sort((a, b) => a.index - b.index);

  assertValidChapterPlans(chapters, {
    expectedCount: meta.targetChapters,
    startIndex: 1,
    requireContiguous: true,
  });

  return {
    plan: {
      logline: str(data.logline),
      tags: arr(data.tags),
      chapters,
    },
    bible: str(data.bibleMd ?? data.bible_md),
    outlineMd: str(data.outlineMd ?? data.outline_md),
  };
}

export async function generateCharacters(meta: ProjectMeta, generated: GeneratedPlan): Promise<Character[]> {
  if (isMock()) return mockCharacters(meta);

  const llm = new LLMClient();
  const data = await llm.json<Record<string, unknown>>(
    characterMessages(meta, generated.bible, generated.outlineMd),
    { agent: "character-designer" },
  );
  const items = Array.isArray(data.characters) ? data.characters : [];
  const characters = items
    .map(normalizeCharacter)
    .filter((character) => character.name.trim().length > 0);
  if (!characters.length) {
    throw new Error("角色设计师没有返回可用角色，请重试或更换模型");
  }
  return characters;
}

function normalizeTitle(value: string): string {
  // 模型可能返回“第30章 夜行”或“《夜行》”等变体；统一剥掉序号、书名号和空白，
  // 只比较标题本体，避免“看起来不同、实际重复”的章节标题漏过检查。
  return value
    .trim()
    .replace(/^第\s*\d+\s*章\s*[：:·.\-—\s]*/u, "")
    .replace(/[\s《》〈〉“”"'‘’]/gu, "")
    .toLowerCase();
}

function duplicateTitleIndexes(chapters: ChapterPlan[], existing: Set<string>): number[] {
  // existing 是已有章节的归一化标题，也放进 used；
  // 这样新章节不仅彼此不能重名，也不能撞上任何旧章节。
  const used = new Set(existing);
  const duplicates: number[] = [];
  for (const chapter of chapters) {
    const key = normalizeTitle(chapter.title);
    if (!key || used.has(key)) duplicates.push(chapter.index);
    else used.add(key);
  }
  return duplicates;
}

async function repairDuplicateTitles(
  llm: LLMClient,
  chapters: ChapterPlan[],
  existingTitles: string[],
): Promise<void> {
  const existingKeys = new Set(existingTitles.map(normalizeTitle));
  const duplicateIndexes = new Set(duplicateTitleIndexes(chapters, existingKeys));

  // 标题修复分两层：先让模型结合章节梗概重新起名；模型调用失败、
  // 返回空标题或仍然重复时，再由函数末尾的后缀逻辑兜底，保证结果一定唯一。
  if (duplicateIndexes.size) {
    const duplicates = chapters.filter((chapter) => duplicateIndexes.has(chapter.index));
    const kept = chapters
      .filter((chapter) => !duplicateIndexes.has(chapter.index))
      .map((chapter) => `第 ${chapter.index} 章《${chapter.title}》`);
    const keptKeys = new Set(
      chapters
        .filter((chapter) => !duplicateIndexes.has(chapter.index))
        .map((chapter) => normalizeTitle(chapter.title)),
    );
    const forbidden = [
      ...existingTitles.slice(-80).map((title) => `《${title}》`),
      ...kept,
    ];

    try {
      const data = await llm.json<Record<string, unknown>>(
        titleRepairMessages(duplicates, forbidden),
        { agent: "title-repair" },
      );
      const items = Array.isArray(data.titles) ? data.titles : [];
      const accepted = new Set<string>();
      for (const item of items) {
        const record = (item ?? {}) as Record<string, unknown>;
        const index = Number(record.index);
        const title = str(record.title).trim();
        const chapter = duplicates.find((candidate) => candidate.index === index);
        if (!chapter || !title) continue;
        const key = normalizeTitle(title);
        if (!key || existingKeys.has(key) || keptKeys.has(key) || accepted.has(key)) continue;
        chapter.title = title;
        accepted.add(key);
      }
    } catch {
      // 改名调用失败时，保底由下面的后缀逻辑保证唯一
    }
  }

  // 最后的机械兜底：即使模型没给出可用新标题，也通过（2）（3）后缀保证唯一。
  // 宁可标题生硬一点，也不能让番茄目录或本地细纲出现重名。
  const used = new Set(existingKeys);
  for (const chapter of chapters) {
    const base = chapter.title.trim();
    let candidate = base;
    let suffix = 2;
    while (!normalizeTitle(candidate) || used.has(normalizeTitle(candidate))) {
      candidate = `${base}（${suffix}）`;
      suffix += 1;
    }
    chapter.title = candidate;
    used.add(normalizeTitle(candidate));
  }
}

export async function extendPlan(
  meta: ProjectMeta,
  plan: ProjectPlan,
  bible: string,
  outlineMd: string,
  recentSummaries: string[],
  count: number,
  context: {
    canon?: CanonFacts;
    characters?: Character[];
    storyContext?: string;
  } = {},
): Promise<ChapterPlan[]> {
  const startIndex = plan.chapters.length
    ? Math.max(...plan.chapters.map((chapter) => chapter.index)) + 1
    : 1;

  if (isMock()) return mockExtendedChapters(meta, startIndex, count);

  const llm = new LLMClient();
  const data = await llm.json<Record<string, unknown>>(
    extendMessages(
      meta,
      plan,
      bible,
      outlineMd,
      recentSummaries,
      count,
      startIndex,
      context,
    ),
    { agent: "extend-plan" },
  );
  const raw = Array.isArray(data.chapters) ? data.chapters : [];
  // 模型可能多返回几章或夹带空标题的行：丢掉无效项后必须凑够请求数量，
  // 再按 startIndex 重新编号，避免章节号断档或重复。
  const candidates = raw
    .map((item) => {
      const record = (item ?? {}) as Record<string, unknown>;
      return {
        title: str(record.title).trim(),
        summary: str(record.summary).trim(),
        keyBeats: arr(record.keyBeats ?? record.key_beats),
      };
    })
    .filter((chapter) => chapter.title && chapter.summary);

  if (candidates.length < count) {
    throw new Error(
      `架构师返回的有效章节不足：需要 ${count} 章，实际只有 ${candidates.length} 章`,
    );
  }

  const chapters: ChapterPlan[] = candidates.slice(0, count).map((chapter, i) => ({
    index: startIndex + i,
    title: chapter.title,
    summary: chapter.summary,
    keyBeats: chapter.keyBeats,
  }));

  assertValidChapterPlans(chapters, {
    expectedCount: count,
    startIndex,
    requireContiguous: true,
  });

  await repairDuplicateTitles(
    llm,
    chapters,
    plan.chapters.map((chapter) => chapter.title),
  );
  return chapters;
}

// 部分模型会用 ```markdown 包裹正文，写入章节文件前去掉首尾围栏。
function stripFences(raw: string): string {
  return raw
    .replace(/^```[^\n]*\n/, "")
    .replace(/\n```\s*$/, "")
    .trim();
}

export async function writeChapter(
  meta: ProjectMeta,
  bible: string,
  characters: Character[],
  chapter: ChapterPlan,
  previousEnding: string,
  history: string[],
  options: ChapterWriteOptions = {},
): Promise<string> {
  if (isMock()) return mockChapter(meta, chapter);

  const llm = new LLMClient();
  const raw = await llm.chat(
    writerMessages(meta, bible, characters, chapter, previousEnding, history, options),
    { agent: "writer", chapter: chapter.index },
  );
  return stripFences(raw);
}

export async function extractChapterFacts(
  meta: ProjectMeta,
  bible: string,
  chapter: ChapterPlan,
  chapterText: string,
  canon: CanonFacts,
): Promise<ExtractedFacts> {
  if (isMock()) {
    return {
      summary: chapter.summary,
      characters: [],
      items: [],
      timeline: null,
      rules: [],
      memory: {
        events: chapter.keyBeats.slice(0, 20),
        characters: [],
        actions: [],
        time: "",
        location: "",
        endingState: "",
        newSettings: [],
        foreshadowsPlanted: [],
        foreshadowsResolved: [],
      },
      story: {
        states: [],
        relations: [],
        events: chapter.keyBeats.slice(0, 20).map((name) => ({
          name,
          time: "",
          location: "",
          participants: [],
          cause: "",
          process: "",
          result: "",
          impact: "",
          relatedEvents: [],
          foreshadows: [],
        })),
      },
    };
  }

  const llm = new LLMClient();
  const data = await llm.json<Record<string, unknown>>(
    factExtractorMessages(meta, bible, chapter, chapterText, canon),
    // 事实抽取要稳定复现，不用创作时的高温参数。
    { temperature: 0.1, agent: "fact-extractor", chapter: chapter.index },
  );
  const facts = normalizeExtractedFacts(data, chapter.summary);
  const memory = normalizeExtractedMemory(data.memory);
  const story = normalizeExtractedStory(data.story);
  return {
    ...facts,
    ...(memory ? { memory: groundExtractedMemory(memory, chapterText) } : {}),
    story: groundExtractedStory(story, chapterText),
  };
}

export async function auditChapter(
  meta: ProjectMeta,
  canon: CanonFacts,
  characters: Character[],
  chapter: ChapterPlan,
  chapterText: string,
  previousContext: string,
  suspicions: ContinuityIssue[],
  nextContext: string,
  storyContext: string,
  evidenceContext = "",
): Promise<ReviewResult> {
  if (isMock()) return mockReview(chapter);

  const llm = new LLMClient();
  const data = await llm.json<Record<string, unknown>>(
    auditMessages(
      meta,
      canon,
      characters,
      chapter,
      chapterText,
      previousContext,
      suspicions,
      nextContext,
      storyContext,
      evidenceContext,
    ),
    { temperature: 0.1, agent: "auditor", chapter: chapter.index },
  );
  return normalizeReviewResult(data, chapter.summary);
}

export async function auditRepairRegression(
  meta: ProjectMeta,
  canon: CanonFacts,
  characters: Character[],
  chapter: ChapterPlan,
  originalText: string,
  repairedText: string,
  evidenceContext: string,
  previousEnding: string,
  nextOpening: string,
  regressionScope = "",
): Promise<ReviewResult> {
  if (isMock()) {
    return {
      summary: chapter.summary,
      issues: [],
      continuityOk: true,
      extractionOk: true,
    };
  }
  const llm = new LLMClient();
  const data = await llm.json<Record<string, unknown>>(
    repairRegressionMessages(
      meta,
      chapter,
      originalText,
      repairedText,
      evidenceContext,
      canon,
      characters,
      previousEnding,
      nextOpening,
      regressionScope,
    ),
    { temperature: 0.1, agent: "auditor", chapter: chapter.index },
  );
  return normalizeReviewResult(data, chapter.summary);
}

export class RepairNeedsAuthorDecisionError extends Error {
  constructor(reason: string) {
    super(reason || "修复证据不足，需要作者决定");
    this.name = "RepairNeedsAuthorDecisionError";
  }
}

// 修复方案格式正确但证据不成立时抛出，由调用方拒绝本章而不是让整个任务失败。
export class RepairPlanRejectedError extends Error {
  readonly details: string[];

  constructor(message: string, details: string[] = []) {
    super(message);
    this.name = "RepairPlanRejectedError";
    this.details = details;
  }
}

export interface RepairPlanIssue {
  issueIndex: number;
  rootCause: string;
  evidence: string;
  locations: string[];
  strategy: string;
  affectedFacts: string[];
  sideEffects: string;
  regressionScope: string;
}

export interface RepairPlan {
  issuePlans: RepairPlanIssue[];
  needsAuthorDecision: boolean;
  decisionReason: string;
}

export function normalizeRepairPlan(input: unknown): RepairPlan {
  const record = (input ?? {}) as Record<string, unknown>;
  const rawPlans = Array.isArray(record.issuePlans)
    ? record.issuePlans
    : Array.isArray(record.issue_plans)
      ? record.issue_plans
      : [];
  const issuePlans: RepairPlanIssue[] = rawPlans.map((item) => {
    const plan = (item ?? {}) as Record<string, unknown>;
    return {
      issueIndex: Number.parseInt(String(plan.issueIndex ?? plan.issue_index ?? ""), 10),
      rootCause: str(plan.rootCause ?? plan.root_cause).trim(),
      evidence: str(plan.evidence).trim(),
      locations: arr(plan.locations),
      strategy: str(plan.strategy).trim(),
      affectedFacts: arr(plan.affectedFacts ?? plan.affected_facts),
      sideEffects: str(plan.sideEffects ?? plan.side_effects).trim(),
      regressionScope: str(plan.regressionScope ?? plan.regression_scope).trim(),
    };
  });
  return {
    issuePlans,
    needsAuthorDecision: record.needsAuthorDecision === true || record.needs_author_decision === true,
    decisionReason: str(record.decisionReason ?? record.decision_reason).trim(),
  };
}

const EVIDENCE_NOISE = /[\s，。！？；：、“”‘’（）()《》【】〔〕…—\-·,.!?;:'"\\/\[\]{}<>|]/gu;

function compactEvidence(value: string): string {
  return value.normalize("NFKC").replace(EVIDENCE_NOISE, "").toLowerCase();
}

function originalEvidenceSection(context: string): string {
  const parts: string[] = [];
  for (const match of context.matchAll(/（原文）([\s\S]*?)(?=\n【|$)/gu)) {
    parts.push(match[1]);
  }
  return parts.join("\n");
}

function containsEvidence(haystack: string, needle: string): boolean {
  const compactNeedle = compactEvidence(needle);
  if (compactNeedle.length < 4) return false;
  const compactHaystack = compactEvidence(haystack);
  if (compactHaystack.includes(compactNeedle)) return true;
  // 长证据可能被模型截断；只比较前 60 个有效字符，避免整段比对失败。
  if (compactNeedle.length > 60) {
    return compactHaystack.includes(compactNeedle.slice(0, 60));
  }
  return false;
}

export function validateRepairPlan(
  plan: RepairPlan,
  issueCount: number,
  context: { chapterText?: string; evidenceContext?: string } = {},
): void {
  if (!plan.issuePlans.length) {
    throw new RepairPlanRejectedError("修复方案没有覆盖任何问题，已拒绝修改正文");
  }
  const covered = new Set<number>();
  const details: string[] = [];
  for (const item of plan.issuePlans) {
    if (
      !Number.isInteger(item.issueIndex) ||
      item.issueIndex < 1 ||
      item.issueIndex > issueCount
    ) {
      throw new RepairPlanRejectedError(
        `修复方案引用了不存在的问题编号：${String(item.issueIndex)}`,
      );
    }
    if (!item.strategy) {
      throw new RepairPlanRejectedError(
        `问题 ${item.issueIndex} 的修复方案缺少可执行策略`,
      );
    }
    if (!item.regressionScope) {
      throw new RepairPlanRejectedError(
        `问题 ${item.issueIndex} 的修复方案没有说明回归审校范围`,
      );
    }
    if (context.chapterText !== undefined) {
      const chapterText = context.chapterText;
      if (!item.evidence) {
        details.push(`问题 ${item.issueIndex} 没有引用任何原文证据`);
      } else if (
        !containsEvidence(chapterText, item.evidence) &&
        !containsEvidence(originalEvidenceSection(context.evidenceContext ?? ""), item.evidence)
      ) {
        details.push(
          `问题 ${item.issueIndex} 引用的证据只来自台账、摘要或推断，不在当前正文和原文证据中`,
        );
      }
      const located = item.locations.some(
        (location) => location.trim() && containsEvidence(chapterText, location),
      );
      if (!located) {
        details.push(
          `问题 ${item.issueIndex} 计划修改的位置在当前正文中不存在`,
        );
      }
    }
    covered.add(item.issueIndex);
  }
  for (let index = 1; index <= issueCount; index += 1) {
    if (!covered.has(index)) {
      details.push(`修复方案遗漏了问题 ${index}`);
    }
  }
  if (details.length) {
    throw new RepairPlanRejectedError(
      `修复方案未通过证据校验，已拒绝修改正文：${details.join("；")}`,
      details,
    );
  }
}

function formatRepairPlan(plan: RepairPlan): string {
  return plan.issuePlans
    .map(
      (item) =>
        `问题 ${item.issueIndex}：
- 根本原因：${item.rootCause || "未说明"}
- 证据：${item.evidence || "未说明"}
- 计划修改位置：${item.locations.join("；") || "未说明"}
- 修改策略：${item.strategy}
- 受影响事实：${item.affectedFacts.join("；") || "未说明"}
- 潜在副作用：${item.sideEffects || "未说明"}
- 回归审校范围：${item.regressionScope || "未说明"}`,
    )
    .join("\n\n");
}

export async function repairChapter(
  meta: ProjectMeta,
  chapter: ChapterPlan,
  chapterText: string,
  issues: ContinuityIssue[],
  canon: CanonFacts,
  previousEnding: string,
  nextOpening: string,
  rewriteInstruction: string,
  reviewFeedback: string,
  options: {
    draftRepair?: boolean;
    evidenceContext?: string;
    twoStage?: boolean;
  } = {},
): Promise<string> {
  if (isMock()) return chapterText;
  if (!issues.length) return chapterText;

  const llm = new LLMClient();
  let planText = "";
  // 两阶段：先出方案并做约束检查，方案通过后才允许改正文。
  if (options.twoStage !== false) {
    const planData = await llm.json<Record<string, unknown>>(
      chapterRepairPlanMessages(
        meta,
        chapter,
        chapterText,
        issues,
        canon,
        previousEnding,
        nextOpening,
        rewriteInstruction,
        reviewFeedback,
        options,
      ),
      { temperature: 0.1, agent: "repair-editor", chapter: chapter.index },
    );
    const plan = normalizeRepairPlan(planData);
    if (plan.needsAuthorDecision) {
      throw new RepairNeedsAuthorDecisionError(plan.decisionReason);
    }
    validateRepairPlan(plan, issues.length);
    planText = formatRepairPlan(plan);
  }

  const raw = await llm.chat(
    chapterRepairMessages(
      meta,
      chapter,
      chapterText,
      issues,
      canon,
      previousEnding,
      nextOpening,
      rewriteInstruction,
      reviewFeedback,
      { ...options, planText },
    ),
    { temperature: 0.2, agent: "repair-editor", chapter: chapter.index },
  );
  return stripFences(raw);
}

export interface RepairPatchPlanResult {
  patches: RepairPatch[];
  planText: string;
  regressionScope: string;
}

/**
 * 补丁式修复：只返回结构化局部修改，不返回整章正文。
 * 方案阶段必须在当前正文和原文证据中真实成立，否则拒绝生成补丁。
 */
export async function repairChapterPatches(
  meta: ProjectMeta,
  chapter: ChapterPlan,
  chapterText: string,
  issues: ContinuityIssue[],
  canon: CanonFacts,
  previousEnding: string,
  nextOpening: string,
  rewriteInstruction: string,
  reviewFeedback: string,
  options: {
    draftRepair?: boolean;
    evidenceContext?: string;
    twoStage?: boolean;
  } = {},
): Promise<RepairPatchPlanResult> {
  if (isMock()) return { patches: [], planText: "", regressionScope: "" };
  if (!issues.length) return { patches: [], planText: "", regressionScope: "" };

  const llm = new LLMClient();
  let planText = "";
  let regressionScope = "";
  if (options.twoStage !== false) {
    const planData = await llm.json<Record<string, unknown>>(
      chapterRepairPlanMessages(
        meta,
        chapter,
        chapterText,
        issues,
        canon,
        previousEnding,
        nextOpening,
        rewriteInstruction,
        reviewFeedback,
        options,
      ),
      { temperature: 0.1, agent: "repair-editor", chapter: chapter.index },
    );
    const plan = normalizeRepairPlan(planData);
    if (plan.needsAuthorDecision) {
      throw new RepairNeedsAuthorDecisionError(plan.decisionReason);
    }
    validateRepairPlan(plan, issues.length, {
      chapterText,
      evidenceContext: options.evidenceContext ?? "",
    });
    planText = formatRepairPlan(plan);
    regressionScope = plan.issuePlans
      .map((item) => item.regressionScope)
      .filter(Boolean)
      .join("；");
  }

  const data = await llm.json<Record<string, unknown>>(
    chapterRepairPatchMessages(
      meta,
      chapter,
      chapterText,
      issues,
      canon,
      previousEnding,
      nextOpening,
      rewriteInstruction,
      reviewFeedback,
      { ...options, planText },
    ),
    { temperature: 0.1, agent: "repair-editor", chapter: chapter.index },
  );
  return {
    patches: normalizeRepairPatches(data),
    planText,
    regressionScope,
  };
}
