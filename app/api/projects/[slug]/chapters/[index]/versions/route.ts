import { NextResponse } from "next/server";
import { apiError, assertSafeSlugParam, parsePositiveInt } from "@/lib/api";
import { listChapterVersions } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: { slug: string; index: string };
}

export async function GET(_request: Request, { params }: RouteContext) {
  try {
    const slug = assertSafeSlugParam(params.slug);
    const index = parsePositiveInt(params.index, "章节序号");
    const versions = await listChapterVersions(slug, index);
    return NextResponse.json({ versions });
  } catch (error) {
    return apiError(error);
  }
}
