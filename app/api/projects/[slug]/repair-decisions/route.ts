import { NextResponse } from "next/server";
import {
  apiError,
  assertSafeSlugParam,
  assertSameOrigin,
  readJsonBody,
} from "@/lib/api";
import {
  confirmRepairDecision,
  getPendingRepairDecision,
} from "@/lib/repair-decision";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ slug: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  const params = await context.params;
  try {
    const slug = assertSafeSlugParam(params.slug);
    const decision = await getPendingRepairDecision(slug);
    return NextResponse.json({ decision: decision ?? null });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request, context: RouteContext) {
  const params = await context.params;
  try {
    assertSameOrigin(request);
    const slug = assertSafeSlugParam(params.slug);
    const body = await readJsonBody<{ id?: unknown; optionIndex?: unknown }>(request);
    if (typeof body.id !== "string" || !body.id.trim()) {
      return NextResponse.json({ error: "缺少修复决策 ID" }, { status: 400 });
    }
    const optionIndex = Number(body.optionIndex);
    if (!Number.isInteger(optionIndex) || optionIndex < 0) {
      return NextResponse.json({ error: "请选择有效的修复方案" }, { status: 400 });
    }
    const decision = await confirmRepairDecision(slug, body.id.trim(), optionIndex);
    return NextResponse.json({ decision });
  } catch (error) {
    return apiError(error);
  }
}
