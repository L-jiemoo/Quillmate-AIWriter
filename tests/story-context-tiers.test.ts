import { describe, expect, it } from "vitest";
import {
  DEFAULT_STORY_CONTEXT_CHARS,
  MAX_STORY_CONTEXT_CHARS,
  STORY_CONTEXT_TIERS,
  normalizeStoryContextChars,
  storyContextTierForChars,
} from "@/lib/story-context-tiers";

describe("三档剧情上下文预算", () => {
  it("默认使用标准档 3200 字符", () => {
    expect(DEFAULT_STORY_CONTEXT_CHARS).toBe(3200);
    expect(normalizeStoryContextChars(undefined)).toBe(3200);
    expect(storyContextTierForChars(undefined).id).toBe("standard");
  });

  it("三个档位固定为 3200 / 4800 / 6400 字符", () => {
    expect(STORY_CONTEXT_TIERS.map((tier) => tier.chars)).toEqual([
      3200, 4800, 6400,
    ]);
    expect(MAX_STORY_CONTEXT_CHARS).toBe(6400);
  });

  it("旧配置映射到最接近的档位", () => {
    expect(normalizeStoryContextChars(3200)).toBe(3200);
    expect(normalizeStoryContextChars(4800)).toBe(4800);
    expect(normalizeStoryContextChars(6400)).toBe(6400);
    expect(normalizeStoryContextChars(3600)).toBe(3200);
    expect(normalizeStoryContextChars(5000)).toBe(4800);
    expect(normalizeStoryContextChars(7000)).toBe(6400);
    // 等距时取更高档，避免旧配置被意外降额。
    expect(normalizeStoryContextChars(4000)).toBe(4800);
  });
});
