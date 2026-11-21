import {
  compareCriticalIssues,
  compareWarningIssues,
  type IssueComparison,
} from "./repair-compare";
import {
  evaluateCausalChanges,
  type CausalChange,
} from "./repair-causal";
import type { Character, ContinuityIssue } from "./types";

export type RepairAcceptanceStatus =
  | "ACCEPTED"
  | "REJECTED_UNRESOLVED"
  | "REJECTED_NEW_CRITICAL"
  | "REJECTED_NEW_WARNING"
  | "REJECTED_FACT_CONFLICT"
  | "REJECTED_SCOPE_VIOLATION"
  | "REJECTED_CAUSAL_CHANGE"
  | "REJECTED_CAUSAL_CONTRADICTION"
  | "NEEDS_AUTHOR_DECISION"
  | "VERIFY_FAILED";

export type RepairAcceptanceMode = "STRICT" | "STANDARD";

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
  // 补丁超出授权范围或改动过大。
  scopeViolation?: boolean;
  // 修复目标只有建议类问题时，允许没有严重问题基线。
  allowNoBaseline?: boolean;
  // 默认严格模式：新增 warning 也不允许自动写回。
  mode?: RepairAcceptanceMode;
  // 修复前后因果结构对比；causalVerified=false 表示审校没有返回可用的对比结果。
  causalChanges?: CausalChange[];
  causalVerified?: boolean;
}

export interface RepairAcceptanceResult {
  status: RepairAcceptanceStatus;
  accepted: boolean;
  comparison: IssueComparison;
  warningComparison?: IssueComparison;
  reasons: string[];
  // 不阻止写回、但必须记录的遗留问题（未解决 warning、新增建议等）。
  leftovers: string[];
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

const EXPRESSION_HINTS =
  /(表达|修辞|文风|用词|措辞|语言|语感|节奏|描写|风格|建议|润色|行文)/u;
// 类型里带“建议”不代表是表达建议，例如“时间线建议”仍然是事实类警告。
const FACT_HINTS =
  /(冲突|矛盾|不一致|时间线|生死|死亡|人物状态|物品|归属|伏笔|因果|规则|世界观|人物关系|台账|连续性)/u;

export type IssueClass = "fact" | "expression" | "unknown";

export function classifyIssue(issue: ContinuityIssue): IssueClass {
  const category = issue.conflictCategory?.trim();
  if (category && category !== "other") return "fact";
  if (category === "other") return "unknown";
  if (FACT_CONFLICT_TYPES.has(issue.type.trim()) || FACT_HINTS.test(issue.type)) {
    return "fact";
  }
  if (EXPRESSION_HINTS.test(issue.type)) return "expression";
  return "unknown";
}

function isFactIssue(issue: ContinuityIssue): boolean {
  return classifyIssue(issue) === "fact";
}

// 规则拓展、解释不足和表达建议只记录，不作为剧情矛盾阻断写回。
function isRecordOnlyWarning(issue: ContinuityIssue): boolean {
  if (
    issue.classification === "rule-extension" ||
    issue.classification === "clarity-gap"
  ) {
    return true;
  }
  return classifyIssue(issue) === "expression";
}

/**
 * 统一修复验收：只有原有严重问题全部解决、没有新增不允许的问题、没有破坏既定事实，
 * 且事实抽取和审校都成功时，才允许把候选稿写入正式正文。
 * “严重问题数量减少”只代表 improved，不能当作通过。
 *
 * STRICT（默认）：新增 warning 也拒绝写回；STANDARD 仅拒绝新增的事实类 warning。
 */
export function evaluateRepair(input: RepairAcceptanceInput): RepairAcceptanceResult {
  const strict = (input.mode ?? "STRICT") === "STRICT";
  const comparison = compareCriticalIssues(
    input.before,
    input.after,
    input.characters ?? [],
  );
  const warningComparison = compareWarningIssues(
    input.before,
    input.after,
    input.characters ?? [],
  );
  const reasons: string[] = [];
  const leftovers: string[] = [];

  const fail = (status: RepairAcceptanceStatus): RepairAcceptanceResult => ({
    status,
    accepted: false,
    comparison,
    warningComparison,
    reasons,
    leftovers,
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
  if (input.scopeViolation) {
    reasons.push("修复修改超出问题授权范围，候选稿不能被自动采用。");
    return fail("REJECTED_SCOPE_VIOLATION");
  }
  if (input.causalVerified === false) {
    reasons.push("回归审校没有返回因果结构对比，无法确认修复是否改变剧情因果。");
    return fail("VERIFY_FAILED");
  }
  const causal = evaluateCausalChanges(input.causalChanges ?? []);
  if (causal.status !== "ACCEPTED") {
    reasons.push(...causal.reasons);
    return fail(causal.status);
  }
  if (causal.reasons.length) leftovers.push(...causal.reasons);

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
    reasons.push(`原有 ${comparison.remaining.length} 个严重问题仍未解决。`);
    return fail("REJECTED_UNRESOLVED");
  }
  if (!comparison.beforeCount && !input.allowNoBaseline) {
    reasons.push("修复前没有可核对的严重问题，不能把空集合当作修复成功。");
    return fail("REJECTED_UNRESOLVED");
  }

  // 警告级问题：严格模式下新增 warning 一律拒绝；标准模式只拒绝事实类新增。
  if (warningComparison.ambiguous && strict) {
    reasons.push("修复前后警告级问题存在歧义匹配，无法确认是否真正解决，需要作者确认。");
    return fail("NEEDS_AUTHOR_DECISION");
  }
  const newWarnings = warningComparison.added;
  const blockingWarnings = newWarnings.filter((issue) =>
    strict
      ? !isRecordOnlyWarning(issue)
      : classifyIssue(issue) === "fact" && !isRecordOnlyWarning(issue),
  );
  if (blockingWarnings.length) {
    reasons.push(
      `修复引入了 ${blockingWarnings.length} 个新的警告级问题：${blockingWarnings
        .map((issue) => issue.type)
        .join("、")}。`,
    );
    return fail("REJECTED_NEW_WARNING");
  }
  const recordedWarnings = newWarnings.filter(
    (issue) => !blockingWarnings.includes(issue),
  );
  const ruleExtensions = recordedWarnings.filter(
    (issue) => issue.classification === "rule-extension",
  );
  const clarityGaps = recordedWarnings.filter(
    (issue) => issue.classification === "clarity-gap",
  );
  const expressions = recordedWarnings.filter(
    (issue) =>
      !ruleExtensions.includes(issue) && !clarityGaps.includes(issue),
  );
  if (ruleExtensions.length) {
    leftovers.push(
      `新增 ${ruleExtensions.length} 条待确认的世界观规则拓展（已记录，不阻断写回）。`,
    );
  }
  if (clarityGaps.length) {
    leftovers.push(
      `新增 ${clarityGaps.length} 条解释不足建议（已记录，不阻断写回）。`,
    );
  }
  if (expressions.length) {
    leftovers.push(
      `新增 ${expressions.length} 条表达建议类 warning（已记录，不作为剧情矛盾）。`,
    );
  }
  if (warningComparison.remaining.length) {
    leftovers.push(
      `原有 ${warningComparison.remaining.length} 条 warning 未解决（已记录，不阻断写回）。`,
    );
  }
  if (warningComparison.ambiguous && !strict) {
    leftovers.push("警告级问题存在歧义匹配，已保守记录。");
  }
  const newSuggestions = input.after.filter(
    (issue) => issue.severity === "ignore",
  ).length;
  if (newSuggestions) {
    leftovers.push(`修复稿含 ${newSuggestions} 条建议类问题（仅记录）。`);
  }

  return {
    status: "ACCEPTED",
    accepted: true,
    comparison,
    warningComparison,
    reasons,
    leftovers,
  };
}

export function describeAcceptance(result: RepairAcceptanceResult): string {
  const { comparison } = result;
  const parts = [
    `严重问题 ${comparison.beforeCount}→${comparison.afterCount}（已解决 ${comparison.resolved.length}，仍存在 ${comparison.remaining.length}，新增 ${comparison.added.length}）`,
  ];
  if (result.warningComparison) {
    const warning = result.warningComparison;
    parts.push(
      `warning ${warning.beforeCount}→${warning.afterCount}（解决 ${warning.resolved.length}，遗留 ${warning.remaining.length}，新增 ${warning.added.length}）`,
    );
  }
  if (result.reasons.length) parts.push(result.reasons.join(""));
  if (result.leftovers.length) parts.push(result.leftovers.join(""));
  return parts.join("；");
}
