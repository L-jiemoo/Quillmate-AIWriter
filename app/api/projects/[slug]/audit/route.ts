import { NextResponse } from "next/server";
import { parseAuditReport } from "@/lib/audit";
import { getAuditReport } from "@/lib/store";
import { errorMessage } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: { slug: string };
}

export async function GET(_request: Request, { params }: RouteContext) {
  try {
    const report = await getAuditReport(params.slug);
    return NextResponse.json({
      ...report,
      result: parseAuditReport(report.content),
    });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 400 });
  }
}
