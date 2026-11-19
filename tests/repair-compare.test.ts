import { describe, expect, it } from "vitest";
import { evaluateRepair } from "@/lib/repair-acceptance";
import {
  compareCriticalIssues,
  filterSeedIssues,
  normalizeIssueText,
} from "@/lib/repair-compare";
import type { Character, ContinuityIssue } from "@/lib/types";

function issue(
  type: string,
  evidence: string,
  detail = "与第 4 章事实台账冲突。",
): ContinuityIssue {
  return { severity: "critical", type, evidence, detail };
}

function character(name: string): Character {
  return {
    name,
    role: "配角",
    gender: "未知",
    age: "未知",
    appearance: "",
    personality: "",
    background: "",
    goals: "",
    arc: "",
    relationships: "",
    speechStyle: "",
  };
}

describe("草稿修复问题对比", () => {
  it("同类型且证据只是标点/措辞微调时视为同一问题", () => {
    const before = [
      issue("时间线", "陈玉华在省城超市收银台旁接电话，随后关机。"),
    ];
    const after = [
      issue("时间线", "陈玉华在省城超市收银台旁接电话, 随后关机"),
    ];
    const result = compareCriticalIssues(before, after);
    expect(result.remaining).toHaveLength(1);
    expect(result.resolved).toHaveLength(0);
    expect(result.added).toHaveLength(0);
    expect(result.accepted).toBe(false);
  });

  it("问题类型变化时视为新增", () => {
    const result = compareCriticalIssues(
      [issue("时间线", "陈玉华下午两点二十在省城接电话。")],
      [issue("人物行为", "陈玉华下午两点二十在省城接电话。")],
    );
    expect(result.added).toHaveLength(1);
    expect(result.resolved).toHaveLength(1);
  });

  it("相同证据且冲突章节相同时仍能匹配", () => {
    const text = "陈玉华在省城超市收银台旁接电话。";
    const result = compareCriticalIssues(
      [issue("时间线", text, "与第 4 章事实冲突。")],
      [issue("时间线", text, "与第 4 章事实冲突。")],
    );
    expect(result.remaining).toHaveLength(1);
    expect(result.resolved).toHaveLength(0);
    expect(result.added).toHaveLength(0);
  });

  it("相同证据但冲突章节不同时必须识别为不同问题", () => {
    const text = "陈玉华在省城超市收银台旁接电话。";
    const result = compareCriticalIssues(
      [issue("时间线", text, "与第 4 章事实冲突。")],
      [issue("时间线", text, "与第 6 章事实冲突。")],
    );
    expect(result.remaining).toHaveLength(0);
    expect(result.resolved).toHaveLength(1);
    expect(result.added).toHaveLength(1);
  });

  it("不同问题类型不能仅凭相同证据匹配", () => {
    const text = "陈玉华在省城超市收银台旁接电话。";
    const result = compareCriticalIssues(
      [issue("时间线", text)],
      [issue("人物生死状态", text)],
    );
    expect(result.resolved).toHaveLength(1);
    expect(result.added).toHaveLength(1);
  });

  it("相同证据但关键实体不同时不能被错误合并", () => {
    const characters = [character("陈玉华"), character("李四")];
    const evidence = "密室里发现了一具尸体。";
    const result = compareCriticalIssues(
      [issue("人物生死状态", evidence, "李四与第 4 章状态冲突。")],
      [issue("人物生死状态", evidence, "陈玉华与第 4 章状态冲突。")],
      characters,
    );
    expect(result.remaining).toHaveLength(0);
    expect(result.resolved).toHaveLength(1);
    expect(result.added).toHaveLength(1);
  });

  it("章节锚点冲突时不会误判为同一问题", () => {
    const before = [
      issue(
        "剧情因果",
        "陈玉华在电话里警告陈默今晚不要去阴巷。",
        "与第 4 章事实冲突。",
      ),
    ];
    const after = [
      issue(
        "剧情因果",
        "陈玉华在电话里警告陈默今晚别去阴巷。",
        "与第 6 章事实冲突。",
      ),
    ];
    const result = compareCriticalIssues(before, after);
    expect(result.remaining).toHaveLength(0);
    expect(result.added).toHaveLength(1);
  });

  it("最大权重匹配，一个问题不能消费多个旧问题", () => {
    const before = [
      issue("时间线", "陈玉华在省城超市收银台旁接电话。"),
      issue("时间线", "陈玉华在省城超市收银台旁边接听电话。"),
    ];
    const after = [issue("时间线", "陈玉华在省城超市收银台旁接电话。")];
    const result = compareCriticalIssues(before, after);
    expect(result.remaining).toHaveLength(1);
    expect(result.resolved).toHaveLength(1);
    expect(result.added).toHaveLength(0);
  });

  it("两个旧问题和两个新问题交叉相似时选择全局最优配对", () => {
    const before = [
      issue(
        "时间线",
        "陈玉华在省城超市收银台旁接电话。",
        "与事实台账冲突。",
      ),
      issue(
        "时间线",
        "陈玉华在省城超市的收银台旁接听电话。",
        "与第 4 章事实台账冲突。",
      ),
    ];
    const after = [
      issue(
        "时间线",
        "陈玉华在省城超市收银台旁接电话。",
        "与第 4 章事实台账冲突。",
      ),
      issue(
        "时间线",
        "陈玉华在省城超市收银台旁接听电话。",
        "与第 5 章事实台账冲突。",
      ),
    ];
    const result = compareCriticalIssues(before, after);
    // 全局最优会同时保留两个旧问题的匹配；贪心会错配成“解决 1、新增 1”。
    expect(result.remaining).toHaveLength(2);
    expect(result.resolved).toHaveLength(0);
    expect(result.added).toHaveLength(0);
  });

  it("歧义匹配时保守处理，不会把多个新问题吸收成同一个旧问题", () => {
    const before = [issue("时间线", "陈玉华在省城超市收银台旁接电话。")];
    const after = [
      issue("时间线", "陈玉华在省城超市收银台旁接电话。", "与第 4 章事实冲突。"),
      issue("时间线", "陈玉华在省城超市收银台旁接电话。", "第 4 章时间线疑似冲突。"),
    ];
    const result = compareCriticalIssues(before, after);
    expect(result.remaining).toHaveLength(1);
    expect(result.resolved).toHaveLength(0);
    expect(result.added).toHaveLength(1);
  });

  it("新增严重问题不能被错误吸收进旧问题", () => {
    const text = "陈玉华在省城超市收银台旁接电话。";
    const result = compareCriticalIssues(
      [issue("时间线", text, "与第 4 章事实冲突。")],
      [
        issue("时间线", text, "与第 4 章事实冲突。"),
        issue("时间线", text, "与第 8 章事实冲突。"),
      ],
    );
    expect(result.resolved).toHaveLength(0);
    expect(result.added).toHaveLength(1);
  });

  it("问题数量减少但仍有原问题未解决时只能算改善，不能验收通过", () => {
    const first = issue("时间线", "陈玉华上午被绑走。");
    const second = issue("人物行为", "陈玉华电话里撒谎。");
    const improved = compareCriticalIssues([first, second], [first]);
    expect(improved.improved).toBe(true);
    expect(improved.accepted).toBe(false);
    expect(improved.remaining).toHaveLength(1);

    const resolved = compareCriticalIssues([first, second], []);
    expect(resolved.accepted).toBe(true);
    expect(resolved.improved).toBe(true);

    const sameCount = compareCriticalIssues(
      [first, second],
      [issue("剧情因果", "陈默突然出现在石室。"), issue("世界观规则", "因果可以转嫁。")],
    );
    expect(sameCount.accepted).toBe(false);
    expect(sameCount.improved).toBe(false);
    expect(sameCount.added).toHaveLength(2);
  });

  it("空问题集合不会被当作成功", () => {
    const result = compareCriticalIssues([], []);
    expect(result.accepted).toBe(false);
    expect(result.beforeCount).toBe(0);
    expect(result.afterCount).toBe(0);
  });
});

describe("旧审校问题过期过滤", () => {
  it("证据仍存在于当前草稿时保留，证据消失时标记过期", () => {
    const active = issue("时间线", "陈玉华在省城超市收银台旁接电话。");
    const stale = issue("人物行为", "陈玉华一早被长夜教带走。");
    const text = "陈玉华在省城超市收银台旁接电话，随后关机。";
    const result = filterSeedIssues([active, stale], text);
    expect(result.active).toEqual([active]);
    expect(result.stale).toEqual([stale]);
  });

  it("规范化会忽略空白和标点差异", () => {
    expect(normalizeIssueText("第 4 章：陈玉华，接电话。")).toBe(
      "第4章陈玉华接电话",
    );
  });
});

describe("结构化问题字段", () => {
  it("来源章节不同的问题不能合并", () => {
    const before = [
      {
        ...issue("剧情因果", "电话内容对不上。", "前后电话内容冲突。"),
        sourceChapter: 4,
      },
    ];
    const after = [
      {
        ...issue("剧情因果", "电话内容对不上。", "前后电话内容冲突。"),
        sourceChapter: 6,
      },
    ];
    const result = compareCriticalIssues(before, after);
    expect(result.remaining).toHaveLength(0);
    expect(result.added).toHaveLength(1);
  });

  it("冲突类别不同的问题不能合并", () => {
    const before = [
      {
        ...issue("剧情因果", "同一时间出现在两地。"),
        conflictCategory: "timeline" as const,
      },
    ];
    const after = [
      {
        ...issue("剧情因果", "同一时间出现在两地。"),
        conflictCategory: "foreshadow" as const,
      },
    ];
    const result = compareCriticalIssues(before, after);
    expect(result.remaining).toHaveLength(0);
    expect(result.added).toHaveLength(1);
  });

  it("受影响人物没有交集时不能合并", () => {
    const before = [
      {
        ...issue("人物行为", "身份暴露。"),
        affectedCharacters: ["陈默"],
      },
    ];
    const after = [
      {
        ...issue("人物行为", "身份暴露。"),
        affectedCharacters: ["陈玉华"],
      },
    ];
    const result = compareCriticalIssues(before, after);
    expect(result.remaining).toHaveLength(0);
    expect(result.added).toHaveLength(1);
  });

  it("只有一边提供来源章节时不能仅凭文本相似度确认已解决", () => {
    const before = [
      {
        ...issue("时间线", "陈玉华在省城超市收银台旁接电话。"),
        sourceChapter: 4,
      },
    ];
    const after = [issue("时间线", "陈玉华在省城超市收银台旁接电话。")];
    const result = compareCriticalIssues(before, after);
    expect(result.ambiguous).toBe(true);
    expect(result.accepted).toBe(false);
    const acceptance = evaluateRepair({ before, after });
    expect(acceptance.status).toBe("REJECTED_UNRESOLVED");
  });

  it("只有一边提供受影响人物时标记歧义", () => {
    const before = [
      {
        ...issue("人物行为", "身份暴露。"),
        affectedCharacters: ["陈默"],
      },
    ];
    const after = [issue("人物行为", "身份暴露。")];
    const result = compareCriticalIssues(before, after);
    expect(result.ambiguous).toBe(true);
  });

  it("章节编号与普通数字不混用锚点", () => {
    const evidence = "陈玉华在省城接电话。";
    const result = compareCriticalIssues(
      [issue("时间线", evidence, "与第 4 章冲突。")],
      [issue("时间线", evidence, "下午 4 点时间对不上。")],
    );
    // “第 4 章”与“4 点”不属于同一锚点，不能仅凭文本相同就认定问题已解决。
    expect(result.remaining).toHaveLength(0);
    expect(result.resolved).toHaveLength(1);
    expect(result.added).toHaveLength(1);
  });

  it("相同指纹且类型一致时视为同一问题", () => {
    const before = [
      { ...issue("时间线", "前后日期矛盾。"), fingerprint: "timeline-4-chen" },
    ];
    const after = [
      { ...issue("时间线", "日期先后对不上。"), fingerprint: "timeline-4-chen" },
    ];
    const result = compareCriticalIssues(before, after);
    expect(result.remaining).toHaveLength(1);
    expect(result.added).toHaveLength(0);
  });
});

describe("统一修复验收", () => {
  it("原问题全部解决且没有新增时通过", () => {
    const before = [issue("时间线", "陈玉华上午被绑走。")];
    const result = evaluateRepair({ before, after: [] });
    expect(result.status).toBe("ACCEPTED");
    expect(result.accepted).toBe(true);
  });

  it("原问题仍有残留时拒绝", () => {
    const problem = issue("时间线", "陈玉华上午被绑走。");
    const result = evaluateRepair({
      before: [problem, issue("人物行为", "陈玉华电话里撒谎。")],
      after: [problem],
    });
    expect(result.status).toBe("REJECTED_UNRESOLVED");
    expect(result.comparison.remaining).toHaveLength(1);
  });

  it("修复引入新严重问题时拒绝", () => {
    const result = evaluateRepair({
      before: [issue("时间线", "陈玉华上午被绑走。")],
      after: [
        issue("时间线", "陈玉华上午被绑走。"),
        issue("剧情因果", "陈默突然出现在石室。", "与第 8 章冲突。"),
      ],
    });
    expect(result.status).toBe("REJECTED_NEW_CRITICAL");
    expect(result.comparison.added).toHaveLength(1);
  });

  it("破坏既定事实时拒绝", () => {
    const result = evaluateRepair({
      before: [issue("时间线", "陈玉华上午被绑走。")],
      after: [],
      factConflicts: [
        {
          severity: "critical",
          type: "死亡状态",
          evidence: "陈玉华再次出现",
          detail: "已在第 3 章死亡",
          conflictCategory: "character-status",
        },
      ],
    });
    expect(result.status).toBe("REJECTED_FACT_CONFLICT");
  });

  it("审校或抽取失败时拒绝", () => {
    const before = [issue("时间线", "陈玉华上午被绑走。")];
    expect(evaluateRepair({ before, after: [], auditFailed: true }).status).toBe(
      "VERIFY_FAILED",
    );
    expect(
      evaluateRepair({ before, after: [], extractionOk: false }).status,
    ).toBe("VERIFY_FAILED");
  });

  it("证据不足需要作者决定时拒绝自动采用", () => {
    const result = evaluateRepair({
      before: [issue("时间线", "陈玉华上午被绑走。")],
      after: [],
      needsAuthorDecision: true,
    });
    expect(result.status).toBe("NEEDS_AUTHOR_DECISION");
  });

  it("匹配存在歧义时保守拒绝", () => {
    const text = "陈玉华在省城超市收银台旁接电话。";
    const result = evaluateRepair({
      before: [issue("时间线", text)],
      after: [issue("时间线", text, "与第 4 章事实冲突。")],
      characters: [character("陈玉华")],
    });
    // 单个精确匹配不构成歧义；但同一问题仍出现在审校结果里，说明未解决。
    expect(result.comparison.ambiguous).toBe(false);
    expect(result.status).toBe("REJECTED_UNRESOLVED");

    const ambiguous = evaluateRepair({
      before: [
        issue("时间线", "陈玉华在省城超市收银台旁接电话。"),
        issue("时间线", "陈玉华在省城超市收银台旁边接听电话。"),
      ],
      after: [issue("时间线", "陈玉华在省城超市收银台旁接电话。")],
      characters: [character("陈玉华")],
    });
    expect(ambiguous.accepted).toBe(false);
    expect(ambiguous.status).toBe("REJECTED_UNRESOLVED");
  });

  it("只有建议类修复目标时允许没有严重问题基线", () => {
    const result = evaluateRepair({ before: [], after: [], allowNoBaseline: true });
    expect(result.status).toBe("ACCEPTED");
  });
});

describe("全严重度严格验收", () => {
  function warningIssue(
    type: string,
    evidence: string,
    conflictCategory?: ContinuityIssue["conflictCategory"],
  ): ContinuityIssue {
    return {
      severity: "warning",
      type,
      evidence,
      detail: "需要注意。",
      conflictCategory,
    };
  }

  it("严格模式下新增事实类 warning 也拒绝写回", () => {
    const result = evaluateRepair({
      before: [issue("时间线", "陈玉华上午被绑走。")],
      after: [
        warningIssue("时间线", "陈玉华下午又出现在省城。", "timeline"),
      ],
    });
    expect(result.status).toBe("REJECTED_NEW_WARNING");
  });

  it("严格模式下新增表达建议类 warning 也拒绝自动写回", () => {
    const result = evaluateRepair({
      before: [issue("时间线", "陈玉华上午被绑走。")],
      after: [warningIssue("表达建议", "这句话可以更简洁。")],
    });
    expect(result.status).toBe("REJECTED_NEW_WARNING");
  });

  it("标准模式只拒绝新增事实类 warning，并记录表达建议", () => {
    const result = evaluateRepair({
      before: [issue("时间线", "陈玉华上午被绑走。")],
      after: [warningIssue("表达建议", "这句话可以更简洁。")],
      mode: "STANDARD",
    });
    expect(result.status).toBe("ACCEPTED");
    expect(result.leftovers.join("")).toContain("表达建议");

    const factual = evaluateRepair({
      before: [issue("时间线", "陈玉华上午被绑走。")],
      after: [warningIssue("物品归属", "匕首持有人发生了变化。", "fact")],
      mode: "STANDARD",
    });
    expect(factual.status).toBe("REJECTED_NEW_WARNING");
  });

  it("原有 warning 未解决时记录遗留问题但仍可写回", () => {
    const warning = warningIssue("表达建议", "结尾略显仓促。");
    const result = evaluateRepair({
      before: [issue("时间线", "陈玉华上午被绑走。"), warning],
      after: [warning],
    });
    expect(result.status).toBe("ACCEPTED");
    expect(result.leftovers.join("")).toContain("warning 未解决");
  });

  it("新增建议类问题只记录，不当作剧情矛盾", () => {
    const result = evaluateRepair({
      before: [issue("时间线", "陈玉华上午被绑走。")],
      after: [
        {
          severity: "ignore",
          type: "用词建议",
          evidence: "可以换一个动词。",
          detail: "仅建议。",
        },
      ],
    });
    expect(result.status).toBe("ACCEPTED");
    expect(result.leftovers.join("")).toContain("建议类问题");
  });

  it("无类别的新增 warning 按不确定问题保守拒绝", () => {
    const result = evaluateRepair({
      before: [issue("时间线", "陈玉华上午被绑走。")],
      after: [warningIssue("其他", "这里似乎有点不对劲。")],
    });
    expect(result.status).toBe("REJECTED_NEW_WARNING");
  });

  it("warning 匹配存在歧义时转交作者决定", () => {
    const result = evaluateRepair({
      before: [
        issue("时间线", "陈玉华上午被绑走。"),
        warningIssue("表达建议", "陈玉华在省城超市收银台旁接电话。"),
        {
          ...warningIssue("表达建议", "陈玉华在省城超市收银台旁接电话。"),
          detail: "另一条接近的措辞建议。",
        },
      ],
      after: [warningIssue("表达建议", "陈玉华在省城超市收银台旁接电话。")],
      characters: [character("陈玉华")],
    });
    expect(result.status).toBe("NEEDS_AUTHOR_DECISION");
  });

  it("补丁超出授权范围时返回范围违规状态", () => {
    const result = evaluateRepair({
      before: [issue("时间线", "陈玉华上午被绑走。")],
      after: [],
      scopeViolation: true,
    });
    expect(result.status).toBe("REJECTED_SCOPE_VIOLATION");
  });
});
