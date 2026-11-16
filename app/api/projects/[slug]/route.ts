import { NextResponse } from "next/server";
import { StorageError } from "@/lib/storage";
import { deleteProject, getProjectDetail, updateProject } from "@/lib/store";
import { errorMessage } from "@/lib/utils";
import type { FanqieConfig, ProjectMeta } from "@/lib/types";

function errorStatus(error: unknown): number {
  if (error instanceof StorageError) {
    return error.code === "not_found" ? 404 : 500;
  }
  return 400;
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: { slug: string };
}

export async function GET(_request: Request, { params }: RouteContext) {
  try {
    return NextResponse.json(await getProjectDetail(params.slug));
  } catch (error) {
    // 区分“项目不存在”和“项目数据损坏”，后者需要用户备份/修复，不能伪装成 404。
    return NextResponse.json(
      { error: errorMessage(error) },
      { status: errorStatus(error) },
    );
  }
}

export async function DELETE(_request: Request, { params }: RouteContext) {
  try {
    await deleteProject(params.slug);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: errorMessage(error) },
      { status: errorStatus(error) },
    );
  }
}

export async function PATCH(request: Request, { params }: RouteContext) {
  try {
    const body = (await request.json()) as {
      meta?: Partial<ProjectMeta>;
      publish?: { fanqie?: Partial<FanqieConfig> };
    };
    await updateProject(params.slug, {
      meta: body.meta,
      publish: body.publish,
    });
    return NextResponse.json(await getProjectDetail(params.slug));
  } catch (error) {
    return NextResponse.json(
      { error: errorMessage(error) },
      { status: errorStatus(error) },
    );
  }
}
