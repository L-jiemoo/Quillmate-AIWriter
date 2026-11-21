import { describe, expect, it } from "vitest";
import { normalizeIssues, normalizeReviewResult } from "@/lib/canon";
import { evaluateRepair } from "@/lib/repair-acceptance";
import type { ContinuityIssue } from "@/lib/types";

function critical(evidence: string): ContinuityIssue {
  return {
    severity: "critical",
    type: "时间线",
    evidence,
    detail: "与第 4 章明确事实冲突。",
  };
}

describe("审校问题分类归一化", () => {
  it("解析 camelCase / snake_case 分类与规则级别", () => {
    const [extension] = normalizeIssues([
      {
        severity: "critical",
        type: "世界观规则",
        evidence: "血脉执念被单独押入书中。",
        detail: "既有规则只禁止活人进入书中。",
        classification: "RULE_EXTENSION",
        rule_level: "HARD_RULE",
      },
    ]);
    expect(extension.classification).toBe("rule-extension");
    expect(extension.ruleLevel).toBe("hard");
  });

  it("规则拓展与解释不足不会保留 critical", () => {
    const [extension, clarity] = normalizeIssues([
      {
        severity: "critical",
        type: "世界观规则",
        evidence: "角色甲把执念作为独立对象押入书中。",
        detail: "可能是规则拓展。",
        issueClass: "rule_extension",
      },
      {
        severity: "critical",
        type: "剧情因果",
        evidence: "阵眼被拔除。",
        detail: "过程交代不足。",
        classification: "CLARITY_GAP",
      },
    ]);
    expect(extension.severity).toBe("warning");
    expect(clarity.severity).toBe("warning");
  });

  it("明确矛盾和旧数据没有分类时保持原判定", () => {
    const [established, legacy] = normalizeIssues([
      {
        severity: "critical",
        type: "时间线",
        evidence: "角色乙上午已被带到巷口。",
        detail: "与第 4 章下午在外地接电话冲突。",
        classification: "ESTABLISHED_CONTRADICTION",
        ruleLevel: "unknown_rule",
      },
      {
        severity: "critical",
        type: "时间线",
        evidence: "角色乙上午已被带到巷口。",
        detail: "旧版审校记录。",
      },
    ]);
    expect(established.severity).toBe("critical");
    expect(established.classification).toBe("established-contradiction");
    expect(established.ruleLevel).toBe("unknown");
    expect(legacy.severity).toBe("critical");
    expect(legacy.classification).toBeUndefined();
  });
});

describe("分类与修复验收", () => {
  it("严格模式下新增规则拓展只记录，不阻断写回", () => {
    const result = evaluateRepair({
      before: [critical("角色乙上午被绑走。")],
      after: [
        {
          severity: "warning",
          type: "世界观规则",
          evidence: "血脉执念被单独押入书中。",
          detail: "既有规则只禁止活人进入书中，执念作为独立对象尚属拓展。",
          classification: "rule-extension",
        },
      ],
    });
    expect(result.status).toBe("ACCEPTED");
    expect(result.leftovers.join("")).toContain("世界观规则拓展");
  });

  it("严格模式下新增解释不足只记录，不阻断写回", () => {
    const result = evaluateRepair({
      before: [critical("角色乙上午被绑走。")],
      after: [
        {
          severity: "warning",
          type: "剧情因果",
          evidence: "阵眼被拔除。",
          detail: "拔除过程交代不足。",
          classification: "clarity-gap",
        },
      ],
    });
    expect(result.status).toBe("ACCEPTED");
    expect(result.leftovers.join("")).toContain("解释不足");
  });

  it("大纲偏离不能判 critical", () => {
    const [issue] = normalizeIssues([
      {
        severity: "critical",
        type: "大纲偏离",
        evidence: "正文写成了另一条路线。",
        detail: "细纲要求走另一条路线。",
      },
    ]);
    expect(issue.severity).toBe("warning");
  });

  it("新增明确矛盾或无语义类别时仍然拒绝", () => {
    const contradiction = evaluateRepair({
      before: [critical("角色乙上午被绑走。")],
      after: [
        {
          severity: "warning",
          type: "其他",
          evidence: "角色乙又出现在外地。",
          detail: "与已建立的时间线冲突。",
          classification: "established-contradiction",
        },
      ],
    });
    expect(contradiction.status).toBe("REJECTED_NEW_WARNING");

    const unclassified = evaluateRepair({
      before: [critical("角色乙上午被绑走。")],
      after: [
        {
          severity: "warning",
          type: "其他",
          evidence: "这里似乎有点不对劲。",
          detail: "无法确认性质。",
        },
      ],
    });
    expect(unclassified.status).toBe("REJECTED_NEW_WARNING");

    const factHint = evaluateRepair({
      before: [critical("角色乙上午被绑走。")],
      after: [
        {
          severity: "warning",
          type: "时间线建议",
          evidence: "角色乙又出现在外地。",
          detail: "与第 4 章时间线不一致。",
        },
      ],
    });
    expect(factHint.status).toBe("REJECTED_NEW_WARNING");
  });
});

describe("两个真实案例的分类结果", () => {
  it("案例一：电话是否伪造不消除人物异地的时间线矛盾", () => {
    const review = normalizeReviewResult({
      summary: "",
      continuityOk: true,
      issues: [
        {
          severity: "critical",
          type: "时间线",
          evidence: "“你姑比你早到了半天。”",
          detail:
            "第 4 章下午角色乙仍在外地接电话；即使电话是伪造的，她上午已被带到巷口仍与电话时间冲突。",
          classification: "ESTABLISHED_CONTRADICTION",
          sourceChapter: 4,
        },
      ],
    });
    expect(review.issues[0].severity).toBe("critical");
    expect(review.continuityOk).toBe(false);
  });

  it("案例二：活人执念作为独立对象按规则拓展记录，不判严重矛盾", () => {
    const after = normalizeIssues([
      {
        severity: "critical",
        type: "世界观规则",
        evidence: "书页显示“血脉引水阵（残），已清除”。",
        detail:
          "既有规则只禁止活人进入书中；角色甲押入的是作为独立对象的血脉执念，尚不能证明违反硬规则。",
        classification: "RULE_EXTENSION",
        ruleLevel: "UNKNOWN_RULE",
      },
    ]);
    expect(after[0].severity).toBe("warning");

    const result = evaluateRepair({
      before: [critical("角色乙上午被绑走。")],
      after,
    });
    expect(result.status).toBe("ACCEPTED");
    expect(result.leftovers.join("")).toContain("世界观规则拓展");
  });
});
