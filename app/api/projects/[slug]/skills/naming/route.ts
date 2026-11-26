import { NextResponse } from "next/server";
import {
  apiError,
  assertSafeSlugParam,
  assertSameOrigin,
  readJsonBody,
} from "@/lib/api";
import { checkProjectNames, runNamingSkill } from "@/lib/skills/naming";
import type { NamingSkillInput } from "@/lib/skills/types";

type RouteContext = { params: Promise<{ slug: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    assertSameOrigin(request);
    const params = await context.params;
    const slug = assertSafeSlugParam(params.slug);
    const body = await readJsonBody<Record<string, unknown>>(request);

    if (body.check === true || body.task === "check") {
      return NextResponse.json(await checkProjectNames(slug));
    }

    const result = await runNamingSkill(
      slug,
      body as Partial<NamingSkillInput>,
    );
    return NextResponse.json(result);
  } catch (error) {
    return apiError(error);
  }
}
