export const STORY_CONTEXT_TIERS = [
  {
    id: "standard",
    label: "标准档",
    chars: 3200,
    summary: "默认预算，保留人物状态与未回收伏笔",
    detail: "适合大多数长篇；剧情事件和人物关系只在有空间时注入。",
  },
  {
    id: "roomy",
    label: "宽松档",
    chars: 4800,
    summary: "多带入剧情事件与人物关系",
    detail: "减少剧情台账截断，适合人物众多、事件密集的作品。",
  },
  {
    id: "max",
    label: "超大档",
    chars: 6400,
    summary: "尽量完整注入剧情台账",
    detail: "输入 token 明显增加；仅在需要完整上下文的审校场景使用。",
  },
] as const;

export type StoryContextTier = (typeof STORY_CONTEXT_TIERS)[number];
export type StoryContextTierId = StoryContextTier["id"];

export const DEFAULT_STORY_CONTEXT_CHARS = 3200;
export const MAX_STORY_CONTEXT_CHARS = 6400;

export function storyContextTierForChars(value: unknown): StoryContextTier {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return STORY_CONTEXT_TIERS.find(
      (tier) => tier.chars === DEFAULT_STORY_CONTEXT_CHARS,
    )!;
  }
  let best: StoryContextTier = STORY_CONTEXT_TIERS[0];
  let distance = Math.abs(best.chars - parsed);
  for (const tier of STORY_CONTEXT_TIERS.slice(1)) {
    const nextDistance = Math.abs(tier.chars - parsed);
    // 两档等距时取更高档，避免旧配置被意外降额。
    if (
      nextDistance < distance ||
      (nextDistance === distance && tier.chars > best.chars)
    ) {
      best = tier;
      distance = nextDistance;
    }
  }
  return best;
}

export function normalizeStoryContextChars(
  value: unknown,
  fallback = DEFAULT_STORY_CONTEXT_CHARS,
): number {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return storyContextTierForChars(value).chars;
}
