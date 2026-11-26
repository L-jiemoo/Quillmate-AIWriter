import { NextResponse } from "next/server";
import {
  apiError,
  assertSafeSlugParam,
  assertSameOrigin,
  readJsonBody,
} from "@/lib/api";
import { getProjectDetail } from "@/lib/store";
import {
  readProjectSkillConfig,
  saveProjectSkillConfig,
} from "@/lib/skills/config";
import { loadCharacterDesigns } from "@/lib/skills/designs";
import { listSkillCatalog } from "@/lib/skills/loader";
import { readSkillUsage } from "@/lib/skills/usage";

type RouteContext = { params: Promise<{ slug: string }> };

async function skillPayload(slug: string) {
  const [config, skills, designs, logs] = await Promise.all([
    readProjectSkillConfig(slug),
    listSkillCatalog(),
    loadCharacterDesigns(slug),
    readSkillUsage(20),
  ]);
  return { config, skills, designs, logs };
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    // 确认项目真实存在，避免拼错 slug 时返回一份看起来正常的默认配置。
    const params = await context.params;
    const slug = assertSafeSlugParam(params.slug);
    await getProjectDetail(slug);
    return NextResponse.json(await skillPayload(slug));
  } catch (error) {
    return apiError(error);
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    assertSameOrigin(request);
    const params = await context.params;
    const slug = assertSafeSlugParam(params.slug);
    await getProjectDetail(slug);
    const body = await readJsonBody<Record<string, unknown>>(request);
    await saveProjectSkillConfig(slug, body);
    return NextResponse.json(await skillPayload(slug));
  } catch (error) {
    return apiError(error);
  }
}
