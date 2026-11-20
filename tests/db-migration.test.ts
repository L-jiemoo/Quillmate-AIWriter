import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectMemory, StoryLedger } from "@/lib/types";

let dataDir: string;
let store: typeof import("@/lib/store");
let jobs: typeof import("@/lib/jobs");
let connection: typeof import("@/lib/db/connection");

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "quillmate-migration-"));
  process.env.QUILLMATE_DATA_DIR = dataDir;
  process.env.QUILLMATE_STORAGE = "file";
  vi.resetModules();
  store = await import("@/lib/store");
  jobs = await import("@/lib/jobs");
  connection = await import("@/lib/db/connection");
});

afterEach(async () => {
  connection.closeDatabase();
  vi.resetModules();
  delete process.env.QUILLMATE_DATA_DIR;
  delete process.env.QUILLMATE_STORAGE;
  await rm(dataDir, { recursive: true, force: true });
});

describe("JSON/文件到 SQLite 的迁移", () => {
  it("迁移失败时回滚数据库并保留原始文件", async () => {
    const created = await store.createProject({ title: "迁移失败", targetChapters: 1 });
    const slug = created.meta.slug;
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
    const planPath = path.join(dataDir, "projects", slug, "plan.json");
    const broken = "{ broken plan";
    await fs.writeFile(planPath, broken, "utf8");

    const migration = await import("@/lib/db/migrate-files");
    await expect(migration.migrateFilesToSqlite()).rejects.toBeTruthy();
    await expect(
      fs.access(path.join(dataDir, "db", "quillmate.sqlite")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(planPath, "utf8")).toBe(broken);
  });

  it("迁移项目、正文、版本和任务，并保持读取结果一致", async () => {
    const created = await store.createProject({ title: "迁移验证", targetChapters: 2 });
    const slug = created.meta.slug;
    await store.savePlan(
      slug,
      {
        logline: "迁移主线",
        tags: ["迁移"],
        chapters: [
          { index: 1, title: "开端", summary: "开始", keyBeats: ["出发"] },
          { index: 2, title: "发展", summary: "推进", keyBeats: ["冲突"] },
        ],
      },
      "# 世界观\n\n迁移世界观。",
      "# 主线\n\n迁移主线。",
    );
    await store.saveChapter(slug, 1, "第一版正文。", "开端");
    await store.saveChapter(slug, 1, "第二版正文。", "开端");

    const memory: ProjectMemory = {
      version: 1,
      book: {
        logline: "迁移记忆",
        tags: ["迁移"],
        worldview: "",
        mainline: "",
        coreCharacters: [],
        coreRules: [],
        finalGoal: "",
        keyConflicts: [],
        summary: "",
        source: "auto",
        updatedAt: "2026-11-17T00:00:00.000Z",
      },
      volumes: [],
      chapters: {
        "1": {
          index: 1,
          summary: "第一章记忆",
          events: ["出发"],
          characters: [],
          actions: [],
          time: "",
          location: "",
          endingState: "",
          newSettings: [],
          foreshadowsPlanted: [],
          foreshadowsResolved: [],
          source: "manual",
          updatedAt: "2026-11-17T00:00:00.000Z",
        },
      },
      updatedAt: "2026-11-17T00:00:00.000Z",
    };
    await store.saveMemory(slug, memory);

    const story: StoryLedger = {
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
          updatedAt: "2026-11-17T00:00:00.000Z",
        },
      ],
      relations: [],
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
          foreshadowIds: [],
          source: "manual",
          updatedAt: "2026-11-17T00:00:00.000Z",
        },
      ],
      foreshadows: [],
      suppressedIds: [],
      updatedAt: "2026-11-17T00:00:00.000Z",
    };
    await store.saveStory(slug, story);

    const fileDetail = await store.getProjectDetail(slug);
    const fileVersions = await store.listChapterVersions(slug, 1);
    const fileMemory = await store.getMemory(slug);
    const fileStory = await store.getStory(slug);

    const job = jobs.acquireProjectSlot(slug, "export");
    job.status = "done";
    job.result = "已导出";
    job.startedAt = new Date().toISOString();
    job.endedAt = job.startedAt;
    job.updatedAt = job.startedAt;
    jobs.releaseProjectSlot(slug, job.id);
    await jobs.flushJob(job);

    const migration = await import("@/lib/db/migrate-files");
    const result = await migration.migrateFilesToSqlite();
    expect(result.projects.map((item) => item.slug)).toContain(slug);
    expect(result.jobs).toBe(1);
    await expect(fs.access(result.reportPath)).resolves.toBeUndefined();
    await expect(fs.access(result.snapshotDir)).resolves.toBeUndefined();

    process.env.QUILLMATE_STORAGE = "sqlite";
    const sqliteDetail = await store.getProjectDetail(slug);
    expect(sqliteDetail.plan).toEqual(fileDetail.plan);
    expect(sqliteDetail.characters).toEqual(fileDetail.characters);
    expect(sqliteDetail.state).toEqual(fileDetail.state);
    expect(sqliteDetail.chapters).toEqual(fileDetail.chapters);
    expect(sqliteDetail.meta).toEqual(fileDetail.meta);
    expect(sqliteDetail.publish).toEqual(fileDetail.publish);

    const sqliteMemory = await store.getMemory(slug);
    expect(sqliteMemory).toEqual(fileMemory);

    const sqliteStory = await store.getStory(slug);
    expect(sqliteStory.states).toEqual(fileStory.states);
    expect(sqliteStory.events).toEqual(fileStory.events);

    const sqliteVersions = await store.listChapterVersions(slug, 1);
    expect(sqliteVersions.map((item) => item.version)).toEqual(
      fileVersions.map((item) => item.version),
    );

    jobs.__reloadJobStoreForTests();
    expect(jobs.getJob(job.id)?.status).toBe("done");
  });
});
