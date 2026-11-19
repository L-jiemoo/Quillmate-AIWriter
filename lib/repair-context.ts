import type {
  CanonFacts,
  ChapterPlan,
  Character,
  ContinuityIssue,
  ProjectDetail,
  StoryLedger,
} from "./types";

const DEFAULT_MAX_CHARS = 7000;
const MAX_SNIPPET_CHARS = 900;
const MAX_CHAPTERS = 8;

export interface EvidenceSnippet {
  chapter: number;
  title: string;
  snippet: string;
  locator: string;
  characters: string[];
  reason: string;
}

export interface RepairEvidenceContext {
  text: string;
  snippets: EvidenceSnippet[];
  missingChapters: number[];
}

interface Candidate {
  chapter: number;
  reason: string;
  keywords: string[];
}

function chapterRefs(value: string): number[] {
  const found = new Set<number>();
  for (const match of value.matchAll(/第\s*(\d+)\s*章/gu)) {
    const parsed = Number.parseInt(match[1], 10);
    if (Number.isInteger(parsed) && parsed > 0) found.add(parsed);
  }
  return [...found];
}

function issueText(issue: ContinuityIssue): string {
  return [issue.evidence, issue.detail, issue.sourceEvidence ?? ""].join("\n");
}

function affectedNames(
  issues: ContinuityIssue[],
  knownNames: string[],
): string[] {
  const names = new Set<string>();
  const issueTexts = issues.map((issue) => issueText(issue)).join("\n");
  for (const issue of issues) {
    for (const name of issue.affectedCharacters ?? []) {
      if (name.trim()) names.add(name.trim());
    }
  }
  for (const raw of knownNames) {
    const name = raw.trim();
    if (name.length >= 2 && issueTexts.includes(name)) names.add(name);
  }
  return [...names];
}

function locate(
  text: string,
  position: number,
  chapter: number,
): string {
  if (position <= 0) return `第 ${chapter} 章开头`;
  const line = text.slice(0, position).split(/\n/u).length;
  return `第 ${chapter} 章第 ${line} 行附近（约第 ${position} 字）`;
}

function snippetAround(
  text: string,
  keyword: string | null,
  chapter: number,
): { snippet: string; locator: string } {
  const trimmed = text.trim();
  if (!keyword) {
    return {
      snippet: trimmed.slice(0, MAX_SNIPPET_CHARS),
      locator: locate(trimmed, 0, chapter),
    };
  }
  const position = trimmed.indexOf(keyword);
  if (position < 0) {
    return {
      snippet: trimmed.slice(0, MAX_SNIPPET_CHARS),
      locator: locate(trimmed, 0, chapter),
    };
  }
  const start = Math.max(0, position - Math.floor(MAX_SNIPPET_CHARS / 3));
  const end = Math.min(trimmed.length, start + MAX_SNIPPET_CHARS);
  const prefix = start > 0 ? "……" : "";
  const suffix = end < trimmed.length ? "……" : "";
  return {
    snippet: `${prefix}${trimmed.slice(start, end)}${suffix}`,
    locator: locate(trimmed, position, chapter),
  };
}

function canonFacts(
  canon: CanonFacts | undefined,
  names: string[],
): string[] {
  if (!canon || !names.length) return [];
  const lines: string[] = [];
  for (const item of canon.characters) {
    if (!names.includes(item.name)) continue;
    lines.push(
      `人物状态：${item.name}｜${item.status}｜所在：${item.location || "未知"}${
        item.note ? `｜${item.note}` : ""
      }｜状态确立于第 ${item.statusChapter} 章`,
    );
  }
  for (const item of canon.items) {
    if (!names.some((name) => item.name.includes(name) || name.includes(item.name))) {
      continue;
    }
    lines.push(
      `物品：${item.name}｜持有人：${item.holder || "未知"}｜状态：${item.state || "未知"}｜确立于第 ${item.chapter} 章`,
    );
  }
  return lines;
}

function storyFacts(
  story: StoryLedger | undefined,
  names: string[],
  chapter: number,
): string[] {
  if (!story || !names.length) return [];
  const lines: string[] = [];
  for (const state of story.states) {
    if (!names.includes(state.name)) continue;
    lines.push(
      `剧情人物状态：${state.name}｜${state.lifeStatus}｜第 ${state.chapter} 章｜${state.identity || "身份未知"}`,
    );
  }
  for (const foreshadow of story.foreshadows) {
    if (
      !foreshadow.relatedCharacters.some((name) => names.includes(name)) &&
      !names.some((name) => foreshadow.text.includes(name))
    ) {
      continue;
    }
    lines.push(
      `伏笔：${foreshadow.text}｜埋设第 ${foreshadow.plantedChapter} 章｜状态：${foreshadow.status}｜回收章节：${
        foreshadow.resolvedChapter || "未回收"
      }${foreshadow.plantedChapter > chapter ? "（属于后文，仅用于衔接，不得据此否定本章）" : ""}`,
    );
  }
  return lines;
}

/**
 * 依据审校问题检索相关章节原文证据。
 * 优先级：问题明确引用的章节 > 涉及人物/事件 > 人物状态与伏笔 > 相邻章节 > 其他证据匹配章节。
 * 输出严格区分“原文摘录”和“事实台账”，不得把摘要当成原文。
 */
export function collectRepairEvidence(input: {
  project: ProjectDetail;
  chapter: ChapterPlan;
  issues: ContinuityIssue[];
  characters?: Character[];
  canon?: CanonFacts;
  story?: StoryLedger;
  maxChars?: number;
}): RepairEvidenceContext {
  const characters = input.characters ?? input.project.characters;
  const written = new Map(
    input.project.chapters
      .filter((item) => item.written && item.content.trim())
      .map((item) => [item.index, item]),
  );
  const names = affectedNames(input.issues, [
    ...characters.map((character) => character.name),
    ...(input.canon?.characters ?? []).map((character) => character.name),
  ]);
  const candidates = new Map<number, Candidate>();
  const missingChapters = new Set<number>();

  const addCandidate = (
    chapter: number,
    reason: string,
    keywords: string[] = [],
  ): void => {
    if (chapter === input.chapter.index) return;
    if (!written.has(chapter)) {
      if (chapter < input.chapter.index) missingChapters.add(chapter);
      return;
    }
    const current = candidates.get(chapter);
    if (!current) {
      candidates.set(chapter, { chapter, reason, keywords: [...keywords] });
      return;
    }
    for (const keyword of keywords) {
      if (!current.keywords.includes(keyword)) current.keywords.push(keyword);
    }
  };

  // 1. 问题明确引用的章节（含结构化字段）。
  for (const issue of input.issues) {
    const refs = new Set<number>(chapterRefs(issueText(issue)));
    if (issue.sourceChapter) refs.add(issue.sourceChapter);
    for (const ref of refs) {
      addCandidate(ref, "问题引用章节", names);
    }
  }

  // 2. 问题涉及的人物/事件：优先出现在问题原文中的章节。
  for (const name of names) {
    for (const chapter of written.values()) {
      if (chapter.content.includes(name)) {
        addCandidate(chapter.index, `涉及人物：${name}`, [name]);
      }
    }
  }

  // 3. 人物状态确认章节与相关伏笔的埋设/回收章节。
  for (const character of input.canon?.characters ?? []) {
    if (!names.includes(character.name)) continue;
    if (character.statusChapter > 0) {
      addCandidate(character.statusChapter, `${character.name} 的生死/状态来源`, []);
    }
  }
  for (const foreshadow of input.story?.foreshadows ?? []) {
    const related =
      foreshadow.relatedCharacters.some((name) => names.includes(name)) ||
      names.some((name) => foreshadow.text.includes(name));
    if (!related) continue;
    addCandidate(foreshadow.plantedChapter, "相关伏笔埋设", []);
    if (foreshadow.resolvedChapter > 0) {
      addCandidate(foreshadow.resolvedChapter, "相关伏笔回收", []);
    }
  }

  // 4. 相邻章节用于衔接检查。
  addCandidate(input.chapter.index - 1, "上一章衔接", []);
  addCandidate(input.chapter.index + 1, "下一章衔接", []);

  // 5. 其他包含问题证据片段的章节。
  for (const issue of input.issues) {
    const evidence = (issue.sourceEvidence || issue.evidence).trim();
    if (evidence.length < 6) continue;
    for (const chapter of written.values()) {
      if (chapter.content.includes(evidence)) {
        addCandidate(chapter.index, "包含问题原文片段", [evidence]);
      }
    }
  }

  const prioritized = [...candidates.values()]
    .sort((left, right) => {
      const score = (candidate: Candidate): number => {
        if (candidate.reason === "问题引用章节") return 0;
        if (candidate.reason.startsWith("涉及人物")) return 1;
        if (candidate.reason.includes("状态来源") || candidate.reason.includes("伏笔")) {
          return 2;
        }
        if (candidate.reason.includes("衔接")) return 3;
        return 4;
      };
      return score(left) - score(right) || left.chapter - right.chapter;
    })
    .slice(0, MAX_CHAPTERS);

  const maxChars = input.maxChars ?? DEFAULT_MAX_CHARS;
  const snippets: EvidenceSnippet[] = [];
  let used = 0;
  for (const candidate of prioritized) {
    const chapter = written.get(candidate.chapter);
    if (!chapter) continue;
    const keyword =
      candidate.keywords.find((item) => chapter.content.includes(item)) ?? null;
    const { snippet, locator } = snippetAround(chapter.content, keyword, candidate.chapter);
    const entry = {
      chapter: candidate.chapter,
      title: chapter.title,
      snippet,
      locator,
      characters: names.filter((name) => snippet.includes(name)),
      reason: candidate.reason,
    };
    const size = snippet.length;
    if (used + size > maxChars && snippets.length > 0) break;
    snippets.push(entry);
    used += size;
  }

  const ledger = [
    ...canonFacts(input.canon, names),
    ...storyFacts(input.story, names, input.chapter.index),
  ];

  const sections: string[] = [
    "【原文证据使用规则】以下内容按来源章节摘录自正式正文；事实台账单独标注，摘要与模型推断不得当作原文事实。修复时不得删除或改写证据来规避矛盾。",
  ];
  if (ledger.length) {
    sections.push(
      `【事实台账（硬约束，不是原文摘录）】\n${ledger.map((line) => `- ${line}`).join("\n")}`,
    );
  }
  if (missingChapters.size) {
    sections.push(
      `【缺失证据】以下被问题引用的章节没有可检索正文，不能凭想象补写：第 ${[
        ...missingChapters,
      ].join("、")} 章。`,
    );
  }
  if (!snippets.length) {
    sections.push("【原文证据】（未检索到可用的历史章节原文）");
  } else {
    snippets.forEach((item, index) => {
      sections.push(
        `【原文证据 ${index + 1}｜第 ${item.chapter} 章《${item.title}》｜${item.locator}｜检索原因：${item.reason}】\n${
          item.characters.length ? `涉及人物：${item.characters.join("、")}\n` : ""
        }（原文）${item.snippet}`,
      );
    });
  }

  return {
    text: sections.join("\n\n"),
    snippets,
    missingChapters: [...missingChapters].sort((a, b) => a - b),
  };
}
