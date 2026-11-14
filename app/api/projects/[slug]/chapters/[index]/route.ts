import { NextResponse } from "next/server";
import { saveChapter } from "@/lib/store";
import { errorMessage } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: { slug: string; index: string };
}

export async function PUT(request: Request, { params }: RouteContext) {
  try {
    const index = Number(params.index);
    if (!Number.isInteger(index) || index < 1) {
      return NextResponse.json({ error: "章节序号不合法" }, { status: 400 });
    }

    const body = (await request.json()) as { content?: unknown; title?: unknown };
    if (typeof body.content !== "string") {
      return NextResponse.json({ error: "章节内容必须是字符串" }, { status: 400 });
    }

    const chapter = await saveChapter(
      params.slug,
      index,
      body.content,
      typeof body.title === "string" ? body.title : undefined,
    );
    return NextResponse.json(chapter);
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 400 });
  }
}
