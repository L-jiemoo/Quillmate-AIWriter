import { NextResponse } from "next/server";
import { apiError, assertSafeSlugParam, noStoreJson } from "@/lib/api";
import { parseAuditReport } from "@/lib/audit";
import { getAuditReport } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: { slug: string };
}

export async function GET(_request: Request, { params }: RouteContext) {
  try {
    const slug = assertSafeSlugParam(params.slug);
    const report = await getAuditReport(slug);
    return noStoreJson({
      ...report,
      result: parseAuditReport(report.content),
    });
  } catch (error) {
    return apiError(error);
  }
}
