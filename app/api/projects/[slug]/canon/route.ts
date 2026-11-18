import { NextResponse } from "next/server";
import {
  apiError,
  assertSafeSlugParam,
  assertSameOrigin,
  readJsonBody,
} from "@/lib/api";
import { normalizeCanon } from "@/lib/canon";
import { getCanon, saveCanon } from "@/lib/store";
import { nowIso } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ slug: string }>;
}

export async function PATCH(request: Request, context: RouteContext) {
  const params = await context.params;
  try {
    assertSameOrigin(request);
    const slug = assertSafeSlugParam(params.slug);
    const body = await readJsonBody<{ canon?: unknown }>(request);
    if (!body.canon || typeof body.canon !== "object") {
      throw new Error("缺少事实台账数据");
    }

    const current = await getCanon(slug);
    const canon = normalizeCanon(body.canon);
    // 覆盖进度由正文抽取维护，手工编辑不能把台账回退到更早章节，
    // 否则后续写作会因为台账“落后”而被误判为需要重建。
    canon.lastChapter = current.lastChapter;
    canon.updatedAt = nowIso();
    await saveCanon(slug, canon);
    return NextResponse.json(canon);
  } catch (error) {
    return apiError(error);
  }
}
