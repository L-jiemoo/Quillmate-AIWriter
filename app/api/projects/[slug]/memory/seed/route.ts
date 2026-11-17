import { NextResponse } from "next/server";
import { apiError, assertSafeSlugParam, assertSameOrigin } from "@/lib/api";
import {
  buildEffectiveMemory,
  memoryStats,
  seedMemory,
} from "@/lib/memory";
import { getMemory, getProjectDetail, saveMemory } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: { slug: string };
}

export async function POST(request: Request, { params }: RouteContext) {
  try {
    assertSameOrigin(request);
    const slug = assertSafeSlugParam(params.slug);
    const detail = await getProjectDetail(slug);
    const stored = await getMemory(slug);
    const memory = seedMemory(detail, stored);
    await saveMemory(slug, memory);
    const effective = buildEffectiveMemory(detail, memory);
    return NextResponse.json({
      memory: effective,
      stats: memoryStats(detail, effective, memory),
    });
  } catch (error) {
    return apiError(error);
  }
}
