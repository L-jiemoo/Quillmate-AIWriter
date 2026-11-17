import { describe, expect, it } from "vitest";
import { diffLines } from "@/lib/text-diff";

describe("章节版本差异", () => {
  it("标记新增、删除和未变化行", () => {
    const diff = diffLines("第一行\n第二行\n第三行", "第一行\n新的第二行\n第三行");
    expect(diff.map((line) => line.type)).toEqual([
      "same",
      "remove",
      "add",
      "same",
    ]);
    expect(diff[1].text).toBe("第二行");
    expect(diff[2].text).toBe("新的第二行");
  });

  it("相同内容全部为 same", () => {
    expect(diffLines("甲\n乙", "甲\n乙").every((line) => line.type === "same")).toBe(
      true,
    );
  });
});
