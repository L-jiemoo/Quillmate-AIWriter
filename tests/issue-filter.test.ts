import { describe, expect, it } from "vitest";
import { normalizeReviewResult } from "@/lib/canon";

describe("审校问题自相否定过滤", () => {
  it("承认不构成冲突、只需作者确认的问题不再保留为严重问题", () => {
    const review = normalizeReviewResult({
      summary: "摘要",
      issues: [
        {
          severity: "critical",
          type: "时间线",
          evidence: "初十夜里，角色甲戌时三刻出发。",
          detail:
            "第 9 章写的是“初十夜里”，本章写成“戌时三刻”，与第 9 章不构成硬冲突。真正的问题是“戌时”与“夜里”的对应关系需作者确认；若第 9 章原意为夜半，则本章提前数小时。",
        },
      ],
    });
    expect(review.issues).toHaveLength(0);
    expect(review.continuityOk).toBe(true);
  });

  it("确实指出具体冲突的问题仍然保留", () => {
    const review = normalizeReviewResult({
      summary: "摘要",
      issues: [
        {
          severity: "critical",
          type: "时间线",
          evidence: "角色甲同一时刻出现在城东和城西。",
          detail: "与第 3 章明确冲突：同一时刻角色甲还在城西，两地相隔一日路程。",
        },
      ],
    });
    expect(review.issues).toHaveLength(1);
    expect(review.issues[0].severity).toBe("critical");
  });

  it("承认与时间线并不冲突、只是偏离细纲的问题不再判严重", () => {
    const review = normalizeReviewResult({
      summary: "摘要",
      issues: [
        {
          severity: "critical",
          type: "时间线",
          evidence: "初十夜里，角色甲亥时三刻出发。",
          detail:
            "这与第 9 章“初十夜里出发”并不冲突，但问题在于：细纲要求角色甲进洞，正文写成在树林外引敌，这是对细纲关键事件的偏离，会影响后续进洞取物的因果链。",
        },
      ],
    });
    expect(review.issues).toHaveLength(0);
    expect(review.continuityOk).toBe(true);
  });

  it("同一段里既否认一个冲突、又指出另一个真实冲突时仍然保留", () => {
    const review = normalizeReviewResult({
      summary: "摘要",
      issues: [
        {
          severity: "critical",
          type: "时间线",
          evidence: "角色甲同一时刻出现在城东和城西。",
          detail:
            "与第 9 章的时间安排不构成冲突，但与第 3 章明确冲突：同一时刻角色甲还在城西，两地相隔一日路程。",
        },
      ],
    });
    expect(review.issues).toHaveLength(1);
    expect(review.issues[0].severity).toBe("critical");
  });

  it("警告级别的确认类提示保留", () => {
    const review = normalizeReviewResult({
      summary: "摘要",
      issues: [
        {
          severity: "warning",
          type: "时间线",
          evidence: "角色甲傍晚出发。",
          detail: "与上一章的“夜里”表述不一致，需作者确认具体时刻。",
        },
      ],
    });
    expect(review.issues).toHaveLength(1);
  });
});
