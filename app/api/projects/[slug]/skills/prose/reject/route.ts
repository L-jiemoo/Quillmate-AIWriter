import { NextResponse } from "next/server";
import {
  apiError,
  assertSafeSlugParam,
  assertSameOrigin,
  readJsonBody,
} from "@/lib/api";
import { rejectProseCandidate } from "@/lib/skills/prose";
import { SkillError } from "@/lib/skills/types";

type RouteContext = { params: Promise<{ slug: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    assertSameOrigin(request);
    const params = await context.params;
    const slug = assertSafeSlugParam(params.slug);
    const body = await readJsonBody<Record<string, unknown>>(request);
    const candidateId =
      typeof body.candidateId === "string" ? body.candidateId.trim() : "";
    if (!candidateId) {
      throw new SkillError("SKILL_INPUT_INVALID", "润色候选编号不能为空");
    }
    return NextResponse.json(await rejectProseCandidate(slug, candidateId));
  } catch (error) {
    return apiError(error);
  }
}
