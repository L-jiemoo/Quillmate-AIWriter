import { NextResponse } from "next/server";
import { apiError, assertSafeSlugParam } from "@/lib/api";
import { buildEffectiveMemory } from "@/lib/memory";
import { buildEffectiveStory, storyChecks } from "@/lib/story";
import { getMemory, getProjectDetail, getStory } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: { slug: string };
}

export async function GET(_request: Request, { params }: RouteContext) {
  try {
    const slug = assertSafeSlugParam(params.slug);
    const detail = await getProjectDetail(slug);
    const memory = buildEffectiveMemory(detail, await getMemory(slug));
    const story = buildEffectiveStory(detail, memory, await getStory(slug));
    return NextResponse.json({ issues: storyChecks(detail, story) });
  } catch (error) {
    return apiError(error);
  }
}
