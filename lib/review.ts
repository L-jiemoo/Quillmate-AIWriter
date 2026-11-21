import { deadNameSuspicions, openingRepeatSuspicion } from "./canon";
import { applyChapterStory, storyChecks } from "./story";
import type {
  CanonFacts,
  ChapterMemory,
  ChapterPlan,
  ContinuityIssue,
  ExtractedStory,
  ProjectDetail,
  ProjectMemory,
  StoryCheckIssue,
  StoryLedger,
} from "./types";

const REPEAT_MIN_CHARS = 40;
const MAX_REPEAT_CHECKS = 3;

const STORY_ISSUE_TYPES: Record<StoryCheckIssue["code"], string> = {
  "same-time-different-locations": "地点/时间线",
  "dead-character-in-later-event": "死亡状态",
  "foreshadow-resolved-before-planted": "伏笔连续性",
  "broken-event-link": "剧情因果",
  "invalid-event-chapter": "时间线",
  "self-relation": "人物关系",
  "revival-without-event": "死亡状态",
};

export interface ReviewSuspicionInput {
  project: ProjectDetail;
  chapter: ChapterPlan;
  text: string;
  canon: CanonFacts;
  memory: ProjectMemory;
  story: StoryLedger;
  previousEnding: string;
  previousChapters: { index: number; content: string }[];
  extracted?: ExtractedStory;
  chapterMemory?: ChapterMemory;
}

export interface ReviewSuspicionResult {
  suspicions: ContinuityIssue[];
  hardIssues: ContinuityIssue[];
}

function compact(text: string): string {
  return text.replace(/\s+/gu, "");
}

function repeatedPassage(
  current: string,
  previous: string,
  size = REPEAT_MIN_CHARS,
): string {
  const currentText = compact(current);
  const previousText = compact(previous);
  if (currentText.length < size || previousText.length < size) return "";
  // 40 字连续重复已经很难是巧合；滑动窗口比对比逐字最长公共子串更适合长篇正文。
  const windows = new Set<string>();
  for (let index = 0; index + size <= previousText.length; index += 1) {
    windows.add(previousText.slice(index, index + size));
  }
  for (let index = 0; index + size <= currentText.length; index += 1) {
    const sample = currentText.slice(index, index + size);
    if (windows.has(sample)) return sample;
  }
  return "";
}

function chapterRepetitionSuspicion(
  chapter: ChapterPlan,
  text: string,
  previousChapters: { index: number; content: string }[],
): ContinuityIssue[] {
  const issues: ContinuityIssue[] = [];
  const recent = [...previousChapters]
    .sort((a, b) => b.index - a.index)
    .slice(0, MAX_REPEAT_CHECKS);
  for (const previous of recent) {
    const matched = repeatedPassage(text, previous.content);
    if (!matched) continue;
    issues.push({
      severity: "warning",
      type: "章节重复",
      evidence: matched.slice(0, 160),
      detail: `第 ${chapter.index} 章与第 ${previous.index} 章存在 ${matched.length} 字以上的连续重复，可能是在复述旧章而不是推进新剧情。`,
    });
  }
  return issues;
}

function beatAppears(beat: string, text: string): boolean {
  const trimmed = beat.trim();
  if (!trimmed) return false;
  if (text.includes(trimmed)) return true;
  // 允许模型在正文里改写措辞：细纲短语中的 2-3 字片段出现即可视为有对应。
  const chars = [...trimmed.replace(/\s+/gu, "")];
  for (let size = Math.min(4, chars.length); size >= 2; size -= 1) {
    for (let start = 0; start + size <= chars.length; start += 1) {
      const sample = chars.slice(start, start + size).join("");
      if (sample && text.includes(sample)) return true;
    }
  }
  return false;
}

function outlineDeviationSuspicion(
  chapter: ChapterPlan,
  text: string,
): ContinuityIssue[] {
  const beats = chapter.keyBeats.map((beat) => beat.trim()).filter(Boolean);
  if (!beats.length) return [];
  if (beats.some((beat) => beatAppears(beat, text))) return [];
  return [
    {
      severity: "warning",
      type: "大纲偏离",
      evidence: `第 ${chapter.index} 章细纲：${beats.slice(0, 5).join("；")}`,
      detail: `本章细纲的关键事件在正文中没有找到明确对应，可能偏离大纲；请确认是需要改正文，还是细纲已经过时。`,
    },
  ];
}

function storySuspicionsForChapter(
  input: ReviewSuspicionInput,
): ContinuityIssue[] {
  const chapterIndex = input.chapter.index;
  const next = applyChapterStory(
    input.project,
    input.memory,
    input.story,
    chapterIndex,
    input.extracted,
    input.chapterMemory,
  );
  return storyChecks(input.project, next)
    .filter(
      (issue) =>
        issue.chapter === chapterIndex ||
        issue.evidence.includes(`第 ${chapterIndex} 章`),
    )
    .map((issue) => ({
      severity: issue.severity === "critical" ? "critical" : "warning",
      type: STORY_ISSUE_TYPES[issue.code] ?? "剧情台账",
      evidence: issue.evidence,
      detail: `第 ${issue.chapter} 章剧情台账：${issue.message}`,
    }));
}

function uniqueIssues(issues: ContinuityIssue[]): ContinuityIssue[] {
  const seen = new Set<string>();
  const result: ContinuityIssue[] = [];
  for (const issue of issues) {
    const key = `${issue.severity}|${issue.type}|${issue.detail}|${issue.evidence}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(issue);
  }
  if (result.length <= 40) return result;
  const rank = (issue: ContinuityIssue): number =>
    issue.severity === "critical" ? 2 : issue.severity === "warning" ? 1 : 0;
  return [...result].sort((left, right) => rank(right) - rank(left)).slice(0, 40);
}

// 审校前的确定性检查：高置信度数据矛盾会作为 hardIssues 强制保留，
// 其余作为线索交给审校模型判断，避免机械规则误伤正常剧情。
export function reviewSuspicions(input: ReviewSuspicionInput): ReviewSuspicionResult {
  const storyIssues = storySuspicionsForChapter(input);
  const hardIssues = storyIssues.filter((issue) => issue.severity === "critical");
  const suspicions = uniqueIssues([
    ...deadNameSuspicions(input.canon, input.text, input.chapter.index),
    ...openingRepeatSuspicion(input.previousEnding, input.text),
    ...chapterRepetitionSuspicion(
      input.chapter,
      input.text,
      input.previousChapters,
    ),
    ...outlineDeviationSuspicion(input.chapter, input.text),
    ...storyIssues,
  ]);
  return { suspicions, hardIssues };
}
