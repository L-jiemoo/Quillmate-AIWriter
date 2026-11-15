import { NextResponse } from "next/server";
import { getActiveJob } from "@/lib/jobs";
import { startJob } from "@/lib/pipeline";
import { errorMessage } from "@/lib/utils";
import type { Job } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED: Job["type"][] = [
  "plan",
  "extend",
  "write",
  "rewrite",
  "repair",
  "recanon",
  "audit",
  "export",
  "fanqie-login",
  "fanqie-publish",
];

interface RouteContext {
  params: { slug: string };
}

export async function GET(_request: Request, { params }: RouteContext) {
  return NextResponse.json({ job: getActiveJob(params.slug) ?? null });
}

export async function POST(request: Request, { params }: RouteContext) {
  try {
    const body = (await request.json()) as {
      type?: unknown;
      count?: unknown;
      indices?: unknown;
      instruction?: unknown;
      useReview?: unknown;
      source?: unknown;
    };
    if (typeof body.type !== "string" || !ALLOWED.includes(body.type as Job["type"])) {
      return NextResponse.json({ error: "未知任务类型" }, { status: 400 });
    }

    const indices = Array.isArray(body.indices)
      ? [
          ...new Set(
            body.indices
              .map(Number)
              .filter((index) => Number.isInteger(index) && index > 0),
          ),
        ].slice(0, 200)
      : [];
    if (body.type === "rewrite" && !indices.length) {
      return NextResponse.json({ error: "请选择要重写的章节" }, { status: 400 });
    }

    const instruction =
      typeof body.instruction === "string" ? body.instruction.slice(0, 500) : "";

    const active = getActiveJob(params.slug);
    if (active) {
      // 页面切走再回来时前端可能暂时不知道任务还在跑，服务端兜底避免并发写作/修复。
      return NextResponse.json(
        { error: "已有任务正在运行，请等待结束后再操作", job: active },
        { status: 409 },
      );
    }

    const job = await startJob(params.slug, body.type as Job["type"], {
      count: Number(body.count) || 1,
      indices,
      instruction,
      useReview: body.useReview === true,
      source: body.source === "review" ? "review" : "audit",
    });
    return NextResponse.json(job, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 400 });
  }
}
