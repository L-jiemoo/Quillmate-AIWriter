import { NextResponse } from "next/server";
import {
  apiError,
  assertSafeSlugParam,
  assertSameOrigin,
  parsePositiveInt,
  readJsonBody,
} from "@/lib/api";
import { saveChapter } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: { slug: string; index: string };
}

export async function PUT(request: Request, { params }: RouteContext) {
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
