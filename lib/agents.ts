import { normalizeExtractedFacts, normalizeReviewResult } from "./canon";
import { getRuntimeConfig } from "./config";
import {
  LLMClient,
  LLMOutputTruncatedError,
  type LLMProgressEvent,
} from "./llm";
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
  architectChapterBatchMessages,
  architectFoundationMessages,
  architectLedgerBatchMessages,
  auditMessages,
  chapterRepairMessages,
  chapterRepairPatchMessages,
  chapterRepairPlanMessages,
  repairRegressionConfirmMessages,
  repairRegressionMessages,
  characterMessages,
  extendMessages,
  factExtractorMessages,
  titleRepairMessages,
  writerMessages,
} from "./prompts";
import {
  normalizeRepairPatches,
  paragraphsMatchingAnchors,
  type RepairPatch,
} from "./repair-patch";
import { structuralRepairIssues } from "./repair-routing";
import {
  causalVerificationComplete,
  formatCausalBaseline,
  isCausalBaselineComplete,
  normalizeCausalBaseline,
  normalizeCausalChanges,
  type CausalBaseline,
  type CausalChange,
} from "./repair-causal";
import {
  classifyRegressionByEvidence,
  normalizeRegressionVerdict,
  type RegressionConfirmation,
  type RepairBaseline,
} from "./repair-iteration";
import {
  assertValidPlanLedger,
  emptyPlanLedger,
  mergePlanLedgers,
  planEntriesForChapters,
  sanitizeGeneratedPlanLedger,
} from "./plan-ledger";
import { normalizeCharacter } from "./store";
import {
  needsHigherTier,
  normalizeOutputTokens,
  tokenBudgetForTask,
} from "./token-tiers";
import { errorMessage } from "./utils";
import type {
  CanonFacts,
  ChapterPlan,
  ChapterWriteOptions,
  Character,
  ContinuityIssue,
  ExtractedFacts,
  PlanLedger,
  ProjectMeta,
  ProjectPlan,
  ReviewResult,
} from "./types";
import type { GeneratedPlan } from "./mock";

// 方案里的章节编号是数字数组，不能用只保留字符串的 arr() 过滤；
// 模型偶尔会写“第4章”，也要能解析出数字。
function numberList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const match = String(item).match(/\d+/u);
      return match ? Number.parseInt(match[0], 10) : Number.NaN;
    })
    .filter((item) => Number.isInteger(item) && item > 0);
}

// 模型偶尔把数组字段写成单个字符串；按需拆分，避免整段设定被静默丢弃。
function stringList(value: unknown, splitLines = false): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return splitLines
      ? value
          .split(/[；;\n]/u)
          .map((item) => item.trim())
          .filter(Boolean)
      : [value.trim()];
  }
  return [];
}

// 修复阶段可以单独配置更强的模型；留空时沿用主模型。
function repairModelOption(): { model?: string } {
  const model = getRuntimeConfig().repairModel.trim();
  return model ? { model } : {};
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function arr(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isMock(): boolean {
  return getRuntimeConfig().provider === "mock";
}

type ProgressReporter = (message: string) => void;

export interface PlanGenerationOptions {
  onProgress?: ProgressReporter;
  client?: LLMClient;
}

export interface CharacterGenerationOptions {
  onProgress?: ProgressReporter;
  client?: LLMClient;
}

interface ArchitectureFoundation {
  logline: string;
  tags: string[];
  bible: string;
  outlineMd: string;
}

interface EventReference {
  id: string;
  name: string;
  chapter: number;
}

interface ArchitectureContext {
  client: LLMClient;
  meta: ProjectMeta;
  foundation: ArchitectureFoundation;
  budget: number;
  report: ProgressReporter;
  onProgress: (event: LLMProgressEvent) => void;
}

export function architectureBatchSize(configured: number): number {
  return normalizeOutputTokens(configured) >= 32768 ? 20 : 10;
}

function reporter(onProgress: ProgressReporter | undefined): ProgressReporter {
  return onProgress ?? (() => undefined);
}

function llmProgress(report: ProgressReporter) {
  return (event: LLMProgressEvent) => {
    report(`[${event.model}] ${event.message}`);
  };
}

function parseFoundation(data: Record<string, unknown>): ArchitectureFoundation {
  const bible = str(data.bibleMd ?? data.bible_md).trim();
  const outlineMd = str(data.outlineMd ?? data.outline_md).trim();
  if (!bible) throw new Error("架构第一阶段没有返回世界观圣经（bibleMd）");
  if (!outlineMd) throw new Error("架构第一阶段没有返回全书主线大纲（outlineMd）");
  return {
    logline: str(data.logline).trim(),
    tags: arr(data.tags),
    bible,
    outlineMd,
  };
}

async function generateFoundation(
  client: LLMClient,
  meta: ProjectMeta,
  budget: number,
  report: ProgressReporter,
  onProgress: (event: LLMProgressEvent) => void,
): Promise<ArchitectureFoundation> {
  report("架构第一阶段：生成世界观、全书主线与分卷规划…");
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const data = await client.json<Record<string, unknown>>(
        architectFoundationMessages(meta),
        { agent: "architect", maxTokens: budget, onProgress },
      );
      return parseFoundation(data);
    } catch (error) {
      lastError = error;
      if (error instanceof LLMOutputTruncatedError) {
        throw new Error(`架构生成第一阶段失败：${errorMessage(error)} 旧架构保持不变。`);
      }
      if (attempt >= 3) break;
      report(
        `架构第一阶段未通过校验（第 ${attempt}/3 次）：${errorMessage(error)}，正在重试…`,
      );
    }
  }
  throw new Error(`架构生成第一阶段连续 3 次失败：${errorMessage(lastError)}`);
}

function parseChapterBatch(
  data: Record<string, unknown>,
  startIndex: number,
  count: number,
): ChapterPlan[] {
  const rawChapters = Array.isArray(data.chapters) ? data.chapters : [];
  if (rawChapters.length < count) {
    throw new Error(
      `模型只返回了 ${rawChapters.length} 章，本批需要 ${count} 章（第 ${startIndex}-${
        startIndex + count - 1
      } 章）`,
    );
  }
  const records = rawChapters.slice(0, count);
  const hasAnyIndex = records.some((item) => {
    const record = (item ?? {}) as Record<string, unknown>;
    return (
      record.index !== undefined &&
      record.index !== null &&
      !(typeof record.index === "string" && !record.index.trim())
    );
  });

  const chapters: ChapterPlan[] = records.map((item, position) => {
    const record = (item ?? {}) as Record<string, unknown>;
    const expected = startIndex + position;
    const parsed = parseChapterIndex(record.index);
    if (hasAnyIndex && parsed !== expected) {
      throw new Error(
        `章节序号不连续：本批第 ${position + 1} 项应为第 ${expected} 章，实际为 ${String(
          record.index,
        )}`,
      );
    }
    const title = str(record.title).trim();
    const summary = str(record.summary).trim();
    if (!title) throw new Error(`第 ${expected} 章标题为空`);
    if (!summary) throw new Error(`第 ${expected} 章梗概为空`);
    return {
      // 全部章节都没给序号时按批次位置补号；混用有效/无效序号则直接报错。
      index: parsed ?? expected,
      title,
      summary,
      keyBeats: arr(record.keyBeats ?? record.key_beats),
    };
  });

  assertValidChapterPlans(chapters, {
    expectedCount: count,
    startIndex,
    requireContiguous: true,
  });
  return chapters;
}

async function collectChapterRange(
  context: ArchitectureContext,
  startIndex: number,
  count: number,
  collected: ChapterPlan[],
): Promise<void> {
  const endIndex = startIndex + count - 1;
  const label = `章节细纲第 ${startIndex}-${endIndex} 章`;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    context.report(`${label}：生成中（第 ${attempt}/3 次）…`);
    try {
      const data = await context.client.json<Record<string, unknown>>(
        architectChapterBatchMessages(
          context.meta,
          context.foundation,
          startIndex,
          count,
          collected,
        ),
        { agent: "architect", maxTokens: context.budget, onProgress: context.onProgress },
      );
      const chapters = parseChapterBatch(data, startIndex, count);
      collected.push(...chapters);
      context.report(`${label}：已完成 ${chapters.length} 章。`);
      return;
    } catch (error) {
      lastError = error;
      if (error instanceof LLMOutputTruncatedError && count > 1) {
        const left = Math.ceil(count / 2);
        context.report(
          `${label} 达到 ${error.maxTokens} Tokens 上限，拆成 ${left} + ${
            count - left
          } 章后分别重试…`,
        );
        await collectChapterRange(context, startIndex, left, collected);
        await collectChapterRange(context, startIndex + left, count - left, collected);
        return;
      }
      if (attempt >= 3) break;
      context.report(`${label}失败（第 ${attempt}/3 次）：${errorMessage(error)}，正在重试…`);
    }
  }
  throw new Error(`架构生成${label}失败：${errorMessage(lastError)}`);
}

function restrictLedgerToChapters(
  ledger: PlanLedger,
  chapters: ChapterPlan[],
): PlanLedger {
  const indexes = new Set(chapters.map((chapter) => chapter.index));
  return {
    ...ledger,
    events: ledger.events.filter((event) => indexes.has(event.chapter)),
    characterChanges: ledger.characterChanges.filter((change) => indexes.has(change.chapter)),
    foreshadows: ledger.foreshadows.filter((item) => indexes.has(item.plantChapter)),
    timeline: ledger.timeline.filter((item) => indexes.has(item.chapter)),
    items: ledger.items.filter((item) => indexes.has(item.chapter)),
    deviations: [],
  };
}

function safeIdPart(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").slice(0, 100);
  return cleaned || "id";
}

function namespaceLedgerIds(ledger: PlanLedger, namespace: string): PlanLedger {
  const eventIds = new Map<string, string>();
  const mapId = (id: string) => {
    if (!eventIds.has(id)) eventIds.set(id, `${namespace}-${safeIdPart(id)}`);
    return eventIds.get(id)!;
  };
  const remap = (ids: string[]) => ids.map((id) => eventIds.get(id) ?? id);

  return {
    ...ledger,
    events: ledger.events
      .map((event) => ({ ...event, id: mapId(event.id) }))
      .map((event) => ({ ...event, relatedEventIds: remap(event.relatedEventIds) })),
    characterChanges: ledger.characterChanges.map((change) => ({
      ...change,
      id: mapId(change.id),
      eventIds: remap(change.eventIds),
    })),
    foreshadows: ledger.foreshadows.map((item) => ({
      ...item,
      id: mapId(item.id),
      eventIds: remap(item.eventIds),
    })),
    timeline: ledger.timeline.map((item) => ({
      ...item,
      id: mapId(item.id),
      eventIds: remap(item.eventIds),
    })),
    items: ledger.items.map((item) => ({
      ...item,
      id: mapId(item.id),
      eventIds: remap(item.eventIds),
    })),
    deviations: [],
  };
}

function ensureLedgerCoverage(
  ledger: PlanLedger,
  chapters: ChapterPlan[],
  report: ProgressReporter,
): PlanLedger {
  const covered = new Set(ledger.events.map((event) => event.chapter));
  const missing = chapters.filter((chapter) => !covered.has(chapter.index));
  if (!missing.length) return ledger;

  const used = new Set(ledger.events.map((event) => event.id));
  const fallback = planEntriesForChapters(missing).map((event) => {
    let id = event.id;
    let suffix = 2;
    while (used.has(id)) {
      id = `${event.id}-${suffix}`;
      suffix += 1;
    }
    used.add(id);
    return { ...event, id };
  });
  report(
    `计划台账缺少第 ${missing.map((chapter) => chapter.index).join("、")} 章的事件，已用章节细纲补齐。`,
  );
  return { ...ledger, events: [...ledger.events, ...fallback] };
}

function pruneLedgerReferences(ledger: PlanLedger): {
  ledger: PlanLedger;
  removed: number;
} {
  const eventIds = new Set(ledger.events.map((event) => event.id));
  let removed = 0;
  const keep = (ids: string[]) => {
    const kept = ids.filter((id) => eventIds.has(id));
    removed += ids.length - kept.length;
    return kept;
  };
  return {
    removed,
    ledger: {
      ...ledger,
      events: ledger.events.map((event) => ({
        ...event,
        relatedEventIds: keep(event.relatedEventIds),
      })),
      characterChanges: ledger.characterChanges.map((change) => ({
        ...change,
        eventIds: keep(change.eventIds),
      })),
      foreshadows: ledger.foreshadows.map((item) => ({
        ...item,
        eventIds: keep(item.eventIds),
      })),
      timeline: ledger.timeline.map((item) => ({
        ...item,
        eventIds: keep(item.eventIds),
      })),
      items: ledger.items.map((item) => ({
        ...item,
        eventIds: keep(item.eventIds),
      })),
    },
  };
}

async function collectLedgerRange(
  context: ArchitectureContext,
  chapters: ChapterPlan[],
  priorEvents: EventReference[],
  collected: PlanLedger[],
  batchNo: number,
  namespace: string,
): Promise<void> {
  const first = chapters[0]?.index ?? 0;
  const last = chapters[chapters.length - 1]?.index ?? first;
  const label = `计划台账第 ${first}-${last} 章`;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    context.report(`${label}：生成中（第 ${attempt}/3 次）…`);
    try {
      const data = await context.client.json<Record<string, unknown>>(
        architectLedgerBatchMessages(
          context.meta,
          context.foundation,
          chapters,
          priorEvents,
          batchNo,
        ),
        { agent: "architect", maxTokens: context.budget, onProgress: context.onProgress },
      );
      const rawLedger = data.planLedger ?? data.plan_ledger;
      const rawRecord = (rawLedger ?? {}) as Record<string, unknown>;
      if (!Array.isArray(rawRecord.events) && !Array.isArray(rawRecord.foreshadows)) {
        throw new Error("模型没有返回结构化计划台账（planLedger）");
      }
      let ledger = restrictLedgerToChapters(
        sanitizeGeneratedPlanLedger(rawLedger),
        chapters,
      );
      if (!ledger.events.length) {
        throw new Error(`计划台账没有覆盖第 ${first}-${last} 章的任何事件`);
      }
      ledger = ensureLedgerCoverage(ledger, chapters, context.report);
      ledger = namespaceLedgerIds(ledger, namespace);
      collected.push(ledger);
      priorEvents.push(
        ...ledger.events.map((event) => ({
          id: event.id,
          name: event.name,
          chapter: event.chapter,
        })),
      );
      context.report(`${label}：已完成 ${ledger.events.length} 个计划事件。`);
      return;
    } catch (error) {
      lastError = error;
      if (error instanceof LLMOutputTruncatedError && chapters.length > 1) {
        const middle = Math.ceil(chapters.length / 2);
        context.report(
          `${label} 达到 ${error.maxTokens} Tokens 上限，拆成 ${middle} + ${
            chapters.length - middle
          } 章后分别重试…`,
        );
        await collectLedgerRange(
          context,
          chapters.slice(0, middle),
          priorEvents,
          collected,
          batchNo,
          `${namespace}a`,
        );
        await collectLedgerRange(
          context,
          chapters.slice(middle),
          priorEvents,
          collected,
          batchNo,
          `${namespace}b`,
        );
        return;
      }
      if (attempt >= 3) break;
      context.report(`${label}失败（第 ${attempt}/3 次）：${errorMessage(error)}，正在重试…`);
    }
  }
  throw new Error(`架构生成${label}失败：${errorMessage(lastError)}`);
}

export async function generatePlan(
  meta: ProjectMeta,
  options: PlanGenerationOptions = {},
): Promise<GeneratedPlan> {
  if (isMock()) return mockPlan(meta);

  const runtime = getRuntimeConfig();
  const budget = tokenBudgetForTask("architecture", runtime.maxTokens);
  const report = reporter(options.onProgress);
  const client = options.client ?? new LLMClient();
  const onProgress = llmProgress(report);
  const target = Math.max(1, Math.round(meta.targetChapters) || 1);

  report(
    `架构生成：模型 ${runtime.model}，输出预算 ${budget} Tokens，目标 ${target} 章。`,
  );
  if (needsHigherTier("architecture", runtime.maxTokens)) {
    report(
      "提示：当前为标准档 8192 Tokens。架构会分批生成；如果仍被截断，请在「模型设置」选择高输出档或超大输出档。",
    );
  }

  const foundation = await generateFoundation(client, meta, budget, report, onProgress);
  report(
    `架构第一阶段完成：世界观 ${foundation.bible.length} 字，主线大纲 ${foundation.outlineMd.length} 字。`,
  );

  const batchSize = architectureBatchSize(runtime.maxTokens);
  const context: ArchitectureContext = {
    client,
    meta,
    foundation,
    budget,
    report,
    onProgress,
  };
  const chapterBatches = Math.ceil(target / batchSize);
  let chapterBatch = 0;
  const chapters: ChapterPlan[] = [];
  report(`架构第二阶段：分批生成章节细纲，共 ${chapterBatches} 批。`);
  for (let start = 1; start <= target; start += batchSize) {
    chapterBatch += 1;
    const count = Math.min(batchSize, target - start + 1);
    report(
      `章节细纲第 ${chapterBatch}/${chapterBatches} 批：第 ${start}-${start + count - 1} 章。`,
    );
    await collectChapterRange(context, start, count, chapters);
  }

  if (chapters.length !== target) {
    throw new Error(`章节细纲数量为 ${chapters.length}，预期 ${target} 章，架构未提交`);
  }
  assertValidChapterPlans(chapters, {
    expectedCount: target,
    startIndex: 1,
    requireContiguous: true,
  });
  await repairDuplicateTitles(client, chapters, []);
  report(`章节细纲已完成：共 ${chapters.length} 章，编号连续且标题已去重。`);

  const ledgerParts: PlanLedger[] = [];
  const priorEvents: EventReference[] = [];
  const ledgerBatches = Math.ceil(chapters.length / batchSize);
  let batchNo = 0;
  report(`架构第三阶段：分批生成结构化计划台账，共 ${ledgerBatches} 批。`);
  for (let start = 0; start < chapters.length; start += batchSize) {
    batchNo += 1;
    const batch = chapters.slice(start, start + batchSize);
    report(
      `计划台账第 ${batchNo}/${ledgerBatches} 批：第 ${batch[0]?.index}-${batch[batch.length - 1]?.index} 章。`,
    );
    await collectLedgerRange(
      context,
      batch,
      priorEvents,
      ledgerParts,
      batchNo,
      `b${batchNo}`,
    );
  }

  let planLedger = ledgerParts.reduce(
    (merged, part) => mergePlanLedgers(merged, part),
    emptyPlanLedger(),
  );
  const pruned = pruneLedgerReferences(planLedger);
  planLedger = pruned.ledger;
  if (pruned.removed) {
    report(`计划台账清理了 ${pruned.removed} 个不存在的跨事件引用。`);
  }
  planLedger = ensureLedgerCoverage(planLedger, chapters, report);
  const plan: ProjectPlan = {
    logline: foundation.logline,
    tags: foundation.tags,
    chapters,
  };
  assertValidPlanLedger(planLedger, plan);
  report(
    `计划台账已完成：${planLedger.events.length} 个计划事件、${planLedger.foreshadows.length} 条计划伏笔。`,
  );

  return {
    plan,
    bible: foundation.bible,
    outlineMd: foundation.outlineMd,
    planLedger,
  };
}

type CharacterTextField = Exclude<keyof Character, "source" | "updatedAt">;

const CHARACTER_FIELDS: Array<[CharacterTextField, string]> = [
  ["name", "姓名"],
  ["role", "角色定位"],
  ["gender", "性别"],
  ["age", "年龄"],
  ["appearance", "外貌"],
  ["personality", "性格"],
  ["background", "背景"],
  ["goals", "目标"],
  ["arc", "成长弧光"],
  ["relationships", "人物关系"],
  ["speechStyle", "说话风格"],
];

function characterNameKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

export function validateGeneratedCharacters(input: unknown): Character[] {
  if (!Array.isArray(input)) {
    throw new Error("角色 JSON 中的 characters 必须是数组");
  }
  if (input.length < 6 || input.length > 10) {
    throw new Error(`角色数量为 ${input.length}，要求 6-10 位核心角色`);
  }

  const characters = input.map(normalizeCharacter);
  const problems: string[] = [];
  for (const [position, character] of characters.entries()) {
    const missing = CHARACTER_FIELDS.filter(([key]) => !character[key]?.trim()).map(
      ([, label]) => label,
    );
    if (missing.length) {
      problems.push(
        `第 ${position + 1} 位角色${character.name ? `「${character.name}」` : ""}缺少：${missing.join("、")}`,
      );
    }
  }

  const seen = new Map<string, string>();
  for (const character of characters) {
    const key = characterNameKey(character.name);
    if (!key) continue;
    const previous = seen.get(key);
    if (previous) problems.push(`角色姓名重复：「${previous}」与「${character.name}」`);
    else seen.set(key, character.name);
  }

  if (problems.length) {
    throw new Error(`角色卡结构校验未通过：${problems.slice(0, 6).join("；")}`);
  }
  return characters;
}

export async function generateCharacters(
  meta: ProjectMeta,
  generated: GeneratedPlan,
  options: CharacterGenerationOptions = {},
): Promise<Character[]> {
  if (isMock()) return mockCharacters(meta);

  const runtime = getRuntimeConfig();
  const budget = tokenBudgetForTask("characters", runtime.maxTokens);
  const report = reporter(options.onProgress);
  const client = options.client ?? new LLMClient();
  const onProgress = llmProgress(report);
  report(`角色生成：模型 ${runtime.model}，输出预算 ${budget} Tokens。`);
  if (needsHigherTier("characters", runtime.maxTokens)) {
    report(
      "提示：当前为标准档 8192 Tokens，角色生成建议使用高输出档 16384 Tokens。",
    );
  }

  let feedback: string[] | undefined;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const data = await client.json<Record<string, unknown>>(
        characterMessages(meta, generated.bible, generated.outlineMd, feedback),
        { agent: "character-designer", maxTokens: budget, onProgress },
      );
      return validateGeneratedCharacters(data.characters);
    } catch (error) {
      lastError = error;
      if (error instanceof LLMOutputTruncatedError) {
        throw new Error(`角色生成失败：${errorMessage(error)} 已生成的架构尚未提交。`);
      }
      if (attempt >= 2) break;
      feedback = [errorMessage(error)];
      report(`角色卡结构校验失败（第 ${attempt}/2 次）：${errorMessage(error)}，正在受控重试…`);
    }
  }
  throw new Error(
    `角色生成连续两次未通过结构校验：${errorMessage(lastError)} 已生成的架构尚未提交。`,
  );
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

export interface ExtendedPlanResult {
  chapters: ChapterPlan[];
  planLedger: PlanLedger;
}

export interface ExtendPlanOptions {
  onProgress?: ProgressReporter;
  client?: LLMClient;
}

async function extendPlanBatch(
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
  },
  llm: LLMClient,
  maxTokens: number,
  onProgress: (event: LLMProgressEvent) => void,
): Promise<ExtendedPlanResult> {
  const startIndex = plan.chapters.length
    ? Math.max(...plan.chapters.map((chapter) => chapter.index)) + 1
    : 1;

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
    { agent: "extend-plan", maxTokens, onProgress },
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

  const rawLedger = data.planLedger ?? data.plan_ledger;
  const rawRecord = (rawLedger ?? {}) as Record<string, unknown>;
  if (!Array.isArray(rawRecord.events) && !Array.isArray(rawRecord.foreshadows)) {
    throw new Error("续排没有返回结构化计划台账（planLedger），本次新章节未提交");
  }
  const planLedger = sanitizeGeneratedPlanLedger(rawLedger);
  if (!planLedger.events.length) {
    throw new Error("续排计划台账为空，本次新章节未提交");
  }
  assertValidPlanLedger(planLedger, {
    ...plan,
    chapters: [...plan.chapters, ...chapters].sort((a, b) => a.index - b.index),
  });
  return { chapters, planLedger };
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
  options: ExtendPlanOptions = {},
): Promise<ExtendedPlanResult> {
  const startIndex = plan.chapters.length
    ? Math.max(...plan.chapters.map((chapter) => chapter.index)) + 1
    : 1;

  if (isMock()) {
    const chapters = mockExtendedChapters(meta, startIndex, count);
    return {
      chapters,
      planLedger: {
        ...emptyPlanLedger(),
        events: planEntriesForChapters(chapters),
      },
    };
  }

  const runtime = getRuntimeConfig();
  const budget = tokenBudgetForTask("chapter-batch", runtime.maxTokens);
  const client = options.client ?? new LLMClient();
  const report = reporter(options.onProgress);
  const onProgress = llmProgress(report);
  const batchSize = architectureBatchSize(runtime.maxTokens);
  const totalBatches = Math.ceil(count / batchSize);
  const workPlan: ProjectPlan = { ...plan, chapters: [...plan.chapters] };
  const chapters: ChapterPlan[] = [];
  let planLedger = emptyPlanLedger();

  report(
    `续排：模型 ${runtime.model}，输出预算 ${budget} Tokens，共 ${count} 章，分 ${totalBatches} 批。`,
  );
  if (needsHigherTier("chapter-batch", runtime.maxTokens)) {
    report("提示：当前为标准档 8192 Tokens，续排会分批生成；如仍截断请提高输出档位。");
  }

  for (let offset = 0; offset < count; offset += batchSize) {
    const batchNo = Math.floor(offset / batchSize) + 1;
    const size = Math.min(batchSize, count - offset);
    report(
      `续排第 ${batchNo}/${totalBatches} 批：从第 ${
        Math.max(...workPlan.chapters.map((chapter) => chapter.index), 0) + 1
      } 章起新增 ${size} 章。`,
    );
    const result = await extendPlanBatch(
      meta,
      workPlan,
      bible,
      outlineMd,
      recentSummaries,
      size,
      context,
      client,
      budget,
      onProgress,
    );
    const part = namespaceLedgerIds(result.planLedger, `extend-b${batchNo}`);
    chapters.push(...result.chapters);
    workPlan.chapters.push(...result.chapters);
    planLedger = mergePlanLedgers(planLedger, part);
  }

  return { chapters, planLedger };
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
  unifiedLedger = "",
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
      unifiedLedger,
    ),
    { temperature: 0.1, agent: "auditor", chapter: chapter.index },
  );
  return normalizeReviewResult(data, chapter.summary);
}

export interface RegressionAuditResult extends ReviewResult {
  causalChanges: CausalChange[];
  causalVerified: boolean;
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
  causalBaselines: CausalBaseline[] = [],
): Promise<RegressionAuditResult> {
  if (isMock()) {
    return {
      summary: chapter.summary,
      issues: [],
      continuityOk: true,
      extractionOk: true,
      causalChanges: [],
      causalVerified: true,
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
      causalBaselines,
    ),
    { temperature: 0.1, agent: "auditor", chapter: chapter.index },
  );
  const causal = normalizeCausalChanges(
    data.causalChanges ?? data.causal_changes,
  );
  return {
    ...normalizeReviewResult(data, chapter.summary),
    causalChanges: causal.changes,
    causalVerified: causalVerificationComplete(
      causal.changes,
      causal.verified,
      causalBaselines.length,
      data.causalVerified ?? data.causal_verified,
    ),
  };
}

// 独立确认候选稿新增的严重问题：不改正文，也不复用修复方案调用，
// 避免同一次生成既改稿又判定自己是否改坏。
export async function confirmRepairRegressions(input: {
  meta: ProjectMeta;
  chapter: ChapterPlan;
  originalText: string;
  candidateText: string;
  baseline: RepairBaseline;
  newIssues: ContinuityIssue[];
  evidenceContext?: string;
}): Promise<RegressionConfirmation[]> {
  const issues = input.newIssues.filter((issue) => issue.severity === "critical");
  if (!issues.length) return [];
  const fallback = (): RegressionConfirmation[] =>
    issues.map((issue) =>
      classifyRegressionByEvidence(issue, input.baseline, input.candidateText),
    );
  if (isMock()) return fallback();

  try {
    const data = await new LLMClient().json<Record<string, unknown>>(
      repairRegressionConfirmMessages(
        input.meta,
        input.chapter,
        input.originalText,
        input.candidateText,
        input.baseline.issues,
        issues,
        input.evidenceContext ?? "",
      ),
      { temperature: 0.1, agent: "auditor", chapter: input.chapter.index },
    );
    const raw = Array.isArray(data.confirmations) ? data.confirmations : [];
    const parsed = new Map<
      number,
      { verdict: ReturnType<typeof normalizeRegressionVerdict>; explanation: string; schemeLevelFailure: boolean }
    >();
    raw.forEach((item) => {
      if (!item || typeof item !== "object") return;
      const record = item as Record<string, unknown>;
      const index = Number.parseInt(String(record.index ?? record.issueIndex ?? ""), 10);
      if (!Number.isInteger(index) || index < 1 || index > issues.length) return;
      parsed.set(index, {
        verdict: normalizeRegressionVerdict(record.verdict ?? record.classification),
        explanation: str(record.explanation ?? record.reason),
        schemeLevelFailure: record.schemeLevelFailure === true,
      });
    });
    return issues.map((issue, offset) => {
      const item = parsed.get(offset + 1);
      return item
        ? { issue, ...item }
        : classifyRegressionByEvidence(issue, input.baseline, input.candidateText);
    });
  } catch (error) {
    // 确认失败不能用“新增问题成立”来兜底，否则会误伤；交给作者确认。
    return issues.map((issue) => ({
      issue,
      verdict: "uncertain" as const,
      explanation: `独立确认调用失败，无法判断是否由本次修复引入：${String(error)}`,
      schemeLevelFailure: false,
    }));
  }
}

export interface RepairDecisionOptionPlan {
  label: string;
  description: string;
  affectedChapters: number[];
  anchors: string[];
  // 该方案会新增的设定/物品/来源；有新增设定的方案不能被推荐。
  introducedFacts: string[];
  // 只能有一个推荐项；模型给出的推荐会先接受，缺失时按改动范围最小兜底。
  recommended: boolean;
}

export class RepairNeedsAuthorDecisionError extends Error {
  readonly options: RepairDecisionOptionPlan[];

  constructor(reason: string, options: RepairDecisionOptionPlan[] = []) {
    super(reason || "修复证据不足，需要作者决定");
    this.name = "RepairNeedsAuthorDecisionError";
    this.options = options;
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
  causalBaseline: CausalBaseline;
}

export interface RepairPlan {
  issuePlans: RepairPlanIssue[];
  needsAuthorDecision: boolean;
  decisionReason: string;
  decisionOptions: RepairDecisionOptionPlan[];
}

// 只保留一个推荐项：模型标了多个时取改动章节最少的一个；
// 完全没标时同样按改动范围最小兜底，保证作者总能看到一个推荐。
function markRecommendedOption(options: RepairDecisionOptionPlan[]): void {
  if (!options.length) return;
  // 有安全方案时，绝不推荐需要凭空新增设定的方案。
  const safe = options.filter((option) => option.introducedFacts.length === 0);
  const pool = safe.length ? safe : options;
  const marked = pool.filter((option) => option.recommended);
  const pick =
    marked.length === 1
      ? marked[0]
      : [...pool].sort(
          (left, right) =>
            left.introducedFacts.length - right.introducedFacts.length ||
            left.affectedChapters.length - right.affectedChapters.length,
        )[0];
  for (const option of options) option.recommended = option === pick;
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
      locations: stringList(plan.locations, true),
      strategy: str(plan.strategy).trim(),
      affectedFacts: stringList(
        plan.affectedFacts ?? plan.affected_facts,
        true,
      ),
      sideEffects: str(plan.sideEffects ?? plan.side_effects).trim(),
      regressionScope: str(plan.regressionScope ?? plan.regression_scope).trim(),
      causalBaseline: normalizeCausalBaseline(
        plan.causalBaseline ?? plan.causal_baseline,
      ),
    };
  });
  const rawOptions = Array.isArray(record.decisionOptions)
    ? record.decisionOptions
    : Array.isArray(record.decision_options)
      ? record.decision_options
      : [];
  const decisionOptions: RepairDecisionOptionPlan[] = rawOptions
    .map((item) => {
      const option = (item ?? {}) as Record<string, unknown>;
      return {
        label: str(option.label).trim(),
        description: str(option.description).trim(),
        affectedChapters: numberList(
          option.affectedChapters ?? option.affected_chapters,
        ),
        anchors: stringList(option.anchors),
        introducedFacts: stringList(
          option.introducedFacts ??
            option.introduced_facts ??
            option.newFacts ??
            option.new_facts,
          true,
        ),
        recommended:
          option.recommended === true ||
          option.isRecommended === true ||
          option.is_recommended === true,
      };
    })
    .filter((option) => option.label && option.description);
  markRecommendedOption(decisionOptions);
  return {
    issuePlans,
    needsAuthorDecision: record.needsAuthorDecision === true || record.needs_author_decision === true,
    decisionReason: str(record.decisionReason ?? record.decision_reason).trim(),
    decisionOptions,
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
  const compactHaystack = compactEvidence(haystack);
  const matchPart = (part: string): boolean => {
    const compactNeedle = compactEvidence(part);
    if (compactNeedle.length < 4) return false;
    if (compactHaystack.includes(compactNeedle)) return true;
    // 长证据可能被模型截断；只比较前 60 个有效字符，避免整段比对失败。
    return (
      compactNeedle.length > 60 &&
      compactHaystack.includes(compactNeedle.slice(0, 60))
    );
  };
  // 审校证据常用“……”或“／”拼接多个位置的原文；
  // 整串拼接后不可能在正文中连续出现，必须逐段核对。
  const parts = needle
    .split(/…+|\.{3,}|⋯+|[／/|｜]+|\n+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length > 1) return parts.some(matchPart);
  return matchPart(needle);
}

export function validateRepairPlan(
  plan: RepairPlan,
  issueCount: number,
  context: {
    chapterText?: string;
    evidenceContext?: string;
    crossChapterText?: string;
    // 方案证据允许回退到问题本身的证据：模型复述证据时常改写措辞，
    // 只要问题证据能在原文中落地，修改仍需通过 locations 校验。
    issues?: ContinuityIssue[];
  } = {},
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
    if (!isCausalBaselineComplete(item.causalBaseline)) {
      throw new RepairPlanRejectedError(
        `问题 ${item.issueIndex} 的修复方案缺少修复前因果结构（动作执行者/动作/作用对象/处理对象/结果），无法保护剧情因果`,
      );
    }
    if (context.chapterText !== undefined) {
      const chapterText = context.chapterText;
      const crossText = context.crossChapterText ?? "";
      const originalEvidence = originalEvidenceSection(context.evidenceContext ?? "");
      const grounded = (needle: string): boolean =>
        containsEvidence(chapterText, needle) ||
        containsEvidence(crossText, needle) ||
        containsEvidence(originalEvidence, needle);
      const issueEvidence = context.issues?.[item.issueIndex - 1]?.evidence ?? "";
      if (!item.evidence) {
        details.push(`问题 ${item.issueIndex} 没有引用任何原文证据`);
      } else if (!grounded(item.evidence) && !(issueEvidence && grounded(issueEvidence))) {
        details.push(
          `问题 ${item.issueIndex} 引用的证据只来自台账、摘要或推断，不在当前正文、此前章节原文或原文证据中`,
        );
      }
      const located = item.locations.some(
        (location) =>
          location.trim() &&
          (containsEvidence(chapterText, location) || containsEvidence(crossText, location)),
      );
      if (!located) {
        details.push(
          `问题 ${item.issueIndex} 计划修改的位置在当前正文和授权此前章节中都不存在`,
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
- 回归审校范围：${item.regressionScope || "未说明"}
- 修复前因果结构：
${formatCausalBaseline(item.causalBaseline)}`,
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
      {
        temperature: 0.1,
        agent: "repair-editor",
        chapter: chapter.index,
        ...repairModelOption(),
      },
    );
    const plan = normalizeRepairPlan(planData);
    if (plan.needsAuthorDecision) {
      throw new RepairNeedsAuthorDecisionError(
        plan.decisionReason,
        plan.decisionOptions,
      );
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
    {
      temperature: 0.2,
      agent: "repair-editor",
      chapter: chapter.index,
      ...repairModelOption(),
    },
  );
  return stripFences(raw);
}

export interface RepairPatchPlanResult {
  patches: RepairPatch[];
  planText: string;
  regressionScope: string;
  affectedChapters: number[];
  causalBaselines: CausalBaseline[];
  // 方案已通过正文校验的修改位置；补丁授权段落必须包含问题证据或这些位置。
  authorizedAnchors: string[];
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
    crossChapterContext?: string;
    authorDirective?: string;
    affectedChapters?: number[];
  } = {},
): Promise<RepairPatchPlanResult> {
  if (isMock()) {
    return {
      patches: [],
      planText: "",
      regressionScope: "",
      affectedChapters: [],
      causalBaselines: [],
      authorizedAnchors: [],
    };
  }
  if (!issues.length) {
    return {
      patches: [],
      planText: "",
      regressionScope: "",
      affectedChapters: [],
      causalBaselines: [],
      authorizedAnchors: [],
    };
  }

  const llm = new LLMClient();
  let planText = "";
  let regressionScope = "";
  let causalBaselines: CausalBaseline[] = [];
  let authorizedAnchors: string[] = [];
  let affectedChapters = options.affectedChapters ?? [];
  const structural = structuralRepairIssues(issues);
  // 作者已确认方向时不拦；否则结构问题必须回归作者决策，不再打补丁。
  const forceAuthorDecision = structural.length > 0 && !options.authorDirective;
  const structuralNote = structural.length
    ? [
        "【程序判定：以下问题属于跨章或细纲结构冲突，不得用局部补丁硬修】",
        ...structural.slice(0, 6).map((issue) => `- [${issue.type}] ${issue.detail.slice(0, 160)}`),
        "必须把 needsAuthorDecision 设为 true，并给出 2-4 个互斥方案；不要输出可直接执行的补丁。",
      ].join("\n")
    : "";
  const planOptions = structuralNote
    ? {
        ...options,
        authorDirective: [options.authorDirective, structuralNote]
          .filter(Boolean)
          .join("\n\n"),
      }
    : options;
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
        planOptions,
      ),
      {
        temperature: 0.1,
        agent: "repair-editor",
        chapter: chapter.index,
        ...repairModelOption(),
      },
    );
    const plan = normalizeRepairPlan(planData);
    if (forceAuthorDecision && !plan.needsAuthorDecision) {
      throw new RepairNeedsAuthorDecisionError(
        plan.decisionReason ||
          `以下问题属于跨章或细纲结构冲突，无法用本章局部补丁安全修复：${structural
            .map((issue) => issue.type)
            .join("、")}`,
        plan.decisionOptions,
      );
    }
    if (plan.needsAuthorDecision) {
      if (options.authorDirective) {
        throw new RepairPlanRejectedError(
          "作者已确认修复方向，但方案仍要求再次由作者决定；请按已确认方向重新制定方案",
        );
      }
      throw new RepairNeedsAuthorDecisionError(plan.decisionReason, plan.decisionOptions);
    }
    validateRepairPlan(plan, issues.length, {
      chapterText,
      evidenceContext: options.evidenceContext ?? "",
      crossChapterText: options.crossChapterContext ?? "",
      issues,
    });
    planText = formatRepairPlan(plan);
    regressionScope = plan.issuePlans
      .map((item) => item.regressionScope)
      .filter(Boolean)
      .join("；");
    causalBaselines = plan.issuePlans.map((item) => item.causalBaseline);
    // locations 已在 validateRepairPlan 中核对确实存在于正文，
    // 补丁阶段用它们授权方案明确要改的段落，而不是只认问题证据原文。
    authorizedAnchors = plan.issuePlans
      .flatMap((item) => item.locations)
      .map((location) => location.trim())
      .filter(Boolean);
    // 决策选项只在等待作者确认时生效；作者确认的章节范围由调用方传入。
    // 不能因为模型随手返回 decisionOptions 就扩大补丁授权章节。
  }

  if (forceAuthorDecision) {
    throw new RepairNeedsAuthorDecisionError(
      `以下问题属于跨章或细纲结构冲突，无法用本章局部补丁安全修复：${structural
        .map((issue) => issue.type)
        .join("、")}`,
    );
  }
  const authorizedParagraphs = paragraphsMatchingAnchors(chapterText, [
    ...issues.flatMap((issue) => [issue.evidence, issue.sourceEvidence ?? ""]),
    ...authorizedAnchors,
  ]);
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
      {
        ...options,
        planText,
        affectedChapters,
        authorizedAnchors,
        authorizedParagraphs,
      },
    ),
    {
      temperature: 0.1,
      agent: "repair-editor",
      chapter: chapter.index,
      ...repairModelOption(),
    },
  );
  return {
    patches: normalizeRepairPatches(data),
    planText,
    regressionScope,
    affectedChapters,
    causalBaselines,
    authorizedAnchors,
  };
}
