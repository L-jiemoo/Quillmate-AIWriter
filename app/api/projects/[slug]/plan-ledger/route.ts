import { NextResponse } from "next/server";
import {
  apiError,
  assertSafeSlugParam,
  assertSameOrigin,
  parsePositiveInt,
  readJsonBody,
  requireConfirm,
} from "@/lib/api";
import { getActiveJob } from "@/lib/jobs";
import {
  emptyPlanLedger,
  removePlanLedgerEntry,
  type PlanLedgerEntryKind,
} from "@/lib/plan-ledger";
import { deleteChapter, getProjectDetail, savePlanLedger } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ slug: string }>;
}

const ENTRY_KINDS: PlanLedgerEntryKind[] = [
  "event",
  "character-change",
  "foreshadow",
  "timeline",
  "item",
  "relation",
  "item-registry",
];

export async function GET(_request: Request, context: RouteContext) {
  const params = await context.params;
  try {
    const slug = assertSafeSlugParam(params.slug);
    const detail = await getProjectDetail(slug);
    const ledger = detail.planLedger ?? emptyPlanLedger(detail.meta.updatedAt);
    const written = new Set(detail.state.written);
    return NextResponse.json({
      planLedger: ledger,
      chapters: detail.plan.chapters
        .slice()
        .sort((left, right) => left.index - right.index)
        .map((chapter) => ({
          index: chapter.index,
          title: chapter.title,
          written: written.has(chapter.index),
        })),
    });
  } catch (error) {
    return apiError(error);
  }
}

// 删除单条计划：只改计划台账，不动正文和已经确认的事实。
export async function PATCH(request: Request, context: RouteContext) {
  const params = await context.params;
  try {
    assertSameOrigin(request);
    const slug = assertSafeSlugParam(params.slug);
    const body = await readJsonBody<{ remove?: { kind?: unknown; id?: unknown } }>(request);
    const kind = String(body.remove?.kind ?? "");
    if (!ENTRY_KINDS.includes(kind as PlanLedgerEntryKind)) {
      throw new Error("不支持的删除类型");
    }
    const id = String(body.remove?.id ?? "").trim();
    if (!id) throw new Error("缺少要删除的条目 ID");

    const active = getActiveJob(slug);
    if (active) {
      return NextResponse.json(
        { error: `项目有任务正在运行（${active.type}），请等待完成或取消后再改计划台账` },
        { status: 409 },
      );
    }

    const detail = await getProjectDetail(slug);
    const ledger = detail.planLedger ?? emptyPlanLedger(detail.meta.updatedAt);
    const next = removePlanLedgerEntry(ledger, kind as PlanLedgerEntryKind, id);
    await savePlanLedger(slug, next);
    return NextResponse.json({ planLedger: next });
  } catch (error) {
    return apiError(error);
  }
}

// 删除末尾一段后补章节大纲：从最后往前逐章走现有的章节删除流程，
// 会一并清理细纲、计划条目、正文、事实台账和剧情台账。
export async function DELETE(request: Request, context: RouteContext) {
  const params = await context.params;
  try {
    assertSameOrigin(request);
    const slug = assertSafeSlugParam(params.slug);
    const body = await readJsonBody<{ fromChapter?: unknown; confirm?: unknown }>(request);
    requireConfirm(body, "confirm", true, "删除章节大纲需要二次确认");
    const fromChapter = parsePositiveInt(body.fromChapter, "起始章节");

    const active = getActiveJob(slug);
    if (active) {
      return NextResponse.json(
        { error: `项目有任务正在运行（${active.type}），请等待完成或取消后再删除大纲` },
        { status: 409 },
      );
    }

    const detail = await getProjectDetail(slug);
    const indices = detail.plan.chapters
      .map((chapter) => chapter.index)
      .sort((left, right) => left - right);
    if (!indices.length) throw new Error("还没有章节大纲");
    const last = indices[indices.length - 1];
    const targetCount = last - fromChapter + 1;
    if (targetCount < 1 || targetCount > indices.length) {
      throw new Error(`起始章节必须是 1 到 ${last} 之间的整数`);
    }
    if (indices.length - targetCount < 1) {
      throw new Error("至少保留一章大纲；如需重写，请重新生成架构");
    }

    const written = new Set(detail.state.written);
    const writtenTargets = indices.filter(
      (index) => index >= fromChapter && written.has(index),
    );
    if (writtenTargets.length) {
      throw new Error(
        `第 ${writtenTargets.slice(0, 5).join("、")} 章已有正文，不能直接删大纲；请先在「章节」页删除对应正文。`,
      );
    }

    // 只能删最后一章，所以必须从末尾往前逐章删。
    for (let index = last; index >= fromChapter; index -= 1) {
      await deleteChapter(slug, index);
    }
    return NextResponse.json({ ok: true, deleted: targetCount, fromChapter, lastChapter: last });
  } catch (error) {
    return apiError(error);
  }
}
