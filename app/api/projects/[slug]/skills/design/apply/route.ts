import { NextResponse } from "next/server";
import {
  apiError,
  parsePositiveInt,
  assertSafeSlugParam,
  assertSameOrigin,
  readJsonBody,
  requireConfirm,
} from "@/lib/api";
import { applyCharacterDesign } from "@/lib/skills/design";
import {
  isCharacterDesignField,
  SkillError,
  type CharacterDesignFields,
} from "@/lib/skills/types";

type RouteContext = { params: Promise<{ slug: string }> };

function pickFields(value: unknown): Partial<CharacterDesignFields> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const fields: Partial<CharacterDesignFields> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!isCharacterDesignField(key) || typeof item !== "string") continue;
    fields[key] = item;
  }
  return fields;
}

function pickFieldList(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  return value.filter(isCharacterDesignField);
}

export async function POST(request: Request, context: RouteContext) {
  try {
    assertSameOrigin(request);
    const params = await context.params;
    const slug = assertSafeSlugParam(params.slug);
    const body = await readJsonBody<Record<string, unknown>>(request);
    requireConfirm(body, "confirm", true, "应用人物设定需要二次确认");
    const characterName =
      typeof body.characterName === "string" ? body.characterName.trim() : "";
    if (!characterName) {
      throw new SkillError("SKILL_INPUT_INVALID", "人物姓名不能为空");
    }

    const manual = body.mode === "manual";
    const result = await applyCharacterDesign(
      slug,
      characterName,
      pickFields(body.fields),
      {
        force: manual,
        lockFields: pickFieldList(body.lockFields),
        unlockFields: pickFieldList(body.unlockFields),
      },
    );
    return NextResponse.json(result);
  } catch (error) {
    return apiError(error);
  }
}
