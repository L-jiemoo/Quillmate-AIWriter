import { NextResponse } from "next/server";
import {
  apiError,
  assertSafeSlugParam,
  assertSameOrigin,
  readJsonBody,
} from "@/lib/api";
import { runCharacterDesignSkill } from "@/lib/skills/design";
import { SkillError } from "@/lib/skills/types";

type RouteContext = { params: Promise<{ slug: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    assertSameOrigin(request);
    const params = await context.params;
    const slug = assertSafeSlugParam(params.slug);
    const body = await readJsonBody<Record<string, unknown>>(request);
    const characterName =
      typeof body.characterName === "string" ? body.characterName.trim() : "";
    if (!characterName) {
      throw new SkillError("SKILL_INPUT_INVALID", "请指定要分析的人物姓名");
    }

    const result = await runCharacterDesignSkill(slug, {
      characterName,
      mode: body.mode === "analyze" ? "analyze" : "design",
      focus: typeof body.focus === "string" ? body.focus.slice(0, 500) : "",
    });
    return NextResponse.json(result);
  } catch (error) {
    return apiError(error);
  }
}
