import { NextResponse } from "next/server";
import { apiError, assertSafeSlugParam, parsePositiveInt } from "@/lib/api";
import { buildEffectiveMemory } from "@/lib/memory";
import { buildEffectiveStory, buildStoryContext } from "@/lib/story";
import { getMemory, getProjectDetail, getStory } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ slug: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  const params = await context.params;
  try {
    const slug = assertSafeSlugParam(params.slug);
    const requested = parsePositiveInt(
      new URL(request.url).searchParams.get("chapter"),
      "chapter",
    );
    const detail = await getProjectDetail(slug);
    const chapter = detail.plan.chapters.find((item) => item.index === requested);
    if (!chapter) throw new Error(`第 ${requested} 章不在当前大纲中`);
    const memory = buildEffectiveMemory(detail, await getMemory(slug));
    const story = buildEffectiveStory(detail, memory, await getStory(slug));
    return NextResponse.json(buildStoryContext(detail, chapter, memory, story));
  } catch (error) {
    return apiError(error);
  }
}
