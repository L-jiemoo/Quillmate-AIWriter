import { describe, expect, it } from "vitest";
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

  it("只有严重问题严格减少且没有新增时才接受新版本", () => {
    const first = issue("时间线", "陈玉华上午被绑走。");
    const second = issue("人物行为", "陈玉华电话里撒谎。");
    const accepted = compareCriticalIssues([first, second], [first]);
    expect(accepted.accepted).toBe(true);

    const sameCount = compareCriticalIssues(
      [first, second],
      [issue("剧情因果", "陈默突然出现在石室。"), issue("世界观规则", "因果可以转嫁。")],
    );
    expect(sameCount.accepted).toBe(false);
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
