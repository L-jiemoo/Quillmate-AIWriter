import { NextResponse } from "next/server";
import { apiError, assertSafeSlugParam, assertSameOrigin } from "@/lib/api";
import { JobConflictError } from "@/lib/jobs";
import { retryJob } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: { slug: string; id: string };
}

export async function POST(request: Request, { params }: RouteContext) {
  try {
    assertSameOrigin(request);
    const slug = assertSafeSlugParam(params.slug);
    const job = await retryJob(slug, params.id);
    return NextResponse.json(job, { status: 202 });
  } catch (error) {
    if (error instanceof JobConflictError) {
      return NextResponse.json(
        { error: error.message, job: error.job },
        { status: 409 },
      );
    }
    return apiError(error);
  }
}
