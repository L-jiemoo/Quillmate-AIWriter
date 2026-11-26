import { NextResponse } from "next/server";
import {
  apiError,
  assertSafeSlugParam,
  assertSameOrigin,
  parsePositiveInt,
  readJsonBody,
  requireConfirm,
} from "@/lib/api";
import { getActiveJob } from "@/lib/jobs";
import { deleteChapter, saveChapter } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ slug: string; index: string }>;
}

export async function PUT(request: Request, context: RouteContext) {
  const params = await context.params;
  try {
    assertSameOrigin(request);
    const slug = assertSafeSlugParam(params.slug);
    const index = parsePositiveInt(params.index, "章节序号");
    const body = await readJsonBody<{ content?: unknown; title?: unknown }>(request);
    if (typeof body.content !== "string") {
      return NextResponse.json({ error: "章节内容必须是字符串" }, { status: 400 });
    }

    const chapter = await saveChapter(
      slug,
      index,
      body.content,
      typeof body.title === "string" ? body.title : undefined,
    );
    return NextResponse.json(chapter);
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const params = await context.params;
  try {
    assertSameOrigin(request);
    const slug = assertSafeSlugParam(params.slug);
    const index = parsePositiveInt(params.index, "章节序号");
    const body = await readJsonBody<{ confirm?: unknown }>(request);
    requireConfirm(body, "confirm", true, "删除章节需要二次确认");

    const active = getActiveJob(slug);
    if (active) {
      return NextResponse.json(
        { error: `项目有任务正在运行（${active.type}），请等待完成或取消后再删除章节` },
        { status: 409 },
      );
    }

    const result = await deleteChapter(slug, index);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return apiError(error);
  }
}
