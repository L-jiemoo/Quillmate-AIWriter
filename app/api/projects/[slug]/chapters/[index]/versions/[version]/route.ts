import { NextResponse } from "next/server";
import {
  apiError,
  assertSafeSlugParam,
  assertSameOrigin,
  parsePositiveInt,
  readJsonBody,
  requireConfirm,
} from "@/lib/api";
import { getChapterVersion, restoreChapterVersion } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ slug: string; index: string; version: string }>;
}

function parseTarget(params: { index: string; version: string }) {
  return {
    index: parsePositiveInt(params.index, "章节序号"),
    version: parsePositiveInt(params.version, "版本号"),
  };
}

export async function GET(_request: Request, context: RouteContext) {
  const params = await context.params;
  try {
    const slug = assertSafeSlugParam(params.slug);
    const target = parseTarget(params);
    const version = await getChapterVersion(slug, target.index, target.version);
    return NextResponse.json({ version });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request, context: RouteContext) {
  const params = await context.params;
  try {
    assertSameOrigin(request);
    const slug = assertSafeSlugParam(params.slug);
    const target = parseTarget(params);
    const body = await readJsonBody<{ action?: unknown; confirm?: unknown }>(request);
    if (body.action !== "restore") {
      return NextResponse.json({ error: "未知操作" }, { status: 400 });
    }
    requireConfirm(body, "confirm", true, "恢复旧版本需要二次确认");

    const result = await restoreChapterVersion(slug, target.index, target.version);
    return NextResponse.json({
      ok: true,
      restoredVersion: result.restored.version,
      newVersion: result.created?.version ?? null,
    });
  } catch (error) {
    return apiError(error);
  }
}
