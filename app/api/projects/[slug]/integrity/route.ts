import { NextResponse } from "next/server";
import {
  apiError,
  assertSafeSlugParam,
  assertSameOrigin,
  readJsonBody,
} from "@/lib/api";
import { checkProjectIntegrity, fixPlanOutlineConsistency } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ slug: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  const params = await context.params;
  try {
    const slug = assertSafeSlugParam(params.slug);
    return NextResponse.json(await checkProjectIntegrity(slug));
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request, context: RouteContext) {
  const params = await context.params;
  try {
    assertSameOrigin(request);
    const slug = assertSafeSlugParam(params.slug);
    const body = await readJsonBody<{ action?: unknown }>(request);
    if (body.action !== "fix-outline") {
      return NextResponse.json({ error: "未知操作" }, { status: 400 });
    }

    const result = await fixPlanOutlineConsistency(slug);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return apiError(error);
  }
}
