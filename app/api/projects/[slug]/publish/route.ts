import { NextResponse } from "next/server";
import {
  apiError,
  assertSafeSlugParam,
  assertSameOrigin,
  readJsonBody,
  requireConfirm,
} from "@/lib/api";
import { clearPublishHistory } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: { slug: string };
}

export async function DELETE(request: Request, { params }: RouteContext) {
  try {
    assertSameOrigin(request);
    const slug = assertSafeSlugParam(params.slug);
    const body = await readJsonBody(request);
    requireConfirm(
      body,
      "confirm",
      "clear-publish-history",
      "清空发布日志需要二次确认",
    );
    await clearPublishHistory(slug);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
