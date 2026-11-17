import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectMemory, StoryLedger } from "@/lib/types";

let dataDir: string;
let store: typeof import("@/lib/store");
let connection: typeof import("@/lib/db/connection");

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "quillmate-sqlite-store-"));
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

describe("SQLite 项目存储", () => {
  it("创建项目、保存大纲、写入正文和版本，完整性检查通过", async () => {
    const created = await store.createProject({ title: "SQLite 测试", targetChapters: 2 });
    const slug = created.meta.slug;

    await store.savePlan(
      slug,
      {
        logline: "一条主线",
        tags: ["测试"],
        chapters: [
          { index: 1, title: "开端", summary: "主角出发", keyBeats: ["出发"] },
          { index: 2, title: "冲突", summary: "遇到敌人", keyBeats: ["冲突"] },
        ],
      },
      "# 世界观\n\n这是世界观。",
      "# 主线大纲\n\n这是主线。",
    );

    let detail = await store.getProjectDetail(slug);
    expect(detail.plan.chapters).toHaveLength(2);
    expect(detail.plan.logline).toBe("一条主线");
    expect(detail.outlineMd).toContain("### 第 1 章");

    await store.saveChapter(slug, 1, "第一章正文。", "开端");
    await store.saveChapter(slug, 1, "第一章修改稿。", "开端");

    detail = await store.getProjectDetail(slug);
    expect(detail.chapters[0].written).toBe(true);
    expect(detail.chapters[0].content).toContain("修改稿");

    const versions = await store.listChapterVersions(slug, 1);
    expect(versions.map((item) => item.version)).toEqual([1, 2]);
    expect(versions.every((item) => item.source === "user")).toBe(true);

    const restored = await store.restoreChapterVersion(slug, 1, 1);
    expect(restored.created?.source).toBe("restore");
    detail = await store.getProjectDetail(slug);
    expect(detail.chapters[0].content).toContain("第一章正文");

    const integrity = await store.checkProjectIntegrity(slug);
    expect(integrity.ok, JSON.stringify(integrity.issues)).toBe(true);
  });

  it("保存和读取长期记忆，删除项目时级联清理", async () => {
    const slug = (await store.createProject({ title: "SQLite 记忆", targetChapters: 1 }))
      .meta.slug;
    const memory: ProjectMemory = {
      version: 1,
      book: {
        logline: "记忆主线",
        tags: ["测试"],
        worldview: "世界观",
        mainline: "主线",
        coreCharacters: ["张三（主角）"],
        coreRules: ["规则一"],
        finalGoal: "目标",
        keyConflicts: ["冲突"],
        summary: "全书摘要",
        source: "auto",
        updatedAt: "2026-11-17T00:00:00.000Z",
      },
      volumes: [
        {
          id: "volume-1-1",
          title: "第一卷",
          startChapter: 1,
          endChapter: 1,
          goal: "卷目标",
          events: ["事件"],
          characterChanges: ["张三：出发"],
          conflicts: ["冲突"],
          foreshadows: ["伏笔"],
          links: "",
          summary: "卷摘要",
          source: "auto",
          updatedAt: "2026-11-17T00:00:00.000Z",
        },
      ],
      chapters: {
        "1": {
          index: 1,
          summary: "章节摘要",
          events: ["事件"],
          characters: ["张三"],
          actions: ["张三：出发"],
          time: "第一日",
          location: "客栈",
          endingState: "离开",
          newSettings: ["设定"],
          foreshadowsPlanted: ["伏笔"],
          foreshadowsResolved: [],
          source: "manual",
          updatedAt: "2026-11-17T00:00:00.000Z",
        },
      },
      updatedAt: "2026-11-17T00:00:00.000Z",
    };

    await store.saveMemory(slug, memory);
    const loaded = await store.getMemory(slug);
    expect(loaded.book.logline).toBe("记忆主线");
    expect(loaded.volumes).toHaveLength(1);
    expect(loaded.chapters["1"].source).toBe("manual");
    expect(loaded.chapters["1"].events).toEqual(["事件"]);

    const story: StoryLedger = {
      version: 1,
      states: [
        {
          id: "state-1-zhang",
          name: "张三",
          chapter: 1,
          identity: "主角",
          age: "二十",
          location: "客栈",
          bodyState: "",
          lifeStatus: "alive",
          abilities: [],
          goals: ["查案"],
          knowledge: [],
          faction: "",
          experience: "",
          eventIds: ["evt-1-1"],
          source: "manual",
          updatedAt: "2026-11-17T00:00:00.000Z",
        },
      ],
      relations: [
        {
          id: "rel-1-zhang-li",
          from: "张三",
          to: "李四",
          type: "朋友",
          status: "同行",
          chapter: 1,
          eventIds: ["evt-1-1"],
          source: "manual",
          updatedAt: "2026-11-17T00:00:00.000Z",
        },
      ],
      events: [
        {
          id: "evt-1-1",
          name: "客栈发现玉佩",
          chapter: 1,
          time: "第一日",
          location: "客栈",
          participants: ["张三", "李四"],
          cause: "",
          process: "发现玉佩",
          result: "",
          impact: "",
          relatedEventIds: [],
          foreshadowIds: ["fs-1-test"],
          source: "manual",
          updatedAt: "2026-11-17T00:00:00.000Z",
        },
      ],
      foreshadows: [
        {
          id: "fs-1-test",
          text: "玉佩的秘密",
          plantedChapter: 1,
          relatedCharacters: ["张三"],
          expectedStartChapter: 1,
          expectedEndChapter: 2,
          status: "pending",
          eventIds: ["evt-1-1"],
          resolution: "",
          resolvedChapter: 0,
          resolutionCandidate: "",
          source: "manual",
          updatedAt: "2026-11-17T00:00:00.000Z",
        },
      ],
      suppressedIds: [],
      updatedAt: "2026-11-17T00:00:00.000Z",
    };
    await store.saveStory(slug, story);
    const loadedStory = await store.getStory(slug);
    expect(loadedStory.states[0].name).toBe("张三");
    expect(loadedStory.relations[0].type).toBe("朋友");
    expect(loadedStory.events[0].name).toBe("客栈发现玉佩");
    expect(loadedStory.foreshadows[0].status).toBe("pending");

    await store.deleteProject(slug);
    const db = connection.getDatabase();
    for (const table of [
      "book_memory",
      "volume_memories",
      "chapter_memories",
      "story_character_states",
      "story_relations",
      "story_events",
      "story_foreshadows",
      "story_meta",
    ]) {
      const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
        count: number;
      };
      expect(row.count, table).toBe(0);
    }
  });

  it("人物来源、补章、发布台账、审计报告和删除均正常", async () => {
    const slug = (await store.createProject({ title: "SQLite 功能", targetChapters: 1 }))
      .meta.slug;
    await store.savePlan(
      slug,
      {
        logline: "",
        tags: [],
        chapters: [{ index: 1, title: "开端", summary: "开始", keyBeats: [] }],
      },
      "# 世界观",
      "# 主线",
    );

    const base = {
      role: "主角",
      gender: "男",
      age: "二十",
      appearance: "",
      personality: "冷静",
      background: "",
      goals: "",
      arc: "",
      relationships: "",
      speechStyle: "",
    };
    await store.saveCharacters(
      slug,
      [
        { ...base, name: "甲" },
        { ...base, name: "乙" },
      ],
      { source: "ai" },
    );
    let detail = await store.getProjectDetail(slug);
    expect(detail.characters.every((item) => item.source === "ai")).toBe(true);

    await store.saveCharacters(
      slug,
      [
        { ...base, name: "甲", personality: "用户改成热血" },
        { ...base, name: "乙" },
      ],
      { markChangedAsUser: true },
    );
    detail = await store.getProjectDetail(slug);
    expect(detail.characters.find((item) => item.name === "甲")?.source).toBe("user");
    expect(detail.characters.find((item) => item.name === "乙")?.source).toBe("ai");

    await store.appendChapters(slug, [
      { index: 2, title: "后续", summary: "继续", keyBeats: [] },
    ]);
    detail = await store.getProjectDetail(slug);
    expect(detail.plan.chapters).toHaveLength(2);
    expect(detail.outlineMd).toContain("### 第 2 章");
    await expect(
      store.updateProject(slug, { meta: { targetChapters: 1 } }),
    ).rejects.toThrow("不能小于现有大纲章节数");

    await store.recordPublishOutcome(slug, {
      bookId: "book-1",
      bookName: "SQLite 功能",
      chapter: 1,
      status: "published",
      message: "测试发布",
    });
    let ledger = await store.getPublishLedger(slug);
    expect(Object.values(ledger.records).some((entry) => entry.chapter === 1)).toBe(true);
    ledger = await store.resolvePublishOutcome(slug, {
      bookId: "book-1",
      bookName: "SQLite 功能",
      chapter: 1,
      published: false,
    });
    expect(Object.keys(ledger.records)).toHaveLength(0);

    await store.saveCanon(slug, {
      characters: [
        {
          name: "甲",
          aliases: [],
          status: "alive",
          location: "城中",
          note: "",
          statusChapter: 1,
          chapter: 1,
        },
      ],
      items: [],
      timeline: { currentDay: "第一天", deadlines: [] },
      rules: ["规则一"],
      lastChapter: 1,
      updatedAt: new Date().toISOString(),
    });
    const canon = await store.getCanon(slug);
    expect(canon.characters).toHaveLength(1);
    expect(canon.rules).toEqual(["规则一"]);

    await store.writeAuditReport(slug, "# 审校\n\n没有明显问题。");
    const audit = await store.getAuditReport(slug);
    expect(audit.content).toContain("没有明显问题");

    const repairPath = await store.saveRepairBackup(slug, 1, "修复前正文");
    expect(repairPath).toContain("before-repair");

    await store.deleteProject(slug);
    await expect(store.getProjectFile(slug)).rejects.toMatchObject({
      name: "StorageError",
      code: "not_found",
    });
    expect(await store.listProjects()).toHaveLength(0);
    await expect(fs.access(path.join(dataDir, "projects", slug))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("完整性检查能发现正文缺失，并能安全补齐主线大纲", async () => {
    const slug = (await store.createProject({ title: "SQLite 校验", targetChapters: 1 }))
      .meta.slug;
    await store.savePlan(
      slug,
      {
        logline: "",
        tags: [],
        chapters: [{ index: 1, title: "开端", summary: "开始", keyBeats: [] }],
      },
      "# 世界观",
      "# 主线",
    );
    await store.saveChapter(slug, 1, "正文");
    await fs.rm(path.join(dataDir, "projects", slug, "chapters", "1.md"));

    const report = await store.checkProjectIntegrity(slug);
    expect(report.ok).toBe(false);
    expect(report.issues.some((issue) => issue.code === "missing-chapter-file")).toBe(true);

    const outlinePath = path.join(dataDir, "projects", slug, "outline.md");
    await fs.writeFile(outlinePath, "# 主线大纲\n\n## 分卷结构\n", "utf8");
    const fixed = await store.fixPlanOutlineConsistency(slug);
    expect(fixed.fixedChapters).toEqual([1]);
    const outline = await fs.readFile(outlinePath, "utf8");
    expect(outline).toContain("### 第 1 章 · 开端");
    const second = await store.fixPlanOutlineConsistency(slug);
    expect(second.fixedChapters).toEqual([]);
  });
});
