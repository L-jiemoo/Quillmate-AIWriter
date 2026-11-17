import { NextResponse } from "next/server";
import { apiError, assertSameOrigin, readJsonBody } from "@/lib/api";
import { createProject, listProjects } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export async function GET() {
  return NextResponse.json(await listProjects());
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const body = await readJsonBody(request);
    const title = text(body.title)?.trim();
    if (!title) {
      return NextResponse.json({ error: "请填写书名" }, { status: 400 });
    }

    const detail = await createProject({
      title,
      slug: text(body.slug),
      genre: text(body.genre),
      tone: text(body.tone),
      idea: text(body.idea),
      author: text(body.author),
      language: text(body.language),
      targetChapters: body.targetChapters === undefined ? undefined : Number(body.targetChapters),
      wordsPerChapter: body.wordsPerChapter === undefined ? undefined : Number(body.wordsPerChapter),
    });

    return NextResponse.json({ slug: detail.meta.slug }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
