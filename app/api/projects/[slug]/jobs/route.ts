import { NextResponse } from "next/server";
import {
  apiError,
  assertSafeSlugParam,
  assertSameOrigin,
  readJsonBody,
  requireConfirm,
} from "@/lib/api";
import { getActiveJob, getInterruptedJobs, JobConflictError } from "@/lib/jobs";
import { startJob } from "@/lib/pipeline";
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
  "memory",
  "audit",
  "export",
  "fanqie-login",
  "fanqie-publish",
];

interface RouteContext {
  params: Promise<{ slug: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  const params = await context.params;
  try {
    const slug = assertSafeSlugParam(params.slug);
    return NextResponse.json({
      job: getActiveJob(slug) ?? null,
      // 服务重启后留下的未完成任务，供前端展示并提供重试。
      interrupted: getInterruptedJobs(slug),
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request, context: RouteContext) {
  const params = await context.params;
  try {
    assertSameOrigin(request);
    const slug = assertSafeSlugParam(params.slug);
    const body = await readJsonBody<{
      type?: unknown;
      count?: unknown;
      indices?: unknown;
      instruction?: unknown;
      useReview?: unknown;
      source?: unknown;
      confirmPublish?: unknown;
    }>(request);
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
    if (body.type === "repair" && body.source === "draft" && !indices.length) {
      return NextResponse.json({ error: "请选择要修复的草稿" }, { status: 400 });
    }
    if (body.type === "fanqie-publish") {
      requireConfirm(body, "confirmPublish", true, "发布操作需要二次确认");
    }

    const instruction =
      typeof body.instruction === "string" ? body.instruction.slice(0, 500) : "";

    const active = getActiveJob(slug);
    if (active) {
      // 页面切走再回来时前端可能暂时不知道任务还在跑，服务端兜底避免并发写作/修复。
      return NextResponse.json(
        { error: "已有任务正在运行，请等待结束后再操作", job: active },
        { status: 409 },
      );
    }

    const job = await startJob(slug, body.type as Job["type"], {
      count: Number(body.count) || 1,
      indices,
      instruction,
      useReview: body.useReview === true,
      source:
        body.type === "repair" && body.source === "draft"
          ? "draft"
          : body.source === "review"
            ? "review"
            : "audit",
      ...(body.type === "fanqie-publish" ? { confirmPublish: true } : {}),
    });
    return NextResponse.json(job, { status: 202 });
  } catch (error) {
    // 并发请求在 acquireProjectSlot 内被拦截；返回正在运行的任务，前端可直接接回。
    if (error instanceof JobConflictError) {
      return NextResponse.json(
        { error: error.message, job: error.job },
        { status: 409 },
      );
    }
    return apiError(error);
  }
}
