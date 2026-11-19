import { describe, expect, it } from "vitest";
import {
  applyRepairPatches,
  hashText,
  normalizeRepairPatches,
  RepairPatchError,
  withIssueIds,
  type RepairPatch,
} from "@/lib/repair-patch";
import type { ContinuityIssue } from "@/lib/types";

function issue(
  evidence: string,
  id = "issue-1",
  type = "时间线",
): ContinuityIssue {
  return { severity: "critical", type, evidence, detail: "与第 4 章事实冲突。", id };
}

function patch(
  issueId: string,
  originalText: string,
  replacement: string,
  reason = "修复对应问题",
): RepairPatch {
  return { issueId, edits: [{ originalText, replacement, reason }] };
}

function errorCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof RepairPatchError) return error.code;
    throw error;
  }
  throw new Error("预期抛出补丁校验错误");
}

describe("修复补丁应用", () => {
  it("正常局部修复只改动授权段落并记录差异", () => {
    const text = "第一段无关内容。\n陈玉华在省城超市收银台旁接电话。\n第三段无关内容。";
    const issues = [issue("陈玉华在省城超市收银台旁接电话。")];
    const batch = applyRepairPatches({
      originalText: text,
      issues,
      patches: [
        patch(
          "issue-1",
          "陈玉华在省城超市收银台旁接电话。",
          "陈玉华在阴巷口接电话。",
        ),
      ],
    });
    expect(batch.text).toContain("陈玉华在阴巷口接电话。");
    expect(batch.text).toContain("第一段无关内容。");
    expect(batch.records).toHaveLength(1);
    expect(batch.records[0].removed).toContain("省城超市");
    expect(batch.records[0].added).toContain("阴巷口");
    expect(batch.paragraphs).toEqual([1]);
  });

  it("原文锚点不存在时拒绝整批补丁", () => {
    expect(
      errorCode(() =>
        applyRepairPatches({
          originalText: "第一段。\n陈玉华在阴巷口接电话。",
          issues: [issue("陈玉华在阴巷口接电话。")],
          patches: [patch("issue-1", "陈玉华在省城接电话。", "陈玉华在阴巷口接电话。")],
        }),
      ),
    ).toBe("ANCHOR_NOT_FOUND");
  });

  it("原文锚点匹配多处时拒绝自动应用", () => {
    expect(
      errorCode(() =>
        applyRepairPatches({
          originalText: "陈玉华接电话。\n陈玉华接电话。",
          issues: [issue("陈玉华接电话。")],
          patches: [patch("issue-1", "陈玉华接电话。", "陈玉华关机。")],
        }),
      ),
    ).toBe("ANCHOR_NOT_UNIQUE");
  });

  it("两个补丁修改区域重叠时整批拒绝", () => {
    const text = "陈玉华在省城超市收银台旁接电话。";
    const issues = [
      issue("陈玉华在省城超市收银台旁接电话。", "issue-1"),
      issue("超市收银台旁接电话。", "issue-2", "人物行为"),
    ];
    expect(
      errorCode(() =>
        applyRepairPatches({
          originalText: text,
          issues,
          patches: [
            patch("issue-1", "陈玉华在省城超市收银台旁接电话。", "陈玉华关机。"),
            patch("issue-2", "超市收银台旁接电话。", "超市收银台旁无人接听。"),
          ],
        }),
      ),
    ).toBe("OVERLAP");
  });

  it("修改未授权段落时拒绝", () => {
    const text = "第一段无关内容。\n陈玉华在省城超市收银台旁接电话。\n第三段无关内容。";
    expect(
      errorCode(() =>
        applyRepairPatches({
          originalText: text,
          issues: [issue("陈玉华在省城超市收银台旁接电话。")],
          patches: [patch("issue-1", "第一段无关内容。", "第一段被改写。")],
        }),
      ),
    ).toBe("UNAUTHORIZED_SCOPE");
  });

  it("修改范围明显过大时拒绝，而不是强行局部改写", () => {
    const text = "陈玉华接电话。";
    expect(
      errorCode(() =>
        applyRepairPatches({
          originalText: text,
          issues: [issue(text)],
          patches: [patch("issue-1", text, "长".repeat(1300))],
        }),
      ),
    ).toBe("UNAUTHORIZED_SCOPE");
  });

  it("问题证据完全不在正文时无法授权修改", () => {
    expect(
      errorCode(() =>
        applyRepairPatches({
          originalText: "第一段。\n陈玉华接电话。",
          issues: [issue("陈默出现在石室。")],
          patches: [patch("issue-1", "陈玉华接电话。", "陈玉华关机。")],
        }),
      ),
    ).toBe("NO_AUTHORIZED_PARAGRAPH");
  });

  it("补丁引用不存在的问题编号时拒绝", () => {
    expect(
      errorCode(() =>
        applyRepairPatches({
          originalText: "陈玉华接电话。",
          issues: [issue("陈玉华接电话。")],
          patches: [patch("issue-9", "陈玉华接电话。", "陈玉华关机。")],
        }),
      ),
    ).toBe("UNKNOWN_ISSUE");
  });

  it("补丁没有覆盖全部问题时拒绝", () => {
    const text = "陈玉华接电话。陈默走进阴巷。";
    const issues = [
      issue("陈玉华接电话。", "issue-1"),
      issue("陈默走进阴巷。", "issue-2", "人物行为"),
    ];
    expect(
      errorCode(() =>
        applyRepairPatches({
          originalText: text,
          issues,
          patches: [patch("issue-1", "陈玉华接电话。", "陈玉华关机。")],
        }),
      ),
    ).toBe("UNCOVERED_ISSUE");
  });

  it("空补丁、空锚点、缺少理由和无实际修改都拒绝", () => {
    const text = "陈玉华接电话。";
    const issues = [issue(text)];
    expect(
      errorCode(() =>
        applyRepairPatches({ originalText: text, issues, patches: [] }),
      ),
    ).toBe("EMPTY_BATCH");
    expect(
      errorCode(() =>
        applyRepairPatches({
          originalText: text,
          issues,
          patches: [{ issueId: "issue-1", edits: [] }],
        }),
      ),
    ).toBe("EMPTY_EDIT");
    expect(
      errorCode(() =>
        applyRepairPatches({
          originalText: text,
          issues,
          patches: [{ issueId: "issue-1", edits: [{ originalText: "", replacement: "x", reason: "r" }] }],
        }),
      ),
    ).toBe("EMPTY_EDIT");
    expect(
      errorCode(() =>
        applyRepairPatches({
          originalText: text,
          issues,
          patches: [patch("issue-1", text, "陈玉华关机。", "")],
        }),
      ),
    ).toBe("MISSING_REASON");
    expect(
      errorCode(() =>
        applyRepairPatches({
          originalText: text,
          issues,
          patches: [patch("issue-1", text, text)],
        }),
      ),
    ).toBe("UNCHANGED_EDIT");
  });

  it("批量补丁部分失败时整批不应用", () => {
    const text = "陈玉华接电话。陈默走进阴巷。";
    const issues = [
      issue("陈玉华接电话。", "issue-1"),
      issue("陈默走进阴巷。", "issue-2", "人物行为"),
    ];
    let applied = "";
    try {
      applyRepairPatches({
        originalText: text,
        issues,
        patches: [
          patch("issue-1", "陈玉华接电话。", "陈玉华关机。"),
          patch("issue-2", "不存在的句子。", "陈默离开阴巷。"),
        ],
      });
      applied = "applied";
    } catch (error) {
      expect(error).toBeInstanceOf(RepairPatchError);
    }
    expect(applied).toBe("");
  });
});

describe("补丁输入规范化与问题 ID", () => {
  it("兼容 camelCase / snake_case 的模型输出", () => {
    const patches = normalizeRepairPatches({
      patches: [
        {
          issue_id: "issue-1",
          edits: [
            {
              original_text: "旧句子。",
              replacement: "新句子。",
              reason: "修正",
            },
          ],
        },
      ],
    });
    expect(patches).toEqual([
      {
        issueId: "issue-1",
        edits: [{ originalText: "旧句子。", replacement: "新句子。", reason: "修正" }],
      },
    ]);
  });

  it("为缺少 ID 的问题生成稳定且不重复的 ID", () => {
    const issues: ContinuityIssue[] = [
      { severity: "critical", type: "时间线", evidence: "证据一", detail: "说明" },
      { severity: "warning", type: "人物行为", evidence: "证据二", detail: "说明" },
    ];
    const staged = withIssueIds(issues);
    expect(staged.map((item) => item.id)).toEqual(["issue-1", "issue-2"]);
    expect(staged[0].sourceEvidence).toBe("证据一");
    expect(withIssueIds([{ ...issues[0], id: "a" }, { ...issues[1], id: "a" }]).map((item) => item.id)).toEqual([
      "a",
      "a-2",
    ]);
  });

  it("原文哈希对相同文本稳定、对修改敏感", () => {
    expect(hashText("同一段正文")).toBe(hashText("同一段正文"));
    expect(hashText("同一段正文")).not.toBe(hashText("同一段正文。"));
  });
});
