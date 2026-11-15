import { NextResponse } from "next/server";
import { normalizeCanon } from "@/lib/canon";
import { getCanon, saveCanon } from "@/lib/store";
import { errorMessage, nowIso } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: { slug: string };
}

export async function PATCH(request: Request, { params }: RouteContext) {
  try {
    const body = (await request.json()) as { canon?: unknown };
    if (!body.canon || typeof body.canon !== "object") {
      throw new Error("缺少事实台账数据");
    }

    const current = await getCanon(params.slug);
    const canon = normalizeCanon(body.canon);
    // 覆盖进度由正文抽取维护，手工编辑不能把台账回退到更早章节，
    // 否则后续写作会因为台账“落后”而被误判为需要重建。
    canon.lastChapter = current.lastChapter;
    canon.updatedAt = nowIso();
    await saveCanon(params.slug, canon);
    return NextResponse.json(canon);
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 400 });
  }
}
