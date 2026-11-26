import { createHash } from "node:crypto";
import { nowIso } from "./utils";
import type {
  CanonCharacter,
  CanonCharacterStatus,
  CanonDeadline,
  CanonFact,
  CanonFactKind,
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

// 通用称呼、亲属称谓和骂人话不能当人物别名：同一称呼经常同时指向多人
// （例如“老东西”可以骂任何上年纪的角色），拿它匹配会把一个角色的事实
// 错误合并到另一个角色名下，或让已死人物检查产生误报。
const GENERIC_CHARACTER_ALIASES = new Set([
  "老东西",
  "老家伙",
  "老小子",
  "老鬼子",
  "老不死的",
  "死老头",
  "臭小子",
  "小子",
  "狗东西",
  "狗日的",
  "混账",
  "家伙",
  "老道",
  "道士",
  "师傅",
  "师父",
  "爷爷",
  "爷",
  "你爷爷",
  "你爷",
  "我爷",
  "奶奶",
  "老奶奶",
  "妹妹",
  "妹",
  "令妹",
  "妹子",
  "姐姐",
  "哥哥",
  "哥",
  "兄弟",
  "小兄弟",
  "大哥",
  "老哥",
  "弟弟",
  "姑娘",
  "小姑娘",
  "大妹子",
  "老头",
  "老人家",
  "老太太",
  "男人",
  "女人",
  "汉子",
  "婆娘",
  "媳妇",
]);

export function isReliableCharacterAlias(value: string): boolean {
  const key = normalizeName(value);
  if (key.length < 2) return false;
  return !GENERIC_CHARACTER_NAMES.has(key) && !GENERIC_CHARACTER_ALIASES.has(key);
}

// 姓名可以是单字（少数民族名、绰号），但不能是“老东西”“爷爷”这类通用称呼。
function isReliableCharacterName(value: string): boolean {
  const key = normalizeName(value);
  return Boolean(key) && !GENERIC_CHARACTER_NAMES.has(key) && !GENERIC_CHARACTER_ALIASES.has(key);
}

function reliableAliases(values: string[]): string[] {
  return values.filter(isReliableCharacterAlias);
}

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

const FACT_KINDS = new Set<CanonFactKind>([
  "world",
  "rule",
  "event",
  "character",
  "item",
  "other",
]);

function stableFactId(kind: string, content: string): string {
  const digest = createHash("sha256").update(`${kind}:${content}`, "utf8").digest("hex");
  return `fact-${digest.slice(0, 12)}`;
}

export function normalizeCanonFact(input: unknown): CanonFact | null {
  const record = (input ?? {}) as Record<string, unknown>;
  const content = str(record.content).trim();
  if (!content) return null;
  const rawKind = str(record.kind).trim().toLowerCase() as CanonFactKind;
  const kind = FACT_KINDS.has(rawKind) ? rawKind : "other";
  const establishedAtRaw = str(record.establishedAt ?? record.established_at).trim();
  const establishedAt =
    establishedAtRaw === "character" || establishedAtRaw === "chapter"
      ? establishedAtRaw
      : "architecture";
  const chapter = Math.max(0, num(record.chapter));
  return {
    id: str(record.id).trim() || stableFactId(kind, content),
    kind,
    content,
    establishedAt,
    chapter,
    // event 事实可能是被误塞进来的未来剧情，读取时也一律按背景参考处理。
    immutable:
      record.immutable !== false && kind !== "event" && kind !== "other",
    note: str(record.note).trim(),
  };
}

export function normalizeCanonFacts(input: unknown): CanonFact[] {
  if (!Array.isArray(input)) return [];
  const facts: CanonFact[] = [];
  const ids = new Set<string>();
  for (const item of input) {
    const fact = normalizeCanonFact(item);
    if (!fact) continue;
    let id = fact.id;
    let suffix = 2;
    while (ids.has(id)) {
      id = `${fact.id}-${suffix}`;
      suffix += 1;
    }
    ids.add(id);
    facts.push({ ...fact, id });
    if (facts.length >= 200) break;
  }
  return facts;
}

// 架构第一阶段的 facts 只需 content/kind；首次确立位置和 ID 由程序补齐。
export function normalizeArchitectureFacts(input: unknown): CanonFact[] {
  return normalizeCanonFacts(input).map((fact) => ({
    ...fact,
    establishedAt: "architecture" as const,
    chapter: 0,
    // 只有世界设定和硬规则是不可变约束；event 事实可能是模型误塞的未来剧情，
    // 只能作为背景参考，不能反过来否定正文或计划。
    immutable: fact.kind === "world" || fact.kind === "rule",
  }));
}

export function emptyCanon(): CanonFacts {
  return {
    characters: [],
    items: [],
    timeline: { currentDay: "", deadlines: [] },
    rules: [],
    facts: [],
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
    (canon.facts?.length ?? 0) === 0 &&
    canon.lastChapter === 0
  );
}

export interface BuildInitialCanonOptions {
  facts?: CanonFact[];
  items?: CanonItem[];
  updatedAt?: string;
}

// 架构阶段还没有正文可抽取，只能把人物卡/架构事实/物品基线转成“待正文确认”的初始台账。
// 统一用 chapter 0 标记，后续第 1 章事实抽取会覆盖为真实状态。
export function buildInitialCanon(
  characters: Character[],
  options: string | BuildInitialCanonOptions = {},
): CanonFacts {
  const resolved = typeof options === "string" ? { updatedAt: options } : options;
  const updatedAt = resolved.updatedAt ?? nowIso();
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
    items: (resolved.items ?? []).map((item) => ({
      ...item,
      aliases: [...item.aliases],
      location: item.location ?? "",
    })),
    timeline: { currentDay: "", deadlines: [] },
    rules: [],
    facts: normalizeCanonFacts(resolved.facts ?? []),
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
    facts: (canon.facts ?? []).filter((fact) => fact.chapter <= chapterIndex),
    lastChapter: chapterIndex,
    updatedAt: canon.updatedAt,
  };
}

// 删除章节后移除只由该章确立的事实；无法确认来源的人物状态降级为“未知”，
// 避免已删除正文里的死亡、位置或物品归属继续约束后续写作。
export function removeChapterFacts(
  canon: CanonFacts,
  chapter: number,
  latestChapter: number,
  updatedAt = nowIso(),
): CanonFacts {
  const characters: CanonCharacter[] = [];
  for (const item of canon.characters) {
    if (item.chapter === chapter && item.statusChapter === chapter) continue;
    if (item.statusChapter === chapter) {
      characters.push({
        ...item,
        status: "unknown",
        statusChapter: 0,
        location: "",
        note: "",
      });
      continue;
    }
    characters.push(
      item.chapter === chapter
        ? { ...item, chapter: latestChapter, location: "", note: "" }
        : item,
    );
  }

  return {
    characters,
    items: canon.items.filter((item) => item.chapter !== chapter),
    timeline: {
      // 时间线最新日期只可能来自被删章节时，不能继续当成已知事实。
      currentDay: canon.lastChapter <= chapter ? "" : canon.timeline.currentDay,
      deadlines: canon.timeline.deadlines.filter((item) => item.chapter !== chapter),
    },
    rules: [...canon.rules],
    facts: (canon.facts ?? []).filter(
      (fact) => !(fact.establishedAt === "chapter" && fact.chapter === chapter),
    ),
    lastChapter: Math.min(canon.lastChapter, latestChapter),
    updatedAt,
  };
}

function normalizeCanonCharacter(input: unknown): CanonCharacter | null {
  const record = (input ?? {}) as Record<string, unknown>;
  const name = str(record.name).trim();
  if (!name || !isReliableCharacterName(name)) return null;
  const chapter = num(record.chapter);
  const status = normalizeStatus(record.status);
  return {
    name,
    aliases: uniqueStrings(arr(record.aliases).filter(isReliableCharacterAlias), name),
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
    location: str(record.location).trim(),
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
  const facts = normalizeCanonFacts(record.facts);
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
    ...(facts.length ? { facts } : {}),
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
  if (!name || !isReliableCharacterName(name)) return null;
  return {
    name,
    aliases: uniqueStrings(arr(record.aliases).filter(isReliableCharacterAlias), name),
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
    location: str(record.location).trim(),
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
  /(?:(?:不构成|并未构成)[^。；\n]{0,12}(?:矛盾|冲突|错误|问题)|不矛盾|并不矛盾|不冲突|并不冲突|无直接矛盾|无直接冲突|未发现矛盾|未发现冲突|与台账一致|误报|非活人出场|不是活人出场|属于(?:回忆|转述|遗物|尸体|幻象)|并非(?:矛盾|冲突|错误|问题)|不算(?:矛盾|冲突|错误|问题))/;
const REAL_PROBLEM =
  /(?:存在.{0,12}(?:矛盾|冲突)|与.{0,20}(?:矛盾|冲突|不符|不一致)|构成.{0,12}(?:矛盾|冲突)|实际改写|需要改写|建议(?:改|明确)|应(?:修改|改写|删除))/;

// 否定结论常和真实问题写在同一句里（“不构成 A 冲突，但 B 确实冲突”）；
// 先剔除含否定词的短句，避免把“不构成冲突”误当成真实问题。
function positiveClauses(text: string): string {
  return text
    .split(/[，。；\n]|但|不过|然而/)
    .filter(
      (clause) =>
        !/(不构成|不矛盾|并不矛盾|不冲突|并不冲突|无直接矛盾|无直接冲突|未发现矛盾|未发现冲突|并非|不算|误报)/.test(
          clause,
        ),
    )
    .join("，");
}

export function isDiscardableIssue(issue: ContinuityIssue): boolean {
  const detail = issue.detail.trim();
  const text = `${issue.type} ${detail} ${issue.evidence}`;
  if (issue.type === "死亡人物出现" && MECHANICAL_DEATH_NAME.test(detail)) {
    return true;
  }
  if (issue.type === "章首重复" && MECHANICAL_OPENING_REPEAT.test(detail)) {
    return true;
  }
  // “不是问题/可以忽略”也可能出现在真实冲突描述里（引述人物台词或“但 B 确实冲突”）；
  // 只有整条问题没有指出真实矛盾时才丢弃。
  if (
    SELF_NEGATING_ISSUE.test(text) &&
    !REAL_PROBLEM.test(positiveClauses(text))
  ) {
    return true;
  }
  // 严重/可忽略条目如果自己已经否定了问题，又没有指出真实矛盾，直接丢弃；
  // 建议类保留，避免误删“需要人工确认”的弱提示。
  return (
    issue.severity !== "warning" &&
    NEGATED_CONCLUSION.test(text) &&
    !REAL_PROBLEM.test(positiveClauses(text))
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
        // 大纲偏离只说明正文与细纲不同，不等于事实冲突；细纲可能已被作者调整。
        // 只有同时违反台账/前文硬事实时，才应由对应类型（而不是大纲偏离）判 critical。
        if (issue.type.includes("大纲偏离") && issue.severity === "critical") {
          issue.severity = "warning";
        }
      }
    }
    if (!issue || isDiscardableIssue(issue)) continue;
    const key = `${issue.severity}|${issue.type}|${issue.detail}|${issue.evidence}`;
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push(issue);
  }
  return limitIssues(issues);
}

// 上限截断必须优先保留 critical，不能按模型输出顺序把严重问题截掉。
function limitIssues(issues: ContinuityIssue[]): ContinuityIssue[] {
  if (issues.length <= 40) return issues;
  const rank = (issue: ContinuityIssue): number =>
    issue.severity === "critical" ? 2 : issue.severity === "warning" ? 1 : 0;
  return [...issues].sort((left, right) => rank(right) - rank(left)).slice(0, 40);
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
    }
  }
  return limitIssues(merged);
}

export function countCritical(issues: ContinuityIssue[]): number {
  return issues.filter((issue) => issue.severity === "critical").length;
}

function cloneCanon(canon: CanonFacts): CanonFacts {
  return {
    characters: canon.characters.map((item) => ({ ...item, aliases: [...item.aliases] })),
    items: canon.items.map((item) => ({
      ...item,
      aliases: [...item.aliases],
      location: item.location ?? "",
    })),
    timeline: {
      currentDay: canon.timeline.currentDay,
      deadlines: canon.timeline.deadlines.map((item) => ({ ...item })),
    },
    rules: [...canon.rules],
    facts: (canon.facts ?? []).map((item) => ({ ...item })),
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
    [existing.name, ...reliableAliases(existing.aliases)].map(normalizeName).filter(Boolean),
  );
  return [name, ...reliableAliases(aliases)].some((candidate) => {
    const key = normalizeName(candidate);
    return Boolean(key) && existingKeys.has(key);
  });
}

// 人物匹配比物品严格：别名必须在整个台账里只属于一个人，
// 否则“老东西”“小翠”这类称呼会把事实合并到错误角色名下。
function characterNamesMatch(
  canon: CanonFacts,
  existing: CanonCharacter,
  name: string,
  aliases: string[],
): boolean {
  const existingKeys = new Set(
    [existing.name, ...reliableAliases(existing.aliases)].map(normalizeName).filter(Boolean),
  );
  return [name, ...reliableAliases(aliases)].some((candidate) => {
    const key = normalizeName(candidate);
    if (!key || !existingKeys.has(key)) return false;
    if (key === normalizeName(existing.name)) return true;
    const owners = canon.characters.filter((item) =>
      [item.name, ...reliableAliases(item.aliases)].some((value) => normalizeName(value) === key),
    );
    return owners.length === 1 && owners[0] === existing;
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
    isReliableCharacterName(fact.name) ? fact.name : "",
    ...reliableAliases(existing.aliases),
    ...reliableAliases(fact.aliases),
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

    const names = [character.name, ...reliableAliases(character.aliases)];
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

// 跨章修复会同时改动多章；按章节顺序把各自的抽取结果重新合并，
// 不能用某一章的完整台账快照覆盖其他章，否则目标章或中间章的新事实会丢失。
export function mergeChapterExtractions(
  base: CanonFacts,
  updates: { index: number; extracted: ExtractedFacts }[],
  mode: "write" | "rewrite" = "rewrite",
): CanonFacts {
  let canon = cloneCanon(base);
  for (const update of [...updates].sort((left, right) => left.index - right.index)) {
    canon = mergeCanon(canon, update.extracted, update.index, mode).canon;
  }
  return canon;
}

export function mergeCanon(
  base: CanonFacts,
  extracted: ExtractedFacts,
  chapterIndex: number,
  mode: "write" | "rewrite" = "write",
): MergeCanonResult {
  const canon = cloneCanon(base);
  const canonFacts = canon.facts ?? (canon.facts = []);
  const conflicts: ContinuityIssue[] = [];

  for (const fact of extracted.characters) {
    const existing = canon.characters.find((item) =>
      characterNamesMatch(canon, item, fact.name, fact.aliases),
    );
    if (!existing) {
      canon.characters.push({
        name: fact.name,
        aliases: uniqueStrings(reliableAliases(fact.aliases), fact.name),
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

    existing.aliases = uniqueStrings(
      [...existing.aliases, ...reliableAliases(fact.aliases)],
      existing.name,
    );

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
        location: fact.location,
        state: fact.state,
        note: fact.note,
        chapter: chapterIndex,
      });
      continue;
    }

    existing.aliases = uniqueStrings([...existing.aliases, ...fact.aliases], existing.name);
    if (existing.chapter <= chapterIndex || (mode === "rewrite" && existing.chapter === chapterIndex)) {
      // 重要物品转移必须能在本章证据中找到物品和接手人；证据不足时保留原持有人，
      // 只记录冲突给作者确认，避免一次含糊抽取直接改写既有事实。
      const holderChanged =
        Boolean(existing.holder) &&
        Boolean(fact.holder) &&
        normalizeName(existing.holder) !== normalizeName(fact.holder) &&
        existing.chapter < chapterIndex;
      const evidence = fact.evidence.trim();
      const mentionsItem =
        Boolean(evidence) &&
        [fact.name, ...fact.aliases].some((name) => name && evidence.includes(name));
      const mentionsNewHolder = Boolean(evidence) && fact.holder
        ? evidence.includes(fact.holder)
        : false;
      if (holderChanged && !(mentionsItem && mentionsNewHolder)) {
        conflicts.push({
          severity: "warning",
          type: "物品归属",
          evidence: fact.evidence,
          detail: `「${existing.name}」原持有人为 ${existing.holder}；本章抽取为 ${fact.holder}，但证据没有同时点名物品和新持有人。已保留原持有人，请人工确认是否发生转移。`,
        });
        continue;
      }
      if (holderChanged && fact.holder && extracted.story?.events?.length) {
        const backedByEvent = extracted.story.events.some((event) => {
          const text = [event.name, event.process, event.result, event.impact]
            .filter(Boolean)
            .join("\n");
          return text.includes(fact.name) && text.includes(fact.holder);
        });
        if (!backedByEvent) {
          conflicts.push({
            severity: "warning",
            type: "物品归属",
            evidence: fact.evidence,
            detail: `「${existing.name}」持有人变为 ${fact.holder}，但本章已抽取的剧情事件里没有对应的交接/转移描写。请确认物品归属与事件是否一致。`,
          });
        }
      }
      if (fact.holder) existing.holder = fact.holder;
      if (fact.location) existing.location = fact.location;
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
      const factId = stableFactId("rule", trimmed);
      if (!canonFacts.some((fact) => fact.id === factId)) {
        canonFacts.push({
          id: factId,
          kind: "rule",
          content: trimmed,
          establishedAt: "chapter",
          chapter: chapterIndex,
          immutable: false,
          note: "",
        });
      }
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
  // 规则类事实排在最前并放宽上限，避免“古印不出山门”这类硬规则被截断。
  const hardFacts = (canon.facts ?? [])
    .filter(
      (fact) =>
        fact.kind === "world" || fact.kind === "rule" || fact.immutable,
    )
    .sort(
      (left, right) =>
        (left.kind === "rule" ? 0 : 1) - (right.kind === "rule" ? 0 : 1),
    )
    .slice(0, includeChapters ? 160 : 120);
  const factRuleKeys = new Set(
    hardFacts
      .filter((fact) => fact.kind === "rule")
      .map((fact) => normalizeName(fact.content)),
  );
  const rules = canon.rules
    .filter((rule) => !factRuleKeys.has(normalizeName(rule)))
    .slice(0, includeChapters ? 20 : 15);

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
      const location = item.location ? `；位置：${clip(item.location, 40)}` : "";
      const state = item.state ? `；状态：${clip(item.state, 40)}` : "";
      const note = item.note ? `；${clip(item.note, 80)}` : "";
      lines.push(`- ${item.name}${chapter}：${holder}${location}${state}${note}`);
    }
  }
  const factLine = (fact: CanonFact): string => {
    const source =
      fact.establishedAt === "architecture"
        ? "架构设定"
        : fact.establishedAt === "character"
          ? "角色设定"
          : chapterLabel(fact.chapter);
    return `- [${fact.id}] ${clip(fact.content, 160)}（首次确立：${source}）`;
  };
  if (hardFacts.length) {
    lines.push("既定事实与硬性规则（不得静默改写）：");
    for (const fact of hardFacts) lines.push(factLine(fact));
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
    // 通用称呼不算“名字出现”，否则“这老东西”会把已死的赵四误判成复活。
    const names = [character.name, ...reliableAliases(character.aliases)];
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

// 每章都用“X 是被一阵敲门声吵醒的”这类“刺激—反应”开头，读起来就是模板。
// 只认“被……吵醒/惊醒/惊动/打断”这一类高置信度形态，且只看开头第一句，
// 避免把正文里的正常被动句误判成开头公式化。
const FORMULAIC_OPENING =
  /被[^。！？]{0,24}(吵醒|惊醒|惊动|叫醒|吼醒|唤醒|拽回|拉回|扯回|打断)/u;

function openingFirstSentence(text: string): string {
  const head = text.replace(/\s+/gu, "").slice(0, 200);
  const match = head.match(/^[^。！？]*[。！？]?/u);
  return (match?.[0] ?? head).trim();
}

function isFormulaicOpening(text: string): boolean {
  return FORMULAIC_OPENING.test(openingFirstSentence(text));
}

// 开头方式分类：写作前把最近三章的类型交给模型，让它换一种结构。
// 分类只看首句，标签是可读的中文短语，不把原句喂给模型，避免又变成素材。
export type OpeningKind =
  | "wake"
  | "judgement"
  | "time"
  | "dialogue"
  | "scene"
  | "action"
  | "other";

export const OPENING_KIND_LABELS: Record<OpeningKind, string> = {
  wake: "被动唤醒或打断式",
  judgement: "事后判断式",
  time: "时间起兴式",
  dialogue: "对话直入式",
  scene: "环境或物件起笔",
  action: "动作中间态",
  other: "其他",
};

const OPENING_SCENE_WORDS =
  /(天色|天光|窗外|院子|屋里|街道|空气|风|雨|雪|雾|阳光|月光|灯|门|走廊|废墟|山林|夜色)/u;
const OPENING_ACTION_HINTS =
  /(把|抓|握|推|拉|抬|低|转|跑|走|站|坐|蹲|伸手|回头|停|盯|看|听|摸)/u;

export function classifyOpening(text: string): OpeningKind {
  const first = openingFirstSentence(text);
  if (!first) return "other";
  if (/[“”"「」]/u.test(first)) return "dialogue";
  if (FORMULAIC_OPENING.test(first)) return "wake";
  if (/是被[^。！？]{0,40}(的|了)/u.test(first)) return "judgement";
  if (OPENING_TIME_MARKERS.test(first.slice(0, 8))) return "time";
  if (OPENING_ACTION_HINTS.test(first)) return "action";
  if (OPENING_SCENE_WORDS.test(first)) return "scene";
  return "other";
}

export function formulaicOpeningSuspicion(
  chapterText: string,
  previousChapters: { index: number; content: string }[],
): ContinuityIssue[] {
  const first = openingFirstSentence(chapterText);
  if (first.length < 6 || !FORMULAIC_OPENING.test(first)) return [];

  // 只看最近三章：更早的章节就算同款开头，也不构成“最近都这么写”的观感。
  const recent = previousChapters
    .slice(-3)
    .filter((chapter) => isFormulaicOpening(chapter.content));
  const sibling = recent.map((chapter) => `第 ${chapter.index} 章`).join("、");

  return [
    {
      severity: "warning",
      type: "章首公式化",
      evidence: first.slice(0, 120),
      detail: sibling
        ? `本章开头与${sibling}同样使用“被……吵醒/惊动”式开头，连续多章读起来像模板。建议改成动作中间态、对话直入或环境细节切入，并保留上一章结尾的位置、身体状态和未完成动作。`
        : "本章开头把现场写成了事后结论（“X 是被……吵醒的”），读者会站在故事外面。建议从动作中间态、声音细节或结果切入，再交代原因。",
    },
  ];
}

// 上一章结尾写了某个道具，模型就可能每章开头都从同一件东西写起。
// 用相邻章节开头的双字组合重合度做粗检测：只报“最近三章里至少两章
// 出现同一个非人名双字词”，具体是否成问题交给审校模型判断。
const OPENING_STOP_CHARS = new Set(
  "的了是在他她它我你您们不就都和与及或而但很更最这那哪一有没也还又再才只把被将从向对于为所以如因由至到着地得么什怎上下里外".split(
    "",
  ),
);

function openingGrams(text: string, excludedNames: string[]): Set<string> {
  const head = text.replace(/[\s\p{P}]/gu, "").slice(0, 90);
  const grams = new Set<string>();
  for (let index = 0; index + 2 <= head.length; index += 1) {
    const pair = head.slice(index, index + 2);
    if (OPENING_STOP_CHARS.has(pair[0]) || OPENING_STOP_CHARS.has(pair[1])) {
      continue;
    }
    // 人名会天然在每章开头出现，不算“意象重复”。
    if (excludedNames.some((name) => name.length > 1 && name.includes(pair))) {
      continue;
    }
    grams.add(pair);
  }
  return grams;
}

export function openingImagerySuspicion(
  chapterText: string,
  previousChapters: { index: number; content: string }[],
  excludedNames: string[] = [],
): ContinuityIssue[] {
  const current = openingGrams(chapterText, excludedNames);
  if (current.size < 2) return [];

  const hits = new Map<string, Set<number>>();
  for (const chapter of previousChapters.slice(-3)) {
    for (const gram of openingGrams(chapter.content, excludedNames)) {
      if (!current.has(gram)) continue;
      const indexes = hits.get(gram) ?? new Set<number>();
      indexes.add(chapter.index);
      hits.set(gram, indexes);
    }
  }

  const repeated = [...hits.entries()]
    .filter(([, indexes]) => indexes.size >= 2)
    .sort((left, right) => right[1].size - left[1].size)
    .slice(0, 4);
  if (!repeated.length) return [];

  const terms = repeated.map(([gram]) => `「${gram}」`).join("、");
  const chapters = [...new Set(repeated.flatMap(([, indexes]) => [...indexes]))]
    .sort((left, right) => left - right)
    .map((index) => `第 ${index} 章`)
    .join("、");

  return [
    {
      severity: "warning",
      type: "章首意象重复",
      evidence: chapterText.trim().slice(0, 80),
      detail: `本章开头与${chapters}的开头都出现了${terms}，连续多章用同一批意象开场容易读成模板。建议开头第一段引入新动作、新信息或新人物，把上一章结尾的物件降为背景。`,
    },
  ];
}

// 骨架比对：把首句的实词压缩成 W，只保留虚词和标点，
// 这样“陆闲是被一阵敲门声吵醒的”和“她是在一个雨天接到电话的”会落到同一副骨架，
// 换成别的题材、换掉具体名词也躲不开。
const OPENING_FUNCTION_CHARS = new Set(
  "的了是在被把将向对和与也就都而但很更最有没还又再才只着过地得么什怎为之其于如所".split(
    "",
  ),
);
const OPENING_PUNCTUATION = /[。！？，、；：“”‘’"'（）()]/u;

function openingStructure(text: string): string {
  const first = openingFirstSentence(text);
  let skeleton = "";
  for (const char of first) {
    if (OPENING_PUNCTUATION.test(char)) {
      skeleton += char;
    } else if (OPENING_FUNCTION_CHARS.has(char)) {
      skeleton += char;
    } else if (!skeleton.endsWith("W")) {
      skeleton += "W";
    }
  }
  return skeleton;
}

// 骨架串很短，用编辑距离类的 LCS 比例比 bigram 交集更稳。
function lcsRatio(left: string, right: string): number {
  const a = [...left];
  const b = [...right];
  if (!a.length || !b.length) return 0;
  let previous = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const current = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      current[j] =
        a[i - 1] === b[j - 1]
          ? previous[j - 1] + 1
          : Math.max(previous[j], current[j - 1]);
    }
    previous = current;
  }
  return previous[b.length] / Math.max(a.length, b.length);
}

export function openingStructureSuspicion(
  chapterText: string,
  previousChapters: { index: number; content: string }[],
): ContinuityIssue[] {
  const skeleton = openingStructure(chapterText);
  // 骨架里的功能字太少时说明首句过短或全是实词，比对没有意义。
  if (skeleton.replace(/W/gu, "").length < 2) return [];

  const matched = previousChapters.slice(-3).filter((chapter) => {
    const other = openingStructure(chapter.content);
    return other.length >= 4 && lcsRatio(skeleton, other) >= 0.6;
  });
  // 只和一章相似可能是巧合；连续三章里出现两次才算模板。
  if (matched.length < 2) return [];

  const chapters = matched.map((chapter) => `第 ${chapter.index} 章`).join("、");
  return [
    {
      severity: "warning",
      type: "章首句式重复",
      evidence: openingFirstSentence(chapterText).slice(0, 120),
      detail: `本章开头与${chapters}使用同一副句式骨架（${skeleton}），连续多章读起来像同一个模板。建议换一种开头结构：动作中间态、对话直入、结果先行或明确的时间跳跃；换结构时仍要保留与上一章结尾的位置、身体状态或未完成动作的衔接。`,
    },
  ];
}

// 换开头结构时最容易一起丢掉的是衔接。这里检查开头有没有留下可识别的锚点：
// 时间推进、视角代词、回忆/梦境提示、人物名，或上一章结尾出现过的实词。
const OPENING_TIME_MARKERS =
  /(次日|翌日|第二天|隔天|三日后|三天后|数日后|半月后|一月后|与此同时|同一时刻|片刻后|半个时辰后|入夜|天亮|午后|黄昏|清晨|拂晓|傍晚|深夜)/u;
const OPENING_PRONOUNS = /(他|她|它|我|他们|她们)/u;
const OPENING_RECALL_MARKERS = /(梦|回忆|想起|记得|记忆|恍然)/u;

function contentGrams(text: string, excludedNames: string[]): Set<string> {
  const clean = text.replace(/[\s\p{P}]/gu, "");
  const grams = new Set<string>();
  for (let index = 0; index + 2 <= clean.length; index += 1) {
    const pair = clean.slice(index, index + 2);
    if (OPENING_STOP_CHARS.has(pair[0]) || OPENING_STOP_CHARS.has(pair[1])) {
      continue;
    }
    if (excludedNames.some((name) => name.length > 1 && name.includes(pair))) {
      continue;
    }
    grams.add(pair);
  }
  return grams;
}

export function openingLinkSuspicion(
  chapterText: string,
  previousEnding: string,
  previousIndex: number,
  knownNames: string[] = [],
): ContinuityIssue[] {
  const ending = previousEnding.replace(/[\s\p{P}]/gu, "");
  if (ending.length < 20) return []; // 全书第一章或上一章没有正文时不判断

  const head = chapterText.replace(/[\s\p{P}]/gu, "").slice(0, 120);
  if (head.length < 10) return [];

  if (OPENING_TIME_MARKERS.test(head)) return [];
  if (OPENING_PRONOUNS.test(head)) return [];
  if (OPENING_RECALL_MARKERS.test(head)) return [];
  if (knownNames.some((name) => name.length > 1 && head.includes(name))) {
    return [];
  }

  // 同场景延续：上一章结尾的实词在开头复现，也算有锚点（与“意象重复”是两回事）。
  const endingGrams = contentGrams(ending.slice(-200), knownNames);
  for (const gram of contentGrams(head, knownNames)) {
    if (endingGrams.has(gram)) return [];
  }

  return [
    {
      severity: "warning",
      type: "章首衔接",
      evidence: chapterText.trim().slice(0, 80),
      detail: `本章开头没有沿用第 ${previousIndex} 章结尾的人物、地点或物件，也没有时间推进、回忆或梦境提示，读者可能觉得另起了一场戏。建议在前 100 字内补一个锚点：同一空间里的物件、人物的身体状态，或上一章没做完的那个动作。`,
    },
  ];
}

// 正文中段的公式化不像开头那样有稳定的骨架，但落点是固定的高频词与句式。
// 词表只用于检测、不写进写作提示词，避免像“敲门声”那样被模型当成默认素材。
// 权重按“是否几乎只在套话里出现”分级：文学性作品里高频但正常的词只记 0.5。
const FORMULAIC_TERMS: { term: string; weight: number }[] = [
  { term: "不由得", weight: 1 },
  { term: "不禁", weight: 1 },
  { term: "忍不住", weight: 1 },
  { term: "顿时", weight: 1 },
  { term: "霎时", weight: 1 },
  { term: "刹那间", weight: 1 },
  { term: "心中一沉", weight: 1 },
  { term: "心中一紧", weight: 1 },
  { term: "心头一紧", weight: 1 },
  { term: "心头一震", weight: 1 },
  { term: "心中一暖", weight: 1 },
  { term: "鼻子一酸", weight: 1 },
  { term: "眼眶一热", weight: 1 },
  { term: "深吸一口气", weight: 1 },
  { term: "深吸了一口气", weight: 1 },
  { term: "攥紧拳头", weight: 1 },
  { term: "握紧拳头", weight: 1 },
  { term: "眉头微皱", weight: 1 },
  { term: "眉头一皱", weight: 1 },
  { term: "嘴角勾起", weight: 1 },
  { term: "勾起一抹", weight: 1 },
  { term: "苦涩一笑", weight: 1 },
  { term: "苦笑一声", weight: 1 },
  { term: "瞳孔骤缩", weight: 1 },
  { term: "瞳孔一缩", weight: 1 },
  { term: "倒吸一口凉气", weight: 1 },
  { term: "仿佛", weight: 0.5 },
  { term: "似乎", weight: 0.5 },
  { term: "竟然", weight: 0.5 },
  { term: "微微", weight: 0.5 },
  { term: "缓缓", weight: 0.5 },
  { term: "轻轻", weight: 0.5 },
  { term: "淡淡", weight: 0.5 },
];

const FORMULAIC_PATTERNS: {
  label: string;
  pattern: RegExp;
  weight: number;
}[] = [
  {
    label: "空气凝固",
    pattern: /空气(仿佛|似乎|好像|瞬间)?(凝固|安静下来|安静得)/gu,
    weight: 2,
  },
  {
    label: "不知过了多久",
    pattern: /(不知|不知道)过了多久/gu,
    weight: 2,
  },
  {
    label: "时间静止",
    pattern: /时间(仿佛|似乎)?(一分一秒|静止|凝固)/gu,
    weight: 2,
  },
];

const FORMULAIC_ENDING = /(这一切|这)?(才|仅仅|只是|不过)(才)?(刚刚)?开始/u;

export interface FormulaicHit {
  term: string;
  count: number;
  weight: number;
}

export interface FormulaicPassageReport {
  chars: number;
  score: number;
  perKilo: number;
  hits: FormulaicHit[];
  endingCliche: string;
  shouldRewrite: boolean;
}

export function analyzeFormulaicPassage(text: string): FormulaicPassageReport {
  const chars = text.replace(/\s/gu, "").length;
  const hits: FormulaicHit[] = [];
  let score = 0;

  for (const item of FORMULAIC_TERMS) {
    const count = text.split(item.term).length - 1;
    if (!count) continue;
    hits.push({ term: item.term, count, weight: item.weight });
    score += count * item.weight;
  }
  for (const item of FORMULAIC_PATTERNS) {
    const matches = text.match(item.pattern);
    if (!matches?.length) continue;
    hits.push({ term: item.label, count: matches.length, weight: item.weight });
    score += matches.length * item.weight;
  }

  // 章末总结句单独加权：它替读者下结论，是最容易被察觉的机械感来源。
  const tail = text.replace(/\s+/gu, "").slice(-140);
  const endingCliche = FORMULAIC_ENDING.test(tail) ? tail.slice(-60) : "";
  if (endingCliche) {
    hits.push({ term: "章末总结句", count: 1, weight: 3 });
    score += 3;
  }

  hits.sort(
    (left, right) =>
      right.count * right.weight - left.count * left.weight,
  );
  const perKilo = chars ? (score / chars) * 1000 : 0;
  return {
    chars,
    score,
    perKilo,
    hits,
    endingCliche,
    // 阈值偏保守：每千字 1.5 分且至少 3 种表现才认为成问题，避免误伤正常用词。
    shouldRewrite: perKilo >= 1.5 && hits.length >= 3,
  };
}

export function formulaicPassageSuspicion(
  chapterText: string,
): ContinuityIssue[] {
  const report = analyzeFormulaicPassage(chapterText);
  if (!report.shouldRewrite) return [];

  const terms = report.hits
    .slice(0, 6)
    .map((hit) => `${hit.term}×${hit.count}`)
    .join("、");
  return [
    {
      severity: "warning",
      type: "文风套话",
      evidence: report.hits
        .slice(0, 5)
        .map((hit) => hit.term)
        .join("、"),
      detail: `本章套话密度偏高：${terms}（每千字约 ${report.perKilo.toFixed(1)} 处${
        report.endingCliche ? "，并含章末总结句" : ""
      }）。建议删掉解释情绪的副词和生理反应，改用具体动作、对话或环境细节承载情绪；同一情绪不要重复用同一个动作。`,
    },
  ];
}

export function formatIssuesForPrompt(
  issues: ContinuityIssue[],
  options: {
    withIds?: boolean;
    detailLimit?: number;
    evidenceLimit?: number;
  } = {},
): string {
  if (!issues.length) return "（没有发现明确冲突）";
  const detailLimit = options.detailLimit ?? 200;
  const evidenceLimit = options.evidenceLimit ?? 100;
  return issues
    .slice(0, 20)
    .map((issue) => {
      const evidence = issue.evidence
        ? `（证据：${clip(issue.evidence, evidenceLimit)}）`
        : "";
      const id = options.withIds && issue.id ? `[${issue.id}] ` : "";
      return `- ${id}[${issue.severity}] ${issue.type}：${clip(issue.detail, detailLimit)}${evidence}`;
    })
    .join("\n");
}
