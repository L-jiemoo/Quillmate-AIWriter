import { NextResponse } from "next/server";
import {
  apiError,
  assertSafeSlugParam,
  assertSameOrigin,
  readJsonBody,
  requireConfirm,
} from "@/lib/api";
import { deleteProject, getProjectDetail, updateProject } from "@/lib/store";
import type { FanqieConfig, ProjectMeta } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: { slug: string };
}

export async function GET(_request: Request, { params }: RouteContext) {
  try {
    const slug = assertSafeSlugParam(params.slug);
    return NextResponse.json(await getProjectDetail(slug));
  } catch (error) {
    // 区分“项目不存在”和“项目数据损坏”，后者需要用户备份/修复，不能伪装成 404。
    return apiError(error);
  }
}

export async function DELETE(request: Request, { params }: RouteContext) {
  try {
    assertSameOrigin(request);
    const slug = assertSafeSlugParam(params.slug);
    const body = await readJsonBody(request);
    requireConfirm(body, "confirmSlug", slug, "删除项目需要确认项目标识");
    await deleteProject(slug);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}

export async function PATCH(request: Request, { params }: RouteContext) {
  try {
    assertSameOrigin(request);
    const slug = assertSafeSlugParam(params.slug);
    const body = await readJsonBody<{
      meta?: Partial<ProjectMeta>;
      publish?: { fanqie?: Partial<FanqieConfig> };
    }>(request);
    await updateProject(slug, {
      meta: body.meta,
      publish: body.publish,
    });
    return NextResponse.json(await getProjectDetail(slug));
  } catch (error) {
    return apiError(error);
  }
}
