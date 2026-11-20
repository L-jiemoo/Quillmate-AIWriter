import { describe, expect, it } from "vitest";
import type { ChapterPlan } from "@/lib/types";
import {
  assertValidChapterPlans,
  parseChapterIndex,
  validateChapterPlans,
} from "@/lib/plan-validation";

function chapter(index: number, title = `标题 ${index}`, summary = `摘要 ${index}`): ChapterPlan {
  return { index, title, summary, keyBeats: [] };
}

describe("严格章节编号校验", () => {
  it("接受 1..N 连续且字段完整的细纲", () => {
    const issues = validateChapterPlans([chapter(1), chapter(2), chapter(3)], {
      expectedCount: 3,
      startIndex: 1,
      requireContiguous: true,
    });
    expect(issues.filter((issue) => issue.severity === "critical")).toEqual([]);
  });

  it("拒绝重复、零、负数和小数编号", () => {
    const issues = validateChapterPlans(
      [chapter(0), chapter(-1), chapter(1.5), chapter(2), chapter(2)],
      { requireContiguous: false },
    );
    const codes = issues.map((issue) => issue.code);
    expect(codes).toContain("invalid-index");
    expect(codes).toContain("duplicate-index");
    expect(issues.filter((issue) => issue.code === "invalid-index")).toHaveLength(3);
  });

  it("拒绝断号、空标题和空摘要，并指出位置", () => {
    const issues = validateChapterPlans(
      [chapter(1), chapter(3, "", "摘要"), chapter(4, "标题", "")],
      { startIndex: 1, requireContiguous: true },
    );
    expect(issues.some((issue) => issue.code === "non-contiguous-index")).toBe(true);
    expect(issues.some((issue) => issue.code === "empty-title")).toBe(true);
    expect(issues.some((issue) => issue.code === "empty-summary")).toBe(true);
    expect(issues.find((issue) => issue.code === "empty-title")?.message).toContain(
      "第 3 章",
    );
  });

  it("检查数量与目标章节数", () => {
    const tooMany = validateChapterPlans([chapter(1), chapter(2)], {
      targetChapters: 1,
    });
    expect(tooMany.find((issue) => issue.code === "exceeds-target")?.severity).toBe(
      "critical",
    );

    const mismatch = validateChapterPlans([chapter(1)], { targetChapters: 3 });
    expect(mismatch.find((issue) => issue.code === "target-mismatch")?.severity).toBe(
      "warning",
    );

    expect(() =>
      assertValidChapterPlans([chapter(1)], { expectedCount: 2 }),
    ).toThrow("章节数量为 1，预期 2 章");
  });

  it("解析模型返回的整数序号，拒绝小数和非数字", () => {
    expect(parseChapterIndex(3)).toBe(3);
    expect(parseChapterIndex(" 04 ")).toBe(4);
    expect(parseChapterIndex(0)).toBeNull();
    expect(parseChapterIndex(1.2)).toBeNull();
    expect(parseChapterIndex("第一章")).toBeNull();
  });
});
