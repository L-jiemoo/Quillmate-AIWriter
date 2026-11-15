import { NextResponse } from "next/server";
import { clearPublishHistory } from "@/lib/store";
import { errorMessage } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: { slug: string };
}

export async function DELETE(_request: Request, { params }: RouteContext) {
  try {
    await clearPublishHistory(params.slug);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 400 });
  }
}
