import { textContainsAnchor } from "./repair-patch";
import type { ContinuityIssue } from "./types";

const CHAPTER_REF = /第\s*\d+\s*章/gu;
const STRUCTURAL_HINT =
  /(?:只改本章|仅改本章|无法只改本章|需要作者|需作者|跨章|互斥|无法同时)/u;
const CONFLICT_HINT = /(?:冲突|矛盾|不一致|互斥)/u;

// 结构性问题：根源跨章、涉及细纲/台账互斥，或明确需要作者裁定。
// 这类问题不进补丁循环，直接走作者决策，避免一轮轮改出新的严重问题。
export function isStructuralRepairIssue(issue: ContinuityIssue): boolean {
  const text = `${issue.type}\n${issue.detail}\n${issue.evidence}`;
  if (issue.type.includes("设定冲突")) return true;
  if (
    issue.type.includes("大纲偏离") &&
    /台账|前文|第\s*\d+\s*章/u.test(text) &&
    /细纲|大纲/u.test(text) &&
    CONFLICT_HINT.test(text)
  ) {
    return true;
  }
  const chapterRefs = [...text.matchAll(CHAPTER_REF)].length;
  if (
    (STRUCTURAL_HINT.test(text) &&
      (CONFLICT_HINT.test(text) || /需作者|需要作者|无法同时/u.test(text))) ||
    (chapterRefs >= 2 &&
      CONFLICT_HINT.test(text) &&
      /剧情因果|物品归属|世界观规则|大纲偏离/u.test(issue.type))
  ) {
    return true;
  }
  return false;
}

export function structuralRepairIssues(
  issues: ContinuityIssue[],
): ContinuityIssue[] {
  return issues.filter(isStructuralRepairIssue);
}

// 作者确认的方案必须可执行：章节范围只能是当前章或更早章节，
// 锚点必须真实存在于对应章节，不能修改后文。
export function validateRepairDecisionOption(
  option: { affectedChapters: number[]; anchors: string[] },
  targetIndex: number,
  chapters: { index: number; content: string }[],
): string[] {
  const errors: string[] = [];
  const affected = new Set(option.affectedChapters);
  if (!affected.has(targetIndex)) {
    errors.push("方案没有包含当前章节");
  }
  const later = option.affectedChapters.filter((index) => index > targetIndex);
  if (later.length) {
    errors.push(`方案试图修改后文第 ${later.join("、")} 章`);
  }
  if (!option.anchors.length) {
    errors.push("方案没有提供可校验的原文锚点");
  }
  const texts = chapters.filter(
    (chapter) => chapter.index === targetIndex || affected.has(chapter.index),
  );
  for (const anchor of option.anchors) {
    const trimmed = anchor.trim();
    if (!trimmed) continue;
    if (!texts.some((chapter) => textContainsAnchor(chapter.content, trimmed))) {
      errors.push(`锚点不在授权章节正文中：${trimmed.slice(0, 40)}`);
    }
  }
  return errors;
}
