import { NextResponse } from "next/server";
import { normalizeCharacter, saveCharacters } from "@/lib/store";
import { errorMessage } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: { slug: string };
}

export async function PUT(request: Request, { params }: RouteContext) {
  try {
    const body = (await request.json()) as { characters?: unknown };
    if (!Array.isArray(body.characters)) {
      return NextResponse.json({ error: "characters 必须是数组" }, { status: 400 });
    }

    const characters = body.characters
      .map(normalizeCharacter)
      .filter((character) => character.name.trim().length > 0);

    await saveCharacters(params.slug, characters);
    return NextResponse.json({ count: characters.length });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 400 });
  }
}
