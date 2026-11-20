import { describe, expect, it } from "vitest";
import {
  DEFAULT_OUTPUT_TOKENS,
  MAX_OUTPUT_TOKENS,
  OUTPUT_TOKEN_TIERS,
  needsHigherTier,
  nextOutputTokens,
  normalizeOutputTokens,
  outputTierForTokens,
  tokenBudgetForTask,
} from "@/lib/token-tiers";

describe("三档输出 Tokens", () => {
  it("默认使用高输出档 16384", () => {
    expect(DEFAULT_OUTPUT_TOKENS).toBe(16384);
    expect(normalizeOutputTokens(undefined)).toBe(16384);
    expect(outputTierForTokens(undefined).id).toBe("high");
  });

  it("三个档位固定为 8192 / 16384 / 32768", () => {
    expect(OUTPUT_TOKEN_TIERS.map((tier) => tier.tokens)).toEqual([8192, 16384, 32768]);
    expect(MAX_OUTPUT_TOKENS).toBe(32768);
  });

  it("旧配置映射到最接近的档位", () => {
    expect(normalizeOutputTokens(8192)).toBe(8192);
    expect(normalizeOutputTokens(16384)).toBe(16384);
    expect(normalizeOutputTokens(32768)).toBe(32768);
    expect(normalizeOutputTokens(4096)).toBe(8192);
    expect(normalizeOutputTokens(12000)).toBe(8192);
    expect(normalizeOutputTokens(20000)).toBe(16384);
    expect(normalizeOutputTokens(30000)).toBe(32768);
    // 等距时取更高档，避免旧配置被意外降额。
    expect(normalizeOutputTokens(12288)).toBe(16384);
  });

  it("只在不超过用户档位的前提下提升预算", () => {
    expect(nextOutputTokens(8192, 16384)).toBe(16384);
    expect(nextOutputTokens(8192, 32768)).toBe(16384);
    expect(nextOutputTokens(16384, 32768)).toBe(32768);
    expect(nextOutputTokens(16384, 16384)).toBeNull();
    expect(nextOutputTokens(32768, 32768)).toBeNull();
  });

  it("任务级预算不会突破用户选择的档位", () => {
    expect(tokenBudgetForTask("small-json", 16384)).toBe(8192);
    expect(tokenBudgetForTask("architecture", 8192)).toBe(8192);
    expect(tokenBudgetForTask("characters", 32768)).toBe(32768);
    expect(needsHigherTier("characters", 8192)).toBe(true);
    expect(needsHigherTier("characters", 16384)).toBe(false);
    expect(needsHigherTier("writing", 8192)).toBe(false);
  });
});
