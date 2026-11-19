import { createHash } from "node:crypto";
import type { ContinuityIssue } from "./types";

export interface RepairEdit {
  originalText: string;
  replacement: string;
  reason: string;
}

export interface RepairPatch {
  issueId: string;
  edits: RepairEdit[];
}

export interface EditRecord {
  issueId: string;
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

export type RepairPatchErrorCode =
  | "EMPTY_BATCH"
  | "UNKNOWN_ISSUE"
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
  // 模型引用长句时偶尔会漏掉空白或截断，退一步用紧凑文本前缀核对。
  const compactAnchor = compact(trimmed);
  if (compactAnchor.length < 4) return false;
  const compactParagraph = compact(paragraph);
  if (compactParagraph.includes(compactAnchor)) return true;
  const head = compactAnchor.slice(0, Math.min(24, compactAnchor.length));
  return head.length >= 4 && compactParagraph.includes(head);
}

function authorizedParagraphs(text: string, anchors: string[]): Set<number> {
  const paragraphs = paragraphsOf(text);
  const allowed = new Set<number>();
  for (const paragraph of paragraphs) {
    if (anchors.some((anchor) => anchorMatchesParagraph(anchor, paragraph.text))) {
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
  start: number;
  end: number;
  edit: RepairEdit;
}

/**
 * 校验并应用补丁批次。任何一项校验失败都会抛错，整个批次不应用。
 * 修改范围按“包含问题证据/原始证据的段落”授权，未授权段落一律拒绝。
 */
export function applyRepairPatches(input: {
  originalText: string;
  patches: RepairPatch[];
  issues: ContinuityIssue[];
  extraAuthorizedAnchors?: string[];
}): AppliedPatchBatch {
  const { originalText, issues } = input;
  if (!input.patches.length) {
    throw new RepairPatchError("EMPTY_BATCH", "修复补丁为空，已拒绝修改正文");
  }

  const issueById = new Map<string, ContinuityIssue>();
  for (const issue of issues) {
    const id = issue.id?.trim();
    if (!id) continue;
    issueById.set(id, issue);
  }

  const editedIssues = new Set<string>();
  const located: LocatedEdit[] = [];
  const errors: string[] = [];

  for (const patch of input.patches) {
    const issueId = patch.issueId.trim();
    if (!issueId || !issueById.has(issueId)) {
      throw new RepairPatchError(
        "UNKNOWN_ISSUE",
        `修复补丁引用了不存在的问题编号：${issueId || "（空）"}`,
      );
    }
    if (!patch.edits.length) {
      throw new RepairPatchError(
        "EMPTY_EDIT",
        `问题 ${issueId} 的补丁没有任何修改`,
      );
    }
    for (const edit of patch.edits) {
      if (!edit.originalText.trim()) {
        throw new RepairPatchError(
          "EMPTY_EDIT",
          `问题 ${issueId} 的补丁缺少原文锚点`,
        );
      }
      if (!edit.reason.trim()) {
        throw new RepairPatchError(
          "MISSING_REASON",
          `问题 ${issueId} 的补丁缺少修改理由`,
        );
      }
      if (edit.replacement === edit.originalText) {
        throw new RepairPatchError(
          "UNCHANGED_EDIT",
          `问题 ${issueId} 的补丁没有实际修改内容`,
        );
      }
      const occurrences = countOccurrences(originalText, edit.originalText);
      if (!occurrences) {
        throw new RepairPatchError(
          "ANCHOR_NOT_FOUND",
          `问题 ${issueId} 的原文锚点在当前正文中不存在：${edit.originalText.slice(0, 40)}`,
        );
      }
      if (occurrences > 1) {
        throw new RepairPatchError(
          "ANCHOR_NOT_UNIQUE",
          `问题 ${issueId} 的原文锚点在当前正文中出现 ${occurrences} 次，无法唯一匹配`,
        );
      }
      const start = originalText.indexOf(edit.originalText);
      located.push({
        issueId,
        start,
        end: start + edit.originalText.length,
        edit,
      });
      editedIssues.add(issueId);
    }
  }

  for (const [id] of issueById) {
    if (!editedIssues.has(id)) {
      errors.push(id);
    }
  }
  if (errors.length) {
    throw new RepairPatchError(
      "UNCOVERED_ISSUE",
      `修复补丁没有覆盖全部待修问题：${errors.join("、")}`,
    );
  }

  const anchors = [
    ...issues.flatMap((issue) => [
      issue.evidence,
      issue.sourceEvidence ?? "",
    ]),
    ...(input.extraAuthorizedAnchors ?? []),
  ].filter(Boolean);
  const allowed = authorizedParagraphs(originalText, anchors);
  if (!allowed.size) {
    throw new RepairPatchError(
      "NO_AUTHORIZED_PARAGRAPH",
      "无法从问题证据中确定授权修改区域，需要作者确认后才能修复",
    );
  }

  const paragraphs = paragraphsOf(originalText);
  const paragraphOf = (position: number): Paragraph | undefined =>
    paragraphs.find(
      (paragraph) => position >= paragraph.start && position <= paragraph.end,
    );

  for (const item of located) {
    const paragraph = paragraphOf(item.start);
    if (!paragraph || !allowed.has(paragraph.index)) {
      throw new RepairPatchError(
        "UNAUTHORIZED_SCOPE",
        `问题 ${item.issueId} 的修改落在未授权段落：${item.edit.originalText.slice(0, 40)}`,
      );
    }
    if (item.end > paragraph.end) {
      throw new RepairPatchError(
        "UNAUTHORIZED_SCOPE",
        `问题 ${item.issueId} 的修改跨越了多个段落，超出授权范围`,
      );
    }
    // 明显扩张式改写不是“最小修改”：保留一个很宽的兜底阈值，防止整段被扩写成新剧情。
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

  const sorted = [...located].sort((left, right) => left.start - right.start);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index].start < sorted[index - 1].end) {
      throw new RepairPatchError(
        "OVERLAP",
        `问题 ${sorted[index - 1].issueId} 与 ${sorted[index].issueId} 的修改区域重叠`,
      );
    }
  }

  const records: EditRecord[] = [];
  let text = originalText;
  for (const item of [...sorted].sort((left, right) => right.start - left.start)) {
    text =
      text.slice(0, item.start) +
      item.edit.replacement +
      text.slice(item.end);
    const paragraph = paragraphOf(item.start);
    records.push({
      issueId: item.issueId,
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

  return {
    text,
    records: records.sort((left, right) => left.start - right.start),
    changedChars: records.reduce(
      (total, record) => total + Math.max(record.originalLength, record.replacementLength),
      0,
    ),
    paragraphs: [...new Set(records.map((record) => record.paragraph))].sort(
      (left, right) => left - right,
    ),
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
        `${index + 1}. [${record.issueId}] 第 ${record.paragraph + 1} 段，${record.originalLength}→${record.replacementLength} 字：${record.reason}`,
    )
    .join("\n");
}
