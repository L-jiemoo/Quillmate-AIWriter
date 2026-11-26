import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanLedger, ProjectMemory, StoryLedger } from "@/lib/types";

let dataDir: string;
let store: typeof import("@/lib/store");
let connection: typeof import("@/lib/db/connection");

const AT = "2026-11-24T00:00:00.000Z";

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "quillmate-chapter-delete-db-"));
  process.env.QUILLMATE_DATA_DIR = dataDir;
  process.env.QUILLMATE_STORAGE = "sqlite";
  vi.resetModules();
  store = await import("@/lib/store");
  connection = await import("@/lib/db/connection");
});

afterEach(async () => {
  connection.closeDatabase();
  vi.resetModules();
  delete process.env.QUILLMATE_DATA_DIR;
  delete process.env.QUILLMATE_STORAGE;
  await rm(dataDir, { recursive: true, force: true });
});

async function projectWithTwoChapters(title: string): Promise<string> {
  const slug = (await store.createProject({ title, targetChapters: 2 })).meta.slug;
  await store.savePlan(
    slug,
    {
      logline: "主线",
      tags: ["测试"],
      chapters: [
        { index: 1, title: "开端", summary: "主角出发", keyBeats: ["出发"] },
        { index: 2, title: "冲突", summary: "主角遇敌", keyBeats: ["遇敌"] },
      ],
    },
    "# 世界观\n\n这是世界观。",
    "# 主线大纲\n\n这是主线。",
  );
  return slug;
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
    volumes: [],
    chapters: {
      "2": {
        index: 2,
        summary: "第二章摘要",
        events: [],
        characters: [],
        actions: [],
        time: "",
        location: "",
        endingState: "",
        newSettings: [],
        foreshadowsPlanted: [],
        foreshadowsResolved: [],
        source: "manual",
        updatedAt: AT,
      },
    },
    updatedAt: AT,
  };
}

function storyFixture(): StoryLedger {
  return {
    version: 1,
    states: [],
    relations: [],
    events: [
      {
        id: "evt-2-1",
        name: "第二章事件",
        chapter: 2,
        time: "",
        location: "",
        participants: [],
        cause: "",
        process: "",
        result: "",
        impact: "",
        relatedEventIds: [],
        foreshadowIds: [],
        source: "manual",
        updatedAt: AT,
      },
    ],
    foreshadows: [],
    suppressedIds: [],
    updatedAt: AT,
  };
}

function planLedgerFixture(): PlanLedger {
  return {
    version: 1,
    events: [
      {
        id: "plan-evt-2",
        name: "第二章计划",
        chapter: 2,
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
    itemRegistry: [],
    relations: [],
    deviations: [],
    updatedAt: AT,
  };
}

describe("SQLite 章节删除", () => {
  it("删除最后一章并同步清理状态、记忆、剧情和计划台账", async () => {
    const slug = await projectWithTwoChapters("SQLite 删除");
    await store.saveChapter(slug, 2, "第二章正文。", "冲突");
    await store.saveMemory(slug, memoryFixture());
    await store.saveStory(slug, storyFixture());
    await store.savePlanLedger(slug, planLedgerFixture());

    const result = await store.deleteChapter(slug, 2);
    expect(result).toEqual({ deleted: 2, remainingChapters: 1 });

    const detail = await store.getProjectDetail(slug);
    expect(detail.chapters.map((chapter) => chapter.index)).toEqual([1]);
    expect(detail.state.written).not.toContain(2);
    expect(detail.outlineMd).not.toContain("### 第 2 章");

    const memory = await store.getMemory(slug);
    expect(memory.chapters["2"]).toBeUndefined();
    const story = await store.getStory(slug);
    expect(story.events).toHaveLength(0);
    const ledger = await store.getPlanLedger(slug);
    expect(ledger.events).toHaveLength(0);

    await expect(
      fs.access(path.join(dataDir, "projects", slug, "chapters", "2.md")),
    ).rejects.toBeTruthy();
    await expect(
      fs.access(path.join(dataDir, "projects", slug, "versions", "2")),
    ).rejects.toBeTruthy();
  });

  it("拒绝删除中间章节", async () => {
    const slug = await projectWithTwoChapters("SQLite 中间章");
    await expect(store.deleteChapter(slug, 1)).rejects.toThrow(/只能删除最后一章/);
  });
});
