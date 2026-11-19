import { nowIso } from "./utils";
import type {
  CanonCharacter,
  CanonCharacterStatus,
  CanonDeadline,
  CanonFacts,
  CanonItem,
  CanonTimeline,
  Character,
  ContinuityIssue,
  ExtractedFacts,
  FactCharacter,
  FactDeadline,
  FactItem,
  FactTimeline,
  ReviewResult,
} from "./types";

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function arr(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
    : [];
}

function num(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

// 模型偶尔会把“他/村民/道士”当成人物名写进台账，这类泛称不参与事实比对。
const GENERIC_CHARACTER_NAMES = new Set([
  "他",
  "她",
  "它",
  "我",
  "你",
  "您",
  "他们",
  "她们",
  "众人",
  "村民",
  "众村民",
  "有人",
  "某人",
  "那人",
  "此人",
  "对方",
  "老头",
  "老人",
  "男人",
  "女人",
  "道士",
  "和尚",
  "士兵",
  "军官",
  "伙计",
  "掌柜",
  "小孩",
  "孩子",
]);

function uniqueStrings(values: string[], exclude = ""): string[] {
  const excluded = normalizeName(exclude);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    const key = normalizeName(trimmed);
    if (!key || key === excluded || seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function normalizeStatus(value: unknown): CanonCharacterStatus {
  const text = str(value).trim().toLowerCase();
  if (["alive", "存活", "活着", "生还", "未死"].includes(text)) return "alive";
  if (["dead", "死亡", "已死", "死了", "身亡", "殒命"].includes(text)) return "dead";
  return "unknown";
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function chapterLabel(chapter: number): string {
  return chapter > 0 ? `第 ${chapter} 章` : "架构设定";
}

export function emptyCanon(): CanonFacts {
  return {
    characters: [],
    items: [],
    timeline: { currentDay: "", deadlines: [] },
    rules: [],
    lastChapter: 0,
    updatedAt: nowIso(),
  };
}

export function isCanonEmpty(canon: CanonFacts): boolean {
  return (
    canon.characters.length === 0 &&
    canon.items.length === 0 &&
    !canon.timeline.currentDay.trim() &&
    canon.timeline.deadlines.length === 0 &&
    canon.rules.length === 0 &&
    canon.lastChapter === 0
  );
}

// 架构阶段还没有正文可抽取，只能把人物卡转成“待正文确认”的初始基线。
// 统一用 chapter 0 标记，后续第 1 章事实抽取会覆盖为真实状态。
export function buildInitialCanon(
  characters: Character[],
  updatedAt = nowIso(),
): CanonFacts {
  return {
    characters: characters
      .map((character): CanonCharacter | null => {
        const name = character.name.trim();
        if (!name) return null;
        const role = character.role.trim();
        const goals = character.goals.trim();
        const note = clip(
          [role, goals ? `目标：${goals}` : ""].filter(Boolean).join("；"),
          120,
        );
        return {
          name,
          aliases: [],
          status: "unknown" as const,
          location: "",
          note,
          statusChapter: 0,
          chapter: 0,
        };
      })
      .filter((item): item is CanonCharacter => Boolean(item)),
    items: [],
    timeline: { currentDay: "", deadlines: [] },
    rules: [],
    lastChapter: 0,
    updatedAt,
  };
}

// 重写/修复第 N 章时只保留截至第 N 章已确立的事实。
// 否则后文才发生的死亡、物品变化会被当成前文的严重矛盾。
export function canonForChapter(
  canon: CanonFacts | undefined,
  chapterIndex: number,
): CanonFacts {
  if (!canon) return emptyCanon();
  if (chapterIndex > canon.lastChapter) return canon;
  return {
    characters: canon.characters
      .filter((item) => item.statusChapter <= chapterIndex)
      // 人物状态可能在早期确立，但位置/备注被后文更新过；这些字段不能倒灌进早期审校。
      .map((item) =>
        item.chapter > chapterIndex
          ? { ...item, location: "", note: "" }
          : item,
      ),
    items: canon.items.filter((item) => item.chapter <= chapterIndex),
    timeline: {
      // 全书最新时间不能倒灌进早期章节；检查最新章节时保留。
      currentDay:
        chapterIndex >= canon.lastChapter ? canon.timeline.currentDay : "",
      deadlines: canon.timeline.deadlines.filter(
        (item) => item.chapter <= chapterIndex,
      ),
    },
    rules: [...canon.rules],
    lastChapter: chapterIndex,
    updatedAt: canon.updatedAt,
  };
}

function normalizeCanonCharacter(input: unknown): CanonCharacter | null {
  const record = (input ?? {}) as Record<string, unknown>;
  const name = str(record.name).trim();
  if (!name || GENERIC_CHARACTER_NAMES.has(name)) return null;
  const chapter = num(record.chapter);
  const status = normalizeStatus(record.status);
  return {
    name,
    aliases: uniqueStrings(
      arr(record.aliases).filter((alias) => !GENERIC_CHARACTER_NAMES.has(alias.trim())),
      name,
    ),
    status,
    location: str(record.location).trim(),
    note: str(record.note).trim(),
    statusChapter: num(record.statusChapter ?? record.status_chapter, chapter),
    chapter,
  };
}

function normalizeCanonItem(input: unknown): CanonItem | null {
  const record = (input ?? {}) as Record<string, unknown>;
  const name = str(record.name).trim();
  if (!name) return null;
  return {
    name,
    aliases: uniqueStrings(arr(record.aliases), name),
    holder: str(record.holder).trim(),
    state: str(record.state).trim(),
    note: str(record.note).trim(),
    chapter: num(record.chapter),
  };
}

function normalizeCanonDeadline(input: unknown): CanonDeadline | null {
  const record = (input ?? {}) as Record<string, unknown>;
  const name = str(record.name).trim();
  if (!name) return null;
  return {
    name,
    due: str(record.due ?? record.deadline ?? record.date ?? record.time).trim(),
    note: str(record.note).trim(),
    chapter: num(record.chapter),
  };
}

function normalizeCanonTimeline(input: unknown): CanonTimeline {
  const record = (input ?? {}) as Record<string, unknown>;
  const deadlines = Array.isArray(record.deadlines)
    ? record.deadlines
        .map(normalizeCanonDeadline)
        .filter((item): item is CanonDeadline => Boolean(item))
        .slice(0, 40)
    : [];
  return {
    currentDay: str(record.currentDay ?? record.current_day ?? record.now).trim(),
    deadlines,
  };
}

export function normalizeCanon(input: unknown): CanonFacts {
  // canon.json 可能来自不同版本，读取时统一结构，避免 UI 和提示词拿到脏数据。
  const record = (input ?? {}) as Record<string, unknown>;
  return {
    characters: Array.isArray(record.characters)
      ? record.characters
          .map(normalizeCanonCharacter)
          .filter((item): item is CanonCharacter => Boolean(item))
          .slice(0, 400)
      : [],
    items: Array.isArray(record.items)
      ? record.items
          .map(normalizeCanonItem)
          .filter((item): item is CanonItem => Boolean(item))
          .slice(0, 400)
      : [],
    timeline: normalizeCanonTimeline(record.timeline),
    rules: arr(record.rules).slice(0, 200),
    lastChapter: num(record.lastChapter ?? record.last_chapter),
    updatedAt: str(record.updatedAt ?? record.updated_at, nowIso()),
  };
}

export interface CanonValidationIssue {
  code:
    | "canon-lagging"
    | "canon-ahead"
    | "duplicate-character"
    | "duplicate-item"
    | "duplicate-deadline"
    | "chapter-out-of-range";
  severity: "critical" | "warning";
  message: string;
}

// 整体重建后的最终校验：台账必须覆盖全部已写章节，且没有重复/越界条目。
export function validateCanon(
  canon: CanonFacts,
  chapters: { index: number }[],
): CanonValidationIssue[] {
  const issues: CanonValidationIssue[] = [];
  const maxChapter = chapters.reduce(
    (max, chapter) => Math.max(max, chapter.index),
    0,
  );

  if (maxChapter > 0 && canon.lastChapter < maxChapter) {
    issues.push({
      code: "canon-lagging",
      severity: "critical",
      message: `台账只覆盖到第 ${canon.lastChapter} 章，已写章节到第 ${maxChapter} 章`,
    });
  }
  if (canon.lastChapter > maxChapter) {
    issues.push({
      code: "canon-ahead",
      severity: "critical",
      message: `台账覆盖到第 ${canon.lastChapter} 章，超出已写章节第 ${maxChapter} 章`,
    });
  }

  const checkDuplicates = (
    items: { name: string }[],
    code: CanonValidationIssue["code"],
    label: string,
  ): void => {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const item of items) {
      const key = normalizeName(item.name);
      if (!key) {
        issues.push({
          code,
          severity: "warning",
          message: `${label}存在空名称条目`,
        });
        continue;
      }
      if (seen.has(key)) duplicates.add(item.name);
      seen.add(key);
    }
    for (const name of duplicates) {
      issues.push({
        code,
        severity: "warning",
        message: `${label}「${name}」重复出现`,
      });
    }
  };

  checkDuplicates(canon.characters, "duplicate-character", "人物");
  checkDuplicates(canon.items, "duplicate-item", "物品");
  checkDuplicates(canon.timeline.deadlines, "duplicate-deadline", "期限");

  for (const character of canon.characters) {
    if (character.chapter > canon.lastChapter || character.statusChapter > canon.lastChapter) {
      issues.push({
        code: "chapter-out-of-range",
        severity: "warning",
        message: `${character.name} 引用了超出台账范围的章节`,
      });
    }
  }

  return issues;
}

function normalizeFactCharacter(input: unknown): FactCharacter | null {
  const record = (input ?? {}) as Record<string, unknown>;
  const name = str(record.name).trim();
  if (!name || GENERIC_CHARACTER_NAMES.has(name)) return null;
  return {
    name,
    aliases: uniqueStrings(
      arr(record.aliases).filter((alias) => !GENERIC_CHARACTER_NAMES.has(alias.trim())),
      name,
    ),
    status: normalizeStatus(record.status),
    location: str(record.location).trim(),
    note: str(record.note).trim(),
    evidence: str(record.evidence).trim(),
  };
}

function normalizeFactItem(input: unknown): FactItem | null {
  const record = (input ?? {}) as Record<string, unknown>;
  const name = str(record.name).trim();
  if (!name) return null;
  return {
    name,
    aliases: uniqueStrings(arr(record.aliases), name),
    holder: str(record.holder).trim(),
    state: str(record.state).trim(),
    note: str(record.note).trim(),
    evidence: str(record.evidence).trim(),
  };
}

function normalizeFactDeadline(input: unknown): FactDeadline | null {
  const record = (input ?? {}) as Record<string, unknown>;
  const name = str(record.name).trim();
  if (!name) return null;
  return {
    name,
    due: str(record.due ?? record.deadline ?? record.date ?? record.time).trim(),
    note: str(record.note).trim(),
  };
}

function normalizeFactTimeline(input: unknown): FactTimeline | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  return {
    currentDay: str(record.currentDay ?? record.current_day ?? record.now).trim(),
    deadlines: Array.isArray(record.deadlines)
      ? record.deadlines
          .map(normalizeFactDeadline)
          .filter((item): item is FactDeadline => Boolean(item))
          .slice(0, 40)
      : [],
  };
}

function dedupeFacts<T extends { name: string; aliases: string[] }>(items: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = [item.name, ...item.aliases].map(normalizeName).find(Boolean) ?? "";
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

export function normalizeExtractedFacts(input: unknown, fallbackSummary: string): ExtractedFacts {
  const record = (input ?? {}) as Record<string, unknown>;
  const characters = Array.isArray(record.characters)
    ? record.characters
        .map(normalizeFactCharacter)
        .filter((item): item is FactCharacter => Boolean(item))
    : [];
  const items = Array.isArray(record.items)
    ? record.items
        .map(normalizeFactItem)
        .filter((item): item is FactItem => Boolean(item))
    : [];

  return {
    summary: str(record.summary, fallbackSummary).trim() || fallbackSummary,
    characters: dedupeFacts(characters).slice(0, 100),
    items: dedupeFacts(items).slice(0, 100),
    timeline: normalizeFactTimeline(record.timeline),
    rules: arr(record.rules).slice(0, 60),
  };
}

export function groundExtractedFacts(
  extracted: ExtractedFacts,
  chapterText: string,
): ExtractedFacts {
  // 模型偶尔会把细纲里的人名带进摘要/台账；名字在本章正文里找不到的条目直接丢弃，
  // 避免“佐藤”这类没在正文出现的人物污染后续上下文。
  const appears = (name: string, aliases: string[]): boolean =>
    [name, ...aliases].some((value) => {
      const trimmed = value.trim();
      return trimmed.length > 0 && chapterText.includes(trimmed);
    });

  return {
    ...extracted,
    characters: extracted.characters.filter((item) => appears(item.name, item.aliases)),
    items: extracted.items.filter((item) => appears(item.name, item.aliases)),
  };
}

// 机械检查只用于提示模型；模型核对后确认是尸体、回忆或转述时，
// 不应把这些线索当成真实问题写进审校记录。
const MECHANICAL_DEATH_NAME =
  /本章正文仍出现该名字。请确认是回忆、尸体或幻象，否则属于复活。$/;
const MECHANICAL_OPENING_REPEAT =
  /本章开头与上一章结尾存在大段重复，可能是在复述上一章而没有推进场景。$/;
const SELF_NEGATING_ISSUE =
  /(?:不属问题|不属于问题|不是问题|确认无误|无需处理|无需修改|应标为\s*ignore|标为\s*ignore|应降级为\s*ignore|可以忽略|不构成任何问题)/i;
const NEGATED_CONCLUSION =
  /(?:不构成(?:复活|矛盾|冲突|问题)|不矛盾|无直接矛盾|未发现矛盾|与台账一致|误报|非活人出场|不是活人出场|属于(?:回忆|转述|遗物|尸体|幻象))/;
const REAL_PROBLEM =
  /(?:存在.{0,12}(?:矛盾|冲突)|与.{0,20}(?:矛盾|冲突|不符|不一致)|构成.{0,12}(?:矛盾|冲突)|实际改写|需要改写|建议(?:改|明确)|应(?:修改|改写|删除))/;

export function isDiscardableIssue(issue: ContinuityIssue): boolean {
  const detail = issue.detail.trim();
  const text = `${issue.type} ${detail} ${issue.evidence}`;
  if (issue.type === "死亡人物出现" && MECHANICAL_DEATH_NAME.test(detail)) {
    return true;
  }
  if (issue.type === "章首重复" && MECHANICAL_OPENING_REPEAT.test(detail)) {
    return true;
  }
  if (SELF_NEGATING_ISSUE.test(text)) return true;
  // 严重/可忽略条目如果自己已经否定了问题，又没有指出真实矛盾，直接丢弃；
  // 建议类保留，避免误删“需要人工确认”的弱提示。
  return (
    issue.severity !== "warning" &&
    NEGATED_CONCLUSION.test(text) &&
    !REAL_PROBLEM.test(text)
  );
}

const CONFLICT_CATEGORIES = new Set([
  "timeline",
  "character-status",
  "fact",
  "foreshadow",
  "causality",
  "other",
]);

function isConflictCategory(
  value: string,
): value is NonNullable<ContinuityIssue["conflictCategory"]> {
  return CONFLICT_CATEGORIES.has(value);
}

const ISSUE_CLASSIFICATIONS: Record<
  string,
  NonNullable<ContinuityIssue["classification"]>
> = {
  establishedcontradiction: "established-contradiction",
  contradiction: "established-contradiction",
  ruleextension: "rule-extension",
  extension: "rule-extension",
  claritygap: "clarity-gap",
  clarity: "clarity-gap",
};

const RULE_LEVELS: Record<string, NonNullable<ContinuityIssue["ruleLevel"]>> = {
  hard: "hard",
  hardrule: "hard",
  soft: "soft",
  softrule: "soft",
  unknown: "unknown",
  unknownrule: "unknown",
  characterbelief: "character-belief",
  belief: "character-belief",
};

function normalizeKey(value: unknown): string {
  return str(value).trim().toLowerCase().replace(/[^a-z]/gu, "");
}

export function normalizeIssueClassification(
  value: unknown,
): ContinuityIssue["classification"] | undefined {
  return ISSUE_CLASSIFICATIONS[normalizeKey(value)];
}

export function normalizeRuleLevel(
  value: unknown,
): ContinuityIssue["ruleLevel"] | undefined {
  return RULE_LEVELS[normalizeKey(value)];
}

function parseOptionalChapter(value: unknown): number | undefined {
  const parsed =
    typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function normalizeIssues(input: unknown): ContinuityIssue[] {
  // 兼容旧版 state.json 里的字符串建议，以及新版的 {severity,type,evidence,detail}。
  if (!Array.isArray(input)) return [];
  const issues: ContinuityIssue[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    let issue: ContinuityIssue | null = null;
    if (typeof raw === "string") {
      const detail = raw.trim();
      if (detail) {
        issue = { severity: "warning", type: "审校建议", evidence: "", detail };
      }
    } else if (raw && typeof raw === "object") {
      const record = raw as Record<string, unknown>;
      const rawSeverity = str(record.severity ?? record.level).trim().toLowerCase();
      const critical =
        rawSeverity === "critical" ||
        rawSeverity === "严重" ||
        rawSeverity === "blocking" ||
        record.blocking === true;
      const ignored =
        !critical &&
        (rawSeverity === "ignore" ||
          rawSeverity === "ignored" ||
          rawSeverity === "optional" ||
          rawSeverity === "可忽略");
      const detail = str(
        record.detail ?? record.message ?? record.description ?? record.issue ?? record.text,
      ).trim();
      const evidence = str(record.evidence ?? record.quote ?? record.source).trim();
      const type = str(record.type ?? record.category, "其他").trim() || "其他";
      if (detail || evidence) {
        issue = {
          severity: critical ? "critical" : ignored ? "ignore" : "warning",
          type,
          evidence,
          detail: detail || evidence,
        };
        const id = str(record.id).trim();
        const fingerprint = str(record.fingerprint).trim();
        const sourceEvidence = str(
          record.sourceEvidence ?? record.source_evidence,
        ).trim();
        const sourceChapter = parseOptionalChapter(
          record.sourceChapter ?? record.source_chapter ?? record.chapter,
        );
        const affectedCharacters = Array.isArray(
          record.affectedCharacters ?? record.affected_characters,
        )
          ? ((record.affectedCharacters ?? record.affected_characters) as unknown[])
              .filter((item): item is string => typeof item === "string")
              .map((item) => item.trim())
              .filter(Boolean)
          : [];
        const rawCategory = str(
          record.conflictCategory ?? record.conflict_category,
        )
          .trim()
          .toLowerCase();
        const conflictCategory = isConflictCategory(rawCategory)
          ? rawCategory
          : undefined;
        const classification = normalizeIssueClassification(
          record.classification ?? record.issueClass ?? record.issue_class,
        );
        const ruleLevel = normalizeRuleLevel(
          record.ruleLevel ?? record.rule_level,
        );
        if (id) issue.id = id;
        if (fingerprint) issue.fingerprint = fingerprint;
        if (sourceEvidence) issue.sourceEvidence = sourceEvidence;
        if (sourceChapter !== undefined) issue.sourceChapter = sourceChapter;
        if (affectedCharacters.length) issue.affectedCharacters = affectedCharacters;
        if (conflictCategory) issue.conflictCategory = conflictCategory;
        if (classification) {
          issue.classification = classification;
          // 规则拓展和解释不足默认不能判 critical；旧数据没有分类，维持原判定。
          if (
            classification !== "established-contradiction" &&
            issue.severity === "critical"
          ) {
            issue.severity = "warning";
          }
        }
        if (ruleLevel) issue.ruleLevel = ruleLevel;
      }
    }
    if (!issue || isDiscardableIssue(issue)) continue;
    const key = `${issue.severity}|${issue.type}|${issue.detail}|${issue.evidence}`;
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push(issue);
    if (issues.length >= 40) break;
  }
  return issues;
}

export function normalizeReviewResult(input: unknown, fallbackSummary = ""): ReviewResult {
  const record = (input ?? {}) as Record<string, unknown>;
  const issues = normalizeIssues(record.issues);
  // 以过滤后的 issues 为准，避免模型一边报 critical 一边又声明本章没问题。
  const continuityOk = !issues.some((issue) => issue.severity === "critical");
  const repaired = typeof record.repaired === "boolean" ? record.repaired : undefined;
  const repairAttempts =
    typeof record.repairAttempts === "number"
      ? record.repairAttempts
      : typeof record.repair_attempts === "number"
        ? record.repair_attempts
        : undefined;
  const extractionOk =
    typeof record.extractionOk === "boolean"
      ? record.extractionOk
      : typeof record.extraction_ok === "boolean"
        ? record.extraction_ok
        : undefined;
  const extractionError =
    typeof record.extractionError === "string"
      ? record.extractionError.trim()
      : typeof record.extraction_error === "string"
        ? record.extraction_error.trim()
        : "";
  const extractionAttempts =
    typeof record.extractionAttempts === "number"
      ? record.extractionAttempts
      : typeof record.extraction_attempts === "number"
        ? record.extraction_attempts
        : undefined;

  return {
    summary: str(record.summary, fallbackSummary).trim() || fallbackSummary,
    issues,
    continuityOk,
    ...(repaired !== undefined ? { repaired } : {}),
    ...(repairAttempts !== undefined ? { repairAttempts } : {}),
    ...(extractionOk !== undefined ? { extractionOk } : {}),
    ...(extractionError ? { extractionError } : {}),
    ...(extractionAttempts !== undefined ? { extractionAttempts } : {}),
  };
}

export function mergeIssues(...lists: ContinuityIssue[][]): ContinuityIssue[] {
  const merged: ContinuityIssue[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const issue of list) {
      if (isDiscardableIssue(issue)) continue;
      const key = `${issue.severity}|${issue.type}|${issue.detail}|${issue.evidence}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(issue);
      if (merged.length >= 40) return merged;
    }
  }
  return merged;
}

export function countCritical(issues: ContinuityIssue[]): number {
  return issues.filter((issue) => issue.severity === "critical").length;
}

function cloneCanon(canon: CanonFacts): CanonFacts {
  return {
    characters: canon.characters.map((item) => ({ ...item, aliases: [...item.aliases] })),
    items: canon.items.map((item) => ({ ...item, aliases: [...item.aliases] })),
    timeline: {
      currentDay: canon.timeline.currentDay,
      deadlines: canon.timeline.deadlines.map((item) => ({ ...item })),
    },
    rules: [...canon.rules],
    lastChapter: canon.lastChapter,
    updatedAt: canon.updatedAt,
  };
}

function namesMatch(
  existing: { name: string; aliases: string[] },
  name: string,
  aliases: string[],
): boolean {
  const existingKeys = new Set(
    [existing.name, ...existing.aliases].map(normalizeName).filter(Boolean),
  );
  return [name, ...aliases].some((candidate) => {
    const key = normalizeName(candidate);
    return Boolean(key) && existingKeys.has(key);
  });
}

function evidenceMentionsCharacter(
  existing: { name: string; aliases: string[] },
  fact: { name: string; aliases: string[]; evidence: string },
): boolean {
  const text = normalizeName(fact.evidence);
  if (!text) return false;
  // 单字别名（如“爷”）太容易误命中，只把姓名和至少两字的别名算作直接证据。
  const candidates = [
    existing.name,
    fact.name,
    ...existing.aliases.filter((alias) => alias.trim().length >= 2),
    ...fact.aliases.filter((alias) => alias.trim().length >= 2),
  ];
  return candidates.some((candidate) => {
    const key = normalizeName(candidate);
    return key.length > 0 && text.includes(key);
  });
}

export interface ReconcileCanonResult {
  canon: CanonFacts;
  changes: string[];
}

// 重写章节后，某些状态（尤其是死亡）可能只由被覆盖的旧稿确立。
// 如果新正文里连名字都不再出现，继续保留 dead 会阻止后续章节让这个人出场，
// 因此降级为 unknown，等待后文重新确立。
export function reconcileCanonWithChapters(
  base: CanonFacts,
  chapters: { index: number; content: string }[],
): ReconcileCanonResult {
  const canon = cloneCanon(base);
  const changes: string[] = [];
  const texts = new Map(chapters.map((chapter) => [chapter.index, chapter.content]));

  for (const character of canon.characters) {
    if (character.status === "unknown" || character.statusChapter <= 0) continue;
    const text = texts.get(character.statusChapter);
    if (text === undefined) continue;

    const names = [
      character.name,
      ...character.aliases.filter((alias) => alias.trim().length >= 2),
    ];
    const appears = names.some((name) => {
      const trimmed = name.trim();
      return trimmed.length > 0 && text.includes(trimmed);
    });
    if (appears) continue;

    const previous = character.status;
    character.status = "unknown";
    const suffix = `第 ${character.statusChapter} 章重写后未再出现，状态待核实。`;
    character.note = character.note ? `${character.note}；${suffix}` : suffix;
    changes.push(`${character.name}：${previous} → unknown`);
  }

  if (changes.length) canon.updatedAt = nowIso();
  return { canon, changes };
}

export interface MergeCanonResult {
  canon: CanonFacts;
  conflicts: ContinuityIssue[];
}

export function mergeCanon(
  base: CanonFacts,
  extracted: ExtractedFacts,
  chapterIndex: number,
  mode: "write" | "rewrite" = "write",
): MergeCanonResult {
  const canon = cloneCanon(base);
  const conflicts: ContinuityIssue[] = [];

  for (const fact of extracted.characters) {
    const existing = canon.characters.find((item) => namesMatch(item, fact.name, fact.aliases));
    if (!existing) {
      canon.characters.push({
        name: fact.name,
        aliases: uniqueStrings(fact.aliases, fact.name),
        status: fact.status,
        location: fact.location,
        note: fact.note,
        statusChapter: chapterIndex,
        chapter: chapterIndex,
      });
      continue;
    }

    const isSameChapterRetcon = mode === "rewrite" && existing.statusChapter === chapterIndex;
    // 台账里比当前章更晚的事实代表“后文已经发生的事”。重写中间章节时不能被旧稿反向覆盖。
    const isLaterFact = existing.statusChapter > chapterIndex;
    const contradictsDeath =
      existing.status === "dead" &&
      fact.status === "alive" &&
      !isSameChapterRetcon &&
      !isLaterFact;

    // 复活是严重冲突，但证据必须直接点名该人物；否则多半是把“它/他”的行动
    // 误归到已死角色头上，降为建议并跳过本次所有状态更新。
    if (contradictsDeath && !evidenceMentionsCharacter(existing, fact)) {
      conflicts.push({
        severity: "warning",
        type: "死亡状态",
        evidence: fact.evidence,
        detail: `${existing.name} 已在${chapterLabel(existing.statusChapter)}死亡；抽取结果将其标为存活，但证据没有直接提到该人物，可能是把其他角色的行动误归到其名下。已忽略这次状态更新，请人工确认。`,
      });
      continue;
    }

    existing.aliases = uniqueStrings([...existing.aliases, ...fact.aliases], existing.name);

    if (fact.status !== "unknown" && !isLaterFact) {
      if (contradictsDeath) {
        conflicts.push({
          severity: "critical",
          type: "死亡状态",
          evidence: fact.evidence,
          detail: `${existing.name} 已在${chapterLabel(existing.statusChapter)}死亡，本章却把其写成存活或仍在行动。`,
        });
      } else if (existing.status !== fact.status) {
        existing.status = fact.status;
        existing.statusChapter = chapterIndex;
      }
    }

    if (!isLaterFact) {
      if (fact.location) existing.location = fact.location;
      if (fact.note) existing.note = fact.note;
      existing.chapter = Math.max(existing.chapter, chapterIndex);
    }
  }

  for (const fact of extracted.items) {
    const existing = canon.items.find((item) => namesMatch(item, fact.name, fact.aliases));
    if (!existing) {
      canon.items.push({
        name: fact.name,
        aliases: uniqueStrings(fact.aliases, fact.name),
        holder: fact.holder,
        state: fact.state,
        note: fact.note,
        chapter: chapterIndex,
      });
      continue;
    }

    existing.aliases = uniqueStrings([...existing.aliases, ...fact.aliases], existing.name);
    if (existing.chapter <= chapterIndex || (mode === "rewrite" && existing.chapter === chapterIndex)) {
      if (fact.holder) existing.holder = fact.holder;
      if (fact.state) existing.state = fact.state;
      if (fact.note) existing.note = fact.note;
      existing.chapter = Math.max(existing.chapter, chapterIndex);
    }
  }

  if (extracted.timeline) {
    // 重写旧章时，如果台账已经记录到更后面的时间，保留后文时间线，避免时间倒退。
    const canAdvanceTimeline = mode === "write" || canon.lastChapter <= chapterIndex;
    if (canAdvanceTimeline) {
      if (extracted.timeline.currentDay) {
        canon.timeline.currentDay = extracted.timeline.currentDay;
      }
      for (const fact of extracted.timeline.deadlines) {
        const existing = canon.timeline.deadlines.find(
          (item) => normalizeName(item.name) === normalizeName(fact.name),
        );
        if (existing) {
          if (fact.due) existing.due = fact.due;
          if (fact.note) existing.note = fact.note;
          existing.chapter = Math.max(existing.chapter, chapterIndex);
        } else {
          canon.timeline.deadlines.push({
            name: fact.name,
            due: fact.due,
            note: fact.note,
            chapter: chapterIndex,
          });
        }
      }
    }
  }

  for (const rule of extracted.rules) {
    const trimmed = rule.trim();
    if (trimmed && !canon.rules.some((item) => normalizeName(item) === normalizeName(trimmed))) {
      canon.rules.push(trimmed);
    }
  }

  canon.lastChapter = Math.max(canon.lastChapter, chapterIndex);
  canon.updatedAt = nowIso();
  return { canon, conflicts };
}

export interface CanonPromptOptions {
  includeChapters?: boolean;
  aliveLimit?: number;
  itemLimit?: number;
}

export function formatCanonForPrompt(
  canon: CanonFacts | undefined,
  options: CanonPromptOptions = {},
): string {
  if (!canon) return "（暂无事实台账）";
  const includeChapters = options.includeChapters ?? false;

  // 先按最近发生排序截断，再按章节正序展示：长篇里最新的死亡事实不能被上限裁掉。
  const baseline = canon.characters.filter(
    (item) => item.chapter === 0 && item.status !== "dead",
  );
  const dead = canon.characters
    .filter((item) => item.status === "dead")
    .sort((a, b) => b.statusChapter - a.statusChapter)
    .slice(0, includeChapters ? 200 : 40)
    .sort((a, b) => a.statusChapter - b.statusChapter);
  const alive = canon.characters
    .filter(
      (item) =>
        item.chapter !== 0 &&
        (includeChapters ? item.status !== "dead" : item.status === "alive"),
    )
    .sort((a, b) => b.chapter - a.chapter)
    .slice(0, options.aliveLimit ?? (includeChapters ? 60 : 40));
  const items = [...canon.items]
    .sort((a, b) => b.chapter - a.chapter)
    .slice(0, options.itemLimit ?? (includeChapters ? 40 : 30));
  const deadlines = canon.timeline.deadlines.slice(0, includeChapters ? 20 : 12);
  const rules = canon.rules.slice(0, includeChapters ? 20 : 15);

  const lines: string[] = [];
  if (dead.length) {
    lines.push("死亡人物（不得以活人身份出场，除非明确是回忆、尸体或幻象）：");
    for (const item of dead) {
      const note = item.note ? `：${clip(item.note, 80)}` : "";
      lines.push(`- ${item.name}（${chapterLabel(item.statusChapter)}死亡）${note}`);
    }
  }
  if (baseline.length) {
    lines.push("架构初始人物（来自人物卡，正文尚未确认生死/位置）：");
    for (const item of baseline) {
      const note = item.note ? `；${clip(item.note, 80)}` : "";
      lines.push(`- ${item.name}${note}`);
    }
  }
  if (alive.length) {
    lines.push(
      includeChapters
        ? "已知存活/未知状态人物（括号内为状态确立章节）："
        : "已知存活/活跃人物：",
    );
    for (const item of alive) {
      const chapter = includeChapters ? `（${chapterLabel(item.statusChapter)}状态）` : "";
      const status = includeChapters && item.status === "unknown" ? "；状态未知" : "";
      const location = item.location ? `；位置：${clip(item.location, 30)}` : "";
      const note = item.note ? `；${clip(item.note, 80)}` : "";
      lines.push(`- ${item.name}${chapter}${status}${location}${note}`);
    }
  }
  if (items.length) {
    lines.push(includeChapters ? "关键物品（括号内为最近确认章节）：" : "关键物品：");
    for (const item of items) {
      const chapter = includeChapters ? `（${chapterLabel(item.chapter)}）` : "";
      const holder = item.holder ? `持有人：${clip(item.holder, 30)}` : "持有人未知";
      const state = item.state ? `；状态：${clip(item.state, 40)}` : "";
      const note = item.note ? `；${clip(item.note, 80)}` : "";
      lines.push(`- ${item.name}${chapter}：${holder}${state}${note}`);
    }
  }
  if (canon.timeline.currentDay) {
    lines.push(`当前时间：${canon.timeline.currentDay}`);
  }
  if (deadlines.length) {
    lines.push("死线/期限：");
    for (const item of deadlines) {
      const chapter = includeChapters ? `（${chapterLabel(item.chapter)}）` : "";
      const due = item.due ? `：${clip(item.due, 40)}` : "";
      const note = item.note ? `（${clip(item.note, 60)}）` : "";
      lines.push(`- ${item.name}${chapter}${due}${note}`);
    }
  }
  if (rules.length) {
    lines.push("硬性规则：");
    for (const rule of rules) lines.push(`- ${clip(rule, 120)}`);
  }

  return lines.length ? lines.join("\n") : "（暂无事实台账）";
}

export function deadNameSuspicions(
  canon: CanonFacts | undefined,
  text: string,
  chapterIndex: number,
): ContinuityIssue[] {
  if (!canon) return [];
  const issues: ContinuityIssue[] = [];
  for (const character of canon.characters) {
    if (character.status !== "dead" || character.statusChapter >= chapterIndex) continue;
    const names = [character.name, ...character.aliases]
      .map((name) => name.trim())
      .filter((name) => name.length >= 2);
    const hit = names.find((name) => text.includes(name));
    if (!hit) continue;
    const at = text.indexOf(hit);
    const evidence = text.slice(Math.max(0, at - 20), Math.min(text.length, at + hit.length + 30));
    issues.push({
      severity: "warning",
      type: "死亡人物出现",
      evidence,
      detail: `${character.name} 已在${chapterLabel(character.statusChapter)}死亡，本章正文仍出现该名字。请确认是回忆、尸体或幻象，否则属于复活。`,
    });
    if (issues.length >= 20) break;
  }
  return issues;
}

export function openingRepeatSuspicion(
  previousEnding: string,
  chapterText: string,
  size = 24,
): ContinuityIssue[] {
  // 只比较“上一章结尾”和“本章开头”，专抓把上一章最后一段又复述一遍的衔接问题。
  const previous = previousEnding.replace(/\s+/g, "").slice(-500);
  const current = chapterText.replace(/\s+/g, "").slice(0, 700);
  if (previous.length < size || current.length < size) return [];

  let best = "";
  for (let start = 0; start <= previous.length - size; start += 2) {
    const sample = previous.slice(start, start + size);
    const at = current.indexOf(sample);
    if (at < 0) continue;
    let left = 0;
    while (
      start - left - 1 >= 0 &&
      at - left - 1 >= 0 &&
      previous[start - left - 1] === current[at - left - 1]
    ) {
      left += 1;
    }
    let right = size;
    while (
      start + right < previous.length &&
      at + right < current.length &&
      previous[start + right] === current[at + right]
    ) {
      right += 1;
    }
    const matched = previous.slice(start - left, start + right);
    if (matched.length > best.length) best = matched;
  }

  if (best.length < size) return [];
  return [
    {
      severity: "warning",
      type: "章首重复",
      evidence: best.slice(0, 120),
      detail: "本章开头与上一章结尾存在大段重复，可能是在复述上一章而没有推进场景。",
    },
  ];
}

export function formatIssuesForPrompt(
  issues: ContinuityIssue[],
  options: { withIds?: boolean } = {},
): string {
  if (!issues.length) return "（没有发现明确冲突）";
  return issues
    .slice(0, 20)
    .map((issue) => {
      const evidence = issue.evidence ? `（证据：${clip(issue.evidence, 100)}）` : "";
      const id = options.withIds && issue.id ? `[${issue.id}] ` : "";
      return `- ${id}[${issue.severity}] ${issue.type}：${clip(issue.detail, 200)}${evidence}`;
    })
    .join("\n");
}
