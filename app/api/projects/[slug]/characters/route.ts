import { NextResponse } from "next/server";
import {
  apiError,
  assertSafeSlugParam,
  assertSameOrigin,
  readJsonBody,
} from "@/lib/api";
import { normalizeCharacter, saveCharacters } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ slug: string }>;
}

export async function PUT(request: Request, context: RouteContext) {
  const params = await context.params;
  try {
    assertSameOrigin(request);
    const slug = assertSafeSlugParam(params.slug);
    const body = await readJsonBody<{ characters?: unknown }>(request);
    if (!Array.isArray(body.characters)) {
      return NextResponse.json({ error: "characters 必须是数组" }, { status: 400 });
    }

    const characters = body.characters
      .map(normalizeCharacter)
      .filter((character) => character.name.trim().length > 0);

    const saved = await saveCharacters(slug, characters, {
      markChangedAsUser: true,
    });
    return NextResponse.json({ count: saved.length });
  } catch (error) {
    return apiError(error);
  }
}
