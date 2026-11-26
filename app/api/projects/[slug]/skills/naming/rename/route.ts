import { NextResponse } from "next/server";
import {
  apiError,
  assertSafeSlugParam,
  assertSameOrigin,
  readJsonBody,
  requireConfirm,
} from "@/lib/api";
import { renameCharacterEverywhere } from "@/lib/skills/rename";

type RouteContext = { params: Promise<{ slug: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    assertSameOrigin(request);
    const params = await context.params;
    const slug = assertSafeSlugParam(params.slug);
    const body = await readJsonBody<Record<string, unknown>>(request);
    const dryRun = body.dryRun === true;
    // 预览不改任何文件，可以免确认；真正执行会改正文与台账，必须二次确认。
    if (!dryRun) {
      requireConfirm(
        body,
        "confirm",
        true,
        "全书改名会同步修改人物档案、台账与章节正文，请二次确认",
      );
    }
    const report = await renameCharacterEverywhere(slug, {
      from: typeof body.from === "string" ? body.from : "",
      to: typeof body.to === "string" ? body.to : "",
      dryRun,
    });
    return NextResponse.json(report);
  } catch (error) {
    return apiError(error);
  }
}
