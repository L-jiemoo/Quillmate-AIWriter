import { describe, expect, it } from "vitest";
import {
  buildInitialCanon,
  emptyCanon,
  formatCanonForPrompt,
  isCanonEmpty,
} from "@/lib/canon";
import type { Character } from "@/lib/types";

function character(overrides: Partial<Character> = {}): Character {
  return {
    name: "沈烛",
    role: "主角",
    gender: "男",
    age: "十九岁",
    appearance: "",
    personality: "",
    background: "",
    goals: "找回失去的记忆",
    arc: "",
    relationships: "",
    speechStyle: "",
    ...overrides,
  };
}

describe("架构初始事实台账", () => {
  it("从人物卡生成待正文确认的人物基线", () => {
    const canon = buildInitialCanon(
      [
        character(),
        character({
          name: "顾晚舟",
          role: "核心配角",
          goals: "送出真相",
        }),
        character({ name: "   ", role: "空角色" }),
      ],
      "2026-11-17T00:00:00.000Z",
    );

    expect(canon.lastChapter).toBe(0);
    expect(canon.updatedAt).toBe("2026-11-17T00:00:00.000Z");
    expect(canon.characters.map((item) => item.name)).toEqual(["沈烛", "顾晚舟"]);
    expect(canon.characters[0]).toMatchObject({
      status: "unknown",
      location: "",
      chapter: 0,
      statusChapter: 0,
    });
    expect(canon.characters[0].note).toContain("主角");
    expect(canon.characters[0].note).toContain("目标：找回失去的记忆");
    expect(canon.items).toEqual([]);
    expect(canon.timeline).toEqual({ currentDay: "", deadlines: [] });
    expect(canon.rules).toEqual([]);
  });

  it("只把完全空白的台账视为可初始化", () => {
    expect(isCanonEmpty(emptyCanon())).toBe(true);
    expect(isCanonEmpty(buildInitialCanon([character()]))).toBe(false);

    const withRule = emptyCanon();
    withRule.rules.push("不可违背的规则");
    expect(isCanonEmpty(withRule)).toBe(false);

    const withChapter = emptyCanon();
    withChapter.lastChapter = 1;
    expect(isCanonEmpty(withChapter)).toBe(false);
  });

  it("提示词能看到架构初始人物，但不会标成已确认存活", () => {
    const canon = buildInitialCanon([character()]);
    const text = formatCanonForPrompt(canon);

    expect(text).toContain("架构初始人物");
    expect(text).toContain("沈烛");
    expect(text).toContain("主角");
    expect(text).not.toContain("已知存活/活跃人物");
  });
});
