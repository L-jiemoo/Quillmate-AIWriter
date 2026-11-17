import { NextResponse } from "next/server";
import {
  apiError,
  assertSafeSlugParam,
  assertSameOrigin,
  readJsonBody,
} from "@/lib/api";
import {
  aggregateBook,
  aggregateVolumes,
  buildEffectiveMemory,
  memoryStats,
  normalizeBookMemory,
  normalizeChapterMemory,
  normalizeVolumeMemory,
} from "@/lib/memory";
import { getMemory, getProjectDetail, saveMemory } from "@/lib/store";
import { nowIso } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: { slug: string };
}

async function load(slug: string) {
  const detail = await getProjectDetail(slug);
  const stored = await getMemory(detail.meta.slug);
  const effective = buildEffectiveMemory(detail, stored);
  return {
    detail,
    stored,
    effective,
    stats: memoryStats(detail, effective, stored),
  };
}

export async function GET(_request: Request, { params }: RouteContext) {
  try {
    const slug = assertSafeSlugParam(params.slug);
    const data = await load(slug);
    return NextResponse.json({
      stored: data.stored,
      memory: data.effective,
      stats: data.stats,
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function PATCH(request: Request, { params }: RouteContext) {
  try {
    assertSameOrigin(request);
    const slug = assertSafeSlugParam(params.slug);
    const body = await readJsonBody<{
      book?: unknown;
      volume?: unknown;
      chapter?: unknown;
    }>(request);
    const { detail, stored } = await load(slug);
    const maxChapter = detail.plan.chapters.reduce(
      (max, chapter) => Math.max(max, chapter.index),
      0,
    );
    const now = nowIso();
    const next = buildEffectiveMemory(detail, stored);

    if (body.book && typeof body.book === "object") {
      next.book = normalizeBookMemory({
        ...next.book,
        ...(body.book as Record<string, unknown>),
        source: "manual",
        updatedAt: now,
      });
    }

    if (body.volume && typeof body.volume === "object") {
      const volume = normalizeVolumeMemory({
        ...(body.volume as Record<string, unknown>),
        source: "manual",
        updatedAt: now,
      });
      if (!volume) throw new Error("分卷数据不完整");
      if (maxChapter && (volume.startChapter > maxChapter || volume.endChapter > maxChapter)) {
        throw new Error(`分卷章节范围不能超过当前大纲最后一章（第 ${maxChapter} 章）`);
      }
      const index = next.volumes.findIndex(
        (item) =>
          item.id === volume.id ||
          (item.startChapter === volume.startChapter && item.endChapter === volume.endChapter),
      );
      if (index >= 0) next.volumes[index] = volume;
      else next.volumes.push(volume);
      next.volumes.sort(
        (a, b) => a.startChapter - b.startChapter || a.endChapter - b.endChapter,
      );
    }

    if (body.chapter && typeof body.chapter === "object") {
      const raw = body.chapter as Record<string, unknown>;
      const index = Number(raw.index);
      const plan = detail.plan.chapters.find((item) => item.index === index);
      if (!plan) throw new Error(`第 ${index} 章不在当前大纲中`);
      const chapter = normalizeChapterMemory(
        { ...raw, source: "manual", updatedAt: now },
        index,
      );
      if (!chapter) throw new Error("章节记忆数据不完整");
      next.chapters[String(index)] = chapter;
    }

    next.volumes = aggregateVolumes(detail, next.chapters, next.volumes, now);
    next.book = aggregateBook(detail, next.volumes, next.book, now);
    next.updatedAt = now;
    await saveMemory(slug, next);

    return NextResponse.json({
      memory: next,
      stats: memoryStats(detail, next, next),
    });
  } catch (error) {
    return apiError(error);
  }
}
