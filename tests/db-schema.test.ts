import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dataDir: string;
let connection: typeof import("@/lib/db/connection");
let schema: typeof import("@/lib/db/schema");
let repo: typeof import("@/lib/db/project-repository");

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "quillmate-db-schema-"));
  process.env.QUILLMATE_DATA_DIR = dataDir;
  process.env.QUILLMATE_STORAGE = "sqlite";
  vi.resetModules();
  connection = await import("@/lib/db/connection");
  schema = await import("@/lib/db/schema");
  repo = await import("@/lib/db/project-repository");
});

afterEach(async () => {
  connection.closeDatabase();
  vi.resetModules();
  delete process.env.QUILLMATE_DATA_DIR;
  delete process.env.QUILLMATE_STORAGE;
  await rm(dataDir, { recursive: true, force: true });
});

describe("SQLite Schema 与事务", () => {
  it("创建当前 Schema 版本并记录迁移", () => {
    const db = connection.getDatabase();
    const row = db
      .prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get() as { version: number };
    expect(row.version).toBe(schema.SCHEMA_VERSION);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const names = new Set(tables.map((table) => table.name));
    expect(names.has("projects")).toBe(true);
    expect(names.has("chapters")).toBe(true);
    expect(names.has("canon_characters")).toBe(true);
    expect(names.has("chapter_versions")).toBe(true);
    expect(names.has("book_memory")).toBe(true);
    expect(names.has("volume_memories")).toBe(true);
    expect(names.has("chapter_memories")).toBe(true);
    expect(names.has("story_character_states")).toBe(true);
    expect(names.has("story_relations")).toBe(true);
    expect(names.has("story_events")).toBe(true);
    expect(names.has("story_foreshadows")).toBe(true);
    expect(names.has("story_meta")).toBe(true);
    expect(names.has("jobs")).toBe(true);
  });

  it("事务失败会回滚全部写入", () => {
    const db = connection.getDatabase();
    db.exec("CREATE TABLE IF NOT EXISTS tx_rollback_test (id INTEGER)");
    expect(() =>
      connection.withTransaction((tx) => {
        tx.prepare("INSERT INTO tx_rollback_test (id) VALUES (1)").run();
        throw new Error("模拟事务失败");
      }),
    ).toThrow("模拟事务失败");
    const row = db.prepare("SELECT COUNT(*) AS count FROM tx_rollback_test").get() as {
      count: number;
    };
    expect(row.count).toBe(0);
    db.exec("DROP TABLE tx_rollback_test");
  });

  it("删除项目会级联删除章节、人物和台账", () => {
    repo.insertProject({
      meta: {
        slug: "cascade",
        title: "级联",
        genre: "",
        tone: "",
        idea: "",
        author: "",
        language: "zh-CN",
        targetChapters: 1,
        wordsPerChapter: 1000,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      publish: {
        fanqie: {
          enabled: true,
          bookId: "",
          bookName: "级联",
          autoSubmit: false,
          headless: false,
          selectors: {},
        },
      },
    });
    repo.replacePlan(
      "cascade",
      {
        logline: "",
        tags: [],
        chapters: [{ index: 1, title: "开端", summary: "开始", keyBeats: [] }],
      },
      repo.getProjectFile("cascade"),
    );
    repo.replaceCanon("cascade", {
      characters: [],
      items: [],
      timeline: { currentDay: "", deadlines: [] },
      rules: ["规则"],
      lastChapter: 0,
      updatedAt: new Date().toISOString(),
    });
    repo.replaceStory("cascade", {
      version: 1,
      states: [
        {
          id: "state-1-zhang",
          name: "张三",
          chapter: 1,
          identity: "主角",
          age: "",
          location: "客栈",
          bodyState: "",
          lifeStatus: "alive",
          abilities: [],
          goals: [],
          knowledge: [],
          faction: "",
          experience: "",
          eventIds: ["evt-1-1"],
          source: "manual",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      relations: [
        {
          id: "rel-1-zhang-li",
          from: "张三",
          to: "李四",
          type: "朋友",
          status: "",
          chapter: 1,
          eventIds: [],
          source: "manual",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      events: [
        {
          id: "evt-1-1",
          name: "出发",
          chapter: 1,
          time: "",
          location: "客栈",
          participants: ["张三"],
          cause: "",
          process: "",
          result: "",
          impact: "",
          relatedEventIds: [],
          foreshadowIds: ["fs-1-test"],
          source: "manual",
          updatedAt: "2026-01-01T00:00:00.000Z",
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
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      suppressedIds: [],
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(repo.getStory("cascade").states).toHaveLength(1);
    repo.deleteProjectRow("cascade");

    const db = connection.getDatabase();
    for (const table of [
      "chapters",
      "characters",
      "canon_rules",
      "canon_meta",
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
});
