// 修复前提取剧情因果结构，修复后对比，防止“补丁都合法但对象/顺序被换掉”。

export interface CausalBaseline {
  issueIndex?: number;
  actor: string;
  action: string;
  target: string;
  object: string;
  location: string;
  sequence: string;
  cause: string;
  effect: string;
  rule: string;
}

export type CausalChangeClass =
  | "SAFE_REPHRASE"
  | "CAUSAL_EXPANSION"
  | "CAUSAL_CHANGE"
  | "CAUSAL_CONTRADICTION";

export interface CausalChange {
  issueIndex?: number;
  classification: CausalChangeClass;
  before: string;
  after: string;
  explanation: string;
}

export interface CausalEvaluation {
  status: "ACCEPTED" | "REJECTED_CAUSAL_CHANGE" | "REJECTED_CAUSAL_CONTRADICTION";
  reasons: string[];
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeKey(value: unknown): string {
  return str(value).toLowerCase().replace(/[^a-z]/gu, "");
}

const CHANGE_CLASSES: Record<string, CausalChangeClass> = {
  saferephrase: "SAFE_REPHRASE",
  rephrase: "SAFE_REPHRASE",
  safe: "SAFE_REPHRASE",
  causalexpansion: "CAUSAL_EXPANSION",
  expansion: "CAUSAL_EXPANSION",
  causalchange: "CAUSAL_CHANGE",
  change: "CAUSAL_CHANGE",
  causalcontradiction: "CAUSAL_CONTRADICTION",
  contradiction: "CAUSAL_CONTRADICTION",
};

export function normalizeCausalBaseline(input: unknown): CausalBaseline {
  const record = (input ?? {}) as Record<string, unknown>;
  const issueIndex = Number.parseInt(
    String(record.issueIndex ?? record.issue_index ?? ""),
    10,
  );
  return {
    ...(Number.isInteger(issueIndex) && issueIndex > 0 ? { issueIndex } : {}),
    actor: str(record.actor),
    action: str(record.action),
    target: str(record.target),
    object: str(record.object),
    location: str(record.location),
    sequence: str(record.sequence),
    cause: str(record.cause),
    effect: str(record.effect),
    rule: str(record.rule),
  };
}

export function isCausalBaselineComplete(baseline: CausalBaseline): boolean {
  return Boolean(
    baseline.actor &&
      baseline.action &&
      baseline.target &&
      baseline.object &&
      baseline.effect,
  );
}

export function normalizeCausalChanges(input: unknown): {
  changes: CausalChange[];
  verified: boolean;
} {
  if (!Array.isArray(input)) return { changes: [], verified: false };
  const changes: CausalChange[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    const before = str(record.before ?? record.original ?? record.source);
    const after = str(record.after ?? record.repaired ?? record.result);
    const explanation = str(
      record.explanation ?? record.reason ?? record.note ?? record.detail,
    );
    if (!before && !after && !explanation) continue;
    const issueIndex = Number.parseInt(
      String(record.issueIndex ?? record.issue_index ?? ""),
      10,
    );
    changes.push({
      ...(Number.isInteger(issueIndex) && issueIndex > 0 ? { issueIndex } : {}),
      // 分类缺失或无法识别时保守按 CAUSAL_CHANGE 处理，不允许静默写回。
      classification:
        CHANGE_CLASSES[
          normalizeKey(record.classification ?? record.class ?? record.type)
        ] ?? "CAUSAL_CHANGE",
      before,
      after,
      explanation,
    });
  }
  return { changes, verified: true };
}

// 有因果基线时，空数组不能直接当作“已验证”：
// 只有模型明确返回 causalVerified=true，或确实返回了逐项对比，才允许验收。
export function causalVerificationComplete(
  changes: CausalChange[],
  verified: boolean,
  baselineCount: number,
  explicit: unknown,
): boolean {
  if (!verified) return false;
  if (explicit === true) return true;
  return baselineCount === 0 || changes.length > 0;
}

export function formatCausalBaseline(baseline: CausalBaseline): string {
  const head = baseline.issueIndex ? `问题 ${baseline.issueIndex}：\n` : "";
  return head + [
    `动作执行者：${baseline.actor || "未说明"}`,
    `动作：${baseline.action || "未说明"}`,
    `动作直接作用对象：${baseline.target || "未说明"}`,
    `被记录/改变/处理的对象：${baseline.object || "未说明"}`,
    `动作发生位置：${baseline.location || "未说明"}`,
    `事件先后顺序：${baseline.sequence || "未说明"}`,
    `触发原因：${baseline.cause || "未说明"}`,
    `事件结果：${baseline.effect || "未说明"}`,
    `涉及世界观规则：${baseline.rule || "未说明"}`,
  ].join("\n");
}

export function describeCausalChange(change: CausalChange): string {
  const issue = change.issueIndex ? `问题 ${change.issueIndex}：` : "";
  return `${issue}${change.classification}（${change.before || "未记录"} → ${
    change.after || "未记录"
  }）${change.explanation ? `：${change.explanation}` : ""}`;
}

export function evaluateCausalChanges(
  changes: CausalChange[],
): CausalEvaluation {
  const contradictions = changes.filter(
    (change) => change.classification === "CAUSAL_CONTRADICTION",
  );
  if (contradictions.length) {
    return {
      status: "REJECTED_CAUSAL_CONTRADICTION",
      reasons: [
        `修复后因果结构与原文或世界观规则直接冲突：${contradictions
          .map(describeCausalChange)
          .join("；")}。`,
      ],
    };
  }
  const rewritten = changes.filter(
    (change) => change.classification === "CAUSAL_CHANGE",
  );
  if (rewritten.length) {
    return {
      status: "REJECTED_CAUSAL_CHANGE",
      reasons: [
        `修复改写了剧情因果结构，必须由作者确认：${rewritten
          .map(describeCausalChange)
          .join("；")}。`,
      ],
    };
  }
  const expansions = changes.filter(
    (change) => change.classification === "CAUSAL_EXPANSION",
  );
  return {
    status: "ACCEPTED",
    reasons: expansions.length
      ? [
          `修复新增了 ${expansions.length} 处因果细节（未改变原因果链），需确认未引入新规则。`,
        ]
      : [],
  };
}
