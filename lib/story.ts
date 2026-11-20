import { canonForChapter } from "./canon";
import { buildEffectiveMemory, estimateTokens } from "./memory";
import { nowIso } from "./utils";
import type {
  CanonCharacterStatus,
  ChapterMemory,
  ChapterPlan,
  Character,
  CharacterRelation,
  CharacterState,
  ExtractedStory,
  ForeshadowRecord,
  ForeshadowStatus,
  PlotEvent,
  ProjectDetail,
  ProjectMemory,
  StoryCheckIssue,
  StoryLedger,
  StoryRetrievalResult,
  StorySource,
  StoryStatsView,
} from "./types";

export const STORY_CHAR_BUDGET = 3200;
const MAX_STATES = 1200;
const MAX_RELATIONS = 600;
const MAX_EVENTS = 1200;
const MAX_FORESHADOWS = 400;
const MAX_CONTEXT_EVENTS = 6;
const MAX_CONTEXT_STATES = 14;
const RECENT_MEMORY_WINDOW = 6;

const STOPWORDS = new Set([
  "一个",
  "一种",
  "这个",
  "那个",
  "自己",
  "什么",
  "怎么",
  "已经",
  "没有",
  "不是",
  "就是",
  "还是",
  "但是",
  "因为",
  "所以",
  "然后",
  "而且",
  "以及",
  "如果",
  "虽然",
  "可以",
  "可能",
  "需要",
  "必须",
  "他们",
  "她们",
  "我们",
  "你们",
  "此时",
  "这时",
  "本章",
  "正文",
  "剧情",
  "事件",
  "人物",
  "之后",
  "之前",
  "同时",
  "其中",
  "发现",
  "知道",
  "看到",
  "决定",
  "准备",
  "终于",
  "突然",
  "仍然",
  "只是",
  "这里",
  "那里",
  "众人",
]);

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function arr(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}……` : trimmed;
}

function normalizeKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s，,。；;：:、！!？?（）()【】[\]《》“”"'‘’·…—_-]+/gu, "");
}

function uniqueStrings(values: string[], exclude = ""): string[] {
  const excluded = normalizeKey(exclude);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    const key = normalizeKey(value);
    if (!key || key === excluded || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function boundedStrings(value: unknown, max: number): string[] {
  return uniqueStrings(arr(value)).map((item) => clip(item, 300)).slice(0, max);
}

function positiveInt(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function hashText(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

export function storyStateId(name: string, chapter: number): string {
  return `state-${chapter}-${hashText(normalizeKey(name))}`;
}

export function storyRelationId(from: string, to: string, chapter: number): string {
  return `rel-${chapter}-${hashText(`${normalizeKey(from)}>${normalizeKey(to)}`)}`;
}

export function storyForeshadowId(text: string, plantedChapter: number): string {
  return `fs-${plantedChapter}-${hashText(normalizeKey(text))}`;
}

function normalizeSource(value: unknown): StorySource {
  return value === "ai" || value === "manual" ? value : "summary";
}

function normalizeLifeStatus(value: unknown): CanonCharacterStatus {
  const text = str(value).trim().toLowerCase();
  if (["alive", "存活", "活着", "生还"].includes(text)) return "alive";
  if (["dead", "死亡", "已死", "身亡"].includes(text)) return "dead";
  return "unknown";
}

function normalizeForeshadowStatus(value: unknown): ForeshadowStatus {
  const text = str(value).trim().toLowerCase();
  if (["planted", "已埋设", "埋设"].includes(text)) return "planted";
  if (["developing", "发展中"].includes(text)) return "developing";
  if (["pending", "待回收"].includes(text)) return "pending";
  if (["resolved", "已回收", "回收"].includes(text)) return "resolved";
  if (["abandoned", "已废弃", "废弃"].includes(text)) return "abandoned";
  return "pending";
}

export function emptyStory(updatedAt = nowIso()): StoryLedger {
  return {
    version: 1,
    states: [],
    relations: [],
    events: [],
    foreshadows: [],
    suppressedIds: [],
    updatedAt,
  };
}

export function normalizeCharacterState(
  input: unknown,
  fallbackChapter = 0,
): CharacterState | null {
  const record = (input ?? {}) as Record<string, unknown>;
  const name = str(record.name).trim();
  const chapter = positiveInt(record.chapter ?? record.chapterIndex ?? record.chapter_index, fallbackChapter);
  if (!name || !chapter) return null;
  return {
    id: str(record.id).trim() || storyStateId(name, chapter),
    name,
    chapter,
    identity: clip(str(record.identity), 200),
    age: clip(str(record.age), 80),
    location: clip(str(record.location), 200),
    bodyState: clip(str(record.bodyState ?? record.body_state), 400),
    lifeStatus: normalizeLifeStatus(record.lifeStatus ?? record.life_status ?? record.status),
    abilities: boundedStrings(record.abilities, 20),
    goals: boundedStrings(record.goals, 20),
    knowledge: boundedStrings(record.knowledge, 30),
    faction: clip(str(record.faction), 120),
    experience: clip(str(record.experience), 1000),
    eventIds: boundedStrings(record.eventIds ?? record.event_ids, 40),
    source: normalizeSource(record.source),
    updatedAt: str(record.updatedAt ?? record.updated_at, nowIso()),
  };
}

export function normalizeCharacterRelation(
  input: unknown,
  fallbackChapter = 0,
): CharacterRelation | null {
  const record = (input ?? {}) as Record<string, unknown>;
  const from = str(record.from).trim();
  const to = str(record.to).trim();
  const chapter = positiveInt(record.chapter ?? record.chapterIndex ?? record.chapter_index, fallbackChapter);
  if (!from || !to || !chapter || normalizeKey(from) === normalizeKey(to)) return null;
  return {
    id: str(record.id).trim() || storyRelationId(from, to, chapter),
    from,
    to,
    type: clip(str(record.type ?? record.relation), 160),
    status: clip(str(record.status), 300),
    chapter,
    eventIds: boundedStrings(record.eventIds ?? record.event_ids, 20),
    source: normalizeSource(record.source),
    updatedAt: str(record.updatedAt ?? record.updated_at, nowIso()),
  };
}

export function normalizePlotEvent(
  input: unknown,
  fallbackChapter = 0,
  fallbackSequence = 1,
): PlotEvent | null {
  const record = (input ?? {}) as Record<string, unknown>;
  const chapter = positiveInt(record.chapter ?? record.chapterIndex ?? record.chapter_index, fallbackChapter);
  const name = clip(str(record.name), 200) || clip(str(record.process), 200);
  if (!chapter || !name) return null;
  return {
    id: str(record.id).trim() || `evt-${chapter}-${fallbackSequence}`,
    name,
    chapter,
    time: clip(str(record.time), 200),
    location: clip(str(record.location), 200),
    participants: boundedStrings(record.participants, 40),
    cause: clip(str(record.cause), 1000),
    process: clip(str(record.process), 1200),
    result: clip(str(record.result), 1000),
    impact: clip(str(record.impact), 1000),
    relatedEventIds: boundedStrings(record.relatedEventIds ?? record.related_event_ids ?? record.relatedEvents, 30),
    foreshadowIds: boundedStrings(record.foreshadowIds ?? record.foreshadow_ids, 20),
    source: normalizeSource(record.source),
    updatedAt: str(record.updatedAt ?? record.updated_at, nowIso()),
  };
}

export function normalizeForeshadowRecord(input: unknown): ForeshadowRecord | null {
  const record = (input ?? {}) as Record<string, unknown>;
  const text = clip(str(record.text), 500);
  const plantedChapter = positiveInt(record.plantedChapter ?? record.planted_chapter);
  if (!text || !plantedChapter) return null;
  const expectedStart = positiveInt(record.expectedStartChapter ?? record.expected_start_chapter);
  const expectedEnd = positiveInt(record.expectedEndChapter ?? record.expected_end_chapter);
  return {
    id: str(record.id).trim() || storyForeshadowId(text, plantedChapter),
    text,
    plantedChapter,
    relatedCharacters: boundedStrings(
      record.relatedCharacters ?? record.related_characters,
      30,
    ),
    expectedStartChapter: expectedStart,
    expectedEndChapter: Math.max(expectedEnd, expectedStart),
    status: normalizeForeshadowStatus(record.status),
    eventIds: boundedStrings(record.eventIds ?? record.event_ids, 30),
    resolution: clip(str(record.resolution), 1000),
    resolvedChapter: positiveInt(record.resolvedChapter ?? record.resolved_chapter),
    resolutionCandidate: clip(
      str(record.resolutionCandidate ?? record.resolution_candidate),
      500,
    ),
    source: normalizeSource(record.source),
    updatedAt: str(record.updatedAt ?? record.updated_at, nowIso()),
  };
}

export function normalizeStory(input: unknown): StoryLedger {
  const record = (input ?? {}) as Record<string, unknown>;
  const stateByKey = new Map<string, CharacterState>();
  for (const item of Array.isArray(record.states) ? record.states : []) {
    const state = normalizeCharacterState(item);
    if (state) stateByKey.set(state.id, state);
  }
  const states = [...stateByKey.values()]
    .sort((a, b) => a.chapter - b.chapter || a.name.localeCompare(b.name, "zh-CN"))
    .slice(0, MAX_STATES);

  const relationByKey = new Map<string, CharacterRelation>();
  for (const item of Array.isArray(record.relations) ? record.relations : []) {
    const relation = normalizeCharacterRelation(item);
    if (relation) relationByKey.set(relation.id, relation);
  }
  const relations = [...relationByKey.values()]
    .sort((a, b) => a.chapter - b.chapter || a.from.localeCompare(b.from, "zh-CN"))
    .slice(0, MAX_RELATIONS);

  const eventByKey = new Map<string, PlotEvent>();
  for (const item of Array.isArray(record.events) ? record.events : []) {
    const event = normalizePlotEvent(item);
    if (event) eventByKey.set(event.id, event);
  }
  const events = [...eventByKey.values()]
    .sort((a, b) => a.chapter - b.chapter || a.id.localeCompare(b.id))
    .slice(0, MAX_EVENTS);

  const foreshadowByKey = new Map<string, ForeshadowRecord>();
  for (const item of Array.isArray(record.foreshadows) ? record.foreshadows : []) {
    const foreshadow = normalizeForeshadowRecord(item);
    if (foreshadow) foreshadowByKey.set(foreshadow.id, foreshadow);
  }
  const foreshadows = [...foreshadowByKey.values()]
    .sort((a, b) => a.plantedChapter - b.plantedChapter || a.text.localeCompare(b.text, "zh-CN"))
    .slice(0, MAX_FORESHADOWS);

  return {
    version: 1,
    states,
    relations,
    events,
    foreshadows,
    suppressedIds: boundedStrings(
      record.suppressedIds ?? record.suppressed_ids,
      2000,
    ),
    updatedAt: str(record.updatedAt ?? record.updated_at, nowIso()),
  };
}

export function normalizeExtractedStory(input: unknown): ExtractedStory {
  const record = (input ?? {}) as Record<string, unknown>;
  const states = (Array.isArray(record.states) ? record.states : [])
    .map((item) => {
      const row = (item ?? {}) as Record<string, unknown>;
      const name = str(row.name).trim();
      if (!name) return null;
      return {
        name,
        identity: clip(str(row.identity), 200),
        age: clip(str(row.age), 80),
        location: clip(str(row.location), 200),
        bodyState: clip(str(row.bodyState ?? row.body_state), 400),
        lifeStatus: normalizeLifeStatus(row.lifeStatus ?? row.life_status ?? row.status),
        abilities: boundedStrings(row.abilities, 20),
        goals: boundedStrings(row.goals, 20),
        knowledge: boundedStrings(row.knowledge, 30),
        faction: clip(str(row.faction), 120),
        experience: clip(str(row.experience), 1000),
        evidence: clip(str(row.evidence), 500),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .slice(0, 40);

  const relations = (Array.isArray(record.relations) ? record.relations : [])
    .map((item) => {
      const row = (item ?? {}) as Record<string, unknown>;
      const from = str(row.from).trim();
      const to = str(row.to).trim();
      if (!from || !to || normalizeKey(from) === normalizeKey(to)) return null;
      return {
        from,
        to,
        type: clip(str(row.type ?? row.relation), 160),
        status: clip(str(row.status), 300),
        evidence: clip(str(row.evidence), 500),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .slice(0, 40);

  const events = (Array.isArray(record.events) ? record.events : [])
    .map((item) => {
      const row = (item ?? {}) as Record<string, unknown>;
      const name = clip(str(row.name), 200) || clip(str(row.process), 200);
      if (!name) return null;
      return {
        name,
        time: clip(str(row.time), 200),
        location: clip(str(row.location), 200),
        participants: boundedStrings(row.participants, 40),
        cause: clip(str(row.cause), 1000),
        process: clip(str(row.process), 1200),
        result: clip(str(row.result), 1000),
        impact: clip(str(row.impact), 1000),
        relatedEvents: boundedStrings(row.relatedEvents ?? row.related_events, 30),
        foreshadows: boundedStrings(row.foreshadows, 20),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .slice(0, 30);

  return { states, relations, events };
}

// 模型偶尔把细纲里的名字带进状态/事件；人物名必须在正文出现。
export function groundExtractedStory(
  story: ExtractedStory,
  chapterText: string,
): ExtractedStory {
  const appears = (value: string): boolean => {
    const trimmed = value.trim();
    return trimmed.length > 0 && chapterText.includes(trimmed);
  };
  return {
    states: story.states.filter((item) => appears(item.name)),
    relations: story.relations.filter(
      (item) => appears(item.from) && appears(item.to),
    ),
    events: story.events.map((item) => ({
      ...item,
      // 参与者可能用“他/众人”等泛指，保留原有名单，只裁掉明显不在正文中的名字。
      participants: item.participants.filter(
        (name) => name.length < 2 || appears(name),
      ),
    })),
  };
}

function tokenize(text: string): string[] {
  const cleaned = text.replace(/[^\p{L}\p{N}]+/gu, " ");
  const result = new Set<string>();
  try {
    const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
    for (const part of segmenter.segment(cleaned)) {
      if (!part.isWordLike) continue;
      const word = part.segment.trim();
      if (word.length < 2 || /^\d+$/u.test(word) || STOPWORDS.has(word)) continue;
      result.add(word);
    }
  } catch {
    for (const word of cleaned.split(/\s+/)) {
      if (word.length >= 2 && !/^\d+$/u.test(word) && !STOPWORDS.has(word)) {
        result.add(word);
      }
    }
  }
  return [...result].slice(0, 80);
}

function sameForeshadow(a: string, b: string): boolean {
  const left = normalizeKey(a);
  const right = normalizeKey(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.length >= 4 && right.length >= 4 && (left.includes(right) || right.includes(left))) {
    return true;
  }
  const leftTokens = new Set(tokenize(a));
  const rightTokens = new Set(tokenize(b));
  if (!leftTokens.size || !rightTokens.size) return false;
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }
  return overlap >= 2;
}

function mentionsForeshadow(text: string, haystack: string): boolean {
  const key = normalizeKey(text);
  const hay = normalizeKey(haystack);
  if (key.length >= 4 && hay.includes(key)) return true;
  const tokens = tokenize(text);
  if (!tokens.length) return false;
  const hits = tokens.filter((token) => haystack.includes(token)).length;
  return hits >= 2 || (tokens.length === 1 && hits === 1 && tokens[0].length >= 3);
}

function findForeshadow(
  records: ForeshadowRecord[],
  text: string,
): ForeshadowRecord | undefined {
  return records.find((item) => sameForeshadow(item.text, text));
}

function chapterEventsByParticipants(events: PlotEvent[], name: string): string[] {
  return events
    .filter((event) => event.participants.includes(name))
    .map((event) => event.id)
    .slice(0, 40);
}

function characterCardByName(
  characters: Character[],
  name: string,
): Character | undefined {
  const key = normalizeKey(name);
  return characters.find((item) => normalizeKey(item.name) === key);
}

function canonCharacterAt(
  detail: ProjectDetail,
  name: string,
  chapter: number,
) {
  const canon = canonForChapter(detail.canon, chapter);
  const key = normalizeKey(name);
  return canon.characters.find(
    (item) =>
      normalizeKey(item.name) === key ||
      item.aliases.some((alias) => normalizeKey(alias) === key),
  );
}

function stateChanged(previous: CharacterState | undefined, next: CharacterState): boolean {
  if (!previous) return true;
  return (
    previous.lifeStatus !== next.lifeStatus ||
    previous.location !== next.location ||
    previous.bodyState !== next.bodyState ||
    previous.identity !== next.identity ||
    previous.faction !== next.faction ||
    previous.experience !== next.experience
  );
}

function derivedState(
  detail: ProjectDetail,
  chapter: number,
  name: string,
  memory: ChapterMemory | undefined,
  previous: CharacterState | undefined,
  events: PlotEvent[],
  source: StorySource,
): CharacterState {
  const canon = canonCharacterAt(detail, name, chapter);
  const card = characterCardByName(detail.characters, name);
  const lifeStatus =
    canon?.status && canon.status !== "unknown"
      ? canon.status
      : previous?.lifeStatus ?? "unknown";
  return {
    id: storyStateId(name, chapter),
    name,
    chapter,
    identity: previous?.identity || card?.role || "",
    age: previous?.age || card?.age || "",
    location: canon?.location || memory?.location || previous?.location || "",
    bodyState: previous?.bodyState || "",
    lifeStatus,
    abilities: previous?.abilities ?? [],
    goals: previous?.goals?.length ? previous.goals : card?.goals ? [card.goals] : [],
    knowledge: previous?.knowledge ?? [],
    faction: previous?.faction || "",
    experience: canon?.note || previous?.experience || "",
    eventIds: chapterEventsByParticipants(events, name),
    source,
    updatedAt: detail.state.updatedAt || detail.meta.updatedAt || nowIso(),
  };
}

function seedStates(
  detail: ProjectDetail,
  memory: ProjectMemory,
  events: PlotEvent[],
): CharacterState[] {
  const written = detail.chapters
    .filter((chapter) => chapter.written && chapter.content.trim())
    .map((chapter) => chapter.index)
    .sort((a, b) => a - b);
  const result: CharacterState[] = [];
  const latestByName = new Map<string, CharacterState>();

  for (const chapter of written) {
    const chapterMemory = memory.chapters[String(chapter)];
    const names = new Set<string>(chapterMemory?.characters ?? []);
    const canon = canonForChapter(detail.canon, chapter);
    for (const item of canon.characters) {
      if (item.statusChapter === chapter || item.chapter === chapter) names.add(item.name);
    }
    for (const name of names) {
      const previous = latestByName.get(normalizeKey(name));
      const next = derivedState(
        detail,
        chapter,
        name,
        chapterMemory,
        previous,
        events.filter((event) => event.chapter === chapter),
        "summary",
      );
      latestByName.set(normalizeKey(name), next);
      if (stateChanged(previous, next)) result.push(next);
    }
  }
  return result;
}

function seedEvents(detail: ProjectDetail, memory: ProjectMemory): PlotEvent[] {
  const written = detail.chapters
    .filter((chapter) => chapter.written && chapter.content.trim())
    .sort((a, b) => a.index - b.index);
  const result: PlotEvent[] = [];
  for (const chapter of written) {
    const chapterMemory = memory.chapters[String(chapter.index)];
    if (!chapterMemory) continue;
    const names = chapterMemory.events.length
      ? chapterMemory.events
      : [chapter.title || `第 ${chapter.index} 章`];
    names.forEach((name, index) => {
      result.push({
        id: `evt-${chapter.index}-${index + 1}`,
        name: clip(name, 200),
        chapter: chapter.index,
        time: chapterMemory.time,
        location: chapterMemory.location,
        participants: chapterMemory.characters.slice(0, 40),
        cause: "",
        process: chapterMemory.events.length ? "" : chapterMemory.summary,
        result: "",
        impact: chapterMemory.endingState,
        relatedEventIds: [],
        foreshadowIds: [],
        source: "summary",
        updatedAt: chapterMemory.updatedAt,
      });
    });
  }
  return result;
}

function seedForeshadows(
  memory: ProjectMemory,
  events: PlotEvent[],
): ForeshadowRecord[] {
  // 大纲伏笔只进入计划台账；剧情台账只登记“正文抽取结果中确实出现”的伏笔。
  const records: ForeshadowRecord[] = [];
  const chapters = Object.values(memory.chapters)
    .filter((chapter) => chapter.source !== "summary")
    .sort((a, b) => a.index - b.index);
  for (const chapter of chapters) {
    for (const text of chapter.foreshadowsPlanted) {
      const existing = findForeshadow(records, text);
      if (existing) {
        existing.eventIds = uniqueStrings([
          ...existing.eventIds,
          ...events
            .filter((event) => event.chapter === chapter.index)
            .map((event) => event.id),
        ]);
        continue;
      }
      records.push({
        id: storyForeshadowId(text, chapter.index),
        text,
        plantedChapter: chapter.index,
        relatedCharacters: chapter.characters.filter((name) => text.includes(name)),
        expectedStartChapter: chapter.index,
        expectedEndChapter: 0,
        status: "planted",
        eventIds: events
          .filter((event) => event.chapter === chapter.index)
          .map((event) => event.id)
          .slice(0, 10),
        resolution: "",
        resolvedChapter: 0,
        resolutionCandidate: "",
        source: "summary",
        updatedAt: chapter.updatedAt,
      });
    }

    for (const text of chapter.foreshadowsResolved) {
      const existing = findForeshadow(records, text);
      if (!existing) continue;
      // AI/摘要只能提供候选；确认回收必须由作者在剧情台账里操作。
      existing.resolutionCandidate = `第 ${chapter.index} 章正文提到可能回收：${clip(text, 200)}`;
      existing.eventIds = uniqueStrings([
        ...existing.eventIds,
        ...events
          .filter((event) => event.chapter === chapter.index)
          .map((event) => event.id),
      ]);
    }
  }
  return records;
}

function mergeById<T extends { id: string }>(seed: T[], stored: T[]): T[] {
  const map = new Map<string, T>();
  for (const item of seed) map.set(item.id, item);
  for (const item of stored) map.set(item.id, item);
  return [...map.values()];
}

function mergeForeshadows(
  seed: ForeshadowRecord[],
  stored: ForeshadowRecord[],
): ForeshadowRecord[] {
  const result = [...stored];
  for (const item of seed) {
    const existing = findForeshadow(result, item.text);
    if (!existing) {
      result.push(item);
      continue;
    }
    if (existing.source !== "manual") {
      if (!existing.expectedStartChapter) existing.expectedStartChapter = item.expectedStartChapter;
      if (!existing.expectedEndChapter) existing.expectedEndChapter = item.expectedEndChapter;
      existing.relatedCharacters = uniqueStrings([
        ...existing.relatedCharacters,
        ...item.relatedCharacters,
      ]).slice(0, 30);
      existing.eventIds = uniqueStrings([...existing.eventIds, ...item.eventIds]).slice(0, 30);
      if (item.resolutionCandidate && !existing.resolvedChapter) {
        existing.resolutionCandidate = item.resolutionCandidate;
      }
    }
  }
  return result;
}

function latestWrittenChapter(detail: ProjectDetail): number {
  return detail.chapters.reduce(
    (max, chapter) => (chapter.written && chapter.content.trim() ? Math.max(max, chapter.index) : max),
    0,
  );
}

function refreshForeshadowStatuses(
  ledger: StoryLedger,
  memory: ProjectMemory,
  latestChapter: number,
): void {
  const chapters = Object.values(memory.chapters)
    .filter((chapter) => chapter.source !== "summary")
    .sort((a, b) => a.index - b.index);
  for (const record of ledger.foreshadows) {
    if (record.source === "manual") continue;
    if (record.resolvedChapter > 0) {
      record.status = "resolved";
      continue;
    }
    if (record.status === "abandoned") continue;

    let candidate = record.resolutionCandidate;
    let developing = false;
    for (const chapter of chapters) {
      if (chapter.index <= record.plantedChapter || chapter.index > latestChapter) continue;
      const search = [
        chapter.summary,
        ...chapter.events,
        ...chapter.actions,
        ...chapter.newSettings,
        ...chapter.foreshadowsPlanted,
      ].join("\n");
      if (mentionsForeshadow(record.text, search)) developing = true;
      for (const resolved of chapter.foreshadowsResolved) {
        if (sameForeshadow(record.text, resolved)) {
          candidate = `第 ${chapter.index} 章正文提到可能回收：${clip(resolved, 200)}`;
        }
      }
    }
    record.resolutionCandidate = candidate;

    if (latestChapter <= record.plantedChapter) {
      record.status = "planted";
    } else if (candidate) {
      // 保持“待回收”，候选只作为提示，不自动变成已回收。
      record.status = "pending";
    } else if (developing) {
      record.status = "developing";
    } else {
      record.status = "pending";
    }
  }
}

function linkForeshadowsToEvents(ledger: StoryLedger): void {
  for (const record of ledger.foreshadows) {
    const linked = new Set(record.eventIds);
    for (const event of ledger.events) {
      if (event.chapter < record.plantedChapter) continue;
      const text = [event.name, event.process, event.result, event.impact]
        .filter(Boolean)
        .join("\n");
      if (mentionsForeshadow(record.text, text)) linked.add(event.id);
    }
    record.eventIds = [...linked].slice(0, 30);
  }
  for (const event of ledger.events) {
    const linked = new Set(event.foreshadowIds);
    for (const record of ledger.foreshadows) {
      if (record.eventIds.includes(event.id)) linked.add(record.id);
    }
    event.foreshadowIds = [...linked].slice(0, 20);
  }
}

export function buildEffectiveStory(
  detail: ProjectDetail,
  memoryInput: ProjectMemory | null | undefined,
  storedInput: StoryLedger | null | undefined,
): StoryLedger {
  const memory = buildEffectiveMemory(detail, memoryInput ?? null);
  const stored = normalizeStory(storedInput ?? emptyStory());
  const seedEventsResult = seedEvents(detail, memory);
  const seedStatesResult = seedStates(detail, memory, seedEventsResult);
  const seedForeshadowsResult = seedForeshadows(memory, seedEventsResult);

  const suppressed = new Set(stored.suppressedIds);
  // 旧版本可能把大纲伏笔直接写进 story.json。这里只保留有正文抽取记忆支撑的记录；
  // 其余迁移到计划台账（读取时按大纲派生），不再作为“已埋设伏笔”参与检索。
  const actualPlantedTexts = Object.values(memory.chapters)
    .filter((chapter) => chapter.source !== "summary")
    .flatMap((chapter) => chapter.foreshadowsPlanted);
  const storedForeshadows = stored.foreshadows.filter(
    (item) =>
      item.source === "manual" ||
      item.resolvedChapter > 0 ||
      Boolean(item.resolutionCandidate) ||
      actualPlantedTexts.some((text) => sameForeshadow(text, item.text)),
  );
  const ledger: StoryLedger = {
    version: 1,
    states: mergeById(seedStatesResult, stored.states).filter(
      (item) => !suppressed.has(item.id),
    ),
    relations: mergeById([], stored.relations).filter(
      (item) => !suppressed.has(item.id),
    ),
    events: mergeById(seedEventsResult, stored.events).filter(
      (item) => !suppressed.has(item.id),
    ),
    foreshadows: mergeForeshadows(seedForeshadowsResult, storedForeshadows).filter(
      (item) => !suppressed.has(item.id),
    ),
    suppressedIds: stored.suppressedIds,
    updatedAt: nowIso(),
  };
  refreshForeshadowStatuses(ledger, memory, latestWrittenChapter(detail));
  linkForeshadowsToEvents(ledger);
  ledger.updatedAt =
    [detail.state.updatedAt, detail.meta.updatedAt, memory.updatedAt, stored.updatedAt]
      .filter(Boolean)
      .sort()
      .pop() || nowIso();
  return ledger;
}

function nextEventId(chapter: number, used: Set<string>): string {
  let sequence = 1;
  while (used.has(`evt-${chapter}-${sequence}`)) sequence += 1;
  const id = `evt-${chapter}-${sequence}`;
  used.add(id);
  return id;
}

function applyExtractedEvents(
  ledger: StoryLedger,
  chapter: number,
  extracted: ExtractedStory | undefined,
  chapterMemory: ChapterMemory | undefined,
): PlotEvent[] {
  const manual = ledger.events.filter(
    (event) => event.chapter === chapter && event.source === "manual",
  );
  const used = new Set(manual.map((event) => event.id));
  const created: PlotEvent[] = [];
  const at = nowIso();

  const raw = extracted?.events.length
    ? extracted.events
    : (chapterMemory?.events ?? []).map((name) => ({
        name,
        time: chapterMemory?.time ?? "",
        location: chapterMemory?.location ?? "",
        participants: chapterMemory?.characters ?? [],
        cause: "",
        process: "",
        result: "",
        impact: chapterMemory?.endingState ?? "",
        relatedEvents: [],
        foreshadows: [],
      }));

  const effective = raw.length
    ? raw
    : [
        {
          name: chapterMemory?.summary
            ? clip(chapterMemory.summary, 160)
            : `第 ${chapter} 章剧情事件`,
          time: chapterMemory?.time ?? "",
          location: chapterMemory?.location ?? "",
          participants: chapterMemory?.characters ?? [],
          cause: "",
          process: chapterMemory?.summary ?? "",
          result: "",
          impact: chapterMemory?.endingState ?? "",
          relatedEvents: [],
          foreshadows: [],
        },
      ];

  for (const item of effective.slice(0, 30)) {
    created.push({
      id: nextEventId(chapter, used),
      name: item.name,
      chapter,
      time: item.time,
      location: item.location,
      participants: item.participants,
      cause: item.cause,
      process: item.process,
      result: item.result,
      impact: item.impact,
      relatedEventIds: [],
      foreshadowIds: [],
      source: extracted?.events.length ? "ai" : "summary",
      updatedAt: at,
    });
  }

  // 事件名称到稳定 ID 的关联：模型通常只能给事件名，这里在本章范围内解析。
  for (let i = 0; i < created.length; i += 1) {
    const item = effective[i];
    const related: string[] = [];
    for (const reference of item.relatedEvents) {
      const target = created.find(
        (event) =>
          event.id !== created[i].id &&
          (normalizeKey(event.name) === normalizeKey(reference) ||
            mentionsForeshadow(reference, event.name)),
      );
      if (target) related.push(target.id);
    }
    created[i].relatedEventIds = uniqueStrings(related).slice(0, 20);
  }

  ledger.events = [
    ...ledger.events.filter(
      (event) => !(event.chapter === chapter && event.source !== "manual"),
    ),
    ...created,
  ].sort((a, b) => a.chapter - b.chapter || a.id.localeCompare(b.id));
  return created;
}

function applyExtractedStates(
  detail: ProjectDetail,
  ledger: StoryLedger,
  chapter: number,
  extracted: ExtractedStory | undefined,
  chapterMemory: ChapterMemory | undefined,
  chapterEvents: PlotEvent[],
): void {
  const previousStates = characterStatesAt(ledger, chapter - 1);
  const previousByName = new Map(
    previousStates.map((item) => [normalizeKey(item.name), item]),
  );
  const manual = ledger.states.filter(
    (state) => state.chapter === chapter && state.source === "manual",
  );
  const manualNames = new Set(manual.map((state) => normalizeKey(state.name)));
  const at = nowIso();

  const names = new Set<string>();
  for (const item of extracted?.states ?? []) names.add(item.name);
  if (!names.size) {
    for (const name of chapterMemory?.characters ?? []) names.add(name);
  }

  const created: CharacterState[] = [...manual];
  for (const name of names) {
    if (manualNames.has(normalizeKey(name))) continue;
    const extractedState = extracted?.states.find(
      (item) => normalizeKey(item.name) === normalizeKey(name),
    );
    const previous = previousByName.get(normalizeKey(name));
    const derived = derivedState(
      detail,
      chapter,
      name,
      chapterMemory,
      previous,
      chapterEvents,
      extractedState ? "ai" : "summary",
    );
    if (extractedState) {
      derived.identity = extractedState.identity || derived.identity;
      derived.age = extractedState.age || derived.age;
      derived.location = extractedState.location || derived.location;
      derived.bodyState = extractedState.bodyState || derived.bodyState;
      derived.lifeStatus =
        extractedState.lifeStatus !== "unknown"
          ? extractedState.lifeStatus
          : derived.lifeStatus;
      derived.abilities = extractedState.abilities.length
        ? extractedState.abilities
        : derived.abilities;
      derived.goals = extractedState.goals.length ? extractedState.goals : derived.goals;
      derived.knowledge = extractedState.knowledge.length
        ? extractedState.knowledge
        : derived.knowledge;
      derived.faction = extractedState.faction || derived.faction;
      derived.experience = extractedState.experience || derived.experience;
      derived.updatedAt = at;
    }
    created.push(derived);
  }

  ledger.states = [
    ...ledger.states.filter(
      (state) => !(state.chapter === chapter && state.source !== "manual"),
    ),
    ...created,
  ].sort((a, b) => a.chapter - b.chapter || a.name.localeCompare(b.name, "zh-CN"));
}

function applyExtractedRelations(
  ledger: StoryLedger,
  chapter: number,
  extracted: ExtractedStory | undefined,
  chapterEvents: PlotEvent[],
): void {
  const at = nowIso();
  const manual = ledger.relations.filter(
    (relation) => relation.chapter === chapter && relation.source === "manual",
  );
  const manualIds = new Set(manual.map((relation) => relation.id));
  const created: CharacterRelation[] = [];
  for (const item of extracted?.relations ?? []) {
    const eventIds = chapterEvents
      .filter(
        (event) =>
          event.participants.includes(item.from) && event.participants.includes(item.to),
      )
      .map((event) => event.id)
      .slice(0, 20);
    const relation = normalizeCharacterRelation(
      {
        ...item,
        chapter,
        eventIds,
        source: "ai",
        updatedAt: at,
      },
      chapter,
    );
    if (relation && !manualIds.has(relation.id)) created.push(relation);
  }
  ledger.relations = [
    ...ledger.relations.filter(
      (relation) => !(relation.chapter === chapter && relation.source !== "manual"),
    ),
    ...manual,
    ...created,
  ].sort((a, b) => a.chapter - b.chapter || a.from.localeCompare(b.from, "zh-CN"));
}

export function finalizeStory(
  detail: ProjectDetail,
  memory: ProjectMemory,
  story: StoryLedger,
): StoryLedger {
  const normalized = normalizeStory(story);
  refreshForeshadowStatuses(normalized, memory, latestWrittenChapter(detail));
  linkForeshadowsToEvents(normalized);
  normalized.updatedAt = nowIso();
  return normalized;
}

export function applyChapterStory(
  detail: ProjectDetail,
  memory: ProjectMemory,
  stored: StoryLedger | null | undefined,
  chapter: number,
  extracted: ExtractedStory | undefined,
  chapterMemory?: ChapterMemory,
): StoryLedger {
  const ledger = buildEffectiveStory(detail, memory, stored);
  // 重写/重抽某章时，允许该章重新出现在台账中；其他章节的删除保持生效。
  const prefixes = [`evt-${chapter}-`, `state-${chapter}-`, `rel-${chapter}-`, `fs-${chapter}-`];
  ledger.suppressedIds = ledger.suppressedIds.filter(
    (id) => !prefixes.some((prefix) => id.startsWith(prefix)),
  );
  const events = applyExtractedEvents(ledger, chapter, extracted, chapterMemory);
  applyExtractedStates(
    detail,
    ledger,
    chapter,
    extracted,
    chapterMemory,
    events,
  );
  applyExtractedRelations(ledger, chapter, extracted, events);
  refreshForeshadowStatuses(ledger, memory, latestWrittenChapter(detail));
  linkForeshadowsToEvents(ledger);
  ledger.updatedAt = nowIso();
  return normalizeStory(ledger);
}

export function characterStatesAt(
  ledger: StoryLedger,
  chapter: number,
): CharacterState[] {
  const latest = new Map<string, CharacterState>();
  for (const state of ledger.states) {
    if (state.chapter > chapter) continue;
    const key = normalizeKey(state.name);
    const previous = latest.get(key);
    if (!previous || state.chapter > previous.chapter) latest.set(key, state);
  }
  return [...latest.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

export function characterHistory(
  ledger: StoryLedger,
  name: string,
): CharacterState[] {
  const key = normalizeKey(name);
  return ledger.states
    .filter((state) => normalizeKey(state.name) === key)
    .sort((a, b) => a.chapter - b.chapter);
}

export function relationsAt(
  ledger: StoryLedger,
  chapter: number,
): CharacterRelation[] {
  const latest = new Map<string, CharacterRelation>();
  for (const relation of ledger.relations) {
    if (relation.chapter > chapter) continue;
    const key = `${normalizeKey(relation.from)}>${normalizeKey(relation.to)}`;
    const previous = latest.get(key);
    if (!previous || relation.chapter > previous.chapter) latest.set(key, relation);
  }
  return [...latest.values()].sort((a, b) => a.from.localeCompare(b.from, "zh-CN"));
}

export function eventsUpTo(ledger: StoryLedger, chapter: number): PlotEvent[] {
  return ledger.events
    .filter((event) => event.chapter <= chapter)
    .sort((a, b) => a.chapter - b.chapter || a.id.localeCompare(b.id));
}

export function eventsForCharacter(
  ledger: StoryLedger,
  name: string,
): PlotEvent[] {
  const key = normalizeKey(name);
  return ledger.events
    .filter((event) =>
      event.participants.some((item) => normalizeKey(item) === key),
    )
    .sort((a, b) => a.chapter - b.chapter || a.id.localeCompare(b.id));
}

export function foreshadowsAt(
  ledger: StoryLedger,
  chapter: number,
): ForeshadowRecord[] {
  return ledger.foreshadows.filter((item) => item.plantedChapter <= chapter);
}

export function isForeshadowOverdue(
  record: ForeshadowRecord,
  latestChapter: number,
): boolean {
  return (
    record.expectedEndChapter > 0 &&
    latestChapter > record.expectedEndChapter &&
    record.status !== "resolved" &&
    record.status !== "abandoned"
  );
}

export function storyStats(detail: ProjectDetail, ledger: StoryLedger): StoryStatsView {
  const latest = latestWrittenChapter(detail);
  const chapters = new Set<number>();
  for (const state of ledger.states) chapters.add(state.chapter);
  for (const event of ledger.events) chapters.add(event.chapter);
  return {
    states: ledger.states.length,
    relations: ledger.relations.length,
    events: ledger.events.length,
    foreshadows: ledger.foreshadows.length,
    openForeshadows: ledger.foreshadows.filter(
      (item) =>
        item.plantedChapter <= latest &&
        item.status !== "resolved" &&
        item.status !== "abandoned",
    ).length,
    overdueForeshadows: ledger.foreshadows.filter((item) =>
      isForeshadowOverdue(item, latest),
    ).length,
    resolvedForeshadows: ledger.foreshadows.filter(
      (item) => item.status === "resolved",
    ).length,
    chaptersCovered: chapters.size,
    updatedAt: ledger.updatedAt,
  };
}

function latestStateBefore(
  ledger: StoryLedger,
  name: string,
  chapter: number,
): CharacterState | undefined {
  const key = normalizeKey(name);
  return ledger.states
    .filter((state) => normalizeKey(state.name) === key && state.chapter <= chapter)
    .sort((a, b) => b.chapter - a.chapter)[0];
}

export function storyChecks(
  detail: ProjectDetail,
  ledger: StoryLedger,
): StoryCheckIssue[] {
  const issues: StoryCheckIssue[] = [];
  const maxChapter = detail.plan.chapters.reduce(
    (max, chapter) => Math.max(max, chapter.index),
    0,
  );
  const events = [...ledger.events].sort(
    (a, b) => a.chapter - b.chapter || a.id.localeCompare(b.id),
  );
  const eventById = new Map(events.map((event) => [event.id, event]));

  const timeGroups = new Map<string, { participant: string; locations: Set<string>; events: PlotEvent[] }>();
  for (const event of events) {
    if (event.time.trim().length < 2) continue;
    for (const participant of event.participants) {
      const key = `${normalizeKey(event.time)}|${normalizeKey(participant)}`;
      if (!event.location.trim()) continue;
      const group = timeGroups.get(key) ?? {
        participant,
        locations: new Set<string>(),
        events: [],
      };
      group.locations.add(normalizeKey(event.location));
      group.events.push(event);
      timeGroups.set(key, group);
    }
  }
  for (const group of timeGroups.values()) {
    if (group.locations.size <= 1) continue;
    const first = group.events[0];
    issues.push({
      severity: "warning",
      code: "same-time-different-locations",
      message: `${group.participant} 在同一时间出现在 ${group.locations.size} 个不同地点，请核对时间线或地点描写。`,
      chapter: first.chapter,
      evidence: group.events.map((event) => `第 ${event.chapter} 章：${event.location}`).join("；"),
    });
  }

  for (const event of events) {
    for (const participant of event.participants) {
      const death = latestStateBefore(ledger, participant, event.chapter);
      if (!death || death.lifeStatus !== "dead" || death.chapter >= event.chapter) continue;
      const revived = ledger.states.some(
        (state) =>
          normalizeKey(state.name) === normalizeKey(participant) &&
          state.chapter > death.chapter &&
          state.chapter <= event.chapter &&
          state.lifeStatus === "alive",
      );
      if (revived) continue;
      issues.push({
        severity: "warning",
        code: "dead-character-in-later-event",
        message: `${participant} 在第 ${death.chapter} 章已死亡，但第 ${event.chapter} 章事件仍列为参与者。需要确认是回忆、尸体、幻象、复活或假死。`,
        chapter: event.chapter,
        evidence: `事件：${event.name}`,
      });
    }
  }

  const statesByName = new Map<string, CharacterState[]>();
  for (const state of ledger.states) {
    const key = normalizeKey(state.name);
    const list = statesByName.get(key) ?? [];
    list.push(state);
    statesByName.set(key, list);
  }
  for (const states of statesByName.values()) {
    const ordered = states.sort((a, b) => a.chapter - b.chapter);
    for (let i = 1; i < ordered.length; i += 1) {
      const previous = ordered[i - 1];
      const current = ordered[i];
      if (
        previous.lifeStatus === "dead" &&
        current.lifeStatus === "alive" &&
        current.chapter > previous.chapter &&
        !current.eventIds.length
      ) {
        issues.push({
          severity: "warning",
          code: "revival-without-event",
          message: `${current.name} 在第 ${previous.chapter} 章死亡，第 ${current.chapter} 章又变为存活；复活/假死需要关联对应剧情事件。`,
          chapter: current.chapter,
          evidence: `状态快照：${current.id}`,
        });
      }
    }
  }

  for (const record of ledger.foreshadows) {
    if (record.resolvedChapter > 0 && record.resolvedChapter < record.plantedChapter) {
      issues.push({
        severity: "critical",
        code: "foreshadow-resolved-before-planted",
        message: `伏笔“${record.text}”的回收章节早于埋设章节。`,
        chapter: record.plantedChapter,
        evidence: `埋设：第 ${record.plantedChapter} 章；回收：第 ${record.resolvedChapter} 章`,
      });
    }
  }

  for (const event of events) {
    if (event.chapter < 1 || (maxChapter > 0 && event.chapter > maxChapter)) {
      issues.push({
        severity: "warning",
        code: "invalid-event-chapter",
        message: `事件“${event.name}”的章节号超出当前大纲范围。`,
        chapter: event.chapter,
        evidence: event.id,
      });
    }
    for (const relatedId of event.relatedEventIds) {
      const target = eventById.get(relatedId);
      if (!target) {
        issues.push({
          severity: "warning",
          code: "broken-event-link",
          message: `事件“${event.name}”关联了不存在的事件 ${relatedId}。`,
          chapter: event.chapter,
          evidence: event.id,
        });
        continue;
      }
      if (target.chapter > event.chapter) {
        issues.push({
          severity: "warning",
          code: "broken-event-link",
          message: `事件“${event.name}”的因果关联指向后文事件“${target.name}”。`,
          chapter: event.chapter,
          evidence: `${event.id} → ${target.id}`,
        });
      }
    }
  }

  for (const relation of ledger.relations) {
    if (normalizeKey(relation.from) === normalizeKey(relation.to)) {
      issues.push({
        severity: "warning",
        code: "self-relation",
        message: `人物关系不能指向自身：${relation.from}。`,
        chapter: relation.chapter,
        evidence: relation.id,
      });
    }
  }

  return issues.slice(0, 200);
}

interface ContextSection {
  title: string;
  lines: string[];
  priority: number;
}

function composeSections(
  sections: ContextSection[],
  budget: number,
): { text: string; truncated: boolean } {
  const selected: string[] = [];
  let used = 0;
  let truncated = false;
  for (const section of [...sections].sort((a, b) => b.priority - a.priority)) {
    if (!section.lines.length) continue;
    const body = `【${section.title}】\n${section.lines.join("\n")}`;
    if (used + body.length + 2 <= budget) {
      selected.push(body);
      used += body.length + 2;
      continue;
    }
    const remaining = budget - used - section.title.length - 8;
    if (remaining > 100) {
      selected.push(`【${section.title}】\n${clip(section.lines.join("\n"), remaining)}`);
      used = budget;
    }
    truncated = true;
  }
  return { text: selected.join("\n\n"), truncated };
}

function stateLine(state: CharacterState): string {
  const parts = [`第 ${state.chapter} 章状态`];
  if (state.identity) parts.push(`身份：${clip(state.identity, 80)}`);
  if (state.age) parts.push(`年龄：${state.age}`);
  if (state.location) parts.push(`位置：${clip(state.location, 80)}`);
  if (state.bodyState) parts.push(`身体：${clip(state.bodyState, 120)}`);
  parts.push(
    `生死：${state.lifeStatus === "dead" ? "死亡" : state.lifeStatus === "alive" ? "存活" : "未知"}`,
  );
  if (state.abilities.length) parts.push(`能力：${state.abilities.slice(0, 4).join("、")}`);
  if (state.goals.length) parts.push(`目标：${state.goals.slice(0, 3).join("；")}`);
  if (state.knowledge.length) parts.push(`掌握：${state.knowledge.slice(0, 3).join("；")}`);
  if (state.faction) parts.push(`阵营：${clip(state.faction, 60)}`);
  if (state.experience) parts.push(`经历：${clip(state.experience, 160)}`);
  return `- ${state.name}（${parts.join("；")}）`;
}

function relationLine(relation: CharacterRelation): string {
  const parts = [relation.type || "关系", `第 ${relation.chapter} 章`];
  if (relation.status) parts.push(clip(relation.status, 160));
  return `- ${relation.from} ↔ ${relation.to}：${parts.join("；")}`;
}

function eventLine(event: PlotEvent): string {
  const parts = [`第 ${event.chapter} 章`];
  if (event.time) parts.push(`时间：${clip(event.time, 60)}`);
  if (event.location) parts.push(`地点：${clip(event.location, 60)}`);
  if (event.participants.length) parts.push(`参与：${event.participants.slice(0, 8).join("、")}`);
  if (event.cause) parts.push(`起因：${clip(event.cause, 120)}`);
  if (event.process) parts.push(`过程：${clip(event.process, 180)}`);
  if (event.result) parts.push(`结果：${clip(event.result, 120)}`);
  if (event.impact) parts.push(`影响：${clip(event.impact, 120)}`);
  return `- 《${event.name}》（${parts.join("；")}）`;
}

function foreshadowLine(record: ForeshadowRecord, latest: number): string {
  const expected =
    record.expectedStartChapter || record.expectedEndChapter
      ? `预期第 ${record.expectedStartChapter || "?"}-${record.expectedEndChapter || "?"} 章回收`
      : "未设预计回收章节";
  const overdue = isForeshadowOverdue(record, latest) ? "；已超期" : "";
  const candidate = record.resolutionCandidate
    ? `；回收候选：${clip(record.resolutionCandidate, 160)}`
    : "";
  const status =
    record.status === "planted"
      ? "已埋设"
      : record.status === "developing"
        ? "发展中"
        : record.status === "resolved"
          ? "已回收"
          : record.status === "abandoned"
            ? "已废弃"
            : "待回收";
  return `- [第 ${record.plantedChapter} 章埋；${status}${overdue}] ${clip(record.text, 300)}（${expected}${candidate}）`;
}

export function buildStoryContext(
  detail: ProjectDetail,
  chapter: ChapterPlan,
  memory: ProjectMemory,
  ledger: StoryLedger,
  options: { budget?: number } = {},
): StoryRetrievalResult {
  const target = chapter.index;
  const latest = Math.max(0, target - 1);
  const planText = [chapter.title, chapter.summary, ...chapter.keyBeats].filter(Boolean).join("\n");
  const tokens = tokenize(planText);
  const states = characterStatesAt(ledger, latest);
  const relevantNames = new Set<string>();
  for (const state of states) {
    if (planText.includes(state.name)) relevantNames.add(normalizeKey(state.name));
  }
  const recent = Object.values(memory.chapters)
    .filter((item) => item.index < target && item.index > target - RECENT_MEMORY_WINDOW)
    .sort((a, b) => b.index - a.index);
  for (const item of recent) {
    for (const name of item.characters) relevantNames.add(normalizeKey(name));
  }
  for (const state of states) {
    if (state.lifeStatus === "dead") relevantNames.add(normalizeKey(state.name));
  }
  const relevantStates = (relevantNames.size
    ? states.filter((state) => relevantNames.has(normalizeKey(state.name)))
    : states
  )
    .sort((a, b) => b.chapter - a.chapter || a.name.localeCompare(b.name, "zh-CN"))
    .slice(0, MAX_CONTEXT_STATES);

  const allRelations = relationsAt(ledger, latest);
  const relevantRelations = allRelations
    .filter(
      (relation) =>
        !relevantNames.size ||
        relevantNames.has(normalizeKey(relation.from)) ||
        relevantNames.has(normalizeKey(relation.to)),
    )
    .slice(0, 16);

  const scoredEvents = ledger.events
    .filter((event) => event.chapter < target)
    .map((event) => {
      const text = [event.name, event.process, event.result, event.impact, event.location]
        .filter(Boolean)
        .join("\n");
      let score = 0;
      for (const token of tokens) {
        if (text.includes(token)) score += 2;
      }
      for (const name of relevantNames) {
        if (text.includes(name) || event.participants.some((item) => normalizeKey(item) === name)) {
          score += 6;
        }
      }
      return { event, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.event.chapter - a.event.chapter)
    .slice(0, MAX_CONTEXT_EVENTS)
    .map((item) => item.event)
    .sort((a, b) => a.chapter - b.chapter || a.id.localeCompare(b.id));

  const openForeshadows = ledger.foreshadows
    .filter(
      (item) =>
        item.plantedChapter < target &&
        item.status !== "resolved" &&
        item.status !== "abandoned",
    )
    .sort(
      (a, b) =>
        Number(isForeshadowOverdue(b, latest)) - Number(isForeshadowOverdue(a, latest)) ||
        a.plantedChapter - b.plantedChapter,
    )
    .slice(0, 12);

  const sections: ContextSection[] = [
    {
      title: "人物动态状态（截至上一章）",
      lines: relevantStates.length
        ? relevantStates.map(stateLine)
        : ["（未检索到人物动态状态；不得虚构人物当前状态）"],
      priority: 100,
    },
    {
      title: "未回收伏笔与回收候选",
      lines: openForeshadows.length
        ? openForeshadows.map((item) => foreshadowLine(item, latest))
        : ["（未检索到未回收伏笔）"],
      priority: 95,
    },
    {
      title: "相关剧情事件（只含检索结果，不含正文）",
      lines: scoredEvents.length
        ? scoredEvents.map(eventLine)
        : ["（未检索到相关剧情事件；不得补写未记录的历史）"],
      priority: 85,
    },
    {
      title: "人物关系",
      lines: relevantRelations.length
        ? relevantRelations.map(relationLine)
        : ["（未检索到人物关系；不要虚构关系）"],
      priority: 75,
    },
  ];

  const budget = options.budget ?? STORY_CHAR_BUDGET;
  const composed = composeSections(sections, budget);
  const text = composed.text || "（未检索到人物状态、剧情事件或伏笔；不得自行补写为既定事实）";
  return {
    chapter: target,
    text,
    tokenEstimate: estimateTokens(text),
    truncated: composed.truncated || text.length > budget,
    chapterIndices: uniqueStrings(scoredEvents.map((event) => String(event.chapter))).map(Number),
    sources: [
      ...relevantStates.map((state) => `人物状态：${state.name}`),
      ...relevantRelations.map((relation) => `关系：${relation.from}↔${relation.to}`),
      ...scoredEvents.map((event) => `事件：第 ${event.chapter} 章`),
      ...openForeshadows.map((item) => `伏笔：第 ${item.plantedChapter} 章`),
    ],
  };
}
