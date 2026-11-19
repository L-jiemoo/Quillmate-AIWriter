import { describe, expect, it } from "vitest";
import {
  normalizeRepairPlan,
  RepairPlanRejectedError,
  validateRepairPlan,
  type RepairPlan,
  type RepairPlanIssue,
} from "@/lib/agents";
import type { ContinuityIssue } from "@/lib/types";

const chapterText = [
  "第一段：陈默在阴巷等待。",
  "陈玉华在省城超市收银台旁接电话。",
  "第三段：长夜教的人出现。",
].join("\n");

const evidenceContext = [
  "【原文证据使用规则】以下内容来自正式正文。",
  "【事实台账（硬约束，不是原文摘录）】",
  "- 人物状态：陈玉华｜alive｜所在：省城｜状态确立于第 4 章",
  "【原文证据 1｜第 4 章《电话》｜第 4 章第 2 行附近】",
  "（原文）陈玉华在省城超市收银台旁接电话。",
].join("\n");

function planIssue(overrides: Partial<RepairPlanIssue> = {}): RepairPlanIssue {
  return {
    issueIndex: 1,
    rootCause: "与第 4 章电话事实冲突",
    evidence: "陈玉华在省城超市收银台旁接电话。",
    locations: ["陈玉华在省城超市收银台旁接电话。"],
    strategy: "改写电话来源，保留收银机背景音",
    affectedFacts: ["第 4 章电话事件"],
    sideEffects: "可能影响后续伏笔",
    regressionScope: "第 4 章与相邻章节",
    causalBaseline: {
      actor: "陈默",
      action: "拨打陈玉华的电话",
      target: "电话",
      object: "陈玉华",
      location: "阴巷附近",
      sequence: "先通话，后前往阴巷",
      cause: "确认陈玉华的情况",
      effect: "陈玉华透露阴巷内幕",
      rule: "无",
    },
    ...overrides,
  };
}

function plan(...issues: RepairPlanIssue[]): RepairPlan {
  return {
    issuePlans: issues,
    needsAuthorDecision: false,
    decisionReason: "",
    decisionOptions: [],
  };
}

function rejectionMessage(fn: () => void): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(RepairPlanRejectedError);
    return (error as Error).message;
  }
  throw new Error("预期方案被拒绝");
}

describe("修复方案证据校验", () => {
  it("证据和修改位置真实存在时通过", () => {
    expect(() =>
      validateRepairPlan(plan(planIssue()), 1, { chapterText, evidenceContext }),
    ).not.toThrow();
  });

  it("证据只来自事实台账时拒绝", () => {
    const message = rejectionMessage(() =>
      validateRepairPlan(
        plan(planIssue({ evidence: "人物状态：陈玉华｜alive｜所在：省城" })),
        1,
        { chapterText, evidenceContext },
      ),
    );
    expect(message).toContain("台账");
  });

  it("模型推断不能当作原文证据", () => {
    const message = rejectionMessage(() =>
      validateRepairPlan(
        plan(planIssue({ evidence: "陈玉华可能是被长夜教威胁才接电话。" })),
        1,
        { chapterText, evidenceContext },
      ),
    );
    expect(message).toContain("不在当前正文");
  });

  it("方案复述证据失真但问题原证据在正文中时通过", () => {
    const neutralText = "第一段：甲在车站等车。\n第二段：乙在办公室里接电话。";
    const issue: ContinuityIssue = {
      severity: "critical",
      type: "时间线",
      evidence: "乙在办公室里接电话。",
      detail: "与上一章冲突。",
    };
    expect(() =>
      validateRepairPlan(
        plan(
          planIssue({
            evidence: "电话里乙在办公室里说话",
            locations: ["乙在办公室里接电话。"],
          }),
        ),
        1,
        { chapterText: neutralText, issues: [issue] },
      ),
    ).not.toThrow();
  });

  it("问题原证据也不在正文中时仍然拒绝", () => {
    const neutralText = "第一段：甲在车站等车。";
    const issue: ContinuityIssue = {
      severity: "critical",
      type: "时间线",
      evidence: "推断：乙可能提前离开办公室。",
      detail: "只来自推断。",
    };
    const message = rejectionMessage(() =>
      validateRepairPlan(
        plan(
          planIssue({
            evidence: "乙可能提前离开办公室",
            locations: ["甲在车站等车。"],
          }),
        ),
        1,
        { chapterText: neutralText, issues: [issue] },
      ),
    );
    expect(message).toContain("不在当前正文");
  });

  it("证据来自检索到的原文证据时通过", () => {
    const remoteEvidence = "陈玉华警告陈默今晚不要去阴巷。";
    expect(() =>
      validateRepairPlan(
        plan(planIssue({ evidence: remoteEvidence })),
        1,
        {
          chapterText,
          evidenceContext: `${evidenceContext}\n【原文证据 2｜第 4 章】\n（原文）${remoteEvidence}`,
        },
      ),
    ).not.toThrow();
  });

  it("计划修改的位置在正文中不存在时拒绝", () => {
    const message = rejectionMessage(() =>
      validateRepairPlan(
        plan(planIssue({ locations: ["第二十章开头"] })),
        1,
        { chapterText, evidenceContext },
      ),
    );
    expect(message).toContain("位置");
  });

  it("方案缺少回归审校范围时拒绝", () => {
    const message = rejectionMessage(() =>
      validateRepairPlan(
        plan(planIssue({ regressionScope: "" })),
        1,
        { chapterText, evidenceContext },
      ),
    );
    expect(message).toContain("回归审校范围");
  });

  it("方案缺少修复前因果结构时拒绝", () => {
    const baseline = planIssue().causalBaseline;
    const message = rejectionMessage(() =>
      validateRepairPlan(
        plan(
          planIssue({
            causalBaseline: { ...baseline, actor: "", effect: "" },
          }),
        ),
        1,
        { chapterText, evidenceContext },
      ),
    );
    expect(message).toContain("因果结构");
  });

  it("方案遗漏问题时拒绝", () => {
    const message = rejectionMessage(() =>
      validateRepairPlan(plan(planIssue()), 2, { chapterText, evidenceContext }),
    );
    expect(message).toContain("遗漏");
  });

  it("引用了不存在的问题编号时拒绝", () => {
    const message = rejectionMessage(() =>
      validateRepairPlan(
        plan(planIssue({ issueIndex: 3 })),
        1,
        { chapterText, evidenceContext },
      ),
    );
    expect(message).toContain("不存在的问题编号");
  });

  it("规范化模型输出并识别需要作者决定", () => {
    const normalized = normalizeRepairPlan({
      issue_plans: [
        {
          issue_index: 1,
          root_cause: "原因",
          evidence: "陈玉华在省城超市收银台旁接电话。",
          locations: ["陈玉华在省城超市收银台旁接电话。"],
          strategy: "改写",
          affected_facts: ["电话"],
          side_effects: "无",
          regression_scope: "第 4 章",
        },
      ],
      needs_author_decision: true,
      decision_reason: "缺少第 4 章原文",
    });
    expect(normalized.issuePlans[0].issueIndex).toBe(1);
    expect(normalized.issuePlans[0].regressionScope).toBe("第 4 章");
    expect(normalized.needsAuthorDecision).toBe(true);
    expect(normalized.decisionReason).toBe("缺少第 4 章原文");
  });
});
