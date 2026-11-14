import { NextResponse } from "next/server";
import { deleteProject, getProjectDetail, updateProject } from "@/lib/store";
import { errorMessage } from "@/lib/utils";
import type { FanqieConfig, ProjectMeta } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: { slug: string };
}

export async function GET(_request: Request, { params }: RouteContext) {
  try {
    return NextResponse.json(await getProjectDetail(params.slug));
  } catch {
    return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  }
}

export async function DELETE(_request: Request, { params }: RouteContext) {
  try {
    await deleteProject(params.slug);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 400 });
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
    return NextResponse.json({ error: errorMessage(error) }, { status: 400 });
  }
}
