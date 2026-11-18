import { NextResponse } from "next/server";
import { apiError, assertSafeSlugParam, assertSameOrigin } from "@/lib/api";
import { requestPause } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ slug: string; id: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  const params = await context.params;
  try {
    assertSameOrigin(request);
    const slug = assertSafeSlugParam(params.slug);
    const job = requestPause(params.id, slug);
    if (!job) {
      return NextResponse.json({ error: "任务不存在" }, { status: 404 });
    }
    return NextResponse.json(job);
  } catch (error) {
    return apiError(error);
  }
}
