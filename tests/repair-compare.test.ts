import { describe, expect, it } from "vitest";
import {
  compareCriticalIssues,
  filterSeedIssues,
  normalizeIssueText,
} from "@/lib/repair-compare";
import type { ContinuityIssue } from "@/lib/types";

function issue(
  type: string,
  evidence: string,
  detail = "与第 4 章事实台账冲突。",
): ContinuityIssue {
  return { severity: "critical", type, evidence, detail };
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

  it("贪心一对一匹配，一个问题不能消费多个旧问题", () => {
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
