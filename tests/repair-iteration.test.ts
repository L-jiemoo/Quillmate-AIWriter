import { describe, expect, it } from "vitest";
import {
  buildRepairBaseline,
  classifyRegressionByEvidence,
  groupIssuesByRootCause,
  normalizeRegressionVerdict,
  summarizeConfirmations,
} from "@/lib/repair-iteration";
import type { ContinuityIssue } from "@/lib/types";

function issue(
  evidence: string,
  overrides: Partial<ContinuityIssue> = {},
): ContinuityIssue {
  return {
    severity: "critical",
    type: "时间线",
    evidence,
    detail: "与第 4 章冲突。",
    ...overrides,
  };
}

describe("两轮修复分组与确认", () => {
  it("按根因分组，每组最多 3 个问题且不丢问题", () => {
    const issues = [
      ...Array.from({ length: 7 }, (_, index) =>
        issue(`角色甲在第${index + 1}处出现。`, { type: "时间线" }),
      ),
      issue("角色乙的物品归属错误。", { type: "物品归属" }),
    ];
    const groups = groupIssuesByRootCause(issues, 3);
    expect(groups.map((group) => group.issues.length)).toEqual([3, 3, 1, 1]);
    expect(groups.flatMap((group) => group.issues)).toHaveLength(issues.length);
  });

  it("基线包含稳定问题 ID、正文哈希和证据", () => {
    const baseline = buildRepairBaseline({
      jobId: "job-1",
      chapterIndex: 5,
      text: "角色乙在办公室里接电话。",
      issues: [issue("角色乙在办公室里接电话。")],
    });
    expect(baseline.issueIds).toHaveLength(1);
    expect(baseline.textHash).toHaveLength(64);
    expect(baseline.factEvidence).toContain("角色乙在办公室里接电话。");
    expect(baseline.chapterVersion.startsWith("ch5:")).toBe(true);
  });

  it("原文已有的证据归为 pre_existing", () => {
    const text = "角色乙在办公室里接电话。";
    const baseline = buildRepairBaseline({
      jobId: "job-1",
      chapterIndex: 1,
      text,
      issues: [issue(text)],
    });
    const result = classifyRegressionByEvidence(
      issue("角色乙在办公室里接电话。"),
      baseline,
      `${text}【修复】`,
    );
    expect(result.verdict).toBe("pre_existing");
  });

  it("省略号拼接的证据也能判断为 pre_existing", () => {
    const text = [
      "角色乙在办公室接电话。",
      "中间叙述。",
      "角色甲在门口等他。",
    ].join("\n");
    const evidence = "角色乙在办公室接电话。……角色甲在门口等他。";
    const baseline = buildRepairBaseline({
      jobId: "job-1",
      chapterIndex: 1,
      text,
      issues: [issue(evidence)],
    });
    const result = classifyRegressionByEvidence(
      issue(evidence),
      baseline,
      `${text}\n【修复】`,
    );
    expect(result.verdict).toBe("pre_existing");
  });

  it("无法核实的证据归为 uncertain，不擅自放行", () => {
    const baseline = buildRepairBaseline({
      jobId: "job-1",
      chapterIndex: 1,
      text: "角色乙在办公室里接电话。",
      issues: [issue("角色乙在办公室里接电话。")],
    });
    const result = classifyRegressionByEvidence(
      issue("这句证据不存在于任何稿子。"),
      baseline,
      "角色乙在办公室里接电话。【修复】",
    );
    expect(result.verdict).toBe("uncertain");
  });

  it("规范化确认结果并汇总", () => {
    expect(normalizeRegressionVerdict("Confirmed New")).toBe("confirmed_new");
    expect(normalizeRegressionVerdict("pre-existing")).toBe("pre_existing");
    expect(normalizeRegressionVerdict("false positive")).toBe("false_positive");
    expect(normalizeRegressionVerdict("???")).toBe("uncertain");

    const confirmed = issue("新增问题一。");
    const pre = issue("既有问题。");
    const uncertain = issue("无法判断。");
    const outcome = summarizeConfirmations([
      { issue: confirmed, verdict: "confirmed_new", explanation: "", schemeLevelFailure: false },
      { issue: pre, verdict: "pre_existing", explanation: "", schemeLevelFailure: false },
      { issue: uncertain, verdict: "uncertain", explanation: "", schemeLevelFailure: false },
    ]);
    expect(outcome.confirmedNew).toEqual([confirmed]);
    expect(outcome.uncertain).toEqual([uncertain]);
    expect(outcome.ignored).toEqual([pre]);
    expect(outcome.schemeFailure).toBe(false);
  });
});
