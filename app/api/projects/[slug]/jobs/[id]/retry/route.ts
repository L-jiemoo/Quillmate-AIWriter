import { NextResponse } from "next/server";
import { JobConflictError } from "@/lib/jobs";
import { retryJob } from "@/lib/pipeline";
import { errorMessage } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: { slug: string; id: string };
}

export async function POST(_request: Request, { params }: RouteContext) {
  try {
    const job = await retryJob(params.slug, params.id);
    return NextResponse.json(job, { status: 202 });
  } catch (error) {
    if (error instanceof JobConflictError) {
      return NextResponse.json(
        { error: error.message, job: error.job },
        { status: 409 },
      );
    }
    const message = errorMessage(error);
    const status = message.includes("不存在") ? 404 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
