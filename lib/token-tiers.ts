export const OUTPUT_TOKEN_TIERS = [
  {
    id: "standard",
    label: "标准档",
    tokens: 8192,
    summary: "短篇写作与小型 JSON 抽取",
    detail: "适合短章节、审校和字段较少的结构化抽取。",
  },
  {
    id: "high",
    label: "高输出档",
    tokens: 16384,
    summary: "长篇章节与角色生成",
    detail: "日常长篇写作、章节细纲和角色卡的推荐档位。",
  },
  {
    id: "xl",
    label: "超大输出档",
    tokens: 32768,
    summary: "全书架构与大型计划台账",
    detail: "适合世界观、全书大纲和大型分批台账。请确认模型支持该额度。",
  },
] as const;

export type OutputTokenTier = (typeof OUTPUT_TOKEN_TIERS)[number];
export type OutputTokenTierId = OutputTokenTier["id"];

export const DEFAULT_OUTPUT_TOKENS = 16384;
export const MAX_OUTPUT_TOKENS = 32768;

export type TokenTask =
  | "small-json"
  | "writing"
  | "characters"
  | "architecture"
  | "chapter-batch"
  | "ledger-batch";

export function outputTierForTokens(value: unknown): OutputTokenTier {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return OUTPUT_TOKEN_TIERS.find((tier) => tier.tokens === DEFAULT_OUTPUT_TOKENS)!;
  }
  let best: OutputTokenTier = OUTPUT_TOKEN_TIERS[0];
  let distance = Math.abs(best.tokens - parsed);
  for (const tier of OUTPUT_TOKEN_TIERS.slice(1)) {
    const nextDistance = Math.abs(tier.tokens - parsed);
    // 两档等距时取更高档，避免旧配置被意外降额。
    if (nextDistance < distance || (nextDistance === distance && tier.tokens > best.tokens)) {
      best = tier;
      distance = nextDistance;
    }
  }
  return best;
}

export function normalizeOutputTokens(value: unknown, fallback = DEFAULT_OUTPUT_TOKENS): number {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return outputTierForTokens(value).tokens;
}

export function nextOutputTokens(current: number, limit: number): number | null {
  const normalized = normalizeOutputTokens(current);
  const capped = normalizeOutputTokens(limit);
  const next = OUTPUT_TOKEN_TIERS.find((tier) => tier.tokens > normalized && tier.tokens <= capped);
  return next?.tokens ?? null;
}

export function tokenBudgetForTask(task: TokenTask, configured: number): number {
  const available = normalizeOutputTokens(configured);
  if (task === "small-json") return Math.min(available, 8192);
  return available;
}

export function needsHigherTier(task: TokenTask, configured: number): boolean {
  if (
    task !== "characters" &&
    task !== "architecture" &&
    task !== "chapter-batch" &&
    task !== "ledger-batch"
  ) {
    return false;
  }
  return normalizeOutputTokens(configured) < 16384;
}
