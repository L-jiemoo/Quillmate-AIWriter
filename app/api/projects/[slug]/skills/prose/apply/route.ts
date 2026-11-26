import { NextResponse } from "next/server";
import {
  apiError,
  assertSafeSlugParam,
  assertSameOrigin,
  parsePositiveInt,
  readJsonBody,
  requireConfirm,
} from "@/lib/api";
import { applyProseCandidate } from "@/lib/skills/prose";
import { SkillError } from "@/lib/skills/types";

type RouteContext = { params: Promise<{ slug: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    assertSameOrigin(request);
    const params = await context.params;
    const slug = assertSafeSlugParam(params.slug);
    const body = await readJsonBody<Record<string, unknown>>(request);
    requireConfirm(body, "confirm", true, "应用润色结果需要二次确认");
    const index = parsePositiveInt(body.index, "章节序号");
    const candidateId =
      typeof body.candidateId === "string" ? body.candidateId.trim() : "";
    if (!candidateId) {
      throw new SkillError("SKILL_INPUT_INVALID", "润色候选编号不能为空");
    }

    const result = await applyProseCandidate(slug, index, candidateId, {
      confirmFactIssues: body.confirmFactIssues === true,
    });
    return NextResponse.json(result);
  } catch (error) {
    return apiError(error);
  }
}
