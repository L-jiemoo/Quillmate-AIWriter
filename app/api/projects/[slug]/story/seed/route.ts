import { NextResponse } from "next/server";
import { apiError, assertSafeSlugParam, assertSameOrigin } from "@/lib/api";
import { buildEffectiveMemory } from "@/lib/memory";
import {
  buildEffectiveStory,
  finalizeStory,
  storyChecks,
  storyStats,
} from "@/lib/story";
import { getMemory, getProjectDetail, getStory, saveStory } from "@/lib/store";
import { nowIso } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ slug: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  const params = await context.params;
  try {
    assertSameOrigin(request);
    const slug = assertSafeSlugParam(params.slug);
    const detail = await getProjectDetail(slug);
    const memory = buildEffectiveMemory(detail, await getMemory(slug));
    const stored = await getStory(slug);
    const effective = buildEffectiveStory(detail, memory, stored);
    const story = finalizeStory(detail, memory, {
      ...effective,
      updatedAt: nowIso(),
    });
    await saveStory(slug, story);
    return NextResponse.json({
      story,
      stats: storyStats(detail, story),
      checks: storyChecks(detail, story),
    });
  } catch (error) {
    return apiError(error);
  }
}
