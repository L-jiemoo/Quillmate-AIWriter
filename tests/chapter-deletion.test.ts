import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChapterMemory,
  Job,
  PlanLedger,
  ProjectMemory,
  StoryLedger,
} from "@/lib/types";

let dataDir: string;
let store: typeof import("@/lib/store");
let pipeline: typeof import("@/lib/pipeline");
let jobs: typeof import("@/lib/jobs");

const AT = "2026-11-24T00:00:00.000Z";

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "quillmate-chapter-delete-"));
  process.env.QUILLMATE_DATA_DIR = dataDir;
  vi.resetModules();
  store = await import("@/lib/store");
  pipeline = await import("@/lib/pipeline");
  jobs = await import("@/lib/jobs");
  jobs.__reloadJobStoreForTests();
});

afterEach(async () => {
  vi.resetModules();
  delete process.env.QUILLMATE_DATA_DIR;
  await rm(dataDir, { recursive: true, force: true });
});

async function waitForJob(id: string): Promise<Job> {
  const deadline = Date.now() + 20000;
  for (;;) {
    const job = jobs.getJob(id);
    if (job && ["done", "error", "paused", "cancelled"].includes(job.status)) {
      return job;
    }
    if (Date.now() > deadline) throw new Error(`等待任务 ${id} 超时`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function projectWithPlan(title: string, chapters: number): Promise<string> {
  const slug = (await store.createProject({ title, targetChapters: chapters })).meta.slug;
  const job = await pipeline.startJob(slug, "plan");
  const done = await waitForJob(job.id);
  expect(done.status, done.error).toBe("done");
  return slug;
}

function chapterMemory(index: number, summary: string): ChapterMemory {
  return {
    index,
    summary,
    events: [`第 ${index} 章事件`],
    characters: ["李汉"],
    actions: [],
    time: "",
    location: "",
    endingState: "",
    newSettings: [],
    foreshadowsPlanted: [],
    foreshadowsResolved: [],
    source: "manual",
    updatedAt: AT,
  };
}

function memoryFixture(): ProjectMemory {
  return {
    version: 1,
    book: {
      logline: "",
      tags: [],
      worldview: "",
      mainline: "",
      coreCharacters: [],
      coreRules: [],
      finalGoal: "",
      keyConflicts: [],
      summary: "",
      source: "auto",
      updatedAt: AT,
    },
    volumes: [
      {
        id: "vol-1",
        title: "第一卷",
        startChapter: 1,
        endChapter: 3,
        goal: "",
        events: [],
        characterChanges: [],
        conflicts: [],
        foreshadows: [],
        links: "",
        summary: "",
        source: "auto",
        updatedAt: AT,
      },
    ],
    chapters: {
      "1": chapterMemory(1, "第一章摘要"),
      "3": chapterMemory(3, "第三章摘要"),
    },
    updatedAt: AT,
  };
}

function storyFixture(): StoryLedger {
  return {
    version: 1,
    states: [
      {
        id: "state-3-李汉",
        name: "李汉",
        chapter: 3,
        identity: "",
        age: "",
        location: "",
        bodyState: "",
        lifeStatus: "alive",
        abilities: [],
        goals: [],
        knowledge: [],
        faction: "",
        experience: "",
        eventIds: ["evt-3-1"],
        source: "manual",
        updatedAt: AT,
      },
    ],
    relations: [],
    events: [
      {
        id: "evt-3-1",
        name: "第三章事件",
        chapter: 3,
        time: "",
        location: "",
        participants: ["李汉"],
        cause: "",
        process: "",
        result: "",
        impact: "",
        relatedEventIds: [],
        foreshadowIds: ["fs-1-古印"],
        source: "manual",
        updatedAt: AT,
      },
    ],
    foreshadows: [
      {
        id: "fs-1-古印",
        text: "古印",
        plantedChapter: 1,
        relatedCharacters: ["李汉"],
        expectedStartChapter: 1,
        expectedEndChapter: 3,
        status: "resolved",
        eventIds: ["evt-3-1"],
        resolution: "第三章回收",
        resolvedChapter: 3,
        resolutionCandidate: "",
        source: "manual",
        updatedAt: AT,
      },
    ],
    suppressedIds: [],
    updatedAt: AT,
  };
}

function planLedgerFixture(): PlanLedger {
  return {
    version: 1,
    events: [
      {
        id: "plan-evt-3",
        name: "第三章计划事件",
        chapter: 3,
        thread: "",
        participants: [],
        premise: "",
        process: "",
        expectedResult: "",
        impact: "",
        relatedEventIds: [],
        importance: "major",
        status: "planned",
        actualChapter: 0,
        actualEventIds: [],
        evidence: "",
        note: "",
        updatedAt: AT,
      },
    ],
    characterChanges: [],
    foreshadows: [],
    timeline: [],
    items: [],
    itemRegistry: [
      {
        id: "item-3",
        name: "古印",
        aliases: [],
        holder: "李汉",
        location: "",
        state: "",
        introducedChapter: 3,
        note: "",
      },
    ],
    relations: [],
    deviations: [],
    updatedAt: AT,
  };
}

describe("章节删除", () => {
  it("删除最后一章会清掉大纲条目、正文、版本、记忆与台账记录", async () => {
    const slug = await projectWithPlan("删除最后一章", 3);
    await store.saveChapter(slug, 3, "第三章正文，包含古印的秘密。", "第三章");
    await store.saveMemory(slug, memoryFixture());
    await store.saveStory(slug, storyFixture());
    await store.savePlanLedger(slug, planLedgerFixture());

    const before = await store.getProjectDetail(slug);
    expect(before.chapters).toHaveLength(3);
    expect(before.state.written).toContain(3);
    await expect(
      fs.access(path.join(dataDir, "projects", slug, "versions", "3")),
    ).resolves.toBeUndefined();

    const result = await store.deleteChapter(slug, 3);
    expect(result).toEqual({ deleted: 3, remainingChapters: 2 });

    const detail = await store.getProjectDetail(slug);
    expect(detail.chapters.map((chapter) => chapter.index)).toEqual([1, 2]);
    expect(detail.plan.chapters.map((chapter) => chapter.index)).toEqual([1, 2]);
    expect(detail.state.written).not.toContain(3);
    expect(detail.state.summaries["3"]).toBeUndefined();
    expect(detail.state.reviews["3"]).toBeUndefined();
    expect(detail.state.rejectedDrafts["3"]).toBeUndefined();
    expect(detail.outlineMd).not.toContain("### 第 3 章");
    expect(detail.outlineMd).toContain("### 第 2 章");
    expect(detail.meta.targetChapters).toBe(2);

    await expect(
      fs.access(path.join(dataDir, "projects", slug, "chapters", "3.md")),
    ).rejects.toBeTruthy();
    await expect(
      fs.access(path.join(dataDir, "projects", slug, "versions", "3")),
    ).rejects.toBeTruthy();

    const memory = await store.getMemory(slug);
    expect(memory.chapters["3"]).toBeUndefined();
    expect(memory.chapters["1"]).toBeDefined();
    expect(memory.volumes[0].endChapter).toBe(2);

    const story = await store.getStory(slug);
    expect(story.states).toHaveLength(0);
    expect(story.events).toHaveLength(0);
    expect(story.foreshadows[0]).toMatchObject({
      plantedChapter: 1,
      status: "pending",
      resolvedChapter: 0,
    });

    const ledger = await store.getPlanLedger(slug);
    expect(ledger.events).toHaveLength(0);
    expect(ledger.itemRegistry).toHaveLength(0);

    const integrity = await store.checkProjectIntegrity(slug);
    expect(integrity.ok, JSON.stringify(integrity.issues)).toBe(true);
  });

  it("拒绝删除中间章节，避免后续编号错位", async () => {
    const slug = await projectWithPlan("删除中间章", 3);
    await expect(store.deleteChapter(slug, 2)).rejects.toThrow(/只能删除最后一章/);
    const detail = await store.getProjectDetail(slug);
    expect(detail.chapters).toHaveLength(3);
  });

  it("已有番茄发布记录的章节不允许删除", async () => {
    const slug = await projectWithPlan("已发布章节", 2);
    await store.saveChapter(slug, 2, "第二章正文。", "第二章");
    await store.recordPublishOutcome(slug, {
      bookId: "book-1",
      bookName: "测试书",
      chapter: 2,
      status: "published",
    });

    await expect(store.deleteChapter(slug, 2)).rejects.toThrow(/番茄发布记录/);
    const detail = await store.getProjectDetail(slug);
    expect(detail.chapters).toHaveLength(2);
    expect(detail.chapters[1].content).toContain("第二章正文");
  });

  it("删除章节 API 需要 confirm，并在确认后删除最后一章", async () => {
    const slug = await projectWithPlan("API 删除", 2);
    const route = await import("@/app/api/projects/[slug]/chapters/[index]/route");

    const without = await route.DELETE(
      new Request(`http://localhost/api/projects/${slug}/chapters/2`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ slug, index: "2" }) },
    );
    expect(without.status).toBe(400);

    const withConfirm = await route.DELETE(
      new Request(`http://localhost/api/projects/${slug}/chapters/2`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      }),
      { params: Promise.resolve({ slug, index: "2" }) },
    );
    expect(withConfirm.status).toBe(200);
    const detail = await store.getProjectDetail(slug);
    expect(detail.chapters).toHaveLength(1);
  });
});
