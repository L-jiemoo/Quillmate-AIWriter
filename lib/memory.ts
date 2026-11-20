import { canonForChapter } from "./canon";
import { nowIso } from "./utils";
import type {
  BookMemory,
  CanonCharacter,
  CanonFacts,
  CanonItem,
  ChapterMemory,
  ChapterPlan,
  Character,
  ExtractedFacts,
  ExtractedMemory,
  MemoryRetrievalResult,
  OpenForeshadow,
  ProjectDetail,
  ProjectMemory,
  VolumeMemory,
} from "./types";

export const MEMORY_TOKEN_BUDGET = 4000;
export const MEMORY_CHAR_BUDGET = MEMORY_TOKEN_BUDGET * 2;

const MAX_MEMORY_ITEMS = 40;
const MAX_CHAPTER_EVENTS = 30;
const MAX_VOLUME_EVENTS = 30;
const MAX_CHAPTERS_IN_CONTEXT = 8;
const RECENT_SUMMARY_WINDOW = 6;

const STOPWORDS = new Set([
  "一个",
  "一种",
  "一些",
  "这个",
  "那个",
  "这些",
  "那些",
  "自己",
  "什么",
  "怎么",
  "为什么",
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
  "不得",
  "不要",
  "他们",
  "她们",
  "我们",
  "你们",
  "此时",
  "这时",
  "时候",
  "地方",
  "东西",
  "事情",
  "人物",
  "主角",
  "本章",
  "上一章",
  "下一章",
  "正文",
  "剧情",
  "故事",
  "出现",
  "发生",
  "开始",
  "结束",
  "继续",
  "为了",
  "来自",
  "成为",
  "进行",
  "通过",
  "之后",
  "之前",
  "同时",
  "其中",
  "发现",
  "知道",
  "看到",
  "听见",
  "决定",
  "准备",
  "似乎",
  "仿佛",
  "终于",
  "立刻",
  "突然",
  "仍然",
  "只是",
  "还有",
  "这里",
  "那里",
  "众人",
  "有人",
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

function uniqueStrings(values: string[], exclude = ""): string[] {
  const excluded = normalizeKey(exclude);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    const key = normalizeKey(value);
    if (!value || !key || key === excluded || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function boundedStrings(value: unknown, max = MAX_MEMORY_ITEMS): string[] {
  return uniqueStrings(arr(value)).map((item) => clipText(item, 500)).slice(0, max);
}

function normalizeKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s，,。；;：:、！!？?（）()【】[\]《》“”"'‘’·…—_-]+/gu, "");
}

function clipText(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}……` : trimmed;
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeSource(value: unknown): ChapterMemory["source"] {
  return value === "ai" || value === "manual" ? value : "summary";
}

function normalizeAutoSource(value: unknown): "auto" | "manual" {
  return value === "manual" ? "manual" : "auto";
}

function emptyBook(updatedAt = nowIso()): BookMemory {
  return {
    logline: "",
    tags: [],
    worldview: "",
    mainline: "",
    coreCharacters: [],
    coreRules: [],
    finalGoal: "",
    keyConflicts: [],
    summary: "",
    source: "auto",
    updatedAt,
  };
}

export function emptyMemory(updatedAt = nowIso()): ProjectMemory {
  return {
    version: 1,
    book: emptyBook(updatedAt),
    volumes: [],
    chapters: {},
    updatedAt,
  };
}

export function normalizeChapterMemory(
  input: unknown,
  fallbackIndex = 0,
): ChapterMemory | null {
  const record = (input ?? {}) as Record<string, unknown>;
  const index = positiveInt(record.index, fallbackIndex);
  if (!index) return null;
  return {
    index,
    summary: clipText(str(record.summary), 2000),
    events: boundedStrings(record.events, MAX_CHAPTER_EVENTS),
    characters: boundedStrings(record.characters, 40),
    actions: boundedStrings(record.actions, 40),
    time: clipText(str(record.time), 200),
    location: clipText(str(record.location), 200),
    endingState: clipText(str(record.endingState ?? record.ending_state), 500),
    newSettings: boundedStrings(record.newSettings ?? record.new_settings, 40),
    foreshadowsPlanted: boundedStrings(
      record.foreshadowsPlanted ?? record.foreshadows_planted,
      30,
    ),
    foreshadowsResolved: boundedStrings(
      record.foreshadowsResolved ?? record.foreshadows_resolved,
      30,
    ),
    source: normalizeSource(record.source),
    updatedAt: str(record.updatedAt ?? record.updated_at, nowIso()),
  };
}

export function normalizeVolumeMemory(input: unknown): VolumeMemory | null {
  const record = (input ?? {}) as Record<string, unknown>;
  const startChapter = positiveInt(record.startChapter ?? record.start_chapter, 0);
  const endChapter = positiveInt(record.endChapter ?? record.end_chapter, 0);
  if (!startChapter || !endChapter) return null;
  const start = Math.min(startChapter, endChapter);
  const end = Math.max(startChapter, endChapter);
  return {
    id: str(record.id, `volume-${start}-${end}`).trim() || `volume-${start}-${end}`,
    title: clipText(str(record.title, `第 ${start}-${end} 章`), 120),
    startChapter: start,
    endChapter: end,
    goal: clipText(str(record.goal), 2000),
    events: boundedStrings(record.events, MAX_VOLUME_EVENTS),
    characterChanges: boundedStrings(record.characterChanges ?? record.character_changes, 40),
    conflicts: boundedStrings(record.conflicts, 30),
    foreshadows: boundedStrings(record.foreshadows, 30),
    links: clipText(str(record.links), 1000),
    summary: clipText(str(record.summary), 3000),
    source: normalizeAutoSource(record.source),
    updatedAt: str(record.updatedAt ?? record.updated_at, nowIso()),
  };
}

export function normalizeBookMemory(input: unknown): BookMemory {
  const record = (input ?? {}) as Record<string, unknown>;
  return {
    logline: clipText(str(record.logline), 500),
    tags: boundedStrings(record.tags, 20),
    worldview: clipText(str(record.worldview), 5000),
    mainline: clipText(str(record.mainline), 5000),
    coreCharacters: boundedStrings(record.coreCharacters ?? record.core_characters, 30),
    coreRules: boundedStrings(record.coreRules ?? record.core_rules, 40),
    finalGoal: clipText(str(record.finalGoal ?? record.final_goal), 2000),
    keyConflicts: boundedStrings(record.keyConflicts ?? record.key_conflicts, 30),
    summary: clipText(str(record.summary), 4000),
    source: normalizeAutoSource(record.source),
    updatedAt: str(record.updatedAt ?? record.updated_at, nowIso()),
  };
}

export function normalizeMemory(input: unknown): ProjectMemory {
  const record = (input ?? {}) as Record<string, unknown>;
  const chapters: Record<string, ChapterMemory> = {};
  const rawChapters =
    record.chapters && typeof record.chapters === "object"
      ? (record.chapters as Record<string, unknown>)
      : {};
  for (const [key, value] of Object.entries(rawChapters)) {
    const fallbackIndex = Number(key);
    const memory = normalizeChapterMemory(value, fallbackIndex);
    if (memory) chapters[String(memory.index)] = memory;
  }

  const volumes = Array.isArray(record.volumes)
    ? record.volumes
        .map(normalizeVolumeMemory)
        .filter((item): item is VolumeMemory => Boolean(item))
    : [];
  volumes.sort((a, b) => a.startChapter - b.startChapter || a.endChapter - b.endChapter);

  return {
    version: 1,
    book: normalizeBookMemory(record.book),
    volumes,
    chapters,
    updatedAt: str(record.updatedAt ?? record.updated_at, nowIso()),
  };
}

export function normalizeExtractedMemory(input: unknown): ExtractedMemory | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  return {
    events: boundedStrings(record.events, 20),
    characters: boundedStrings(record.characters, 30),
    actions: boundedStrings(record.actions, 30),
    time: clipText(str(record.time), 200),
    location: clipText(str(record.location), 200),
    endingState: clipText(str(record.endingState ?? record.ending_state), 500),
    newSettings: boundedStrings(record.newSettings ?? record.new_settings, 30),
    foreshadowsPlanted: boundedStrings(
      record.foreshadowsPlanted ?? record.foreshadows_planted,
      20,
    ),
    foreshadowsResolved: boundedStrings(
      record.foreshadowsResolved ?? record.foreshadows_resolved,
      20,
    ),
  };
}

// 模型偶尔把细纲里的名字带进记忆；人物名必须在正文出现，避免污染检索。
export function groundExtractedMemory(
  memory: ExtractedMemory,
  chapterText: string,
): ExtractedMemory {
  const appears = (value: string): boolean => {
    const trimmed = value.trim();
    return trimmed.length > 0 && chapterText.includes(trimmed);
  };
  return {
    ...memory,
    characters: memory.characters.filter(appears),
    actions: memory.actions.filter((action) => {
      const name = action.split(/[：:]/)[0]?.trim() ?? "";
      return !name || appears(name);
    }),
  };
}

export function buildChapterMemory(
  index: number,
  summary: string,
  extracted: ExtractedFacts | undefined,
  source: ChapterMemory["source"],
  updatedAt = nowIso(),
): ChapterMemory {
  const memory = extracted?.memory;
  return {
    index,
    summary: clipText(extracted?.summary || summary, 2000),
    events: memory?.events ?? [],
    characters: uniqueStrings([
      ...(memory?.characters ?? []),
      ...(extracted?.characters.map((item) => item.name) ?? []),
    ]).slice(0, 40),
    actions: memory?.actions ?? [],
    time: memory?.time ?? "",
    location: memory?.location ?? "",
    endingState: memory?.endingState ?? "",
    newSettings: uniqueStrings([
      ...(memory?.newSettings ?? []),
      ...(extracted?.rules ?? []),
    ]).slice(0, 40),
    foreshadowsPlanted: memory?.foreshadowsPlanted ?? [],
    foreshadowsResolved: memory?.foreshadowsResolved ?? [],
    source,
    updatedAt,
  };
}

function chineseNumberToInt(input: string): number | null {
  const raw = input.trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw);

  const digits: Record<string, number> = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
  let total = 0;
  let current = 0;
  for (const char of raw) {
    if (char in digits) {
      current = digits[char];
      continue;
    }
    const unit = units[char];
    if (!unit) return null;
    total += (current || 1) * unit;
    current = 0;
  }
  return total + current || null;
}

interface ParsedVolume {
  number: number;
  title: string;
  startChapter: number;
  endChapter: number;
  goal: string;
}

export function parseVolumesFromOutline(outlineMd: string): ParsedVolume[] {
  const result: ParsedVolume[] = [];
  const seen = new Set<string>();
  const pattern =
    /^\s*[-*]?\s*第\s*([零〇一二两三四五六七八九十百千\d]+)\s*卷\s*[（(]\s*(\d+)\s*[-–—~至到]\s*(\d+)\s*章\s*[）)]\s*[：:]?\s*(.*)$/u;
  for (const line of outlineMd.split(/\r?\n/)) {
    const match = pattern.exec(line);
    if (!match) continue;
    const number = chineseNumberToInt(match[1]);
    const startChapter = Number(match[2]);
    const endChapter = Number(match[3]);
    if (!number || !Number.isInteger(startChapter) || !Number.isInteger(endChapter)) continue;
    if (startChapter < 1 || endChapter < startChapter) continue;
    const goal = match[4].trim().replace(/[。；;]+$/u, "");
    const firstSentence = goal.split(/[。；;\n]/u)[0]?.trim() ?? "";
    const title =
      firstSentence && firstSentence.length <= 16
        ? `第${number}卷 · ${firstSentence}`
        : `第${number}卷`;
    const key = `${startChapter}-${endChapter}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ number, title, startChapter, endChapter, goal });
  }
  return result.sort((a, b) => a.startChapter - b.startChapter);
}

export interface ParsedForeshadow {
  text: string;
  plantedChapter: number;
  resolvedChapter: number;
}

export function parseOutlineForeshadows(outlineMd: string): ParsedForeshadow[] {
  const result: ParsedForeshadow[] = [];
  const seen = new Set<string>();
  const pattern =
    /(?:伏笔\s*[：:]\s*)?(.{2,300}?)[（(]\s*第\s*(\d+)\s*章\s*埋[，,、\s]*第\s*(\d+)\s*章\s*回收\s*[）)]/u;
  for (const line of outlineMd.split(/\r?\n/)) {
    const match = pattern.exec(line.replace(/^[-*]\s*/u, ""));
    if (!match) continue;
    const text = match[1].replace(/^[-*]\s*/u, "").trim();
    const plantedChapter = Number(match[2]);
    const resolvedChapter = Number(match[3]);
    if (!text || !Number.isInteger(plantedChapter) || !Number.isInteger(resolvedChapter)) {
      continue;
    }
    const key = normalizeKey(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push({ text, plantedChapter, resolvedChapter });
  }
  return result;
}

function chapterIndexes(detail: ProjectDetail): number[] {
  return detail.chapters
    .filter((chapter) => chapter.written && chapter.content.trim())
    .map((chapter) => chapter.index)
    .sort((a, b) => a - b);
}

function parseVolumeRanges(detail: ProjectDetail, written: number[]): ParsedVolume[] {
  const parsed = parseVolumesFromOutline(detail.outlineMd);
  if (!written.length) return parsed;
  const covered = new Set<number>();
  for (const volume of parsed) {
    for (let index = volume.startChapter; index <= volume.endChapter; index += 1) {
      covered.add(index);
    }
  }
  const uncovered = written.filter((index) => !covered.has(index));
  if (!uncovered.length) return parsed;

  const auto: ParsedVolume[] = [];
  let start = uncovered[0];
  let previous = uncovered[0];
  let number = parsed.length + 1;
  const push = (from: number, to: number) => {
    auto.push({
      number,
      title: `第${number}卷（自动）`,
      startChapter: from,
      endChapter: to,
      goal: "自动划分：覆盖分卷结构中尚未声明的已写章节。",
    });
    number += 1;
  };
  for (const index of uncovered.slice(1)) {
    if (index === previous + 1) {
      previous = index;
      continue;
    }
    push(start, previous);
    start = index;
    previous = index;
  }
  push(start, previous);
  return [...parsed, ...auto];
}

export function seedChapterMemory(detail: ProjectDetail, index: number): ChapterMemory {
  const chapter = detail.chapters.find((item) => item.index === index);
  const plan = detail.plan.chapters.find((item) => item.index === index);
  const summary = detail.state.summaries[String(index)] || plan?.summary || "";
  const canon = detail.canon;
  const characters = canon.characters.filter(
    (item) => item.chapter === index || item.statusChapter === index,
  );
  const items = canon.items.filter((item) => item.chapter === index);
  const deadlines = canon.timeline.deadlines.filter((item) => item.chapter === index);
  return {
    index,
    summary: clipText(summary, 2000),
    events: [],
    characters: uniqueStrings(characters.map((item) => item.name)).slice(0, 40),
    actions: [],
    time: "",
    location: uniqueStrings(
      characters.map((item) => item.location).filter(Boolean),
    )
      .slice(0, 3)
      .join("、"),
    endingState: "",
    newSettings: uniqueStrings([
      ...items.map((item) => `物品：${item.name}`),
      ...deadlines.map((item) => `期限：${item.name}`),
    ]).slice(0, 40),
    // 大纲里的伏笔只是计划，不能因为章节已写就视为已经埋设。
    // 实际埋设/回收只能来自正文抽取结果（写章节时写入记忆）。
    foreshadowsPlanted: [],
    foreshadowsResolved: [],
    source: "summary",
    updatedAt: detail.state.updatedAt || detail.meta.updatedAt || nowIso(),
  };
}

function chapterMemoryMap(
  detail: ProjectDetail,
  stored: ProjectMemory,
): Record<string, ChapterMemory> {
  const result: Record<string, ChapterMemory> = { ...stored.chapters };
  for (const index of chapterIndexes(detail)) {
    const existing = result[String(index)];
    if (existing) {
      if (!existing.summary) {
        const plan = detail.plan.chapters.find((item) => item.index === index);
        existing.summary =
          detail.state.summaries[String(index)] || plan?.summary || "";
      }
      continue;
    }
    result[String(index)] = seedChapterMemory(detail, index);
  }
  return result;
}

export function collectOpenForeshadows(
  memory: Pick<ProjectMemory, "chapters">,
  beforeChapter: number,
): OpenForeshadow[] {
  const chapters = Object.values(memory.chapters)
    // source=summary 的记忆来自大纲/摘要自动派生，不能作为伏笔实际埋设或回收的证据。
    .filter((item) => item.index < beforeChapter && item.source !== "summary")
    .sort((a, b) => a.index - b.index);
  const planted: OpenForeshadow[] = [];
  for (const chapter of chapters) {
    for (const text of chapter.foreshadowsPlanted) {
      planted.push({ text, plantedChapter: chapter.index });
    }
  }

  const resolved = new Set<string>();
  for (const chapter of chapters) {
    for (const text of chapter.foreshadowsResolved) {
      resolved.add(normalizeKey(text));
    }
  }
  const isResolved = (text: string): boolean => {
    const key = normalizeKey(text);
    if (!key) return false;
    if (resolved.has(key)) return true;
    for (const candidate of resolved) {
      if (candidate.length >= 4 && (candidate.includes(key) || key.includes(candidate))) {
        return true;
      }
    }
    return false;
  };

  const seen = new Set<string>();
  return planted
    .filter((item) => {
      const key = normalizeKey(item.text);
      if (!key || isResolved(item.text) || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.plantedChapter - b.plantedChapter)
    .slice(0, 20);
}

function aggregateVolume(
  detail: ProjectDetail,
  chapters: Record<string, ChapterMemory>,
  range: ParsedVolume,
  updatedAt: string,
): VolumeMemory {
  const memories = Object.values(chapters)
    .filter((item) => item.index >= range.startChapter && item.index <= range.endChapter)
    .sort((a, b) => a.index - b.index);
  const planChapters = detail.plan.chapters.filter(
    (item) => item.index >= range.startChapter && item.index <= range.endChapter,
  );
  const open = collectOpenForeshadows({ chapters }, range.endChapter + 1).filter(
    (item) => item.plantedChapter >= range.startChapter,
  );
  const summary = clipText(
    memories
      .map((item) => `第 ${item.index} 章：${item.summary}`)
      .filter((line) => line.trim().length > 4)
      .join("\n"),
    3000,
  );
  return {
    id: `volume-${range.startChapter}-${range.endChapter}`,
    title: range.title,
    startChapter: range.startChapter,
    endChapter: range.endChapter,
    goal: clipText(range.goal, 2000),
    events: uniqueStrings(memories.flatMap((item) => item.events)).slice(0, MAX_VOLUME_EVENTS),
    characterChanges: uniqueStrings(memories.flatMap((item) => item.actions)).slice(0, 40),
    conflicts: uniqueStrings(planChapters.flatMap((item) => item.keyBeats)).slice(0, 30),
    foreshadows: open.map((item) => item.text).slice(0, 30),
    links: "",
    summary,
    source: "auto",
    updatedAt,
  };
}

export function aggregateVolumes(
  detail: ProjectDetail,
  chapters: Record<string, ChapterMemory>,
  storedVolumes: VolumeMemory[],
  updatedAt = nowIso(),
): VolumeMemory[] {
  const written = chapterIndexes(detail);
  const ranges = parseVolumeRanges(detail, written);
  const stored = storedVolumes
    .map(normalizeVolumeMemory)
    .filter((item): item is VolumeMemory => Boolean(item));
  const byRange = new Map<string, VolumeMemory>();
  for (const volume of stored) {
    byRange.set(`${volume.startChapter}-${volume.endChapter}`, volume);
  }

  const result: VolumeMemory[] = [];
  const used = new Set<string>();
  for (const range of ranges) {
    const key = `${range.startChapter}-${range.endChapter}`;
    const existing = byRange.get(key);
    if (existing?.source === "manual") {
      result.push(existing);
      used.add(key);
      continue;
    }
    result.push(aggregateVolume(detail, chapters, range, updatedAt));
    used.add(key);
  }
  // 用户手工维护、但不在当前大纲分卷范围内的卷也保留，避免编辑后消失。
  for (const volume of stored) {
    if (volume.source === "manual" && !used.has(`${volume.startChapter}-${volume.endChapter}`)) {
      result.push(volume);
    }
  }
  return result.sort((a, b) => a.startChapter - b.startChapter || a.endChapter - b.endChapter);
}

function extractMarkdownSection(markdown: string, names: string[]): string {
  const lines = markdown.split(/\r?\n/);
  const namesSet = new Set(names);
  for (let i = 0; i < lines.length; i += 1) {
    const heading = /^#{1,4}\s*(.+?)\s*$/u.exec(lines[i]);
    if (!heading || !namesSet.has(heading[1].trim())) continue;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^#{1,4}\s+/u.test(lines[j])) break;
      body.push(lines[j]);
    }
    const text = body.join("\n").trim();
    if (text) return text;
  }
  return "";
}

function extractBullets(section: string): string[] {
  return section
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*]\s*/u, "").trim())
    .filter((line) => line.length > 0)
    .slice(0, 20);
}

function extractMainline(outlineMd: string): string {
  const marker = outlineMd.split(/\r?\n/).findIndex((line) => /^#{1,4}\s*第?\s*\d+\s*章/u.test(line));
  const head = marker >= 0 ? outlineMd.split(/\r?\n/).slice(0, marker).join("\n") : outlineMd;
  return clipText(head, 3000);
}

export function aggregateBook(
  detail: ProjectDetail,
  volumes: VolumeMemory[],
  storedBook: BookMemory,
  updatedAt = nowIso(),
): BookMemory {
  if (storedBook.source === "manual") return storedBook;
  const coreCharacters = detail.characters
    .slice(0, 12)
    .map((item) => `${item.name}（${item.role || "角色"}）`);
  const conflictSection = extractMarkdownSection(detail.outlineMd, ["主线冲突", "核心矛盾"]);
  const goalSection =
    extractMarkdownSection(detail.outlineMd, ["最终目标", "故事最终目标"]) ||
    extractMarkdownSection(detail.bible, ["核心矛盾"]);
  const volumeSummary = volumes
    .map((item) => `${item.title}：${item.summary}`)
    .filter((line) => line.trim().length > 5)
    .join("\n");
  return {
    logline: detail.plan.logline,
    tags: detail.plan.tags,
    worldview: clipText(detail.bible, 4000),
    mainline: extractMainline(detail.outlineMd),
    coreCharacters,
    coreRules: detail.canon.rules.slice(0, 30),
    finalGoal: clipText(goalSection, 2000),
    keyConflicts: extractBullets(conflictSection),
    summary: clipText(
      [detail.plan.logline, volumeSummary].filter(Boolean).join("\n\n"),
      4000,
    ),
    source: "auto",
    updatedAt,
  };
}

export function buildEffectiveMemory(
  detail: ProjectDetail,
  storedInput: ProjectMemory | null | undefined,
): ProjectMemory {
  const stored = normalizeMemory(storedInput ?? emptyMemory());
  const updatedAt =
    [detail.state.updatedAt, detail.meta.updatedAt, stored.updatedAt]
      .filter(Boolean)
      .sort()
      .pop() || nowIso();
  const chapters = chapterMemoryMap(detail, stored);
  const volumes = aggregateVolumes(detail, chapters, stored.volumes, updatedAt);
  const book = aggregateBook(detail, volumes, stored.book, updatedAt);
  return { version: 1, book, volumes, chapters, updatedAt };
}

export function applyChapterMemory(
  detail: ProjectDetail,
  stored: ProjectMemory | null | undefined,
  chapterMemory: ChapterMemory,
): ProjectMemory {
  const normalized = normalizeMemory(stored ?? emptyMemory());
  const effective = buildEffectiveMemory(detail, normalized);
  effective.chapters[String(chapterMemory.index)] = chapterMemory;
  const updatedAt = nowIso();
  effective.volumes = aggregateVolumes(detail, effective.chapters, normalized.volumes, updatedAt);
  effective.book = aggregateBook(detail, effective.volumes, normalized.book, updatedAt);
  effective.updatedAt = updatedAt;
  return effective;
}

export function seedMemory(
  detail: ProjectDetail,
  stored: ProjectMemory | null | undefined,
): ProjectMemory {
  const effective = buildEffectiveMemory(detail, stored);
  effective.updatedAt = nowIso();
  return effective;
}

export interface MemoryStats {
  storedChapters: number;
  effectiveChapters: number;
  aiChapters: number;
  seedChapters: number;
  manualChapters: number;
  volumes: number;
  openForeshadows: number;
  updatedAt: string;
}

export function memoryStats(
  detail: ProjectDetail,
  effective: ProjectMemory,
  stored: ProjectMemory,
): MemoryStats {
  const memories = Object.values(effective.chapters);
  const maxChapter = detail.chapters.reduce(
    (max, chapter) => Math.max(max, chapter.index),
    0,
  );
  return {
    storedChapters: Object.keys(stored.chapters).length,
    effectiveChapters: memories.length,
    aiChapters: memories.filter((item) => item.source === "ai").length,
    seedChapters: memories.filter((item) => item.source === "summary").length,
    manualChapters: memories.filter((item) => item.source === "manual").length,
    volumes: effective.volumes.length,
    openForeshadows: collectOpenForeshadows(effective, maxChapter + 1).length,
    updatedAt: effective.updatedAt,
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
  return [...result].slice(0, 100);
}

function collectRelevantNames(
  canon: CanonFacts,
  characters: Character[],
  text: string,
): string[] {
  const names = new Set<string>();
  for (const item of canon.characters) {
    if ([item.name, ...item.aliases].some((name) => name && text.includes(name))) {
      names.add(item.name);
    }
  }
  for (const item of characters) {
    if (item.name && text.includes(item.name)) names.add(item.name);
  }
  return [...names];
}

function chapterSearchText(memory: ChapterMemory): string {
  return [
    memory.summary,
    ...memory.events,
    ...memory.characters,
    ...memory.actions,
    ...memory.newSettings,
    ...memory.foreshadowsPlanted,
    ...memory.foreshadowsResolved,
    memory.time,
    memory.location,
    memory.endingState,
  ]
    .filter(Boolean)
    .join("\n");
}

function scoreChapter(
  memory: ChapterMemory,
  tokens: string[],
  names: string[],
  target: number,
): number {
  const hay = chapterSearchText(memory);
  let score = 0;
  for (const token of tokens) {
    if (hay.includes(token)) score += 2;
  }
  for (const name of names) {
    if (memory.characters.includes(name) || hay.includes(name)) score += 6;
  }
  const gap = Math.max(0, target - memory.index);
  return score + Math.max(0, 2 - gap / 20);
}

function canonicalCharacterLine(item: CanonCharacter): string {
  const status =
    item.status === "dead"
      ? `第 ${item.statusChapter} 章死亡`
      : item.status === "unknown"
        ? "状态未知"
        : `第 ${item.statusChapter || item.chapter} 章状态`;
  const location = item.location ? `；位置：${clipText(item.location, 80)}` : "";
  const note = item.note ? `；${clipText(item.note, 160)}` : "";
  return `- ${item.name}（${status}${location}${note}）`;
}

function canonicalItemLine(item: CanonItem): string {
  const holder = item.holder ? `；持有人：${item.holder}` : "";
  const state = item.state ? `；${item.state}` : "";
  const note = item.note ? `；${clipText(item.note, 120)}` : "";
  return `- ${item.name}（第 ${item.chapter} 章${holder}${state}${note}）`;
}

function characterCardLine(item: Character): string {
  const role = item.role ? `（${item.role}）` : "";
  const relationships = item.relationships
    ? `；关系：${clipText(item.relationships, 160)}`
    : "";
  return `- ${item.name}${role}${relationships}`;
}

function foreshadowLine(item: OpenForeshadow): string {
  return `- [第 ${item.plantedChapter} 章埋] ${clipText(item.text, 240)}`;
}

function chapterContextLine(memory: ChapterMemory): string {
  const parts = [`第 ${memory.index} 章：${clipText(memory.summary, 360)}`];
  if (memory.events.length) {
    parts.push(`事件：${memory.events.slice(0, 5).map((item) => clipText(item, 120)).join("；")}`);
  }
  if (memory.characters.length) {
    parts.push(`人物：${memory.characters.slice(0, 8).join("、")}`);
  }
  if (memory.time) parts.push(`时间：${clipText(memory.time, 80)}`);
  if (memory.location) parts.push(`地点：${clipText(memory.location, 80)}`);
  if (memory.endingState) parts.push(`章末：${clipText(memory.endingState, 180)}`);
  return `- ${parts.join("；")}`;
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
  const ordered = [...sections]
    .filter((section) => section.lines.length > 0)
    .sort((a, b) => b.priority - a.priority);
  const selected: string[] = [];
  let used = 0;
  let truncated = false;
  for (const section of ordered) {
    const body = `【${section.title}】\n${section.lines.join("\n")}`;
    if (used + body.length + 2 <= budget) {
      selected.push(body);
      used += body.length + 2;
      continue;
    }
    // 高优先级内容即使超预算也要保留一部分，低优先级直接舍弃。
    if (section.priority >= 85) {
      const remaining = budget - used - section.title.length - 8;
      if (remaining > 80) {
        selected.push(`【${section.title}】\n${clipText(section.lines.join("\n"), remaining)}`);
        used = budget;
      }
      truncated = true;
      continue;
    }
    truncated = true;
  }
  return { text: selected.join("\n\n"), truncated };
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2);
}

export function buildMemoryContext(
  detail: ProjectDetail,
  chapter: ChapterPlan,
  storedMemory: ProjectMemory | null | undefined,
  options: { budget?: number; recentWindow?: number } = {},
): MemoryRetrievalResult {
  const memory = buildEffectiveMemory(detail, storedMemory);
  const target = chapter.index;
  const canon = canonForChapter(detail.canon, target);
  const planText = [chapter.title, chapter.summary, ...chapter.keyBeats].filter(Boolean).join("\n");
  const tokens = tokenize(planText);
  const names = collectRelevantNames(canon, detail.characters, planText);
  const recentWindow = options.recentWindow ?? RECENT_SUMMARY_WINDOW;
  const threshold = target - recentWindow;
  const allChapterMemories = Object.values(memory.chapters)
    .filter((item) => item.index < target)
    .sort((a, b) => a.index - b.index);

  const scored = allChapterMemories
    .filter((item) => item.index < threshold)
    .map((item) => ({ memory: item, score: scoreChapter(item, tokens, names, target) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.memory.index - a.memory.index)
    .slice(0, MAX_CHAPTERS_IN_CONTEXT)
    .sort((a, b) => a.memory.index - b.memory.index);
  const relevantChapters = scored.map((item) => item.memory);
  const chapterText = relevantChapters.map(chapterSearchText).join("\n");

  const relevantCanonCharacters = canon.characters
    .filter((item) => {
      if (item.status === "dead") return true;
      return [item.name, ...item.aliases].some(
        (name) => name && (planText.includes(name) || chapterText.includes(name)),
      );
    })
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === "dead" ? -1 : 1;
      return b.chapter - a.chapter;
    })
    .slice(0, 20);
  const relevantCards = detail.characters
    .filter((item) => item.name && (planText.includes(item.name) || chapterText.includes(item.name)))
    .slice(0, 8);
  const relevantItems = canon.items
    .filter((item) =>
      [item.name, ...item.aliases].some(
        (name) => name && (planText.includes(name) || chapterText.includes(name)),
      ),
    )
    .slice(0, 12);
  const matchedRules = canon.rules.filter((rule) =>
    tokens.some((token) => rule.includes(token)),
  );
  const rules = uniqueStrings([...matchedRules, ...canon.rules]).slice(0, 12);
  const deadlines = canon.timeline.deadlines.slice(0, 10);
  const open = collectOpenForeshadows(memory, target).slice(0, 12);
  const currentVolume =
    memory.volumes.find(
      (item) => target >= item.startChapter && target <= item.endChapter,
    ) ??
    [...memory.volumes].reverse().find((item) => item.startChapter < target) ??
    memory.volumes[0];

  const book = memory.book;
  const bookLines = [
    book.logline ? `故事梗概：${clipText(book.logline, 300)}` : "",
    book.mainline ? `主线：${clipText(book.mainline, 1200)}` : "",
    book.keyConflicts.length ? `核心矛盾：${book.keyConflicts.join("；")}` : "",
    book.finalGoal ? `最终目标：${clipText(book.finalGoal, 500)}` : "",
    book.coreCharacters.length ? `核心人物：${book.coreCharacters.join("、")}` : "",
    book.coreRules.length ? `核心规则：${book.coreRules.slice(0, 8).join("；")}` : "",
  ].filter(Boolean);

  const volumeLines = currentVolume
    ? [
        `卷目标：${clipText(currentVolume.goal, 400)}`,
        currentVolume.events.length
          ? `主要事件：${currentVolume.events.slice(0, 6).map((item) => clipText(item, 100)).join("；")}`
          : "",
        currentVolume.characterChanges.length
          ? `人物变化：${currentVolume.characterChanges.slice(0, 6).map((item) => clipText(item, 100)).join("；")}`
          : "",
        currentVolume.conflicts.length
          ? `本卷冲突：${currentVolume.conflicts.slice(0, 6).map((item) => clipText(item, 100)).join("；")}`
          : "",
        currentVolume.foreshadows.length
          ? `本卷伏笔：${currentVolume.foreshadows.slice(0, 6).map((item) => clipText(item, 100)).join("；")}`
          : "",
        currentVolume.summary ? `卷摘要：${clipText(currentVolume.summary, 1200)}` : "",
      ].filter(Boolean)
    : [];

  const sections: ContextSection[] = [
    {
      title: "全书记忆",
      lines: bookLines.length ? bookLines : ["（全书资料尚未生成）"],
      priority: 100,
    },
    ...(currentVolume
      ? [
          {
            title: `当前分卷：${currentVolume.title}（第 ${currentVolume.startChapter}-${currentVolume.endChapter} 章）`,
            lines: volumeLines,
            priority: 95,
          },
        ]
      : []),
    {
      title: "未回收伏笔",
      lines: open.length ? open.map(foreshadowLine) : ["（未检索到未回收伏笔）"],
      // 核心事实和未回收伏笔在预算紧张时优先于全书摘要。
      priority: 112,
    },
    {
      title: "相关人物",
      lines: [
        ...relevantCanonCharacters.map(canonicalCharacterLine),
        ...relevantCards.map(characterCardLine),
      ].length
        ? [...relevantCanonCharacters.map(canonicalCharacterLine), ...relevantCards.map(characterCardLine)]
        : ["（未检索到与本章直接相关的人物；不要虚构人物关系）"],
      priority: 108,
    },
    {
      title: "相关历史章节（只含摘要，不含正文）",
      lines: relevantChapters.length
        ? relevantChapters.map(chapterContextLine)
        : ["（未检索到与本章直接相关的历史章节；不要补写未记录的历史）"],
      priority: 80,
    },
    {
      title: "相关规则",
      lines: rules.length ? rules.map((rule) => `- ${clipText(rule, 240)}`) : ["（未检索到规则）"],
      priority: 70,
    },
    {
      title: "相关物品",
      lines: relevantItems.length
        ? relevantItems.map(canonicalItemLine)
        : ["（未检索到与本章直接相关的关键物品）"],
      priority: 60,
    },
    {
      title: "时间线",
      lines: [
        canon.timeline.currentDay ? `当前时间：${clipText(canon.timeline.currentDay, 160)}` : "",
        ...deadlines.map(
          (item) =>
            `- ${item.name}（到期：${item.due || "未知"}；第 ${item.chapter} 章${item.note ? `；${clipText(item.note, 80)}` : ""}）`,
        ),
      ].filter(Boolean),
      priority: 55,
    },
  ];

  const budget = options.budget ?? MEMORY_CHAR_BUDGET;
  const composed = composeSections(sections, budget);
  const fallback = "（未检索到长期记忆；不得自行补写为既定事实）";
  const text = composed.text || fallback;
  const sources = [
    ...relevantChapters.map((item) => `第 ${item.index} 章`),
    ...relevantCanonCharacters.map((item) => `人物：${item.name}`),
    ...relevantItems.map((item) => `物品：${item.name}`),
    ...open.map((item) => `伏笔：第 ${item.plantedChapter} 章`),
  ];
  return {
    chapter: target,
    text,
    tokenEstimate: estimateTokens(text),
    truncated: composed.truncated || text.length > budget,
    chapterIndices: relevantChapters.map((item) => item.index),
    sources,
    openForeshadows: open,
  };
}
