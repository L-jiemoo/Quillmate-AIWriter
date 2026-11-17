import { describe, expect, it } from "vitest";
import {
  auditMessages,
  chapterRepairMessages,
} from "@/lib/prompts";
import { PROMPT_AGENTS, PROMPT_CATALOG } from "@/lib/prompt-registry";
import { reviewProject } from "./fixtures/review-scenarios";

const DIMENSIONS = [
  "人物行为合理性",
  "人物性格一致性",
  "时间线连续性",
  "地点连续性",
  "人物生死状态",
  "物品归属",
  "世界观规则冲突",
  "剧情因果关系",
  "伏笔连续性",
  "章节内容重复",
  "章节与大纲偏离",
];

describe("典型小说审校提示词回归", () => {
  it("审校提示词包含全部 11 个维度、人物卡、剧情台账和证据要求", () => {
    const detail = reviewProject();
    const chapter = detail.plan.chapters[3];
    const text = auditMessages(
      detail.meta,
      detail.canon,
      detail.characters,
      chapter,
      "张三在密室里发现了一行旧字。",
      "上一章结尾：张三推开门。",
      [
        {
          severity: "warning",
          type: "死亡人物出现",
          evidence: "李四走进来",
          detail: "李四已在第 2 章死亡。",
        },
      ],
      "下一章开头：旧字发光。",
      "【人物动态状态】李四：第 2 章死亡。",
    )
      .map((message) => message.content)
      .join("\n");

    for (const dimension of DIMENSIONS) {
      expect(text).toContain(dimension);
    }
    expect(text).toContain("核心人物档案");
    expect(text).toContain("剧情台账");
    expect(text).toContain("本章正文中的原文短句");
    expect(text).toContain("不允许为了通过审校而建议修改既定事实");
  });

  it("修复提示词要求只改相关段落且不得改台账既定剧情", () => {
    const detail = reviewProject();
    const chapter = detail.plan.chapters[3];
    const text = chapterRepairMessages(
      detail.meta,
      chapter,
      "张三在密室里发现了一行旧字。",
      [
        {
          severity: "critical",
          type: "人物生死状态",
          evidence: "李四走进来",
          detail: "李四已在第 2 章死亡。",
        },
      ],
      detail.canon,
      "",
      "",
      "",
      "",
    )
      .map((message) => message.content)
      .join("\n");

    expect(text).toContain("人物行为合理性");
    expect(text).toContain("伏笔连续性");
    expect(text).toContain("只修与这些问题直接相关的段落");
    expect(text).toContain("不得为了让本章通过而修改事实台账");
  });

  it("所有模型 Agent 都有稳定的内置提示词版本", () => {
    expect(PROMPT_AGENTS).toHaveLength(8);
    for (const agent of PROMPT_AGENTS) {
      expect(PROMPT_CATALOG[agent].version).toMatch(/^\d{4}\./);
      expect(PROMPT_CATALOG[agent].label.length).toBeGreaterThan(0);
    }
  });
});
