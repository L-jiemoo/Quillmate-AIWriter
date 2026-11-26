import path from "node:path";
import { writeJsonSafe } from "../storage";
import {
  getMemory,
  getProjectDetail,
  getStory,
  saveCanon,
  saveChapter,
  saveCharacters,
  saveMemory,
  savePlan,
  savePlanLedger,
  saveStory,
} from "../store";
import type {
  CanonFacts,
  PlanLedger,
  ProjectDetail,
  ProjectMemory,
  ProjectPlan,
  StoryLedger,
} from "../types";
import { nowIso } from "../utils";
import { skillProjectDir } from "./config";
import {
  CHARACTER_DESIGNS_FILENAME,
  characterDesignsPath,
  loadCharacterDesigns,
} from "./designs";
import { normalizeNameKey } from "./naming";
import { SkillError, type CharacterDesignRecord } from "./types";

export interface RenameChapterHit {
  index: number;
  title: string;
  occurrences: number;
}

export interface RenameReport {
  from: string;
  to: string;
  applied: boolean;
  // from 是否出现在人物档案或事实台账里。未登记时只做纯文本替换，需要提示用户。
  known: boolean;
  chapters: RenameChapterHit[];
  totals: {
    occurrences: number;
    chapters: number;
    characters: number;
    canon: number;
    plan: number;
    ledger: number;
    designs: number;
    memory: number;
    story: number;
    outline: number;
    world: number;
  };
  warnings: string[];
}

export interface RenameInput {
  from: string;
  to: string;
  dryRun?: boolean;
}

interface Replacer {
  replace(value: string): string;
  count: number;
}

// 中文人名没有词边界：直接 replace 会把「李明」改坏「李明华」。
// 先把包含 from 的其他已知专名换成占位符，替换完再还原，保证只命中完整人名。
export function createNameReplacer(
  from: string,
  to: string,
  knownNames: string[],
): Replacer {
  const guards = [...new Set(knownNames)]
    .filter((name) => name !== from && name.includes(from))
    .sort((left, right) => right.length - left.length);
  const replacer: Replacer = {
    count: 0,
    replace(value: string): string {
      if (!value.includes(from)) return value;
      let text = value;
      const tokens: [string, string][] = [];
      guards.forEach((guard, index) => {
        if (!text.includes(guard)) return;
        const token = `\u0000guard${index}\u0000`;
        tokens.push([token, guard]);
        text = text.split(guard).join(token);
      });
      const parts = text.split(from);
      replacer.count += parts.length - 1;
      text = parts.join(to);
      for (const [token, guard] of tokens) {
        text = text.split(token).join(guard);
      }
      return text;
    },
  };
  return replacer;
}

function replaceDeep<T>(value: T, replacer: Replacer): T {
  if (typeof value === "string") return replacer.replace(value) as T;
  if (Array.isArray(value)) {
    return value.map((item) => replaceDeep(item, replacer)) as T;
  }
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(source)) {
      next[key] = replaceDeep(item, replacer);
    }
    return next as T;
  }
  return value;
}

// 一次替换 + 计数，避免每个字段各写一套前后差值逻辑。
function replaceMeasured<T>(
  value: T,
  replacer: Replacer,
): { value: T; hits: number } {
  const before = replacer.count;
  const next = replaceDeep(value, replacer);
  return { value: next, hits: replacer.count - before };
}

function knownCharacterNames(detail: ProjectDetail): string[] {
  const names = new Set<string>();
  for (const character of detail.characters) {
    const name = character.name.trim();
    if (name) names.add(name);
  }
  for (const character of detail.canon.characters) {
    const name = character.name.trim();
    if (name) names.add(name);
    for (const alias of character.aliases ?? []) {
      const trimmed = alias.trim();
      if (trimmed) names.add(trimmed);
    }
  }
  return [...names];
}

function normalizeInput(input: RenameInput): {
  from: string;
  to: string;
  dryRun: boolean;
} {
  const from = (input.from ?? "").trim();
  const to = (input.to ?? "").trim();
  if (!from) throw new SkillError("SKILL_INPUT_INVALID", "请输入要修改的旧姓名");
  if (!to) throw new SkillError("SKILL_INPUT_INVALID", "请输入新姓名");
  if (from === to) {
    throw new SkillError("SKILL_INPUT_INVALID", "新旧姓名相同，不需要修改");
  }
  if (from.length > 40 || to.length > 40) {
    throw new SkillError("SKILL_INPUT_INVALID", "姓名过长，最多 40 个字符");
  }
  return { from, to, dryRun: input.dryRun === true };
}

// 全书改名：人物档案、事实台账、计划台账、记忆、剧情台账、设定稿与正文一起改。
// 只改档案不改正文，正文里的人名就会和台账脱节，后续润色的人名保护也会失效。
export async function renameCharacterEverywhere(
  slug: string,
  input: RenameInput,
): Promise<RenameReport> {
  const { from, to, dryRun } = normalizeInput(input);
  const detail = await getProjectDetail(slug);
  const names = knownCharacterNames(detail);
  const characterNames = new Set(
    detail.characters.map((item) => item.name.trim()).filter(Boolean),
  );
  const fromInCharacters = characterNames.has(from);
  const toInCharacters = characterNames.has(to);
  const known = names.includes(from);
  const warnings: string[] = [];

  if (names.includes(to)) {
    // 只有两张人物卡分别叫这两个名字时才是真冲突；
    // 若旧名只在台账/正文里残留，那是“人物卡已改名、正文没同步”，必须允许。
    if (fromInCharacters && toInCharacters) {
      throw new SkillError(
        "SKILL_INPUT_INVALID",
        `「${to}」已经是项目中的人物名或别名，请换一个姓名以避免重名`,
      );
    }
  } else {
    const toKey = normalizeNameKey(to);
    const similar = names.find(
      (name) => name !== from && normalizeNameKey(name) === toKey,
    );
    if (similar) {
      throw new SkillError(
        "SKILL_INPUT_INVALID",
        `「${to}」与已有姓名「${similar}」相同（仅空格/标点不同），请换一个姓名`,
      );
    }
  }

  const replacer = createNameReplacer(from, to, names);

  // 正文：逐章算出替换结果，只有命中的章节才会写回并生成版本记录。
  const chapterHits: RenameChapterHit[] = [];
  const chapterWrites: { index: number; content: string }[] = [];
  for (const chapter of detail.chapters) {
    if (!chapter.content.includes(from)) continue;
    const result = replaceMeasured(chapter.content, replacer);
    chapterHits.push({
      index: chapter.index,
      title: chapter.title,
      occurrences: result.hits,
    });
    if (result.hits > 0) {
      chapterWrites.push({ index: chapter.index, content: result.value });
    }
  }

  const planResult = replaceMeasured(detail.plan, replacer);
  const charactersResult = replaceMeasured(detail.characters, replacer);
  const canonResult = replaceMeasured(detail.canon, replacer);
  const bibleResult = replaceMeasured(detail.bible, replacer);
  const outlineResult = replaceMeasured(detail.outlineMd, replacer);
  const ledgerResult = detail.planLedger
    ? replaceMeasured(detail.planLedger, replacer)
    : { value: undefined, hits: 0 };
  const memory = await getMemory(slug);
  const memoryResult = replaceMeasured(memory, replacer);
  const story = await getStory(slug);
  const storyResult = replaceMeasured(story, replacer);

  const designs = await loadCharacterDesigns(slug);
  const designsResult = replaceMeasured(designs, replacer);
  const nextDesigns: Record<string, CharacterDesignRecord> = {};
  for (const [name, record] of Object.entries(designsResult.value)) {
    const targetName =
      normalizeNameKey(name) === normalizeNameKey(from) ? to : name;
    if (nextDesigns[targetName]) {
      warnings.push(
        `人物设定中「${name}」与「${targetName}」会落到同一条记录，已跳过前者，请手动核对`,
      );
      continue;
    }
    nextDesigns[targetName] = { ...record, name: targetName };
  }

  const occurrences = chapterHits.reduce(
    (sum, chapter) => sum + chapter.occurrences,
    0,
  );
  const totals: RenameReport["totals"] = {
    occurrences,
    chapters: chapterHits.length,
    characters: charactersResult.hits,
    canon: canonResult.hits,
    plan: planResult.hits,
    ledger: ledgerResult.hits,
    designs: designsResult.hits,
    memory: memoryResult.hits,
    story: storyResult.hits,
    outline: outlineResult.hits,
    world: bibleResult.hits,
  };

  if (!fromInCharacters) {
    warnings.push(
      toInCharacters
        ? `人物卡里已经找不到「${from}」，本次会把正文、台账与设定中残留的旧名同步为「${to}」`
        : `「${from}」不在人物卡中，本次只按文本替换；建议先把人物卡补上，后续润色才会保护这个人名`,
    );
  }
  const guarded = names.filter((name) => name !== from && name.includes(from));
  if (guarded.length) {
    warnings.push(
      `以下姓名包含「${from}」，已跳过以免改坏其他人名：${guarded.join("、")}`,
    );
  }

  const report: RenameReport = {
    from,
    to,
    applied: false,
    known,
    chapters: chapterHits,
    totals,
    warnings,
  };

  if (dryRun) return report;

  // 先改正文（saveChapter 会为每章保留历史版本），再同步档案与台账。
  // 中途失败时正文已是新名，重跑一次即可把剩余文件补齐（对已改内容幂等）。
  for (const item of chapterWrites) {
    await saveChapter(slug, item.index, item.content, undefined, {
      source: "user",
      note: `全书改名：${from} → ${to}`,
    });
  }
  await saveCharacters(slug, charactersResult.value, {
    markChangedAsUser: true,
  });
  await saveCanon(slug, canonResult.value as CanonFacts);
  await savePlan(
    slug,
    planResult.value as ProjectPlan,
    bibleResult.value,
    outlineResult.value,
  );
  if (ledgerResult.value) {
    await savePlanLedger(slug, ledgerResult.value as PlanLedger);
  }
  await saveMemory(slug, memoryResult.value as ProjectMemory);
  await saveStory(slug, storyResult.value as StoryLedger);
  await writeJsonSafe(
    characterDesignsPath(slug),
    {
      version: 1,
      designs: nextDesigns,
      updatedAt: nowIso(),
    },
    {
      backup: {
        dir: path.join(skillProjectDir(slug), "backups"),
        name: CHARACTER_DESIGNS_FILENAME,
        keep: 20,
      },
    },
  );

  return { ...report, applied: true };
}
