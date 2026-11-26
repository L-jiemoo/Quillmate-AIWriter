import type { ChapterPlan, ProjectMeta, ProjectPlan } from "./types";
import type { PlanIssue } from "./plan-validation";

export const CHAPTER_SECTION_START = "<!-- quillmate:chapters:start -->";
export const CHAPTER_SECTION_END = "<!-- quillmate:chapters:end -->";

export interface OutlineChapterEntry {
  index: number;
  title: string;
}

// 模型和大纲里可能出现“第三十章”“第30章：夜行”等写法；比较标题时只保留本体。
export function normalizeOutlineTitle(title: string): string {
  return title
    .trim()
    .replace(/^第\s*\d+\s*章\s*[：:·.\-—\s]*/u, "")
    .replace(/[\s《》〈〉“”"'‘’]/gu, "")
    .toLowerCase();
}

const CHAPTER_HEADING =
  /^#{2,4}[ \t]*第\s*(\d+)\s*章(?:\s*[·•:：\-—]\s*(.*?))?\s*#*\s*$/gmu;

export function extractOutlineChapters(outlineMd: string): OutlineChapterEntry[] {
  const entries: OutlineChapterEntry[] = [];
  for (const match of outlineMd.matchAll(CHAPTER_HEADING)) {
    const index = Number(match[1]);
    if (!Number.isInteger(index) || index < 1) continue;
    entries.push({ index, title: (match[2] ?? "").trim() });
  }
  return entries;
}

export function buildChapterOutlineSection(chapters: ChapterPlan[]): string {
  if (!chapters.length) return "";
  const sorted = [...chapters].sort((a, b) => a.index - b.index);
  const lines = [CHAPTER_SECTION_START, "## 章节细纲（自动同步）", ""];
  for (const chapter of sorted) {
    lines.push(`### 第 ${chapter.index} 章 · ${chapter.title}`, "", chapter.summary, "");
    if (chapter.keyBeats.length) {
      lines.push(...chapter.keyBeats.map((beat) => `- ${beat}`), "");
    }
  }
  lines.push(CHAPTER_SECTION_END);
  return lines.join("\n");
}

export function appendChapterOutline(outlineMd: string, chapters: ChapterPlan[]): string {
  const section = buildChapterOutlineSection(chapters);
  if (!section) return outlineMd;
  const base = outlineMd.trimEnd();
  return `${base}${base ? "\n\n" : ""}${section}\n`;
}

// 删除章节时只重建自动同步的章节细纲段落，用户在标记之外写的主线内容保持原样。
export function removeChapterOutline(
  outlineMd: string,
  index: number,
  remaining: ChapterPlan[],
): string {
  const start = outlineMd.indexOf(CHAPTER_SECTION_START);
  const end = outlineMd.indexOf(CHAPTER_SECTION_END);
  if (start >= 0 && end > start) {
    const before = outlineMd.slice(0, start).replace(/\s+$/u, "");
    const after = outlineMd.slice(end + CHAPTER_SECTION_END.length).replace(/^\s*/u, "");
    const section = buildChapterOutlineSection(remaining);
    const parts = [before, section, after].filter((part) => part.trim().length > 0);
    return parts.length ? `${parts.join("\n\n").trimEnd()}\n` : "";
  }
  return removeOutlineHeadingBlock(outlineMd, index);
}

// 旧项目没有同步标记时，按标题层级删除该章小节，避免留下孤儿章节。
function removeOutlineHeadingBlock(markdown: string, index: number): string {
  const lines = markdown.split(/\r?\n/);
  const heading = new RegExp(
    `^(#{2,4})[ \\t]*第\\s*${index}\\s*章(?:[ \\t]|$|[·•:：\\-—])`,
  );
  let startLine = -1;
  let level = 0;
  for (let line = 0; line < lines.length; line += 1) {
    const match = heading.exec(lines[line]);
    if (match) {
      startLine = line;
      level = match[1].length;
      break;
    }
  }
  if (startLine < 0) return markdown;

  let endLine = lines.length;
  for (let line = startLine + 1; line < lines.length; line += 1) {
    const next = /^(#{1,6})[ \t]+/u.exec(lines[line]);
    if (next && next[1].length <= level) {
      endLine = line;
      break;
    }
  }

  const kept = [...lines.slice(0, startLine), ...lines.slice(endLine)]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return kept ? `${kept}\n` : "";
}

export function missingOutlineChapters(
  plan: ProjectPlan,
  outlineMd: string,
): ChapterPlan[] {
  const present = new Set(extractOutlineChapters(outlineMd).map((entry) => entry.index));
  return plan.chapters.filter((chapter) => !present.has(chapter.index));
}

// 只追加缺失章节，不改写用户在 outline.md 里已经写下的内容。
export function ensurePlanOutlineSync(
  outlineMd: string,
  chapters: ChapterPlan[],
): string {
  if (!chapters.length) return outlineMd;
  const present = new Set(extractOutlineChapters(outlineMd).map((entry) => entry.index));
  const missing = chapters.filter((chapter) => !present.has(chapter.index));
  return missing.length ? appendChapterOutline(outlineMd, missing) : outlineMd;
}

export function checkPlanOutlineConsistency(
  plan: ProjectPlan,
  outlineMd: string,
  meta: ProjectMeta,
): PlanIssue[] {
  const issues: PlanIssue[] = [];

  if (plan.chapters.length > meta.targetChapters) {
    issues.push({
      severity: "critical",
      code: "plan-exceeds-target",
      message: `大纲有 ${plan.chapters.length} 章，超过项目目标 ${meta.targetChapters} 章`,
    });
  } else if (plan.chapters.length !== meta.targetChapters) {
    issues.push({
      severity: "warning",
      code: "plan-target-mismatch",
      message: `大纲有 ${plan.chapters.length} 章，项目目标为 ${meta.targetChapters} 章`,
    });
  }

  if (!plan.chapters.length) return issues;

  if (!outlineMd.trim()) {
    issues.push({
      severity: "warning",
      code: "outline-empty",
      message: "主线大纲为空，无法确认是否已同步章节细纲",
    });
    return issues;
  }

  const entries = extractOutlineChapters(outlineMd);
  if (!entries.length) {
    issues.push({
      severity: "warning",
      code: "outline-no-chapters",
      message: "主线大纲没有章节列表，可自动补全缺失的章节细纲",
    });
    return issues;
  }

  const byIndex = new Map<number, OutlineChapterEntry[]>();
  for (const entry of entries) {
    const list = byIndex.get(entry.index) ?? [];
    list.push(entry);
    byIndex.set(entry.index, list);
  }

  const planIndexes = new Set(plan.chapters.map((chapter) => chapter.index));
  for (const chapter of plan.chapters) {
    const found = byIndex.get(chapter.index);
    if (!found?.length) {
      issues.push({
        severity: "warning",
        code: "outline-missing-chapter",
        message: `主线大纲缺少第 ${chapter.index} 章《${chapter.title}》，可自动补全`,
        index: chapter.index,
      });
      continue;
    }
    if (found.length > 1) {
      issues.push({
        severity: "warning",
        code: "outline-duplicate-chapter",
        message: `主线大纲中第 ${chapter.index} 章出现 ${found.length} 次`,
        index: chapter.index,
      });
    }
    const headingTitle = found[0].title;
    if (
      headingTitle &&
      normalizeOutlineTitle(headingTitle) !== normalizeOutlineTitle(chapter.title)
    ) {
      issues.push({
        severity: "warning",
        code: "outline-title-mismatch",
        message: `第 ${chapter.index} 章标题不一致：细纲为《${chapter.title}》，大纲为《${headingTitle}》`,
        index: chapter.index,
      });
    }
  }

  for (const entry of entries) {
    if (!planIndexes.has(entry.index)) {
      issues.push({
        severity: "warning",
        code: "outline-orphan-chapter",
        message: `主线大纲中的第 ${entry.index} 章不在章节细纲中，请人工确认`,
        index: entry.index,
      });
    }
  }

  return issues;
}
