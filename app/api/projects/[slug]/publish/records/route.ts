import { NextResponse } from "next/server";
import {
  apiError,
  assertSafeSlugParam,
  assertSameOrigin,
  readJsonBody,
  requireConfirm,
} from "@/lib/api";
import { getProjectFile, resolvePublishOutcomes } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 一次批量标记的上限：够覆盖一本连载，又不至于让单个请求卡太久。
const MAX_BATCH = 500;

interface RouteContext {
  params: Promise<{ slug: string }>;
}

function toChapterList(value: unknown): number[] {
  const raw = Array.isArray(value) ? value : [value];
  return [
    ...new Set(
      raw
        .map(Number)
        .filter((chapter) => Number.isInteger(chapter) && chapter > 0),
    ),
  ].slice(0, MAX_BATCH);
}

export async function POST(request: Request, context: RouteContext) {
  const params = await context.params;
  try {
    assertSameOrigin(request);
    const slug = assertSafeSlugParam(params.slug);
    const body = await readJsonBody<{
      chapter?: unknown;
      chapters?: unknown;
      published?: unknown;
      confirm?: unknown;
    }>(request);
    const published = body.published;
    // chapters 支持批量；chapter 保留给旧前端与单章操作。
    const chapters = toChapterList(body.chapters ?? body.chapter);
    if (!chapters.length || typeof published !== "boolean") {
      return NextResponse.json({ error: "章节号或发布状态无效" }, { status: 400 });
    }
    requireConfirm(body, "confirm", true, "修改发布状态需要二次确认");

    const file = await getProjectFile(slug);
    const config = file.publish.fanqie;
    if (!config.bookName.trim()) {
      return NextResponse.json({ error: "请先在「发布」页填写番茄书名" }, { status: 400 });
    }

    const ledger = await resolvePublishOutcomes(slug, {
      bookId: config.bookId,
      bookName: config.bookName,
      chapters,
      published,
    });
    return NextResponse.json({ ok: true, ledger, chapters: chapters.length });
  } catch (error) {
    return apiError(error);
  }
}
