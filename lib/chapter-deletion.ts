import { removeChapterFacts } from "./canon";
import { removeChapterFromPlanLedger } from "./plan-ledger";
import { removeChapterOutline } from "./plan-consistency";
import { dropChapterStory } from "./story";
import type {
  CanonFacts,
  PlanLedger,
  ProjectMemory,
  ProjectPlan,
  ProjectState,
  StoryLedger,
} from "./types";

export interface ChapterDeletionInput {
  plan: ProjectPlan;
  state: ProjectState;
  canon: CanonFacts;
  memory: ProjectMemory | null;
  story: StoryLedger | null;
  planLedger: PlanLedger | null;
  outlineMd: string;
  index: number;
  updatedAt: string;
}

export interface ChapterDeletionResult {
  plan: ProjectPlan;
  state: ProjectState;
  canon: CanonFacts;
  memory: ProjectMemory | null;
  story: StoryLedger | null;
  planLedger: PlanLedger | null;
  outlineMd: string;
  latestChapter: number;
}

function omitChapter<T>(record: Record<string, T>, index: number): Record<string, T> {
  const key = String(index);
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

// 章节号同时是正文、记忆和台账的主键；删除中间章节会让后续内容整体错位，
// 因此只开放最后一章，保留编号连续性，也不需要迁移其他章节的数据。
export function assertDeletableChapter(plan: ProjectPlan, index: number): void {
  if (!Number.isInteger(index) || index < 1) {
    throw new Error("章节序号不合法");
  }
  if (!plan.chapters.some((chapter) => chapter.index === index)) {
    throw new Error(`第 ${index} 章不在当前大纲中`);
  }
  const last = plan.chapters.reduce(
    (max, chapter) => Math.max(max, chapter.index),
    0,
  );
  if (index !== last) {
    throw new Error(
      `只能删除最后一章（当前最后一章是第 ${last} 章）；删除中间章节会打乱后续章节编号`,
    );
  }
  if (plan.chapters.length <= 1) {
    throw new Error("至少保留一章大纲；如需重写，请重新生成架构或直接修改该章");
  }
}

function dropChapterMemory(
  memory: ProjectMemory,
  index: number,
  updatedAt: string,
): ProjectMemory {
  const volumes = memory.volumes
    .map((volume) =>
      volume.endChapter >= index
        ? { ...volume, endChapter: Math.max(volume.startChapter, index - 1) }
        : volume,
    )
    .filter((volume) => volume.endChapter >= volume.startChapter);

  return {
    ...memory,
    // 分卷和全书自动记忆会在下次读取时按剩余章节重新聚合；手工记忆保持原样。
    volumes,
    chapters: omitChapter(memory.chapters, index),
    book:
      memory.book.source === "manual"
        ? memory.book
        : { ...memory.book, updatedAt },
    updatedAt,
  };
}

export function buildChapterDeletion(
  input: ChapterDeletionInput,
): ChapterDeletionResult {
  const { index, updatedAt } = input;
  const remaining = input.plan.chapters.filter((chapter) => chapter.index !== index);
  const latestChapter = remaining.reduce(
    (max, chapter) => Math.max(max, chapter.index),
    0,
  );

  const state: ProjectState = {
    ...input.state,
    written: input.state.written.filter((item) => item !== index),
    summaries: omitChapter(input.state.summaries, index),
    reviews: omitChapter(input.state.reviews, index),
    rejectedDrafts: omitChapter(input.state.rejectedDrafts, index),
    repairs: omitChapter(input.state.repairs, index),
    updatedAt,
  };

  return {
    plan: { ...input.plan, chapters: remaining },
    state,
    canon: removeChapterFacts(input.canon, index, latestChapter, updatedAt),
    memory: input.memory ? dropChapterMemory(input.memory, index, updatedAt) : null,
    story: input.story ? dropChapterStory(input.story, index, updatedAt) : null,
    planLedger: input.planLedger
      ? removeChapterFromPlanLedger(input.planLedger, index, updatedAt)
      : null,
    outlineMd: removeChapterOutline(input.outlineMd, index, remaining),
    latestChapter,
  };
}
