import { NextResponse } from "next/server";
import {
  apiError,
  assertSafeSlugParam,
  assertSameOrigin,
  readJsonBody,
  requireConfirm,
} from "@/lib/api";
import { getProjectFile, resolvePublishOutcome } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: { slug: string };
}

export async function POST(request: Request, { params }: RouteContext) {
  try {
    assertSameOrigin(request);
    const slug = assertSafeSlugParam(params.slug);
    const body = await readJsonBody<{
      chapter?: unknown;
      published?: unknown;
      confirm?: unknown;
    }>(request);
    const chapter = Number(body.chapter);
    const published = body.published;
    if (!Number.isInteger(chapter) || chapter < 1 || typeof published !== "boolean") {
      return NextResponse.json({ error: "章节号或发布状态无效" }, { status: 400 });
    }
    requireConfirm(body, "confirm", true, "修改发布状态需要二次确认");

    const file = await getProjectFile(slug);
    const config = file.publish.fanqie;
    if (!config.bookName.trim()) {
      return NextResponse.json({ error: "请先在「发布」页填写番茄书名" }, { status: 400 });
    }

    const ledger = await resolvePublishOutcome(slug, {
      bookId: config.bookId,
      bookName: config.bookName,
      chapter,
      published,
    });
    return NextResponse.json({ ok: true, ledger });
  } catch (error) {
    return apiError(error);
  }
}
