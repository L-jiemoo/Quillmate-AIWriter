import { NextResponse } from "next/server";
import {
  apiError,
  assertSafeSlugParam,
  assertSameOrigin,
  readJsonBody,
  requireConfirm,
} from "@/lib/api";
import { buildEffectiveMemory } from "@/lib/memory";
import {
  buildEffectiveStory,
  characterHistory,
  characterStatesAt,
  eventsForCharacter,
  eventsUpTo,
  finalizeStory,
  foreshadowsAt,
  normalizeCharacterRelation,
  normalizeCharacterState,
  normalizeForeshadowRecord,
  normalizePlotEvent,
  relationsAt,
  storyChecks,
  storyStats,
} from "@/lib/story";
import { getMemory, getProjectDetail, getStory, saveStory } from "@/lib/store";
import { nowIso } from "@/lib/utils";
import type { StoryLedger } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ slug: string }>;
}

async function load(slug: string) {
  const detail = await getProjectDetail(slug);
  const storedMemory = await getMemory(detail.meta.slug);
  const memory = buildEffectiveMemory(detail, storedMemory);
  const stored = await getStory(detail.meta.slug);
  const story = buildEffectiveStory(detail, memory, stored);
  const maxChapter = detail.plan.chapters.reduce(
    (max, chapter) => Math.max(max, chapter.index),
    0,
  );
  const latestWritten = detail.state.written.length
    ? Math.max(...detail.state.written)
    : maxChapter || 1;
  return { detail, memory, stored, story, maxChapter, latestWritten };
}

function parseChapter(
  value: string | null,
  fallback: number,
  maxChapter: number,
): number {
  if (value === null || value.trim() === "") return fallback;
  const chapter = Number(value);
  if (!Number.isInteger(chapter) || chapter < 1) {
    throw new Error("章节号必须是大于 0 的整数");
  }
  if (maxChapter > 0 && chapter > maxChapter) {
    throw new Error(`章节号不能超过当前大纲最后一章（第 ${maxChapter} 章）`);
  }
  return chapter;
}

function nextManualEventId(
  story: StoryLedger,
  chapter: number,
  preferred?: string,
): string {
  const used = new Set(story.events.map((event) => event.id));
  const requested = preferred?.trim();
  if (requested && !used.has(requested)) return requested;
  let sequence = 1;
  while (used.has(`evt-${chapter}-manual-${sequence}`)) sequence += 1;
  return `evt-${chapter}-manual-${sequence}`;
}

export async function GET(request: Request, context: RouteContext) {
  const params = await context.params;
  try {
    const slug = assertSafeSlugParam(params.slug);
    const url = new URL(request.url);
    const data = await load(slug);
    const chapter = parseChapter(
      url.searchParams.get("chapter"),
      data.latestWritten,
      data.maxChapter,
    );
    const character = url.searchParams.get("character")?.trim() ?? "";
    const states = characterStatesAt(data.story, chapter);
    const view = {
      chapter,
      states: character
        ? states.filter((state) => state.name.includes(character))
        : states,
      relations: relationsAt(data.story, chapter),
      events: eventsUpTo(data.story, chapter),
      foreshadows: foreshadowsAt(data.story, chapter),
      ...(character
        ? {
            character,
            characterHistory: characterHistory(data.story, character),
            characterEvents: eventsForCharacter(data.story, character),
          }
        : {}),
    };
    return NextResponse.json({
      stored: data.stored,
      story: data.story,
      stats: storyStats(data.detail, data.story),
      checks: storyChecks(data.detail, data.story),
      view,
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  const params = await context.params;
  try {
    assertSameOrigin(request);
    const slug = assertSafeSlugParam(params.slug);
    const body = await readJsonBody<{
      state?: unknown;
      relation?: unknown;
      event?: unknown;
      foreshadow?: unknown;
      delete?: { kind?: string; id?: string };
      confirm?: unknown;
    }>(request);
    if (body.delete) {
      requireConfirm(body, "confirm", true, "删除剧情台账记录需要二次确认");
    }
    const data = await load(slug);
    const now = nowIso();
    const next = data.story;
    const suppressed = new Set(next.suppressedIds);
    const unsuppress = (id: string) => suppressed.delete(id);

    const requireChapter = (value: unknown): number => {
      const chapter = Number(value);
      if (!Number.isInteger(chapter) || chapter < 1) {
        throw new Error("章节号必须是大于 0 的整数");
      }
      if (data.maxChapter > 0 && chapter > data.maxChapter) {
        throw new Error(`章节号不能超过当前大纲最后一章（第 ${data.maxChapter} 章）`);
      }
      return chapter;
    };

    if (body.state && typeof body.state === "object") {
      const raw = body.state as Record<string, unknown>;
      const chapter = requireChapter(raw.chapter);
      const state = normalizeCharacterState(
        { ...raw, chapter, source: "manual", updatedAt: now },
        chapter,
      );
      if (!state) throw new Error("人物状态至少需要人物名和章节号");
      next.states = [
        ...next.states.filter((item) => item.id !== state.id),
        state,
      ];
      unsuppress(state.id);
    }

    if (body.relation && typeof body.relation === "object") {
      const raw = body.relation as Record<string, unknown>;
      const chapter = requireChapter(raw.chapter);
      const relation = normalizeCharacterRelation(
        { ...raw, chapter, source: "manual", updatedAt: now },
        chapter,
      );
      if (!relation) throw new Error("人物关系需要两个不同的人物名和章节号");
      next.relations = [
        ...next.relations.filter((item) => item.id !== relation.id),
        relation,
      ];
      unsuppress(relation.id);
    }

    if (body.event && typeof body.event === "object") {
      const raw = body.event as Record<string, unknown>;
      const chapter = requireChapter(raw.chapter);
      const event = normalizePlotEvent(
        {
          ...raw,
          id: nextManualEventId(next, chapter, typeof raw.id === "string" ? raw.id : ""),
          chapter,
          source: "manual",
          updatedAt: now,
        },
        chapter,
      );
      if (!event) throw new Error("剧情事件至少需要事件名称和章节号");
      next.events = [
        ...next.events.filter((item) => item.id !== event.id),
        event,
      ];
      unsuppress(event.id);
    }

    if (body.foreshadow && typeof body.foreshadow === "object") {
      const raw = body.foreshadow as Record<string, unknown>;
      const status = typeof raw.status === "string" ? raw.status : "";
      const resolvedChapter =
        status === "resolved"
          ? Number(raw.resolvedChapter) || data.latestWritten
          : 0;
      const foreshadow = normalizeForeshadowRecord({
        ...raw,
        status,
        resolvedChapter,
        resolution:
          status === "resolved" && !String(raw.resolution ?? "").trim()
            ? "作者确认已回收"
            : raw.resolution,
        source: "manual",
        updatedAt: now,
      });
      if (!foreshadow) throw new Error("伏笔至少需要文本和埋设章节");
      next.foreshadows = [
        ...next.foreshadows.filter((item) => item.id !== foreshadow.id),
        foreshadow,
      ];
      unsuppress(foreshadow.id);
    }

    const deletion = body.delete;
    if (deletion && typeof deletion === "object") {
      const id = String(deletion.id ?? "").trim();
      if (!id) throw new Error("删除操作缺少记录 ID");
      switch (deletion.kind) {
        case "state":
          next.states = next.states.filter((item) => item.id !== id);
          suppressed.add(id);
          break;
        case "relation":
          next.relations = next.relations.filter((item) => item.id !== id);
          suppressed.add(id);
          break;
        case "event":
          next.events = next.events.filter((item) => item.id !== id);
          suppressed.add(id);
          next.states = next.states.map((state) => ({
            ...state,
            eventIds: state.eventIds.filter((eventId) => eventId !== id),
          }));
          next.relations = next.relations.map((relation) => ({
            ...relation,
            eventIds: relation.eventIds.filter((eventId) => eventId !== id),
          }));
          next.foreshadows = next.foreshadows.map((foreshadow) => ({
            ...foreshadow,
            eventIds: foreshadow.eventIds.filter((eventId) => eventId !== id),
          }));
          break;
        case "foreshadow":
          next.foreshadows = next.foreshadows.filter((item) => item.id !== id);
          suppressed.add(id);
          next.events = next.events.map((event) => ({
            ...event,
            foreshadowIds: event.foreshadowIds.filter((item) => item !== id),
          }));
          break;
        default:
          throw new Error("只能删除人物状态、人物关系、剧情事件或伏笔");
      }
    }

    next.suppressedIds = [...suppressed];
    const finalized = finalizeStory(data.detail, data.memory, next);
    await saveStory(slug, finalized);
    return NextResponse.json({
      story: finalized,
      stats: storyStats(data.detail, finalized),
      checks: storyChecks(data.detail, finalized),
    });
  } catch (error) {
    return apiError(error);
  }
}
