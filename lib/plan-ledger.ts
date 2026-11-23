import { createHash } from "node:crypto";
import { parseOutlineForeshadows } from "./memory";
import { nowIso } from "./utils";
import type {
  CanonFacts,
  ChapterMemory,
  ChapterPlan,
  Character,
  ContinuityIssue,
  ExtractedStory,
  PlanCharacterChange,
  PlanDeviation,
  PlanEvent,
  PlanForeshadow,
  PlanImportance,
  PlanItem,
  PlanItemChange,
  PlanItemChangeType,
  PlanLedger,
  PlanRelation,
  PlanRelationDirection,
  PlanStatus,
  PlanTimelineEntry,
  PlotEvent,
  ProjectPlan,
} from "./types";
import { itemOwnershipAt, relationsAt } from "./plan-view";

export const PLAN_LEDGER_VERSION = 1;

const STATUS_ALIASES: Record<string, PlanStatus> = {
  planned: "planned",
  plan: "planned",
  pending: "planned",
  future: "planned",
  partially_realized: "partially_realized",
  "partially-realized": "partially_realized",
  partial: "partially_realized",
  realized: "realized",
  realised: "realized",
  done: "realized",
  executed: "realized",
  deviated: "deviated",
  deviated_from_plan: "deviated",
  changed: "deviated",
  cancelled: "cancelled",
  canceled: "cancelled",
  abandoned: "cancelled",
};

const IMPORTANCE_ALIASES: Record<string, PlanImportance> = {
  core: "core",
  main: "core",
  critical: "core",
  major: "major",
  important: "major",
  minor: "minor",
  normal: "minor",
  background: "background",
  low: "background",
};

export function emptyPlanLedger(updatedAt = nowIso()): PlanLedger {
  return {
    version: PLAN_LEDGER_VERSION,
    events: [],
    characterChanges: [],
    foreshadows: [],
    timeline: [],
    items: [],
    itemRegistry: [],
    relations: [],
    deviations: [],
    completedChapter: 0,
    completedAt: "",
    updatedAt,
  };
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function list(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
}

function positiveInt(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function stableId(prefix: string, key: string): string {
  const digest = createHash("sha256").update(key, "utf8").digest("hex").slice(0, 10);
  return `${prefix}-${digest}`;
}

function uniqueId(candidate: string, used: Set<string>): string {
  let next = candidate;
  let index = 2;
  while (used.has(next)) {
    next = `${candidate}-${index}`;
    index += 1;
  }
  used.add(next);
  return next;
}

export function normalizePlanStatus(value: unknown): PlanStatus {
  const key = text(value).toLowerCase();
  return STATUS_ALIASES[key] ?? "planned";
}

function normalizeImportance(value: unknown): PlanImportance {
  const key = text(value).toLowerCase();
  return IMPORTANCE_ALIASES[key] ?? "minor";
}

function normalizeEvent(input: unknown, at: string, used: Set<string>): PlanEvent | null {
  const record = recordOf(input);
  const name = text(record.name);
  const chapter = positiveInt(record.chapter);
  if (!name || !chapter) return null;
  const process = text(record.process);
  const id = text(record.id) || stableId("plan-event", `${chapter}:${name}:${process}`);
  return {
    id: uniqueId(id, used),
    name,
    chapter,
    thread: text(record.thread ?? record.line ?? record.storyline),
    participants: list(record.participants),
    premise: text(record.premise),
    process,
    expectedResult: text(record.expectedResult ?? record.expected_result),
    impact: text(record.impact),
    relatedEventIds: list(record.relatedEventIds ?? record.related_event_ids),
    importance: normalizeImportance(record.importance),
    status: normalizePlanStatus(record.status),
    actualChapter: positiveInt(record.actualChapter ?? record.actual_chapter),
    actualEventIds: list(record.actualEventIds ?? record.actual_event_ids),
    evidence: text(record.evidence),
    note: text(record.note),
    updatedAt: text(record.updatedAt ?? record.updated_at) || at,
  };
}

function normalizeCharacterChange(
  input: unknown,
  at: string,
  used: Set<string>,
): PlanCharacterChange | null {
  const record = recordOf(input);
  const character = text(record.character ?? record.name);
  const chapter = positiveInt(record.chapter);
  if (!character || !chapter) return null;
  const after = text(record.after);
  const id = text(record.id) || stableId("plan-char", `${chapter}:${character}:${after}`);
  return {
    id: uniqueId(id, used),
    character,
    chapter,
    before: text(record.before),
    after,
    reason: text(record.reason),
    eventIds: list(record.eventIds ?? record.event_ids),
    status: normalizePlanStatus(record.status),
    actualChapter: positiveInt(record.actualChapter ?? record.actual_chapter),
    evidence: text(record.evidence),
    updatedAt: text(record.updatedAt ?? record.updated_at) || at,
  };
}

function normalizeForeshadow(input: unknown, at: string, used: Set<string>): PlanForeshadow | null {
  const record = recordOf(input);
  const foreshadowText = text(record.text ?? record.content);
  const plantChapter = positiveInt(record.plantChapter ?? record.plant_chapter ?? record.plannedPlantChapter);
  if (!foreshadowText || !plantChapter) return null;
  const resolveChapter = positiveInt(
    record.resolveChapter ?? record.resolve_chapter ?? record.plannedResolveChapter,
  );
  const id = text(record.id) || stableId("plan-foreshadow", `${plantChapter}:${foreshadowText}`);
  return {
    id: uniqueId(id, used),
    text: foreshadowText,
    plantChapter,
    resolveChapter,
    purpose: text(record.purpose),
    eventIds: list(record.eventIds ?? record.event_ids),
    resolveCondition: text(record.resolveCondition ?? record.resolve_condition),
    status: normalizePlanStatus(record.status),
    actualPlantChapter: positiveInt(record.actualPlantChapter ?? record.actual_plant_chapter),
    actualResolveChapter: positiveInt(record.actualResolveChapter ?? record.actual_resolve_chapter),
    evidence: text(record.evidence),
    updatedAt: text(record.updatedAt ?? record.updated_at) || at,
  };
}

function normalizeTimeline(
  input: unknown,
  at: string,
  used: Set<string>,
): PlanTimelineEntry | null {
  const record = recordOf(input);
  const chapter = positiveInt(record.chapter);
  const time = text(record.time);
  if (!chapter || (!time && !text(record.sequence))) return null;
  const id = text(record.id) || stableId("plan-time", `${chapter}:${time}:${text(record.sequence)}`);
  return {
    id: uniqueId(id, used),
    chapter,
    time,
    eventIds: list(record.eventIds ?? record.event_ids),
    sequence: text(record.sequence),
    constraints: text(record.constraints),
    participants: list(record.participants),
    status: normalizePlanStatus(record.status),
    actualChapter: positiveInt(record.actualChapter ?? record.actual_chapter),
    evidence: text(record.evidence),
    updatedAt: text(record.updatedAt ?? record.updated_at) || at,
  };
}

const ITEM_CHANGE_TYPES = new Set<PlanItemChangeType>([
  "transfer",
  "state",
  "location",
  "introduce",
  "destroy",
  "other",
]);

function normalizeItemChangeType(value: unknown): PlanItemChangeType {
  const key = text(value).trim().toLowerCase();
  if (ITEM_CHANGE_TYPES.has(key as PlanItemChangeType)) {
    return key as PlanItemChangeType;
  }
  return "other";
}

function normalizeItem(input: unknown, at: string, used: Set<string>): PlanItemChange | null {
  const record = recordOf(input);
  const item = text(record.item ?? record.name);
  const chapter = positiveInt(record.chapter);
  if (!item || !chapter) return null;
  const id = text(record.id) || stableId("plan-item", `${chapter}:${item}`);
  const stateChange = text(record.stateChange ?? record.state_change);
  return {
    id: uniqueId(id, used),
    item,
    chapter,
    changeType: normalizeItemChangeType(record.changeType ?? record.change_type),
    holder: text(record.holder),
    location: text(record.location),
    state: text(record.state) || stateChange,
    stateChange,
    reason: text(record.reason),
    eventIds: list(record.eventIds ?? record.event_ids),
    status: normalizePlanStatus(record.status),
    actualChapter: positiveInt(record.actualChapter ?? record.actual_chapter),
    evidence: text(record.evidence),
    updatedAt: text(record.updatedAt ?? record.updated_at) || at,
  };
}

function normalizePlanItem(input: unknown): PlanItem | null {
  const record = recordOf(input);
  const name = text(record.name ?? record.item);
  if (!name) return null;
  return {
    id: text(record.id) || stableId("plan-item-base", name),
    name,
    aliases: list(record.aliases),
    holder: text(record.holder),
    location: text(record.location),
    state: text(record.state),
    introducedChapter: positiveInt(
      record.introducedChapter ?? record.introduced_chapter ?? record.chapter,
    ),
    note: text(record.note),
  };
}

function normalizePlanRelation(
  input: unknown,
  at: string,
  used: Set<string>,
): PlanRelation | null {
  const record = recordOf(input);
  const from = text(record.from ?? record.source);
  const to = text(record.to ?? record.target);
  const startChapter = positiveInt(
    record.startChapter ?? record.start_chapter ?? record.chapter,
  );
  if (!from || !to || !startChapter) return null;
  const type = text(record.type ?? record.relation) || "未注明";
  const endChapter = positiveInt(record.endChapter ?? record.end_chapter);
  const strengthRaw = Number(record.strength);
  const strength = Number.isFinite(strengthRaw)
    ? Math.min(5, Math.max(1, Math.round(strengthRaw)))
    : 3;
  const directionRaw = text(record.direction).trim().toLowerCase();
  const direction: PlanRelationDirection =
    directionRaw === "one-way" || directionRaw === "oneway" || directionRaw === "单向"
      ? "one-way"
      : "two-way";
  const id = text(record.id) || stableId("plan-relation", `${from}:${to}:${type}:${startChapter}`);
  return {
    id: uniqueId(id, used),
    from,
    to,
    type,
    strength,
    direction,
    startChapter,
    endChapter: endChapter && endChapter >= startChapter ? endChapter : 0,
    changeEventIds: list(record.changeEventIds ?? record.change_event_ids),
    status: normalizePlanStatus(record.status),
    actualChapter: positiveInt(record.actualChapter ?? record.actual_chapter),
    evidence: text(record.evidence),
    updatedAt: text(record.updatedAt ?? record.updated_at) || at,
  };
}

function normalizeDeviation(input: unknown): PlanDeviation | null {
  const record = recordOf(input);
  const planId = text(record.planId ?? record.plan_id);
  const chapter = positiveInt(record.chapter);
  if (!planId || !chapter) return null;
  const planType = text(record.planType ?? record.plan_type);
  const allowed = [
    "event",
    "character-change",
    "foreshadow",
    "timeline",
    "item",
    "relation",
  ] as const;
  const normalizedType = (allowed as readonly string[]).includes(planType)
    ? (planType as PlanDeviation["planType"])
    : "event";
  return {
    id: text(record.id) || stableId("plan-deviation", `${planId}:${chapter}:${text(record.actual)}`),
    planType: normalizedType,
    planId,
    chapter,
    expected: text(record.expected),
    actual: text(record.actual),
    reason: text(record.reason),
    at: text(record.at) || nowIso(),
  };
}

// 续排或模型漏登记时，把未知物品补进基线；否则一条漏登记就会让整批计划被拒绝。
export function ensureItemRegistryCoverage(ledger: PlanLedger): PlanLedger {
  const registry = [...ledger.itemRegistry];
  const names = new Set(
    registry.flatMap((item) => [item.name, ...item.aliases]).map(normalizeKey),
  );
  let changed = false;
  for (const change of ledger.items) {
    const key = normalizeKey(change.item);
    if (!key || names.has(key)) continue;
    registry.push({
      id: stableId("plan-item-base", `${change.chapter}:${change.item}`),
      name: change.item,
      aliases: [],
      holder: change.holder,
      location: change.location,
      state: change.state || change.stateChange,
      introducedChapter: change.chapter,
      note: change.reason || "续排自动登记的物品基线",
    });
    names.add(key);
    changed = true;
  }
  return changed ? { ...ledger, itemRegistry: registry } : ledger;
}

export function normalizePlanItemRegistry(input: unknown): PlanItem[] {
  const result: PlanItem[] = [];
  const ids = new Set<string>();
  for (const item of Array.isArray(input) ? input : []) {
    const normalized = normalizePlanItem(item);
    if (!normalized) continue;
    let id = normalized.id;
    let suffix = 2;
    while (ids.has(id)) {
      id = `${normalized.id}-${suffix}`;
      suffix += 1;
    }
    ids.add(id);
    result.push({ ...normalized, id });
  }
  return result;
}

export function normalizePlanRelations(
  input: unknown,
  updatedAt = nowIso(),
): PlanRelation[] {
  const result: PlanRelation[] = [];
  const ids = new Set<string>();
  for (const item of Array.isArray(input) ? input : []) {
    const normalized = normalizePlanRelation(item, updatedAt, ids);
    if (normalized) result.push(normalized);
  }
  return result;
}

export function normalizePlanLedger(input: unknown, updatedAt = nowIso()): PlanLedger {
  const record = recordOf(input);
  const at = text(record.updatedAt ?? record.updated_at) || updatedAt;
  const events: PlanEvent[] = [];
  const characterChanges: PlanCharacterChange[] = [];
  const foreshadows: PlanForeshadow[] = [];
  const timeline: PlanTimelineEntry[] = [];
  const items: PlanItemChange[] = [];
  const itemRegistry: PlanItem[] = [];
  const relations: PlanRelation[] = [];
  const deviations: PlanDeviation[] = [];
  const eventIds = new Set<string>();
  const changeIds = new Set<string>();
  const foreshadowIds = new Set<string>();
  const timelineIds = new Set<string>();
  const itemIds = new Set<string>();
  const relationIds = new Set<string>();
  const deviationIds = new Set<string>();

  for (const item of Array.isArray(record.events) ? record.events : []) {
    const normalized = normalizeEvent(item, at, eventIds);
    if (normalized) events.push(normalized);
  }
  for (const item of Array.isArray(record.characterChanges ?? record.character_changes)
    ? ((record.characterChanges ?? record.character_changes) as unknown[])
    : []) {
    const normalized = normalizeCharacterChange(item, at, changeIds);
    if (normalized) characterChanges.push(normalized);
  }
  for (const item of Array.isArray(record.foreshadows) ? record.foreshadows : []) {
    const normalized = normalizeForeshadow(item, at, foreshadowIds);
    if (normalized) foreshadows.push(normalized);
  }
  for (const item of Array.isArray(record.timeline) ? record.timeline : []) {
    const normalized = normalizeTimeline(item, at, timelineIds);
    if (normalized) timeline.push(normalized);
  }
  for (const item of Array.isArray(record.items) ? record.items : []) {
    const normalized = normalizeItem(item, at, itemIds);
    if (normalized) items.push(normalized);
  }
  const registryIds = new Set<string>();
  for (const item of Array.isArray(record.itemRegistry ?? record.item_registry)
    ? ((record.itemRegistry ?? record.item_registry) as unknown[])
    : []) {
    const normalized = normalizePlanItem(item);
    if (!normalized) continue;
    let id = normalized.id;
    let suffix = 2;
    while (registryIds.has(id)) {
      id = `${normalized.id}-${suffix}`;
      suffix += 1;
    }
    registryIds.add(id);
    itemRegistry.push({ ...normalized, id });
  }
  for (const item of Array.isArray(record.relations) ? record.relations : []) {
    const normalized = normalizePlanRelation(item, at, relationIds);
    if (normalized) relations.push(normalized);
  }
  for (const item of Array.isArray(record.deviations) ? record.deviations : []) {
    const normalized = normalizeDeviation(item);
    if (normalized) {
      const unique = uniqueId(normalized.id, deviationIds);
      deviations.push({ ...normalized, id: unique });
    }
  }

  return {
    version: positiveInt(record.version, PLAN_LEDGER_VERSION),
    events,
    characterChanges,
    foreshadows,
    timeline,
    items,
    itemRegistry,
    relations,
    deviations,
    completedChapter: positiveInt(
      record.completedChapter ?? record.completed_chapter,
    ),
    completedAt: text(record.completedAt ?? record.completed_at),
    updatedAt: at,
  };
}

// 模型返回的计划只能作为未来计划入库：不允许它自报 realized 或实际章节。
export function sanitizeGeneratedPlanLedger(input: unknown, updatedAt = nowIso()): PlanLedger {
  const ledger = normalizePlanLedger(input, updatedAt);
  const reset = <T extends { status: PlanStatus; evidence: string }>(item: T): T => ({
    ...item,
    status: "planned" as const,
    evidence: "",
  });
  return {
    ...ledger,
    events: ledger.events.map((item) => ({
      ...reset(item),
      actualChapter: 0,
      actualEventIds: [],
    })),
    characterChanges: ledger.characterChanges.map((item) => ({
      ...reset(item),
      actualChapter: 0,
    })),
    foreshadows: ledger.foreshadows.map((item) => ({
      ...reset(item),
      actualPlantChapter: 0,
      actualResolveChapter: 0,
    })),
    timeline: ledger.timeline.map((item) => ({
      ...reset(item),
      actualChapter: 0,
    })),
    items: ledger.items.map((item) => ({
      ...reset(item),
      actualChapter: 0,
    })),
    relations: ledger.relations.map((item) => ({
      ...reset(item),
      actualChapter: 0,
    })),
    itemRegistry: ledger.itemRegistry.map((item) => ({ ...item })),
    deviations: [],
    completedChapter: 0,
    completedAt: "",
  };
}

export function assertValidPlanLedger(
  ledger: PlanLedger,
  plan?: ProjectPlan,
  characters?: Character[],
): void {
  const maxChapter = plan?.chapters.length
    ? Math.max(...plan.chapters.map((chapter) => chapter.index))
    : Number.POSITIVE_INFINITY;
  const checkChapter = (chapter: number, label: string, allowZero = false) => {
    if (allowZero && chapter === 0) return;
    if (!Number.isInteger(chapter) || chapter < 1) {
      throw new Error(`计划台账${label}的章节号不合法：${chapter}`);
    }
    if (Number.isFinite(maxChapter) && chapter > maxChapter) {
      throw new Error(`计划台账${label}指向不存在的第 ${chapter} 章（当前大纲共 ${maxChapter} 章）`);
    }
  };

  const eventIds = new Set<string>();
  for (const event of ledger.events) {
    if (eventIds.has(event.id)) throw new Error(`计划台账事件 ID 重复：${event.id}`);
    eventIds.add(event.id);
    checkChapter(event.chapter, `事件「${event.name}」`);
    if (event.relatedEventIds.some((id) => !ledger.events.some((item) => item.id === id))) {
      throw new Error(`计划事件「${event.name}」引用了不存在的事件 ID`);
    }
  }

  const changeIds = new Set<string>();
  for (const change of ledger.characterChanges) {
    if (changeIds.has(change.id)) throw new Error(`计划人物变化 ID 重复：${change.id}`);
    changeIds.add(change.id);
    checkChapter(change.chapter, `人物变化「${change.character}」`);
  }

  const foreshadowIds = new Set<string>();
  for (const item of ledger.foreshadows) {
    if (foreshadowIds.has(item.id)) throw new Error(`计划伏笔 ID 重复：${item.id}`);
    foreshadowIds.add(item.id);
    checkChapter(item.plantChapter, `伏笔「${item.text}」埋设`);
    if (item.resolveChapter) {
      checkChapter(item.resolveChapter, `伏笔「${item.text}」回收`);
      if (item.resolveChapter < item.plantChapter) {
        throw new Error(`计划伏笔「${item.text}」的回收章节早于埋设章节`);
      }
    }
  }

  const timelineIds = new Set<string>();
  for (const item of ledger.timeline) {
    if (timelineIds.has(item.id)) throw new Error(`计划时间线 ID 重复：${item.id}`);
    timelineIds.add(item.id);
    checkChapter(item.chapter, `时间线「${item.time || item.sequence}」`);
  }

  const itemIds = new Set<string>();
  for (const item of ledger.items) {
    if (itemIds.has(item.id)) throw new Error(`计划物品变化 ID 重复：${item.id}`);
    itemIds.add(item.id);
    checkChapter(item.chapter, `物品「${item.item}」`);
  }

  const registryNames = new Set(
    ledger.itemRegistry
      .flatMap((item) => [item.name, ...item.aliases])
      .map(normalizeKey)
      .filter(Boolean),
  );
  const registryIds = new Set<string>();
  for (const item of ledger.itemRegistry) {
    if (registryIds.has(item.id)) throw new Error(`物品基线 ID 重复：${item.id}`);
    registryIds.add(item.id);
    if (item.introducedChapter) {
      checkChapter(item.introducedChapter, `物品基线「${item.name}」`);
    }
  }
  if (registryNames.size) {
    for (const item of ledger.items) {
      if (!registryNames.has(normalizeKey(item.item))) {
        throw new Error(
          `计划物品变化引用了未登记在物品基线中的物品：${item.item}`,
        );
      }
    }
  }

  const nameKeys = characters?.length
    ? new Set(characters.map((item) => normalizeKey(item.name)).filter(Boolean))
    : null;
  const relationIds = new Set<string>();
  for (const relation of ledger.relations) {
    if (relationIds.has(relation.id)) {
      throw new Error(`计划关系 ID 重复：${relation.id}`);
    }
    relationIds.add(relation.id);
    if (normalizeKey(relation.from) === normalizeKey(relation.to)) {
      throw new Error(`计划关系不能指向同一角色：${relation.from}`);
    }
    if (
      !Number.isInteger(relation.strength) ||
      relation.strength < 1 ||
      relation.strength > 5
    ) {
      throw new Error(`计划关系「${relation.from}—${relation.to}」的强度必须在 1-5`);
    }
    if (relation.direction !== "one-way" && relation.direction !== "two-way") {
      throw new Error(`计划关系「${relation.from}—${relation.to}」方向不合法`);
    }
    checkChapter(relation.startChapter, `关系「${relation.from}—${relation.to}」起点`);
    if (relation.endChapter) {
      checkChapter(relation.endChapter, `关系「${relation.from}—${relation.to}」终点`);
      if (relation.endChapter < relation.startChapter) {
        throw new Error(`计划关系「${relation.from}—${relation.to}」终点早于起点`);
      }
    }
    if (nameKeys) {
      for (const name of [relation.from, relation.to]) {
        if (!nameKeys.has(normalizeKey(name))) {
          throw new Error(`计划关系引用了不存在的人物：${name}`);
        }
      }
    }
    if (relation.changeEventIds.some((id) => !eventIds.has(id))) {
      throw new Error(`计划关系「${relation.from}—${relation.to}」引用了不存在的计划事件`);
    }
  }

  for (const deviation of ledger.deviations) {
    checkChapter(deviation.chapter, `计划偏离「${deviation.planId}」`);
  }
  if (ledger.completedChapter) {
    checkChapter(ledger.completedChapter, "完结章");
  }
}

// 旧项目没有计划台账文件：把章节细纲和大纲伏笔迁移为 planned 记录。
// 这里只生成“计划”，不会写入任何 actualChapter 或证据。
export function derivePlanLedger(
  plan: ProjectPlan,
  outlineMd: string,
  updatedAt = nowIso(),
): PlanLedger {
  const events: PlanEvent[] = plan.chapters.map((chapter) => ({
    id: stableId("plan-event", `${chapter.index}:${chapter.title}`),
    name: chapter.title,
    chapter: chapter.index,
    thread: "",
    participants: [],
    premise: "",
    process: chapter.summary,
    expectedResult: "",
    impact: chapter.keyBeats.join("；"),
    relatedEventIds: [],
    importance: chapter.index === plan.chapters[0]?.index ? "core" : "minor",
    status: "planned",
    actualChapter: 0,
    actualEventIds: [],
    evidence: "",
    note: "由旧版章节细纲迁移，等待正文确认。",
    updatedAt,
  }));

  const used = new Set<string>();
  const foreshadows: PlanForeshadow[] = parseOutlineForeshadows(outlineMd).map((item) => ({
    id: uniqueId(
      stableId("plan-foreshadow", `${item.plantedChapter}:${item.text}`),
      used,
    ),
    text: item.text,
    plantChapter: item.plantedChapter,
    resolveChapter: item.resolvedChapter,
    purpose: "",
    eventIds: [],
    resolveCondition: "",
    status: "planned",
    actualPlantChapter: 0,
    actualResolveChapter: 0,
    evidence: "",
    updatedAt,
  }));

  return {
    version: PLAN_LEDGER_VERSION,
    events,
    characterChanges: [],
    foreshadows,
    timeline: [],
    items: [],
    itemRegistry: [],
    relations: [],
    deviations: [],
    completedChapter: 0,
    completedAt: "",
    updatedAt,
  };
}

export function planEntriesForChapters(
  chapters: ChapterPlan[],
  updatedAt = nowIso(),
): PlanEvent[] {
  return chapters.map((chapter) => ({
    id: stableId("plan-event", `${chapter.index}:${chapter.title}`),
    name: chapter.title,
    chapter: chapter.index,
    thread: "",
    participants: [],
    premise: "",
    process: chapter.summary,
    expectedResult: "",
    impact: chapter.keyBeats.join("；"),
    relatedEventIds: [],
    importance: "minor",
    status: "planned",
    actualChapter: 0,
    actualEventIds: [],
    evidence: "",
    note: "续排大纲自动登记，等待正文确认。",
    updatedAt,
  }));
}

function planLedgerIds(ledger: PlanLedger): string[] {
  return [
    ...ledger.events,
    ...ledger.characterChanges,
    ...ledger.foreshadows,
    ...ledger.timeline,
    ...ledger.items,
    ...ledger.itemRegistry,
    ...ledger.relations,
  ].map((item) => item.id);
}

// 续排时新增计划如果复用了既有 id，merge 会覆盖原计划；提交前先拦下来。
export function planLedgerIdCollisions(
  base: PlanLedger,
  addition: PlanLedger,
): string[] {
  const existing = new Set(planLedgerIds(base));
  return [...new Set(planLedgerIds(addition))].filter((id) => existing.has(id));
}

export function mergePlanLedgers(base: PlanLedger, addition: PlanLedger): PlanLedger {
  const merge = <T extends { id: string }>(a: T[], b: T[]): T[] => {
    const map = new Map<string, T>();
    for (const item of a) map.set(item.id, item);
    for (const item of b) map.set(item.id, item);
    return [...map.values()];
  };
  return {
    version: PLAN_LEDGER_VERSION,
    events: merge(base.events, addition.events),
    characterChanges: merge(base.characterChanges, addition.characterChanges),
    foreshadows: merge(base.foreshadows, addition.foreshadows),
    timeline: merge(base.timeline, addition.timeline),
    items: merge(base.items, addition.items),
    itemRegistry: merge(base.itemRegistry, addition.itemRegistry),
    relations: merge(base.relations, addition.relations),
    deviations: merge(base.deviations, addition.deviations),
    completedChapter: addition.completedChapter || base.completedChapter,
    completedAt: addition.completedAt || base.completedAt,
    updatedAt: nowIso(),
  };
}

export function activePlanStatus(status: PlanStatus): boolean {
  return status !== "cancelled" && status !== "realized";
}

const STATUS_LABELS: Record<PlanStatus, string> = {
  planned: "未执行",
  partially_realized: "部分实现",
  realized: "已确认实现",
  deviated: "已偏离计划",
  cancelled: "已取消",
};

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}……` : text;
}

export function formatPlanContext(
  ledger: PlanLedger | undefined,
  chapter: ChapterPlan,
  options: { budget?: number } = {},
): string {
  if (!ledger) return "";
  const target = chapter.index;
  const lines: string[] = [];

  const events = ledger.events.filter(
    (item) => item.chapter === target && activePlanStatus(item.status),
  );
  for (const item of events) {
    const parts = [`第 ${item.chapter} 章`, STATUS_LABELS[item.status]];
    if (item.thread) parts.push(`线：${clip(item.thread, 40)}`);
    if (item.participants.length) parts.push(`参与：${item.participants.join("、")}`);
    if (item.premise) parts.push(`前提：${clip(item.premise, 120)}`);
    if (item.process) parts.push(`经过：${clip(item.process, 220)}`);
    if (item.expectedResult) parts.push(`预期结果：${clip(item.expectedResult, 160)}`);
    if (item.impact) parts.push(`影响：${clip(item.impact, 120)}`);
    lines.push(`- 《${item.name}》（${parts.join("；")}）`);
  }

  const changes = ledger.characterChanges.filter(
    (item) => item.chapter === target && activePlanStatus(item.status),
  );
  for (const item of changes) {
    lines.push(
      `- ${item.character}：${item.before || "?"} → ${item.after || "?"}（${STATUS_LABELS[item.status]}；原因：${clip(item.reason, 100) || "未注明"}）`,
    );
  }

  const foreshadows = ledger.foreshadows.filter(
    (item) =>
      (item.plantChapter === target || item.resolveChapter === target) &&
      activePlanStatus(item.status),
  );
  for (const item of foreshadows) {
    const action =
      item.plantChapter === target && item.resolveChapter === target
        ? "计划埋设并回收"
        : item.plantChapter === target
          ? "计划埋设"
          : "计划回收";
    lines.push(`- ${action}：${clip(item.text, 200)}（${STATUS_LABELS[item.status]}）`);
  }

  const timeline = ledger.timeline.filter(
    (item) => item.chapter === target && activePlanStatus(item.status),
  );
  for (const item of timeline) {
    const parts = [item.time, item.sequence, item.constraints].filter(Boolean);
    lines.push(`- 时间线计划：${clip(parts.join("；"), 200)}`);
  }

  const items = ledger.items.filter(
    (item) => item.chapter === target && activePlanStatus(item.status),
  );
  for (const item of items) {
    const parts = [
      item.holder ? `持有人：${item.holder}` : "",
      item.location ? `位置：${item.location}` : "",
      item.state ? `状态：${item.state}` : "",
      item.reason ? `原因：${clip(item.reason, 80)}` : "",
      item.stateChange ? `变化：${clip(item.stateChange, 80)}` : "",
    ].filter(Boolean);
    lines.push(`- 物品变化：${item.item} → ${parts.join("；") || "未注明"}`);
  }

  const relations = relationsAt(ledger, target);
  for (const relation of relations) {
    const direction = relation.direction === "one-way" ? "单向" : "双向";
    const range = relation.endChapter
      ? `第 ${relation.startChapter}-${relation.endChapter} 章`
      : `第 ${relation.startChapter} 章起`;
    lines.push(
      `- 关系：${relation.from} → ${relation.to}，${relation.type}（强度 ${relation.strength}/5，${direction}，${range}${relation.evidence ? `；已确认：${clip(relation.evidence, 60)}` : ""}）`,
    );
  }

  const ownership = itemOwnershipAt(ledger, target);
  if (ownership.length) {
    lines.push(`- 第 ${target} 章物品归属快照：`);
    for (const snapshot of ownership) {
      const parts = [
        snapshot.holder ? `持有人：${snapshot.holder}` : "",
        snapshot.location ? `位置：${snapshot.location}` : "",
        snapshot.state ? `状态：${snapshot.state}` : "",
      ].filter(Boolean);
      lines.push(
        `  · ${snapshot.item} → ${parts.join("；") || "未记录"}${
          snapshot.changedChapter
            ? `（最近变更：第 ${snapshot.changedChapter} 章${snapshot.reason ? `，${clip(snapshot.reason, 60)}` : ""}）`
            : ""
        }`,
      );
    }
  }

  const budget = options.budget ?? 2400;
  const body = lines.join("\n");
  return body.length > budget ? `${body.slice(0, budget)}\n……（计划台账已截断）` : body;
}

// 本章正文如果已经写出了后面章节的计划事件，说明模型把后续剧情提前消费了。
// 这是结构性错误，不能当成普通的“计划偏离”，否则后续章节会全部失去依据。
export function detectFuturePlanConsumption(
  ledger: PlanLedger | undefined,
  chapter: number,
  extracted: ExtractedStory | undefined,
  memory?: ChapterMemory,
): ContinuityIssue[] {
  if (!ledger) return [];
  const actualTexts = [
    memory?.summary ?? "",
    ...(memory?.events ?? []),
    ...(memory?.actions ?? []),
    ...(extracted?.events ?? []).map((event) =>
      [event.name, event.process, event.result, event.impact]
        .filter(Boolean)
        .join("\n"),
    ),
  ]
    .map((text) => text.trim())
    .filter(Boolean);
  if (!actualTexts.length) return [];
  const actual = actualTexts.join("\n");
  const issues: ContinuityIssue[] = [];
  const GENERIC_NAMES = new Set([
    "示例章节",
    "示例",
    "章节",
    "测试",
    "剧情",
    "事件",
    "故事",
    "推进",
  ]);
  for (const event of ledger.events) {
    if (event.chapter <= chapter || event.status === "cancelled") continue;
    const target = [event.name, event.process, event.expectedResult]
      .filter(Boolean)
      .join("\n");
    if (!target.trim()) continue;
    const nameTokens = event.name
      .split(/[^一-鿿]+/u)
      .map((token) => token.trim())
      .filter(
        (token) =>
          token.length >= 2 &&
          !GENERIC_NAMES.has(token) &&
          !/^(示例|测试)/u.test(token) &&
          !/^第.+章$/u.test(token),
      );
    const names = event.participants.filter((name) => name.trim().length >= 2);
    const sharesCharacter = names.some((name) => actual.includes(name));
    const sharesName = nameTokens.some((token) => actual.includes(token));
    // 没有角色名、也没有有效事件名命中的通用文本，不进入提前消费判断。
    if (!sharesCharacter && !sharesName) continue;
    let best = { score: 0, text: "" };
    for (const text of actualTexts) {
      const score = textSimilarity(target, text);
      if (score > best.score) best = { score, text };
    }
    const threshold = sharesCharacter ? 0.35 : 0.5;
    if (best.score < threshold) continue;
    issues.push({
      severity: "critical",
      type: "提前消费后续章节",
      evidence: clip(best.text, 160),
      detail: `本章写出了计划第 ${event.chapter} 章的事件《${event.name}》。每章只能写本章细纲范围，后续章节的计划事件、人物变化、伏笔和物品转移不得提前实现。`,
      sourceChapter: event.chapter,
      conflictCategory: "causality",
    });
    if (issues.length >= 3) break;
  }
  return issues;
}

function normalizeKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\s，。！？；：、,.!?;:"'“”‘’（）()《》〈〉【】\[\]…—\-]/gu, "");
}

function bigrams(value: string): Set<string> {
  const normalized = normalizeKey(value);
  const grams = new Set<string>();
  if (normalized.length <= 2) {
    if (normalized) grams.add(normalized);
    return grams;
  }
  for (let i = 0; i + 1 < normalized.length; i += 1) {
    grams.add(normalized.slice(i, i + 2));
  }
  return grams;
}

export function textSimilarity(a: string, b: string): number {
  const left = bigrams(a);
  const right = bigrams(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const gram of left) {
    if (right.has(gram)) shared += 1;
  }
  return shared / Math.max(left.size, right.size);
}

function samePlanText(a: string, b: string): boolean {
  const left = normalizeKey(a);
  const right = normalizeKey(b);
  if (!left || !right) return false;
  return left === right || (left.length >= 4 && right.includes(left)) || (right.length >= 4 && left.includes(right));
}

interface ActualEvent {
  id: string;
  name: string;
  text: string;
}

export interface PlanReconciliationInput {
  ledger: PlanLedger;
  chapter: number;
  chapterMemory?: ChapterMemory;
  extracted?: ExtractedStory;
  storyEvents?: PlotEvent[];
  canon: CanonFacts;
}

export interface PlanReconciliationResult {
  ledger: PlanLedger;
  changes: string[];
}

function markDeviation(
  ledger: PlanLedger,
  planType: PlanDeviation["planType"],
  planId: string,
  chapter: number,
  expected: string,
  actual: string,
  reason: string,
): void {
  const existing = ledger.deviations.find(
    (item) => item.planId === planId && item.chapter === chapter,
  );
  if (existing) return;
  ledger.deviations.push({
    id: stableId("plan-deviation", `${planId}:${chapter}`),
    planType,
    planId,
    chapter,
    expected,
    actual,
    reason,
    at: nowIso(),
  });
}

function actualEventUnits(
  chapter: number,
  memory: ChapterMemory | undefined,
  extracted: ExtractedStory | undefined,
  storyEvents: PlotEvent[] | undefined,
): ActualEvent[] {
  const units: ActualEvent[] = [];
  if (storyEvents?.length) {
    for (const event of storyEvents.filter((item) => item.chapter === chapter)) {
      units.push({
        id: event.id,
        name: event.name,
        text: [event.name, event.process, event.result, event.impact, event.location]
          .filter(Boolean)
          .join("\n"),
      });
    }
  }
  for (const event of extracted?.events ?? []) {
    units.push({
      id: "",
      name: event.name,
      text: [event.name, event.process, event.result, event.impact, event.location]
        .filter(Boolean)
        .join("\n"),
    });
  }
  // 章节摘要也是正文抽取结果的一部分：即使模型给事件起了别的名字，
  // 计划事件仍应能在摘要/关键动作里找到对应证据。
  if (memory) {
    units.push({
      id: "",
      name: memory.summary,
      text: [
        memory.summary,
        ...memory.events,
        ...memory.actions,
        ...memory.newSettings,
        memory.endingState,
      ]
        .filter(Boolean)
        .join("\n"),
    });
  }
  return units;
}

export function reconcileChapterPlan(input: PlanReconciliationInput): PlanReconciliationResult {
  const ledger = normalizePlanLedger(input.ledger);
  const at = nowIso();
  const changes: string[] = [];
  const chapter = input.chapter;
  const memory = input.chapterMemory;
  const actualUnits = actualEventUnits(chapter, memory, input.extracted, input.storyEvents);
  const actualText = actualUnits.map((item) => item.text).join("\n");
  const memoryText = memory
    ? [
        memory.summary,
        ...memory.events,
        ...memory.actions,
        ...memory.newSettings,
        memory.endingState,
        ...memory.foreshadowsPlanted,
        ...memory.foreshadowsResolved,
      ]
        .filter(Boolean)
        .join("\n")
    : "";

  for (const event of ledger.events) {
    if (event.chapter !== chapter || event.status === "cancelled") continue;
    if (event.status === "realized") continue;
    const target = [event.name, event.process, event.expectedResult].filter(Boolean).join("\n");
    let best: ActualEvent | null = null;
    let bestScore = 0;
    for (const unit of actualUnits) {
      const score = textSimilarity(target, unit.text);
      if (score > bestScore) {
        best = unit;
        bestScore = score;
      }
    }
    if (best && bestScore >= 0.28) {
      event.status = "realized";
      event.actualChapter = chapter;
      event.actualEventIds = best.id ? [best.id] : [];
      event.evidence = clip(best.text, 400);
      event.updatedAt = at;
      changes.push(`计划事件《${event.name}》已在第 ${chapter} 章正文中找到证据`);
      continue;
    }
    if (best && bestScore >= 0.12) {
      event.status = "partially_realized";
      event.actualChapter = chapter;
      event.actualEventIds = best.id ? [best.id] : [];
      event.evidence = clip(best.text, 400);
      event.updatedAt = at;
      changes.push(`计划事件《${event.name}》只部分出现在第 ${chapter} 章`);
      continue;
    }
    event.status = "deviated";
    event.actualChapter = chapter;
    event.evidence = "";
    event.updatedAt = at;
    markDeviation(
      ledger,
      "event",
      event.id,
      chapter,
      [event.name, event.process].filter(Boolean).join("："),
      clip(memoryText, 300) || "正文未检测到对应事件",
      "正文实际发展未落实该计划事件",
    );
    changes.push(`计划事件《${event.name}》未在正文中落实，标记偏离`);
  }

  for (const change of ledger.characterChanges) {
    if (change.chapter !== chapter || change.status === "cancelled") continue;
    if (change.status === "realized") continue;
    const canonCharacter = input.canon.characters.find(
      (item) =>
        normalizeKey(item.name) === normalizeKey(change.character) ||
        item.aliases.some((alias) => normalizeKey(alias) === normalizeKey(change.character)),
    );
    const extractedState = input.extracted?.states.find(
      (item) => normalizeKey(item.name) === normalizeKey(change.character),
    );
    const actualFields = canonCharacter
      ? [
          canonCharacter.status === "dead" ? "死亡" : canonCharacter.status === "alive" ? "存活" : "",
          canonCharacter.location,
          canonCharacter.note,
        ]
      : [];
    if (extractedState) {
      actualFields.push(
        extractedState.lifeStatus === "dead" ? "死亡" : extractedState.lifeStatus === "alive" ? "存活" : "",
        extractedState.identity,
        extractedState.location,
        extractedState.bodyState,
        extractedState.experience,
        extractedState.evidence,
      );
    }
    const actual = actualFields.filter(Boolean).join("；");
    const score = textSimilarity(change.after, actual);
    let matched = score >= 0.25;
    if (change.after.includes("死")) matched = Boolean(canonCharacter?.status === "dead" || extractedState?.lifeStatus === "dead");
    else if (change.after.includes("活") || change.after.includes("生还")) {
      matched = Boolean(canonCharacter?.status === "alive" || extractedState?.lifeStatus === "alive");
    }
    if (matched) {
      change.status = "realized";
      change.actualChapter = chapter;
      change.evidence = clip(actual, 400);
      change.updatedAt = at;
      changes.push(`计划人物变化「${change.character}」已由正文确认`);
      continue;
    }
    if (score >= 0.1 || actual.includes(change.after)) {
      change.status = "partially_realized";
      change.actualChapter = chapter;
      change.evidence = clip(actual, 400);
      change.updatedAt = at;
      changes.push(`计划人物变化「${change.character}」只部分实现`);
      continue;
    }
    change.status = "deviated";
    change.actualChapter = chapter;
    change.evidence = clip(actual, 400);
    change.updatedAt = at;
    markDeviation(
      ledger,
      "character-change",
      change.id,
      chapter,
      `${change.character}：${change.before} → ${change.after}`,
      clip(actual, 300) || "正文未检测到对应变化",
      "正文中的实际人物状态与计划不一致",
    );
    changes.push(`计划人物变化「${change.character}」未落实，标记偏离`);
  }

  const planted = memory?.foreshadowsPlanted ?? [];
  const resolved = memory?.foreshadowsResolved ?? [];
  for (const item of ledger.foreshadows) {
    if (item.status === "cancelled") continue;
    if (item.plantChapter === chapter && !item.actualPlantChapter) {
      const match = planted.find((candidate) => samePlanText(candidate, item.text));
      if (match) {
        item.actualPlantChapter = chapter;
        item.evidence = clip(match, 400);
        item.updatedAt = at;
        changes.push(`计划伏笔「${item.text}」已由第 ${chapter} 章正文确认埋设`);
      } else if (chapter >= item.plantChapter) {
        item.status = "deviated";
        item.updatedAt = at;
        markDeviation(
          ledger,
          "foreshadow",
          item.id,
          chapter,
          `计划第 ${item.plantChapter} 章埋设：${item.text}`,
          "第 " + chapter + " 章正文未检测到该伏笔",
          "正文没有出现计划中的伏笔线索",
        );
        changes.push(`计划伏笔「${item.text}」未在正文埋设，未写入实际剧情台账`);
        continue;
      }
    }
    if (item.resolveChapter === chapter && !item.actualResolveChapter) {
      const match = resolved.find((candidate) => samePlanText(candidate, item.text));
      if (match && item.actualPlantChapter) {
        item.actualResolveChapter = chapter;
        item.status = "realized";
        item.evidence = clip(match, 400);
        item.updatedAt = at;
        changes.push(`计划伏笔「${item.text}」已由第 ${chapter} 章正文确认回收`);
      } else if (!match) {
        if (item.actualPlantChapter) item.status = "partially_realized";
        item.updatedAt = at;
        markDeviation(
          ledger,
          "foreshadow",
          item.id,
          chapter,
          `计划第 ${item.resolveChapter} 章回收：${item.text}`,
          "第 " + chapter + " 章正文未检测到回收证据",
          "不能仅因到达计划回收章节就标记已回收",
        );
        changes.push(`计划伏笔「${item.text}」缺少回收证据，保持未回收`);
      }
    }
    if (
      item.actualPlantChapter &&
      item.status !== "realized" &&
      item.status !== "deviated"
    ) {
      item.status = "partially_realized";
      item.updatedAt = at;
    }
  }

  if (memory?.time) {
    for (const item of ledger.timeline) {
      if (item.chapter !== chapter || item.status === "cancelled") continue;
      const target = [item.time, item.sequence].filter(Boolean).join("；");
      const score = textSimilarity(target, memory.time);
      if (score >= 0.2 || (item.time && memory.time.includes(item.time))) {
        item.status = "realized";
        item.actualChapter = chapter;
        item.evidence = clip(memory.time, 300);
        item.updatedAt = at;
      } else if (item.time) {
        item.status = "deviated";
        item.actualChapter = chapter;
        item.evidence = "";
        item.updatedAt = at;
        markDeviation(
          ledger,
          "timeline",
          item.id,
          chapter,
          target,
          clip(memory.time, 200),
          "正文时间与计划时间不一致",
        );
      }
    }
  }

  for (const item of ledger.items) {
    if (item.chapter !== chapter || item.status === "cancelled") continue;
    if (item.status === "realized") continue;
    const actual = input.canon.items.find(
      (entry) =>
        normalizeKey(entry.name) === normalizeKey(item.item) ||
        entry.aliases.some((alias) => normalizeKey(alias) === normalizeKey(item.item)),
    );
    if (!actual) {
      item.status = "deviated";
      item.actualChapter = chapter;
      item.updatedAt = at;
      markDeviation(
        ledger,
        "item",
        item.id,
        chapter,
        `${item.item}：${item.holder} / ${item.stateChange}`,
        "正文未检测到该物品事实",
        "计划中的物品变化没有正文依据",
      );
      continue;
    }
    const plannedState = item.state || item.stateChange;
    const matchesHolder =
      !item.holder ||
      textSimilarity(item.holder, actual.holder) >= 0.2 ||
      actual.holder.includes(item.holder);
    const matchesLocation =
      !item.location ||
      textSimilarity(item.location, actual.location ?? "") >= 0.2 ||
      (actual.location ?? "").includes(item.location);
    const matchesState =
      !plannedState ||
      textSimilarity(plannedState, actual.state) >= 0.2 ||
      actual.state.includes(plannedState);
    const matched = [matchesHolder, matchesLocation, matchesState].filter(Boolean).length;
    const required = [item.holder, item.location, plannedState].filter(Boolean).length;
    const actualText = clip(
      [actual.holder, actual.location, actual.state, actual.note].filter(Boolean).join("；"),
      300,
    );
    if (required === 0 || matched === required) {
      item.status = "realized";
      item.actualChapter = chapter;
      item.evidence = actualText;
      item.updatedAt = at;
    } else if (matched > 0) {
      item.status = "partially_realized";
      item.actualChapter = chapter;
      item.evidence = actualText;
      item.updatedAt = at;
    } else {
      item.status = "deviated";
      item.actualChapter = chapter;
      item.evidence = actualText;
      item.updatedAt = at;
      markDeviation(
        ledger,
        "item",
        item.id,
        chapter,
        `${item.item}：${item.holder} / ${item.location} / ${plannedState}`,
        `${actual.holder} / ${actual.location ?? ""} / ${actual.state}`,
        "正文中的物品归属、位置或状态与计划不一致",
      );
    }
  }

  const extractedRelations = input.extracted?.relations ?? [];
  for (const relation of ledger.relations) {
    if (relation.status === "cancelled") continue;
    const active =
      relation.startChapter <= chapter &&
      (relation.endChapter === 0 || chapter <= relation.endChapter);
    if (!active) continue;
    const pairMatch = extractedRelations.find(
      (item) =>
        (normalizeKey(item.from) === normalizeKey(relation.from) &&
          normalizeKey(item.to) === normalizeKey(relation.to)) ||
        (normalizeKey(item.from) === normalizeKey(relation.to) &&
          normalizeKey(item.to) === normalizeKey(relation.from)),
    );
    if (pairMatch) {
      relation.actualChapter = chapter;
      relation.evidence = clip(
        pairMatch.evidence || `${pairMatch.from}→${pairMatch.to}：${pairMatch.type}`,
        300,
      );
      if (relation.status === "planned") relation.status = "partially_realized";
      relation.updatedAt = at;
      continue;
    }
    const eventChanged = relation.changeEventIds.some((id) =>
      ledger.events.some(
        (event) =>
          event.id === id &&
          event.status === "realized" &&
          event.actualChapter === chapter,
      ),
    );
    if (relation.startChapter === chapter && eventChanged) {
      relation.status = "deviated";
      relation.actualChapter = chapter;
      relation.updatedAt = at;
      markDeviation(
        ledger,
        "relation",
        relation.id,
        chapter,
        `${relation.from}—${relation.to}：${relation.type}`,
        "正文未检出对应关系变化",
        "计划中的关系变化在正文中没有落实",
      );
    }
  }

  ledger.updatedAt = at;
  return { ledger: normalizePlanLedger(ledger), changes };
}
