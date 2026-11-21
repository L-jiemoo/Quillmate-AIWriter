import { describe, expect, it } from "vitest";
import {
  isStructuralRepairIssue,
  validateRepairDecisionOption,
} from "@/lib/repair-routing";
import type { ContinuityIssue } from "@/lib/types";

function issue(detail: string, type = "剧情因果"): ContinuityIssue {
  return {
    severity: "critical",
    type,
    evidence: "角色乙在办公室里接电话。",
    detail,
  };
}

describe("结构问题分流", () => {
  it("跨章互斥、只改本章无法解决时走作者决策", () => {
    expect(
      isStructuralRepairIssue(
        issue(
          "第 4 章写角色乙在电话里，本周又写他在巷口；只改本章无法同时满足两处，需作者确认。",
        ),
      ),
    ).toBe(true);
  });

  it("单章内的普通冲突仍然走局部修复", () => {
    expect(
      isStructuralRepairIssue(
        issue("与第 4 章的时间线冲突，需要改本章台词。", "时间线"),
      ),
    ).toBe(false);
  });
});

describe("作者决策方案校验", () => {
  const chapters = [
    { index: 3, content: "角色乙在办公室里接电话。" },
    { index: 4, content: "角色甲在巷口等他。" },
  ];
  const base = {
    label: "方案 A",
    description: "只改本章",
    affectedChapters: [4],
    anchors: ["角色甲在巷口等他。"],
    introducedFacts: [],
    recommended: true,
  };

  it("锚点真实且章节范围合法时通过", () => {
    expect(validateRepairDecisionOption(base, 4, chapters)).toEqual([]);
  });

  it("试图修改后文或锚点不存在时拒绝", () => {
    const errors = validateRepairDecisionOption(
      {
        ...base,
        affectedChapters: [4, 6],
        anchors: ["这句不在正文里。"],
      },
      4,
      chapters,
    );
    expect(errors.join("；")).toContain("后文第 6 章");
    expect(errors.join("；")).toContain("锚点不在授权章节正文中");
  });
});
