import { NextResponse } from "next/server";
import { apiError, assertSafeSlugParam, parsePositiveInt } from "@/lib/api";
import { buildMemoryContext } from "@/lib/memory";
import { getMemory, getProjectDetail } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: { slug: string };
}

export async function GET(request: Request, { params }: RouteContext) {
  try {
    const slug = assertSafeSlugParam(params.slug);
    const chapter = parsePositiveInt(
      new URL(request.url).searchParams.get("chapter"),
      "chapter",
    );
    const detail = await getProjectDetail(slug);
    const plan = detail.plan.chapters.find((item) => item.index === chapter);
    if (!plan) throw new Error(`第 ${chapter} 章不在当前大纲中`);
    const memory = await getMemory(slug);
    return NextResponse.json({
      chapter: plan.index,
      title: plan.title,
      summary: plan.summary,
      retrieval: buildMemoryContext(detail, plan, memory),
    });
  } catch (error) {
    return apiError(error);
  }
}
