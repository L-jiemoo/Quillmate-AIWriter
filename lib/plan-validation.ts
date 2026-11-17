import type { ChapterPlan } from "./types";

export type PlanIssueSeverity = "critical" | "warning";

export interface PlanIssue {
  severity: PlanIssueSeverity;
  code: string;
  message: string;
  index?: number;
}

export interface PlanValidationOptions {
  // 项目目标章节数；超过为严重问题，不一致为提示。
  targetChapters?: number;
  // 本次生成/追加的预期章节数。
  expectedCount?: number;
  // 连续性检查的起始序号，默认 1。
  startIndex?: number;
  requireContiguous?: boolean;
  allowEmpty?: boolean;
}

export function parseChapterIndex(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && value > 0 ? value : null;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function chapterLabel(chapter: ChapterPlan | undefined, position: number): string {
  const index = chapter && Number.isInteger(chapter.index) ? chapter.index : null;
  return index ? `第 ${index} 章（第 ${position} 项）` : `第 ${position} 项`;
}

export function validateChapterPlans(
  chapters: ChapterPlan[],
  options: PlanValidationOptions = {},
): PlanIssue[] {
  const issues: PlanIssue[] = [];
  if (!Array.isArray(chapters)) {
    return [
      {
        severity: "critical",
        code: "invalid-list",
        message: "章节细纲必须是数组",
      },
    ];
  }

  if (!chapters.length && !options.allowEmpty) {
    issues.push({
      severity: "critical",
      code: "empty-plan",
      message: "章节细纲为空",
    });
  }

  const seen = new Set<number>();
  chapters.forEach((chapter, position) => {
    const label = chapterLabel(chapter, position + 1);
    if (!chapter || typeof chapter !== "object") {
      issues.push({
        severity: "critical",
        code: "invalid-chapter",
        message: `${label} 不是有效的章节对象`,
      });
      return;
    }

    if (!Number.isInteger(chapter.index) || chapter.index < 1) {
      issues.push({
        severity: "critical",
        code: "invalid-index",
        message: `${label} 的章节序号 ${String(chapter.index)} 不合法：必须是大于 0 的整数`,
        index: chapter.index,
      });
    } else if (seen.has(chapter.index)) {
      issues.push({
        severity: "critical",
        code: "duplicate-index",
        message: `章节序号重复：第 ${chapter.index} 章`,
        index: chapter.index,
      });
    } else {
      seen.add(chapter.index);
    }

    if (typeof chapter.title !== "string" || !chapter.title.trim()) {
      issues.push({
        severity: "critical",
        code: "empty-title",
        message: `${label} 标题为空`,
        index: chapter.index,
      });
    }
    if (typeof chapter.summary !== "string" || !chapter.summary.trim()) {
      issues.push({
        severity: "critical",
        code: "empty-summary",
        message: `${label} 摘要为空`,
        index: chapter.index,
      });
    }
    if (!Array.isArray(chapter.keyBeats)) {
      issues.push({
        severity: "critical",
        code: "invalid-key-beats",
        message: `${label} keyBeats 不是数组`,
        index: chapter.index,
      });
    }
  });

  if (options.expectedCount !== undefined && chapters.length !== options.expectedCount) {
    issues.push({
      severity: "critical",
      code: "count-mismatch",
      message: `章节数量为 ${chapters.length}，预期 ${options.expectedCount} 章`,
    });
  }

  if (options.targetChapters !== undefined) {
    if (chapters.length > options.targetChapters) {
      issues.push({
        severity: "critical",
        code: "exceeds-target",
        message: `章节数量 ${chapters.length} 超过项目目标 ${options.targetChapters} 章`,
      });
    } else if (chapters.length !== options.targetChapters) {
      issues.push({
        severity: "warning",
        code: "target-mismatch",
        message: `章节数量 ${chapters.length} 与项目目标 ${options.targetChapters} 章不一致`,
      });
    }
  }

  if (options.requireContiguous && seen.size) {
    const sorted = [...seen].sort((a, b) => a - b);
    const start = options.startIndex ?? 1;
    sorted.forEach((index, offset) => {
      const expected = start + offset;
      if (index !== expected) {
        issues.push({
          severity: "critical",
          code: "non-contiguous-index",
          message: `章节序号不连续：第 ${offset + 1} 个序号是第 ${index} 章，应为第 ${expected} 章`,
          index,
        });
      }
    });
  }

  return issues;
}

export function criticalPlanIssues(issues: PlanIssue[]): PlanIssue[] {
  return issues.filter((issue) => issue.severity === "critical");
}

export function formatPlanIssues(issues: PlanIssue[], limit = 8): string {
  const critical = criticalPlanIssues(issues);
  const shown = critical.slice(0, limit).map((issue) => `- ${issue.message}`);
  const rest = critical.length > limit ? `\n- 另有 ${critical.length - limit} 个问题未列出` : "";
  return `大纲校验未通过：\n${shown.join("\n")}${rest}`;
}

export function assertValidChapterPlans(
  chapters: ChapterPlan[],
  options: PlanValidationOptions = {},
): void {
  const issues = validateChapterPlans(chapters, options);
  if (criticalPlanIssues(issues).length) throw new Error(formatPlanIssues(issues));
}
