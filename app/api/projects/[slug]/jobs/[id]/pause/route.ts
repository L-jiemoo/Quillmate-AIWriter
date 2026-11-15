import { NextResponse } from "next/server";
import { requestPause } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: { slug: string; id: string };
}

export async function POST(_request: Request, { params }: RouteContext) {
  const job = requestPause(params.id, params.slug);
  if (!job) {
    return NextResponse.json({ error: "任务不存在" }, { status: 404 });
  }
  return NextResponse.json(job);
}
