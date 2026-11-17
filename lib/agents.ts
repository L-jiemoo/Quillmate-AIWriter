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
  characterMessages,
  extendMessages,
  factExtractorMessages,
  titleRepairMessages,
  writerMessages,
} from "./prompts";
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
): Promise<ChapterPlan[]> {
  const startIndex = plan.chapters.length
    ? Math.max(...plan.chapters.map((chapter) => chapter.index)) + 1
    : 1;

  if (isMock()) return mockExtendedChapters(meta, startIndex, count);

  const llm = new LLMClient();
  const data = await llm.json<Record<string, unknown>>(
    extendMessages(meta, plan, bible, outlineMd, recentSummaries, count, startIndex),
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
    ),
    { temperature: 0.1, agent: "auditor", chapter: chapter.index },
  );
  return normalizeReviewResult(data, chapter.summary);
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
): Promise<string> {
  if (isMock()) return chapterText;

  const llm = new LLMClient();
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
    ),
    { temperature: 0.2, agent: "repair-editor", chapter: chapter.index },
  );
  return stripFences(raw);
}
