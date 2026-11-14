import { NextResponse } from "next/server";
import { startJob } from "@/lib/pipeline";
import { errorMessage } from "@/lib/utils";
import type { Job } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED: Job["type"][] = [
  "plan",
  "extend",
  "write",
  "export",
  "fanqie-login",
  "fanqie-publish",
];

interface RouteContext {
  params: { slug: string };
}

export async function POST(request: Request, { params }: RouteContext) {
  try {
    const body = (await request.json()) as { type?: unknown; count?: unknown };
    if (typeof body.type !== "string" || !ALLOWED.includes(body.type as Job["type"])) {
      return NextResponse.json({ error: "未知任务类型" }, { status: 400 });
    }

    const job = await startJob(params.slug, body.type as Job["type"], {
      count: Number(body.count) || 1,
    });
    return NextResponse.json(job, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 400 });
  }
}
