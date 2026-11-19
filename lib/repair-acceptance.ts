import { compareCriticalIssues, type IssueComparison } from "./repair-compare";
import type { Character, ContinuityIssue } from "./types";

export type RepairAcceptanceStatus =
  | "ACCEPTED"
  | "REJECTED_UNRESOLVED"
  | "REJECTED_NEW_CRITICAL"
  | "REJECTED_FACT_CONFLICT"
  | "NEEDS_AUTHOR_DECISION"
  | "VERIFY_FAILED";

export interface RepairAcceptanceInput {
  before: ContinuityIssue[];
  after: ContinuityIssue[];
  characters?: Character[];
  // 事实抽取或审校没成功时，任何结论都不可信。
  extractionOk?: boolean;
  auditFailed?: boolean;
  // 修复后依旧存在的既定事实冲突（死亡状态、物品归属、时间线、伏笔等）。
  factConflicts?: ContinuityIssue[];
  // Repair Agent 认为证据不足，需要作者决定。
  needsAuthorDecision?: boolean;
  // 修复目标只有建议类问题时，允许没有严重问题基线。
  allowNoBaseline?: boolean;
}

export interface RepairAcceptanceResult {
  status: RepairAcceptanceStatus;
  accepted: boolean;
  comparison: IssueComparison;
  reasons: string[];
}

const FACT_CONFLICT_TYPES = new Set([
  "死亡状态",
  "人物生死状态",
  "物品归属",
  "时间线",
  "伏笔状态",
  "伏笔生命周期",
  "伏笔连续性",
  "因果一致性",
  "剧情台账",
  "世界观规则",
  "人物关系",
  "事实冲突",
]);

function isFactIssue(issue: ContinuityIssue): boolean {
  const category = issue.conflictCategory?.trim();
  if (category && category !== "other") return true;
  return FACT_CONFLICT_TYPES.has(issue.type.trim());
}

/**
 * 统一修复验收：只有原问题全部解决、没有新增严重问题、没有破坏既定事实，
 * 且事实抽取和审校都成功时，才允许把候选稿写入正式正文。
 * “严重问题数量减少”只代表 improved，不能当作通过。
 */
export function evaluateRepair(input: RepairAcceptanceInput): RepairAcceptanceResult {
  const comparison = compareCriticalIssues(
    input.before,
    input.after,
    input.characters ?? [],
  );
  const reasons: string[] = [];

  const fail = (status: RepairAcceptanceStatus): RepairAcceptanceResult => ({
    status,
    accepted: false,
    comparison,
    reasons,
  });

  if (input.auditFailed) {
    reasons.push("连续性审校调用失败，候选稿未经检查。");
    return fail("VERIFY_FAILED");
  }
  if (input.extractionOk === false) {
    reasons.push("事实抽取失败，无法确认候选稿是否破坏既定事实。");
    return fail("VERIFY_FAILED");
  }
  if (input.needsAuthorDecision) {
    reasons.push("修复 Agent 证据不足，需要作者决定，不能自动采用。");
    return fail("NEEDS_AUTHOR_DECISION");
  }

  const newFactConflicts = (input.factConflicts ?? []).filter(
    (issue) => issue.severity === "critical" && isFactIssue(issue),
  );
  if (newFactConflicts.length) {
    reasons.push(
      `修复后仍有 ${newFactConflicts.length} 个既定事实冲突：${newFactConflicts
        .map((issue) => issue.type)
        .join("、")}。`,
    );
    return fail("REJECTED_FACT_CONFLICT");
  }

  if (comparison.ambiguous) {
    reasons.push("修复前后问题存在歧义匹配，无法确认原问题是否真正解决。");
    return fail("REJECTED_UNRESOLVED");
  }
  if (comparison.added.length) {
    reasons.push(`修复引入了 ${comparison.added.length} 个新的严重问题。`);
    return fail("REJECTED_NEW_CRITICAL");
  }
  if (comparison.remaining.length) {
    reasons.push(
      `原有 ${comparison.remaining.length} 个严重问题仍未解决。`,
    );
    return fail("REJECTED_UNRESOLVED");
  }
  if (!comparison.beforeCount && !input.allowNoBaseline) {
    reasons.push("修复前没有可核对的严重问题，不能把空集合当作修复成功。");
    return fail("REJECTED_UNRESOLVED");
  }

  return {
    status: "ACCEPTED",
    accepted: true,
    comparison,
    reasons,
  };
}

export function describeAcceptance(result: RepairAcceptanceResult): string {
  const { comparison } = result;
  const base = `严重问题 ${comparison.beforeCount}→${comparison.afterCount}（已解决 ${comparison.resolved.length}，仍存在 ${comparison.remaining.length}，新增 ${comparison.added.length}）`;
  return result.reasons.length
    ? `${base}；${result.reasons.join("")}`
    : base;
}
