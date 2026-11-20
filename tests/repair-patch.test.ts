import { describe, expect, it } from "vitest";
import {
  applyRepairPatches,
  applyRepairPatchesAcross,
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
  throw new Error("预期抛出补角色丁校验错误");
}

describe("修复补角色丁应用", () => {
  it("正常局部修复只改动授权段落并记录差异", () => {
    const text = "第一段无关内容。\n角色乙在外地超市收银台旁接电话。\n第三段无关内容。";
    const issues = [issue("角色乙在外地超市收银台旁接电话。")];
    const batch = applyRepairPatches({
      originalText: text,
      issues,
      patches: [
        patch(
          "issue-1",
          "角色乙在外地超市收银台旁接电话。",
          "角色乙在巷口接电话。",
        ),
      ],
    });
    expect(batch.text).toContain("角色乙在巷口接电话。");
    expect(batch.text).toContain("第一段无关内容。");
    expect(batch.records).toHaveLength(1);
    expect(batch.records[0].removed).toContain("外地超市");
    expect(batch.records[0].added).toContain("巷口");
    expect(batch.paragraphs).toEqual([1]);
  });

  it("原文锚点不存在时拒绝整批补角色丁", () => {
    expect(
      errorCode(() =>
        applyRepairPatches({
          originalText: "第一段。\n角色乙在巷口接电话。",
          issues: [issue("角色乙在巷口接电话。")],
          patches: [patch("issue-1", "角色乙在外地接电话。", "角色乙在巷口接电话。")],
        }),
      ),
    ).toBe("ANCHOR_NOT_FOUND");
  });

  it("原文锚点匹配多处时拒绝自动应用", () => {
    expect(
      errorCode(() =>
        applyRepairPatches({
          originalText: "角色乙接电话。\n角色乙接电话。",
          issues: [issue("角色乙接电话。")],
          patches: [patch("issue-1", "角色乙接电话。", "角色乙关机。")],
        }),
      ),
    ).toBe("ANCHOR_NOT_UNIQUE");
  });

  it("两个补角色丁修改区域重叠时整批拒绝", () => {
    const text = "角色乙在外地超市收银台旁接电话。";
    const issues = [
      issue("角色乙在外地超市收银台旁接电话。", "issue-1"),
      issue("超市收银台旁接电话。", "issue-2", "人物行为"),
    ];
    expect(
      errorCode(() =>
        applyRepairPatches({
          originalText: text,
          issues,
          patches: [
            patch("issue-1", "角色乙在外地超市收银台旁接电话。", "角色乙关机。"),
            patch("issue-2", "超市收银台旁接电话。", "超市收银台旁无人接听。"),
          ],
        }),
      ),
    ).toBe("OVERLAP");
  });

  it("修改未授权段落时拒绝", () => {
    const text = "第一段无关内容。\n角色乙在外地超市收银台旁接电话。\n第三段无关内容。";
    expect(
      errorCode(() =>
        applyRepairPatches({
          originalText: text,
          issues: [issue("角色乙在外地超市收银台旁接电话。")],
          patches: [patch("issue-1", "第一段无关内容。", "第一段被改写。")],
        }),
      ),
    ).toBe("UNAUTHORIZED_SCOPE");
  });

  it("方案位置显式授权的其他段落可以修改", () => {
    const text = [
      "第一段无关内容。",
      "角色乙在办公室里接电话。",
      "角色甲忽然想起电话里的背景音。",
    ].join("\n");
    const batch = applyRepairPatches({
      originalText: text,
      issues: [issue("角色乙在办公室里接电话。")],
      extraAuthorizedAnchors: ["角色甲忽然想起电话里的背景音。"],
      patches: [
        patch("issue-1", "角色甲忽然想起电话里的背景音。", "角色甲忽然想起电话里的录音。"),
      ],
    });
    expect(batch.text).toContain("电话里的录音");
    expect(batch.paragraphs).toEqual([2]);
  });

  it("修改范围明显过大时拒绝，而不是强行局部改写", () => {
    const text = "角色乙接电话。";
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

  it("证据用省略号跨段引用时，被引用的每个段落都可修改", () => {
    const text = [
      "开头无关段落。",
      "“你姑比你早到了半天。”角色丙往旁边让了让。",
      "中间无关段落。",
      "“你姑今天一早出门进货，我的人在批发市场后巷把她带走了。”",
      "结尾无关段落。",
    ].join("\n");
    const evidence =
      "“你姑比你早到了半天。”……“你姑今天一早出门进货，我的人在批发市场后巷把她带走了。”";
    const batch = applyRepairPatches({
      originalText: text,
      issues: [issue(evidence)],
      patches: [
        patch(
          "issue-1",
          "“你姑比你早到了半天。”角色丙往旁边让了让。",
          "“你姑比你早到两个钟头。”角色丙往旁边让了让。",
        ),
      ],
    });
    expect(batch.text).toContain("早到两个钟头");
    expect(batch.paragraphs).toEqual([1]);
  });

  it("证据用全角斜杠拼接时，含任一片段的段落都可修改", () => {
    const text = [
      "开头无关段落。",
      "角色丙说：“今晚出发。”",
      "中间无关段落。",
      "角色丁说：“明早出发。”",
      "角色甲重复：“今晚出发。”",
    ].join("\n");
    const evidence = "“今晚出发。”／“明早出发。”角色丁说";
    const batch = applyRepairPatches({
      originalText: text,
      issues: [issue(evidence)],
      patches: [
        patch("issue-1", "角色甲重复：“今晚出发。”", "角色甲重复：“今晚就走。”"),
      ],
    });
    expect(batch.text).toContain("今晚就走");
    expect(batch.paragraphs).toEqual([4]);
  });

  it("问题证据完全不在正文时无法授权修改", () => {
    expect(
      errorCode(() =>
        applyRepairPatches({
          originalText: "第一段。\n角色乙接电话。",
          issues: [issue("角色甲出现在石室。")],
          patches: [patch("issue-1", "角色乙接电话。", "角色乙关机。")],
        }),
      ),
    ).toBe("NO_AUTHORIZED_PARAGRAPH");
  });

  it("补角色丁引用不存在的问题编号时拒绝", () => {
    expect(
      errorCode(() =>
        applyRepairPatches({
          originalText: "角色乙接电话。",
          issues: [issue("角色乙接电话。")],
          patches: [patch("issue-9", "角色乙接电话。", "角色乙关机。")],
        }),
      ),
    ).toBe("UNKNOWN_ISSUE");
  });

  it("补角色丁没有覆盖全部问题时拒绝", () => {
    const text = "角色乙接电话。角色甲走进巷口。";
    const issues = [
      issue("角色乙接电话。", "issue-1"),
      issue("角色甲走进巷口。", "issue-2", "人物行为"),
    ];
    expect(
      errorCode(() =>
        applyRepairPatches({
          originalText: text,
          issues,
          patches: [patch("issue-1", "角色乙接电话。", "角色乙关机。")],
        }),
      ),
    ).toBe("UNCOVERED_ISSUE");
  });

  it("空补角色丁、空锚点、缺少理由和无实际修改都拒绝", () => {
    const text = "角色乙接电话。";
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
          patches: [patch("issue-1", text, "角色乙关机。", "")],
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

  it("批量补角色丁部分失败时整批不应用", () => {
    const text = "角色乙接电话。角色甲走进巷口。";
    const issues = [
      issue("角色乙接电话。", "issue-1"),
      issue("角色甲走进巷口。", "issue-2", "人物行为"),
    ];
    let applied = "";
    try {
      applyRepairPatches({
        originalText: text,
        issues,
        patches: [
          patch("issue-1", "角色乙接电话。", "角色乙关机。"),
          patch("issue-2", "不存在的句子。", "角色甲离开巷口。"),
        ],
      });
      applied = "applied";
    } catch (error) {
      expect(error).toBeInstanceOf(RepairPatchError);
    }
    expect(applied).toBe("");
  });
});

describe("跨章补角色丁应用", () => {
  const targetText = "第5章：角色乙上午已被带到巷口。";
  const sourceText = "第4章：角色乙在外地超市收银台旁接电话。";
  const crossIssue = issue("角色乙上午已被带到巷口。");

  it("作者确认的根因章节可以同时修改，仍逐章校验差异", () => {
    const batches = applyRepairPatchesAcross({
      chapters: [
        { index: 5, text: targetText },
        { index: 4, text: sourceText, extraAuthorizedAnchors: [sourceText] },
      ],
      targetIndex: 5,
      issues: [crossIssue],
      patches: [
        {
          issueId: "issue-1",
          edits: [
            {
              originalText: "角色乙上午已被带到巷口。",
              replacement: "角色乙下午被带到巷口。",
              reason: "保留第 4 章电话真实性",
            },
            {
              chapterIndex: 4,
              originalText: sourceText,
              replacement: "第4章：电话是某组织伪造的录音。",
              reason: "保留第 5 章时间线",
            },
          ],
        },
      ],
    });
    const byChapter = new Map(batches.map((batch) => [batch.chapterIndex, batch]));
    expect(byChapter.get(5)?.text).toContain("下午被带到巷口");
    expect(byChapter.get(4)?.text).toContain("伪造的录音");
    expect(byChapter.get(4)?.records).toHaveLength(1);
  });

  it("未列入授权章节的跨章修改直接拒绝", () => {
    expect(
      errorCode(() =>
        applyRepairPatchesAcross({
          chapters: [{ index: 5, text: targetText }],
          targetIndex: 5,
          issues: [crossIssue],
          patches: [
            {
              issueId: "issue-1",
              edits: [
                {
                  chapterIndex: 4,
                  originalText: sourceText,
                  replacement: "新正文。",
                  reason: "越权",
                },
              ],
            },
          ],
        }),
      ),
    ).toBe("UNKNOWN_CHAPTER");
  });

  it("根因章节没有授权锚点时不能修改", () => {
    expect(
      errorCode(() =>
        applyRepairPatchesAcross({
          chapters: [
            { index: 5, text: targetText },
            { index: 4, text: sourceText },
          ],
          targetIndex: 5,
          issues: [crossIssue],
          patches: [
            {
              issueId: "issue-1",
              edits: [
                {
                  originalText: "角色乙上午已被带到巷口。",
                  replacement: "角色乙下午被带到巷口。",
                  reason: "目标章修复",
                },
                {
                  chapterIndex: 4,
                  originalText: sourceText,
                  replacement: "新正文。",
                  reason: "越权",
                },
              ],
            },
          ],
        }),
      ),
    ).toBe("NO_AUTHORIZED_PARAGRAPH");
  });
});

describe("补角色丁输入规范化与问题 ID", () => {
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
