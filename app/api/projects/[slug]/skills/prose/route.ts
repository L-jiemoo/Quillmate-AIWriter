import { NextResponse } from "next/server";
import {
  apiError,
  assertSafeSlugParam,
  assertSameOrigin,
  parsePositiveInt,
  readJsonBody,
} from "@/lib/api";
import { runProseSkill } from "@/lib/skills/prose";
import type { ProseStyleConfig } from "@/lib/skills/types";

type RouteContext = { params: Promise<{ slug: string }> };

function styleOverride(value: unknown): Partial<ProseStyleConfig> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Partial<ProseStyleConfig>;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 100);
}

export async function POST(request: Request, context: RouteContext) {
  try {
    assertSameOrigin(request);
    const params = await context.params;
    const slug = assertSafeSlugParam(params.slug);
    const body = await readJsonBody<Record<string, unknown>>(request);
    const index = parsePositiveInt(body.index, "章节序号");
    const result = await runProseSkill(slug, {
      index,
      style: styleOverride(body.style),
      bannedExpressions: stringList(body.bannedExpressions),
      preferredExpressions: stringList(body.preferredExpressions),
    });
    return NextResponse.json(result);
  } catch (error) {
    return apiError(error);
  }
}
