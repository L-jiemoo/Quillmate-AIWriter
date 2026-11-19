import { createHash } from "node:crypto";
import type { ContinuityIssue } from "./types";

export interface RepairEdit {
  originalText: string;
  replacement: string;
  reason: string;
  // 缺省表示目标章节；跨章修复时必须与授权章节一致。
  chapterIndex?: number;
}

export interface RepairPatch {
  issueId: string;
  edits: RepairEdit[];
}

export interface EditRecord {
  issueId: string;
  chapterIndex: number;
  start: number;
  end: number;
  paragraph: number;
  originalLength: number;
  replacementLength: number;
  removed: string;
  added: string;
  reason: string;
}

export interface AppliedPatchBatch {
  text: string;
  records: EditRecord[];
  changedChars: number;
  paragraphs: number[];
}

export interface AppliedChapterBatch extends AppliedPatchBatch {
  chapterIndex: number;
}

export interface PatchChapter {
  index: number;
  text: string;
  extraAuthorizedAnchors?: string[];
}

export type RepairPatchErrorCode =
  | "EMPTY_BATCH"
  | "UNKNOWN_ISSUE"
  | "UNKNOWN_CHAPTER"
  | "UNCOVERED_ISSUE"
  | "EMPTY_EDIT"
  | "MISSING_REASON"
  | "UNCHANGED_EDIT"
  | "ANCHOR_NOT_FOUND"
  | "ANCHOR_NOT_UNIQUE"
  | "OVERLAP"
  | "NO_AUTHORIZED_PARAGRAPH"
  | "UNAUTHORIZED_SCOPE";

export class RepairPatchError extends Error {
  readonly code: RepairPatchErrorCode;
  readonly details: string[];

  constructor(code: RepairPatchErrorCode, message: string, details: string[] = []) {
    super(message);
    this.name = "RepairPatchError";
    this.code = code;
    this.details = details;
  }
}

export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function chapterNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function normalizeRepairPatches(input: unknown): RepairPatch[] {
  const record = (input ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(record.patches) ? record.patches : [];
  return raw.map((item) => {
    const patch = (item ?? {}) as Record<string, unknown>;
    const rawEdits = Array.isArray(patch.edits) ? patch.edits : [];
    return {
      issueId: str(patch.issueId ?? patch.issue_id).trim(),
      edits: rawEdits.map((edit) => {
        const value = (edit ?? {}) as Record<string, unknown>;
        return {
          originalText: str(value.originalText ?? value.original_text),
          replacement: str(value.replacement),
          reason: str(value.reason).trim(),
          chapterIndex: chapterNumber(
            value.chapterIndex ?? value.chapter_index,
          ),
        };
      }),
    };
  });
}

/**
 * 给基线问题补上稳定 ID 和原始证据。ID 只用于本次修复与补丁关联，
 * 不改变审校结果本身；旧项目数据缺少 ID 时按序号生成。
 */
export function withIssueIds(issues: ContinuityIssue[]): ContinuityIssue[] {
  const used = new Set<string>();
  return issues.map((issue, index) => {
    const base =
      issue.id?.trim() ||
      issue.fingerprint?.trim() ||
      `issue-${index + 1}`;
    let id = base;
    let suffix = 2;
    while (used.has(id)) {
      id = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(id);
    return {
      ...issue,
      id,
      sourceEvidence: issue.sourceEvidence?.trim() || issue.evidence,
    };
  });
}

interface Paragraph {
  index: number;
  start: number;
  end: number;
  text: string;
}

function paragraphsOf(text: string): Paragraph[] {
  const result: Paragraph[] = [];
  let start = 0;
  let index = 0;
  for (const line of text.split("\n")) {
    const end = start + line.length;
    result.push({ index, start, end, text: line });
    start = end + 1;
    index += 1;
  }
  return result;
}

function compact(value: string): string {
  return value.replace(/\s+/gu, "");
}

function anchorMatchesParagraph(anchor: string, paragraph: string): boolean {
  const trimmed = anchor.trim();
  if (trimmed.length < 2) return false;
  if (paragraph.includes(trimmed)) return true;
  const compactAnchor = compact(trimmed);
  if (compactAnchor.length < 4) return false;
  const compactParagraph = compact(paragraph);
  if (compactParagraph.includes(compactAnchor)) return true;
  const head = compactAnchor.slice(0, Math.min(24, compactAnchor.length));
  return head.length >= 4 && compactParagraph.includes(head);
}

// 审校证据常用“……”把不同段落的原文拼在一起，整条证据无法在正文中命中。
function evidenceFragments(anchor: string): string[] {
  return anchor
    .split(/…+|\.{3,}|⋯+/u)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2);
}

function authorizedParagraphs(text: string, anchors: string[]): Set<number> {
  const paragraphs = paragraphsOf(text);
  const fragments = anchors
    .filter(Boolean)
    .flatMap((anchor) => [anchor, ...evidenceFragments(anchor)]);
  const allowed = new Set<number>();
  for (const paragraph of paragraphs) {
    if (fragments.some((fragment) => anchorMatchesParagraph(fragment, paragraph.text))) {
      allowed.add(paragraph.index);
    }
  }
  return allowed;
}

function countOccurrences(text: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let position = text.indexOf(needle);
  while (position >= 0) {
    count += 1;
    position = text.indexOf(needle, position + needle.length);
  }
  return count;
}

interface LocatedEdit {
  issueId: string;
  chapterIndex: number;
  start: number;
  end: number;
  edit: RepairEdit;
}

/**
 * 校验并应用补丁批次。任何一项校验失败都会抛错，所有章节的补丁都不应用。
 * 目标章节按“问题证据”授权段落；跨章章节只能按额外授权的锚点（作者确认的方案）修改。
 */
export function applyRepairPatchesAcross(input: {
  chapters: PatchChapter[];
  targetIndex: number;
  patches: RepairPatch[];
  issues: ContinuityIssue[];
}): AppliedChapterBatch[] {
  const chapterMap = new Map(input.chapters.map((chapter) => [chapter.index, chapter]));
  const target = chapterMap.get(input.targetIndex);
  if (!target) {
    throw new RepairPatchError("UNKNOWN_CHAPTER", "目标章节正文不存在，无法应用补丁");
  }
  if (!input.patches.length) {
    throw new RepairPatchError("EMPTY_BATCH", "修复补丁为空，已拒绝修改正文");
  }

  const issueById = new Map<string, ContinuityIssue>();
  for (const issue of input.issues) {
    const id = issue.id?.trim();
    if (!id) continue;
    issueById.set(id, issue);
  }

  const editedIssues = new Set<string>();
  const located: LocatedEdit[] = [];

  for (const patch of input.patches) {
    const issueId = patch.issueId.trim();
    if (!issueId || !issueById.has(issueId)) {
      throw new RepairPatchError(
        "UNKNOWN_ISSUE",
        `修复补丁引用了不存在的问题编号：${issueId || "（空）"}`,
      );
    }
    if (!patch.edits.length) {
      throw new RepairPatchError("EMPTY_EDIT", `问题 ${issueId} 的补丁没有任何修改`);
    }
    for (const edit of patch.edits) {
      const chapterIndex = edit.chapterIndex ?? input.targetIndex;
      const chapter = chapterMap.get(chapterIndex);
      if (!chapter) {
        throw new RepairPatchError(
          "UNKNOWN_CHAPTER",
          `问题 ${issueId} 的补丁指向未授权章节：第 ${chapterIndex} 章`,
        );
      }
      if (!edit.originalText.trim()) {
        throw new RepairPatchError("EMPTY_EDIT", `问题 ${issueId} 的补丁缺少原文锚点`);
      }
      if (!edit.reason.trim()) {
        throw new RepairPatchError("MISSING_REASON", `问题 ${issueId} 的补丁缺少修改理由`);
      }
      if (edit.replacement === edit.originalText) {
        throw new RepairPatchError("UNCHANGED_EDIT", `问题 ${issueId} 的补丁没有实际修改内容`);
      }
      const occurrences = countOccurrences(chapter.text, edit.originalText);
      if (!occurrences) {
        throw new RepairPatchError(
          "ANCHOR_NOT_FOUND",
          `问题 ${issueId} 的原文锚点在第 ${chapterIndex} 章中不存在：${edit.originalText.slice(0, 40)}`,
        );
      }
      if (occurrences > 1) {
        throw new RepairPatchError(
          "ANCHOR_NOT_UNIQUE",
          `问题 ${issueId} 的原文锚点在第 ${chapterIndex} 章中出现 ${occurrences} 次，无法唯一匹配`,
        );
      }
      const start = chapter.text.indexOf(edit.originalText);
      located.push({
        issueId,
        chapterIndex,
        start,
        end: start + edit.originalText.length,
        edit,
      });
      editedIssues.add(issueId);
    }
  }

  const uncovered = [...issueById.keys()].filter((id) => !editedIssues.has(id));
  if (uncovered.length) {
    throw new RepairPatchError(
      "UNCOVERED_ISSUE",
      `修复补丁没有覆盖全部待修问题：${uncovered.join("、")}`,
    );
  }

  const targetAnchors = input.issues.flatMap((issue) => [
    issue.evidence,
    issue.sourceEvidence ?? "",
  ]);
  const authorization = new Map<number, Set<number>>();
  for (const chapter of input.chapters) {
    const anchors =
      chapter.index === input.targetIndex
        ? [...targetAnchors, ...(chapter.extraAuthorizedAnchors ?? [])]
        : [...(chapter.extraAuthorizedAnchors ?? [])];
    authorization.set(chapter.index, authorizedParagraphs(chapter.text, anchors.filter(Boolean)));
  }

  const paragraphsByChapter = new Map(
    input.chapters.map((chapter) => [chapter.index, paragraphsOf(chapter.text)]),
  );
  const paragraphOf = (chapterIndex: number, position: number): Paragraph | undefined =>
    paragraphsByChapter.get(chapterIndex)?.find(
      (paragraph) => position >= paragraph.start && position <= paragraph.end,
    );

  for (const item of located) {
    const allowed = authorization.get(item.chapterIndex) ?? new Set<number>();
    if (!allowed.size) {
      throw new RepairPatchError(
        "NO_AUTHORIZED_PARAGRAPH",
        `第 ${item.chapterIndex} 章无法确定授权修改区域，需要作者确认后才能修复`,
      );
    }
    const paragraph = paragraphOf(item.chapterIndex, item.start);
    if (!paragraph || !allowed.has(paragraph.index)) {
      throw new RepairPatchError(
        "UNAUTHORIZED_SCOPE",
        `问题 ${item.issueId} 的修改落在第 ${item.chapterIndex} 章未授权段落：${item.edit.originalText.slice(0, 40)}`,
      );
    }
    if (item.end > paragraph.end) {
      throw new RepairPatchError(
        "UNAUTHORIZED_SCOPE",
        `问题 ${item.issueId} 的修改跨越了第 ${item.chapterIndex} 章多个段落，超出授权范围`,
      );
    }
    if (
      item.edit.replacement.length >
      Math.max(item.edit.originalText.length * 4, 1200)
    ) {
      throw new RepairPatchError(
        "UNAUTHORIZED_SCOPE",
        `问题 ${item.issueId} 的修改范围明显过大（${item.edit.originalText.length}→${item.edit.replacement.length} 字）`,
      );
    }
  }

  const results: AppliedChapterBatch[] = [];
  for (const chapter of input.chapters) {
    const edits = located
      .filter((item) => item.chapterIndex === chapter.index)
      .sort((left, right) => left.start - right.start);
    if (!edits.length) continue;
    for (let index = 1; index < edits.length; index += 1) {
      if (edits[index].start < edits[index - 1].end) {
        throw new RepairPatchError(
          "OVERLAP",
          `第 ${chapter.index} 章中问题 ${edits[index - 1].issueId} 与 ${edits[index].issueId} 的修改区域重叠`,
        );
      }
    }
    let text = chapter.text;
    const records: EditRecord[] = [];
    for (const item of [...edits].sort((left, right) => right.start - left.start)) {
      text = text.slice(0, item.start) + item.edit.replacement + text.slice(item.end);
      const paragraph = paragraphOf(item.chapterIndex, item.start);
      records.push({
        issueId: item.issueId,
        chapterIndex: item.chapterIndex,
        start: item.start,
        end: item.end,
        paragraph: paragraph?.index ?? -1,
        originalLength: item.edit.originalText.length,
        replacementLength: item.edit.replacement.length,
        removed: item.edit.originalText,
        added: item.edit.replacement,
        reason: item.edit.reason,
      });
    }
    results.push({
      chapterIndex: chapter.index,
      text,
      records: records.sort((left, right) => left.start - right.start),
      changedChars: records.reduce(
        (total, record) =>
          total + Math.max(record.originalLength, record.replacementLength),
        0,
      ),
      paragraphs: [...new Set(records.map((record) => record.paragraph))].sort(
        (left, right) => left - right,
      ),
    });
  }

  return results;
}

export function applyRepairPatches(input: {
  originalText: string;
  patches: RepairPatch[];
  issues: ContinuityIssue[];
  extraAuthorizedAnchors?: string[];
  chapterIndex?: number;
}): AppliedPatchBatch {
  const targetIndex = input.chapterIndex ?? 1;
  const [batch] = applyRepairPatchesAcross({
    chapters: [
      {
        index: targetIndex,
        text: input.originalText,
        extraAuthorizedAnchors: input.extraAuthorizedAnchors,
      },
    ],
    targetIndex,
    patches: input.patches,
    issues: input.issues,
  });
  return {
    text: batch?.text ?? input.originalText,
    records: batch?.records ?? [],
    changedChars: batch?.changedChars ?? 0,
    paragraphs: batch?.paragraphs ?? [],
  };
}

export function describePatchBatch(batch: AppliedPatchBatch): string {
  return `修改 ${batch.records.length} 处（涉及第 ${batch.paragraphs
    .map((index) => index + 1)
    .join("、")} 段，约 ${batch.changedChars} 字）`;
}

export function formatEditRecords(records: EditRecord[]): string {
  return records
    .map(
      (record, index) =>
        `${index + 1}. [${record.issueId}] 第 ${record.chapterIndex} 章第 ${record.paragraph + 1} 段，${record.originalLength}→${record.replacementLength} 字：${record.reason}`,
    )
    .join("\n");
}
