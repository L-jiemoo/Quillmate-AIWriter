import { getRuntimeConfig } from "./config";
import { LLMClient } from "./llm";
import { mockChapter, mockCharacters, mockExtendedChapters, mockPlan, mockReview } from "./mock";
import {
  architectMessages,
  characterMessages,
  extendMessages,
  reviewerMessages,
  titleRepairMessages,
  writerMessages,
} from "./prompts";
import { normalizeCharacter } from "./store";
import type { ChapterPlan, Character, ProjectMeta, ProjectPlan, ReviewResult } from "./types";
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
  const data = await llm.json<Record<string, unknown>>(architectMessages(meta));
  const rawChapters = Array.isArray(data.chapters) ? data.chapters : [];
  // 模型输出不可全信：缺 index 的章节按数组顺序补号，
  // 缺标题的给默认名，最后按 index 排序，保证细纲可以直接落盘。
  const chapters: ChapterPlan[] = rawChapters
    .map((item, i) => {
      const record = (item ?? {}) as Record<string, unknown>;
      return {
        index: typeof record.index === "number" ? record.index : i + 1,
        title: str(record.title, `第 ${i + 1} 章`),
        summary: str(record.summary),
        keyBeats: arr(record.keyBeats ?? record.key_beats),
      };
    })
    .sort((a, b) => a.index - b.index);

  if (!chapters.length) throw new Error("架构师没有返回章节细纲，请重试或更换模型");

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
  );
  const items = Array.isArray(data.characters) ? data.characters : [];
  return items.map(normalizeCharacter).filter((character) => character.name.trim().length > 0);
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
): Promise<ChapterPlan[]> {
  const startIndex = plan.chapters.length
    ? Math.max(...plan.chapters.map((chapter) => chapter.index)) + 1
    : 1;

  if (isMock()) return mockExtendedChapters(meta, startIndex, count);

  const llm = new LLMClient();
  const data = await llm.json<Record<string, unknown>>(
    extendMessages(meta, plan, bible, outlineMd, recentSummaries, count, startIndex),
  );
  const raw = Array.isArray(data.chapters) ? data.chapters : [];
  // 模型可能多返回几章、或夹带空标题的行；先丢掉空项并截断到请求数量，
  // 再按 startIndex 重新编号，保证章节号连续且不受模型自报序号影响。
  const chapters = raw
    .map((item) => {
      const record = (item ?? {}) as Record<string, unknown>;
      return {
        index: startIndex,
        title: str(record.title),
        summary: str(record.summary),
        keyBeats: arr(record.keyBeats ?? record.key_beats),
      };
    })
    .filter((chapter) => chapter.title.trim() && chapter.summary.trim())
    .slice(0, count)
    .map((chapter, i) => ({ ...chapter, index: startIndex + i }));

  if (!chapters.length) {
    throw new Error("架构师没有返回新的章节细纲，请重试或更换模型");
  }

  await repairDuplicateTitles(
    llm,
    chapters,
    plan.chapters.map((chapter) => chapter.title),
  );
  return chapters;
}

export async function writeChapter(
  meta: ProjectMeta,
  bible: string,
  characters: Character[],
  chapter: ChapterPlan,
  history: string[],
): Promise<string> {
  if (isMock()) return mockChapter(meta, chapter);

  const llm = new LLMClient();
  const raw = await llm.chat(writerMessages(meta, bible, characters, chapter, history));
  // 部分模型会用 ```markdown 包裹正文，写入章节文件前去掉首尾围栏。
  return raw
    .replace(/^```[^\n]*\n/, "")
    .replace(/\n```\s*$/, "")
    .trim();
}

export async function reviewChapter(
  meta: ProjectMeta,
  bible: string,
  chapter: ChapterPlan,
  chapterText: string,
): Promise<ReviewResult> {
  if (isMock()) return mockReview(chapter);

  const llm = new LLMClient();
  const data = await llm.json<Record<string, unknown>>(
    reviewerMessages(meta, bible, chapter, chapterText),
  );
  return {
    summary: str(data.summary, chapter.summary),
    issues: arr(data.issues),
    continuityOk: Boolean(data.continuityOk ?? data.continuity_ok ?? true),
  };
}
