import { hashText, withIssueIds } from "./repair-patch";
import { compareCriticalIssues, normalizeIssueText } from "./repair-compare";
import type { CausalBaseline } from "./repair-causal";
import type { ContinuityIssue, ReviewResult } from "./types";

export type RepairPhase =
  | "BASELINE"
  | "REPAIRING"
  | "VERIFYING"
  | "REGRESSION_CONFIRMING"
  | "SECOND_REPAIR"
  | "ACCEPTED"
  | "NEEDS_AUTHOR_REVIEW"
  | "FAILED";

export interface RepairBaseline {
  jobId: string;
  chapterIndex: number;
  originalText: string;
  textHash: string;
  chapterVersion: string;
  issueIds: string[];
  issues: ContinuityIssue[];
  factEvidence: string[];
  causalBaselines: CausalBaseline[];
  createdAt: string;
}

export interface RepairRoundRecord {
  round: 1 | 2;
  inputHash: string;
  outputHash: string;
  handledIssueIds: string[];
  resolvedIssueIds: string[];
  addedIssueIds: string[];
  modelCalls: number;
  accepted: boolean;
  stopReason: string;
}

export interface IssueGroup {
  key: string;
  issues: ContinuityIssue[];
}

const MAX_GROUP_SIZE = 3;

// 同一根因（类型 + 来源章节 + 冲突类别）尽量一起修，拆成小批避免一次改太多。
export function groupIssuesByRootCause(
  issues: ContinuityIssue[],
  maxGroupSize = MAX_GROUP_SIZE,
): IssueGroup[] {
  const groups = new Map<string, ContinuityIssue[]>();
  for (const issue of issues) {
    const key = [
      issue.type.trim(),
      issue.sourceChapter ?? "",
      issue.conflictCategory ?? "",
      issue.ruleLevel ?? "",
    ].join("|");
    const list = groups.get(key) ?? [];
    list.push(issue);
    groups.set(key, list);
  }
  const result: IssueGroup[] = [];
  for (const [key, list] of groups) {
    for (let index = 0; index < list.length; index += maxGroupSize) {
      result.push({
        key: `${key}#${index / maxGroupSize + 1}`,
        issues: list.slice(index, index + maxGroupSize),
      });
    }
  }
  return result;
}

export function buildRepairBaseline(input: {
  jobId: string;
  chapterIndex: number;
  text: string;
  issues: ContinuityIssue[];
  causalBaselines?: CausalBaseline[];
}): RepairBaseline {
  const issues = withIssueIds(input.issues.filter((issue) => issue.severity !== "ignore"));
  return {
    jobId: input.jobId,
    chapterIndex: input.chapterIndex,
    originalText: input.text,
    textHash: hashText(input.text),
    chapterVersion: `ch${input.chapterIndex}:${hashText(input.text).slice(0, 12)}`,
    issueIds: issues.map((issue) => issue.id ?? "").filter(Boolean),
    issues,
    factEvidence: issues
      .filter((issue) => issue.evidence.trim())
      .map((issue) => issue.evidence.trim()),
    causalBaselines: input.causalBaselines ?? [],
    createdAt: new Date().toISOString(),
  };
}

export type RegressionVerdict =
  | "confirmed_new"
  | "pre_existing"
  | "false_positive"
  | "uncertain";

export interface RegressionConfirmation {
  issue: ContinuityIssue;
  verdict: RegressionVerdict;
  explanation: string;
  schemeLevelFailure: boolean;
}

const VERDICT_ALIASES: Record<string, RegressionVerdict> = {
  confirmednew: "confirmed_new",
  confirmed: "confirmed_new",
  new: "confirmed_new",
  preexisting: "pre_existing",
  existing: "pre_existing",
  old: "pre_existing",
  falsepositive: "false_positive",
  false: "false_positive",
  uncertain: "uncertain",
  unknown: "uncertain",
};

function verdictKey(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/gu, "");
}

export function normalizeRegressionVerdict(value: unknown): RegressionVerdict {
  return VERDICT_ALIASES[verdictKey(value)] ?? "uncertain";
}

// 规则兜底：原文中已经存在的证据不能算本次修复新增；无法判断的一律 uncertain。
export function classifyRegressionByEvidence(
  issue: ContinuityIssue,
  baseline: RepairBaseline,
  candidateText: string,
): RegressionConfirmation {
  const evidenceParts = issue.evidence
    .split(/…+|\.{3,}|⋯+|[／/|｜]+|\n+/u)
    .map(normalizeIssueText)
    .filter((part) => part.length >= 6);
  const evidenceWhole = normalizeIssueText(issue.evidence);
  const original = normalizeIssueText(baseline.originalText);
  const candidate = normalizeIssueText(candidateText);
  if (!evidenceWhole) {
    return {
      issue,
      verdict: "uncertain",
      explanation: "新增问题缺少原文证据，无法确认是否由本次修复引入。",
      schemeLevelFailure: false,
    };
  }
  const presentIn = (text: string): boolean =>
    evidenceParts.length
      ? evidenceParts.every((part) => text.includes(part))
      : evidenceWhole.length >= 6 && text.includes(evidenceWhole);
  if (presentIn(original)) {
    return {
      issue,
      verdict: "pre_existing",
      explanation: "该证据在修复前原文中已经存在，属于既有问题。",
      schemeLevelFailure: false,
    };
  }
  // 证据在候选稿中找不到时，既不能当新增，也不能直接当误报；
  // 交给作者确认，避免用猜测放行或阻断。
  return {
    issue,
    verdict: "uncertain",
    explanation: !presentIn(candidate)
      ? "候选稿中找不到该证据，无法确认问题是否成立。"
      : "需要独立确认该问题是否由本次修复引入。",
    schemeLevelFailure: false,
  };
}

export interface ConfirmOutcome {
  confirmations: RegressionConfirmation[];
  confirmedNew: ContinuityIssue[];
  uncertain: ContinuityIssue[];
  ignored: ContinuityIssue[];
  schemeFailure: boolean;
}

export function summarizeConfirmations(
  confirmations: RegressionConfirmation[],
): ConfirmOutcome {
  const confirmedNew: ContinuityIssue[] = [];
  const uncertain: ContinuityIssue[] = [];
  const ignored: ContinuityIssue[] = [];
  let schemeFailure = false;
  for (const item of confirmations) {
    if (item.schemeLevelFailure) schemeFailure = true;
    if (item.verdict === "confirmed_new") confirmedNew.push(item.issue);
    else if (item.verdict === "uncertain") uncertain.push(item.issue);
    else ignored.push(item.issue);
  }
  return { confirmations, confirmedNew, uncertain, ignored, schemeFailure };
}

export function compareToBaseline(
  baseline: RepairBaseline,
  review: ReviewResult,
  characters: Parameters<typeof compareCriticalIssues>[2] = [],
) {
  return compareCriticalIssues(baseline.issues, review.issues, characters);
}

export function describeRound(record: RepairRoundRecord): string {
  return `第 ${record.round} 轮：处理 ${record.handledIssueIds.length} 个问题，解决 ${record.resolvedIssueIds.length}，新增 ${record.addedIssueIds.length}，模型调用 ${record.modelCalls} 次，${record.accepted ? "验收通过" : "未通过"}（${record.stopReason}）`;
}
