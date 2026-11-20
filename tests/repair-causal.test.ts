import { describe, expect, it } from "vitest";
import { evaluateRepair } from "@/lib/repair-acceptance";
import {
  evaluateCausalChanges,
  isCausalBaselineComplete,
  normalizeCausalBaseline,
  normalizeCausalChanges,
  type CausalChange,
} from "@/lib/repair-causal";
import type { ContinuityIssue } from "@/lib/types";

const before: ContinuityIssue = {
  severity: "critical",
  type: "剧情因果",
  evidence: "角色甲念出角色丙的罪行。",
  detail: "与第 4 章冲突。",
};

function change(
  classification: CausalChange["classification"],
  beforeText = "角色甲念罪行，书自动生成角色丙页",
  afterText = "角色甲念罪行，书自动生成角色丙页",
): CausalChange {
  return {
    issueIndex: 1,
    classification,
    before: beforeText,
    after: afterText,
    explanation: "测试分类",
  };
}

describe("修复前因果结构", () => {
  it("兼容 camel/snake 字段并要求核心字段完整", () => {
    const baseline = normalizeCausalBaseline({
      issue_index: 1,
      actor: "角色甲",
      action: "念出罪行",
      target: "记录载体",
      object: "角色丙",
      effect: "生成角色丙对应的记录页",
    });
    expect(baseline.issueIndex).toBe(1);
    expect(isCausalBaselineComplete(baseline)).toBe(true);
    expect(
      isCausalBaselineComplete(normalizeCausalBaseline({ actor: "角色甲" })),
    ).toBe(false);
  });
});

describe("修复后因果变更分类", () => {
  it("模型返回数组时 verified 为 true，缺失时不得视为已验证", () => {
    expect(normalizeCausalChanges(undefined).verified).toBe(false);
    expect(normalizeCausalChanges([]).verified).toBe(true);
  });

  it("分类缺失但记录了改动时保守归为 CAUSAL_CHANGE", () => {
    const { changes, verified } = normalizeCausalChanges([
      {
        issue_index: 1,
        before: "角色甲念罪行，书自动生成角色丙页",
        after: "角色甲按住角色丁页，书在角色丁页后生成角色丙页",
        explanation: "新增了中间页",
      },
    ]);
    expect(verified).toBe(true);
    expect(changes[0].classification).toBe("CAUSAL_CHANGE");
  });

  it("记录载体案例：新增角色丁页作为中间媒介判为 CAUSAL_CHANGE", () => {
    const evaluation = evaluateCausalChanges([
      change(
        "CAUSAL_CHANGE",
        "角色甲念出角色丙罪行，记录载体自动生成角色丙页",
        "角色甲按住角色丁页空白处念罪行，书在角色丁页后翻出角色丙页",
      ),
    ]);
    expect(evaluation.status).toBe("REJECTED_CAUSAL_CHANGE");
    expect(evaluation.reasons.join("")).toContain("因果");
  });

  it("安全改写通过，合理拓展记录但不阻断", () => {
    expect(evaluateCausalChanges([change("SAFE_REPHRASE")]).status).toBe(
      "ACCEPTED",
    );
    const expansion = evaluateCausalChanges([change("CAUSAL_EXPANSION")]);
    expect(expansion.status).toBe("ACCEPTED");
    expect(expansion.reasons.join("")).toContain("因果细节");
  });

  it("直接冲突优先判定为 CAUSAL_CONTRADICTION", () => {
    const evaluation = evaluateCausalChanges([
      change("CAUSAL_CHANGE"),
      change("CAUSAL_CONTRADICTION"),
    ]);
    expect(evaluation.status).toBe("REJECTED_CAUSAL_CONTRADICTION");
  });
});

describe("因果分类与统一验收", () => {
  function accept(causalChanges?: CausalChange[], causalVerified?: boolean) {
    return evaluateRepair({
      before: [before],
      after: [],
      causalChanges,
      causalVerified,
    });
  }

  it("因果被改写或与原文冲突时拒绝写回", () => {
    expect(accept([change("CAUSAL_CHANGE")], true).status).toBe(
      "REJECTED_CAUSAL_CHANGE",
    );
    expect(accept([change("CAUSAL_CONTRADICTION")], true).status).toBe(
      "REJECTED_CAUSAL_CONTRADICTION",
    );
  });

  it("没有返回因果对比时无法通过验收", () => {
    expect(accept(undefined, false).status).toBe("VERIFY_FAILED");
    expect(accept([], false).status).toBe("VERIFY_FAILED");
  });

  it("安全改写与合理拓展可以通过，拓展写入遗留记录", () => {
    expect(accept([change("SAFE_REPHRASE")], true).status).toBe("ACCEPTED");
    const expansion = accept([change("CAUSAL_EXPANSION")], true);
    expect(expansion.status).toBe("ACCEPTED");
    expect(expansion.leftovers.join("")).toContain("因果细节");
  });
});
