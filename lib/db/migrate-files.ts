import { promises as fs } from "node:fs";
import path from "node:path";
import { validateCanon } from "../canon";
import { JOBS_DIR, PROJECTS_DIR } from "../config";
import { assertValidChapterPlans } from "../plan-validation";
import * as fileStore from "../store-file";
import {
  normalizeChapterVersion,
  normalizeCharacter,
  projectFile,
} from "../store-file";
import { readJsonStrict } from "../storage";
import { DB_DIR, DB_FILE } from "../storage-mode";
import { countWords, errorMessage, isSafeSlug, nowIso } from "../utils";
import type {
  CanonFacts,
  ChapterVersion,
  Character,
  Job,
  JobLog,
  JobParams,
  JobStatus,
  ProjectDetail,
  ProjectMemory,
  StoryLedger,
} from "../types";
import { backupDatabase, buildManifest, createDataSnapshot, sha256 } from "./backup";
import { closeDatabase, getDatabase } from "./connection";
import * as jobRepo from "./job-repository";
import * as repo from "./project-repository";

export interface MigrationProjectResult {
  slug: string;
  title: string;
  chapters: number;
  characters: number;
  reviews: number;
  versions: number;
  warnings: string[];
}

export interface MigrationResult {
  snapshotDir: string;
  reportPath: string;
  previousDatabaseBackup: string | null;
  projects: MigrationProjectResult[];
  jobs: number;
  warnings: string[];
}

const JOB_TYPES = [
  "plan",
  "extend",
  "wrapup",
  "foreshadow",
  "write",
  "finale",
  "rewrite",
  "repair",
  "recanon",
  "memory",
  "audit",
  "export",
  "fanqie-login",
  "fanqie-publish",
] as const;

const JOB_STATUSES = [
  "queued",
  "running",
  "paused",
  "done",
  "error",
  "cancelled",
  "interrupted",
] as const;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) result[key] = canonical(record[key]);
    return result;
  }
  return value;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function withoutVolatile<T extends object>(value: T, keys: string[]): T {
  const copy = { ...value } as Record<string, unknown>;
  for (const key of keys) delete copy[key];
  return copy as T;
}

function memoryForCompare(memory: ProjectMemory): unknown {
  const strip = (value: { updatedAt?: string }): Record<string, unknown> => {
    const copy = { ...value } as Record<string, unknown>;
    delete copy.updatedAt;
    return copy;
  };
  return {
    book: strip(memory.book),
    volumes: memory.volumes.map(strip),
    chapters: Object.fromEntries(
      Object.entries(memory.chapters).map(([key, value]) => [key, strip(value)]),
    ),
  };
}

function storyForCompare(story: StoryLedger): unknown {
  const strip = (value: { updatedAt?: string }): Record<string, unknown> => {
    const copy = { ...value } as Record<string, unknown>;
    delete copy.updatedAt;
    return copy;
  };
  return {
    states: story.states.map(strip),
    relations: story.relations.map(strip),
    events: story.events.map(strip),
    foreshadows: story.foreshadows.map(strip),
    suppressedIds: story.suppressedIds,
  };
}

function dedupeCharacters(characters: Character[]): {
  characters: Character[];
  warnings: string[];
} {
  const byName = new Map<string, Character>();
  const warnings: string[] = [];
  for (const raw of characters) {
    const character = normalizeCharacter(raw);
    const name = character.name.trim();
    if (!name) continue;
    if (byName.has(name)) {
      warnings.push(`角色「${name}」重复，迁移时保留第一条`);
      continue;
    }
    byName.set(name, { ...character, name });
  }
  return { characters: [...byName.values()], warnings };
}

function dedupeCanon(canon: CanonFacts): { canon: CanonFacts; warnings: string[] } {
  const warnings: string[] = [];
  const characters = new Map<string, CanonFacts["characters"][number]>();
  for (const item of canon.characters) {
    const name = item.name.trim();
    if (!name) continue;
    const previous = characters.get(name);
    if (!previous) {
      characters.set(name, item);
      continue;
    }
    warnings.push(`事实台账人物「${name}」重复，迁移时保留章节更新较晚的一条`);
    if (item.chapter >= previous.chapter) characters.set(name, item);
  }

  const items = new Map<string, CanonFacts["items"][number]>();
  for (const item of canon.items) {
    const name = item.name.trim();
    if (!name) continue;
    const previous = items.get(name);
    if (!previous) {
      items.set(name, item);
      continue;
    }
    warnings.push(`事实台账物品「${name}」重复，迁移时保留章节更新较晚的一条`);
    if (item.chapter >= previous.chapter) items.set(name, item);
  }

  const deadlines = new Map<string, CanonFacts["timeline"]["deadlines"][number]>();
  for (const item of canon.timeline.deadlines) {
    const name = item.name.trim();
    if (!name) continue;
    const previous = deadlines.get(name);
    if (!previous) {
      deadlines.set(name, item);
      continue;
    }
    warnings.push(`事实台账期限「${name}」重复，迁移时保留章节更新较晚的一条`);
    if (item.chapter >= previous.chapter) deadlines.set(name, item);
  }

  const rules = [...new Set(canon.rules.map((rule) => rule.trim()).filter(Boolean))];
  return {
    canon: {
      characters: [...characters.values()],
      items: [...items.values()],
      timeline: { currentDay: canon.timeline.currentDay, deadlines: [...deadlines.values()] },
      rules,
      lastChapter: canon.lastChapter,
      updatedAt: canon.updatedAt,
    },
    warnings,
  };
}

async function readChapterFiles(slug: string): Promise<Map<number, string>> {
  const dir = projectFile(slug, "chapters");
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
  const result = new Map<number, string>();
  for (const entry of entries) {
    const match = /^(\d+)\.md$/.exec(entry);
    if (!match) continue;
    const index = Number(match[1]);
    if (!Number.isInteger(index) || index < 1) continue;
    result.set(index, await fs.readFile(path.join(dir, entry), "utf8"));
  }
  return result;
}

async function readProjectVersions(
  slug: string,
  warnings: string[],
): Promise<repo.ImportChapterVersion[]> {
  const versionsRoot = projectFile(slug, "versions");
  let dirs: string[] = [];
  try {
    dirs = await fs.readdir(versionsRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const versions: repo.ImportChapterVersion[] = [];
  for (const dirName of dirs) {
    const index = Number(dirName);
    if (!Number.isInteger(index) || index < 1) continue;
    const dir = path.join(versionsRoot, dirName);
    const stat = await fs.stat(dir);
    if (!stat.isDirectory()) continue;
    const files = (await fs.readdir(dir)).filter((name) => name.endsWith(".json")).sort();
    for (const fileName of files) {
      const filePath = path.join(dir, fileName);
      const raw = await readJsonStrict<unknown>(filePath);
      let record: ChapterVersion;
      try {
        record = normalizeChapterVersion(raw, index, filePath);
      } catch (error) {
        warnings.push(`第 ${index} 章版本文件无法解析，迁移中止：${errorMessage(error)}`);
        throw error;
      }
      versions.push({
        index,
        version: record.version,
        createdAt: record.createdAt,
        source: record.source,
        title: record.title,
        summary: record.summary,
        note: record.note,
        contentPath: path.relative(projectFile(slug), filePath).split(path.sep).join("/"),
        contentHash: sha256(record.content),
        previousHash: record.previousContent ? sha256(record.previousContent) : null,
        words: countWords(record.content),
      });
    }
  }
  return versions.sort((a, b) => a.index - b.index || a.version - b.version);
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function parseJob(raw: unknown): Job | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = text(record.id).trim();
  const slug = text(record.slug).trim();
  const type = record.type;
  if (!id || !slug || !JOB_TYPES.includes(type as Job["type"])) return null;

  const params: JobParams = {};
  const rawParams = (record.params ?? {}) as Record<string, unknown>;
  if (rawParams.count !== undefined) {
    const count = Number(rawParams.count);
    if (Number.isFinite(count)) params.count = Math.max(1, Math.round(count));
  }
  if (Array.isArray(rawParams.indices)) {
    params.indices = [
      ...new Set(
        rawParams.indices
          .map(Number)
          .filter((index) => Number.isInteger(index) && index > 0),
      ),
    ].slice(0, 200);
  }
  if (typeof rawParams.instruction === "string") {
    params.instruction = rawParams.instruction.slice(0, 500);
  }
  if (typeof rawParams.useReview === "boolean") params.useReview = rawParams.useReview;
  if (typeof rawParams.wrapUpBrief === "string" && rawParams.wrapUpBrief.trim()) {
    params.wrapUpBrief = rawParams.wrapUpBrief.trim().slice(0, 2000);
  }
  if (rawParams.source === "review" || rawParams.source === "audit") {
    params.source = rawParams.source;
  }

  const logs: JobLog[] = Array.isArray(record.logs)
    ? record.logs
        .map((item) => {
          const log = (item ?? {}) as Record<string, unknown>;
          const message = text(log.message).trim();
          if (!message) return null;
          return { time: text(log.time, nowIso()), message };
        })
        .filter((item): item is JobLog => Boolean(item))
        .slice(-400)
    : [];

  const createdAt = text(record.createdAt, nowIso());
  return {
    id,
    slug,
    type: type as Job["type"],
    status: JOB_STATUSES.includes(record.status as JobStatus)
      ? (record.status as JobStatus)
      : "error",
    params,
    pauseRequested: record.pauseRequested === true,
    cancelRequested: record.cancelRequested === true,
    cancelReason:
      record.cancelReason === "user" || record.cancelReason === "timeout"
        ? record.cancelReason
        : undefined,
    logs,
    result: typeof record.result === "string" ? record.result : undefined,
    error: typeof record.error === "string" ? record.error : undefined,
    createdAt,
    startedAt: typeof record.startedAt === "string" ? record.startedAt : undefined,
    endedAt: typeof record.endedAt === "string" ? record.endedAt : undefined,
    updatedAt: text(record.updatedAt, createdAt),
  };
}

async function acquireMigrationLock(): Promise<() => Promise<void>> {
  await fs.mkdir(DB_DIR, { recursive: true });
  const lockPath = path.join(DB_DIR, "migrate.lock");
  try {
    const handle = await fs.open(lockPath, "wx");
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, at: nowIso() }),
      "utf8",
    );
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        "数据库迁移锁已存在；请确认没有其他迁移或服务正在运行，必要时删除 data/db/migrate.lock 后重试",
      );
    }
    throw error;
  }
  return async () => {
    await fs.rm(lockPath, { force: true });
  };
}

async function assertNoActiveJobLocks(): Promise<void> {
  const locksDir = path.join(JOBS_DIR, "locks");
  let entries: string[] = [];
  try {
    entries = await fs.readdir(locksDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const locks = entries.filter((name) => name.endsWith(".lock"));
  if (locks.length) {
    throw new Error(
      `检测到 ${locks.length} 个项目任务锁，迁移前请停止服务并确认任务已结束：${locks.join("、")}`,
    );
  }
}

async function verifySnapshot(
  dir: string,
  manifest: Record<string, { size: number; sha256: string }>,
): Promise<void> {
  const actual = await buildManifest(dir);
  for (const [relative, expected] of Object.entries(manifest)) {
    const got = actual[relative];
    if (!got || got.size !== expected.size || got.sha256 !== expected.sha256) {
      throw new Error(`迁移前快照校验失败：${relative}`);
    }
  }
}

async function migrateProjects(): Promise<MigrationProjectResult[]> {
  const entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
  const results: MigrationProjectResult[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !isSafeSlug(entry.name)) continue;
    const slug = entry.name;
    const detail: ProjectDetail = await fileStore.getProjectDetail(slug);
    assertValidChapterPlans(detail.plan.chapters, {
      targetChapters: detail.meta.targetChapters,
      requireContiguous: true,
      allowEmpty: true,
    });
    const warnings: string[] = [];

    const dedupedCharacters = dedupeCharacters(detail.characters);
    warnings.push(...dedupedCharacters.warnings);
    const dedupedCanon = dedupeCanon(detail.canon);
    warnings.push(...dedupedCanon.warnings);
    for (const issue of validateCanon(dedupedCanon.canon, detail.chapters)) {
      warnings.push(`台账校验：${issue.message}`);
    }

    const chapterFiles = await readChapterFiles(slug);
    const chapterStates: repo.ImportChapterState[] = [];
    const seen = new Set<number>();
    for (const chapter of detail.plan.chapters) {
      const content = chapterFiles.get(chapter.index) ?? "";
      seen.add(chapter.index);
      chapterStates.push({
        index: chapter.index,
        written: detail.state.written.includes(chapter.index),
        summary: detail.state.summaries[String(chapter.index)] ?? "",
        contentPath: `chapters/${chapter.index}.md`,
        contentHash: sha256(content),
        words: countWords(content),
        writtenAt: null,
        updatedAt: detail.state.updatedAt,
      });
    }
    for (const [index, content] of chapterFiles) {
      if (seen.has(index)) continue;
      warnings.push(`第 ${index} 章正文不在大纲中，已作为孤儿章节元数据迁移`);
      chapterStates.push({
        index,
        written: detail.state.written.includes(index),
        summary: detail.state.summaries[String(index)] ?? "",
        contentPath: `chapters/${index}.md`,
        contentHash: sha256(content),
        words: countWords(content),
        writtenAt: null,
        updatedAt: detail.state.updatedAt,
      });
    }

    const versions = await readProjectVersions(slug, warnings);
    const memory = await fileStore.getMemory(slug);
    const story = await fileStore.getStory(slug);
    const planLedger = await fileStore.getPlanLedger(slug);
    repo.importProjectSnapshot({
      file: await fileStore.getProjectFile(slug),
      plan: detail.plan,
      characters: dedupedCharacters.characters,
      canon: dedupedCanon.canon,
      state: detail.state,
      chapterStates,
      versions,
      publishLedger: detail.publishLedger,
      memory,
      story,
      planLedger,
    });

    results.push({
      slug,
      title: detail.meta.title,
      chapters: detail.plan.chapters.length,
      characters: dedupedCharacters.characters.length,
      reviews: Object.keys(detail.state.reviews).length,
      versions: versions.length,
      warnings,
    });
  }
  return results;
}

async function migrateJobs(): Promise<{ count: number; warnings: string[] }> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(JOBS_DIR);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { count: 0, warnings: [] };
    throw error;
  }

  let count = 0;
  const warnings: string[] = [];
  for (const fileName of entries.filter((name) => name.endsWith(".json"))) {
    try {
      const raw = await readJsonStrict<unknown>(path.join(JOBS_DIR, fileName));
      const job = parseJob(raw);
      if (!job) {
        warnings.push(`跳过无法识别的任务文件：${fileName}`);
        continue;
      }
      jobRepo.writeJob(job);
      count += 1;
    } catch (error) {
      warnings.push(`跳过损坏的任务文件 ${fileName}：${errorMessage(error)}`);
    }
  }
  return { count, warnings };
}

function countTable(table: string): number {
  const row = getDatabase()
    .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
    .get() as { count: number };
  return Number(row.count);
}

async function validateMigration(
  projects: MigrationProjectResult[],
  jobCount: number,
): Promise<string[]> {
  const warnings: string[] = [];
  const db = getDatabase();

  const integrity = db.prepare("PRAGMA integrity_check").get() as
    | { integrity_check: string }
    | undefined;
  if (integrity?.integrity_check !== "ok") {
    throw new Error(`数据库完整性检查失败：${integrity?.integrity_check ?? "unknown"}`);
  }
  const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeys.length) {
    throw new Error(`外键检查失败：${JSON.stringify(foreignKeys.slice(0, 5))}`);
  }

  if (countTable("projects") !== projects.length) {
    throw new Error("项目数量与迁移结果不一致");
  }
  if (jobRepo.countJobs() !== jobCount) {
    throw new Error("任务数量与迁移结果不一致");
  }

  const store = await import("../store-file");
  const sqliteStore = await import("../store-sqlite");
  for (const item of projects) {
    const fileDetail = await store.getProjectDetail(item.slug);
    const sqliteDetail = await sqliteStore.getProjectDetail(item.slug);

    if (countTable("chapters") < item.chapters) {
      throw new Error(`第 ${item.slug} 项目章节数量不足`);
    }
    if (!sameValue(fileDetail.plan, sqliteDetail.plan)) {
      throw new Error(`第 ${item.slug} 项目大纲迁移后不一致`);
    }
    const fileCharacters = dedupeCharacters(fileDetail.characters).characters;
    if (!sameValue(fileCharacters, sqliteDetail.characters)) {
      throw new Error(`第 ${item.slug} 项目人物卡迁移后不一致`);
    }
    const fileCanon = dedupeCanon(fileDetail.canon).canon;
    if (!sameValue(withoutVolatile(fileCanon, ["updatedAt"]), withoutVolatile(sqliteDetail.canon, ["updatedAt"]))) {
      throw new Error(`第 ${item.slug} 项目事实台账迁移后不一致`);
    }
    if (!sameValue(fileDetail.state, sqliteDetail.state)) {
      throw new Error(`第 ${item.slug} 项目状态迁移后不一致`);
    }
    if (!sameValue(fileDetail.meta, sqliteDetail.meta)) {
      throw new Error(`第 ${item.slug} 项目元数据迁移后不一致`);
    }
    if (!sameValue(fileDetail.publish, sqliteDetail.publish)) {
      throw new Error(`第 ${item.slug} 项目发布配置迁移后不一致`);
    }
    if (!sameValue(fileDetail.publishLedger.records, sqliteDetail.publishLedger.records)) {
      throw new Error(`第 ${item.slug} 项目发布去重台账迁移后不一致`);
    }
    if (!sameValue(fileDetail.chapters, sqliteDetail.chapters)) {
      throw new Error(`第 ${item.slug} 项目章节正文迁移后不一致`);
    }
    const fileMemory = await store.getMemory(item.slug);
    const sqliteMemory = await sqliteStore.getMemory(item.slug);
    if (!sameValue(memoryForCompare(fileMemory), memoryForCompare(sqliteMemory))) {
      throw new Error(`第 ${item.slug} 项目长期记忆迁移后不一致`);
    }
    const fileStory = await store.getStory(item.slug);
    const sqliteStory = await sqliteStore.getStory(item.slug);
    if (!sameValue(storyForCompare(fileStory), storyForCompare(sqliteStory))) {
      throw new Error(`第 ${item.slug} 项目剧情台账迁移后不一致`);
    }

    const rows = db
      .prepare(
        "SELECT chapter_index, content_path, content_hash FROM chapter_states WHERE slug = ?",
      )
      .all(item.slug) as unknown as Array<{
      chapter_index: number;
      content_path: string;
      content_hash: string;
    }>;
    for (const row of rows) {
      const filePath = projectFile(item.slug, row.content_path);
      let content = "";
      try {
        content = await fs.readFile(filePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (sha256(content) !== row.content_hash) {
        throw new Error(
          `第 ${item.slug} 项目第 ${row.chapter_index} 章正文哈希迁移后不一致`,
        );
      }
    }
  }

  if (warnings.length) {
    // 预留给后续校验项的汇总。
    console.warn(`[migrate] ${warnings.join("；")}`);
  }
  return warnings;
}

export async function migrateFilesToSqlite(): Promise<MigrationResult> {
  const releaseLock = await acquireMigrationLock();
  let previousDbPath: string | null = null;
  let newDbCreated = false;

  try {
    await assertNoActiveJobLocks();
    const snapshot = await createDataSnapshot("pre-sqlite");
    await verifySnapshot(snapshot.dir, snapshot.manifest.files);

    let previousDatabaseBackup: string | null = null;
    try {
      await fs.access(DB_FILE);
      previousDatabaseBackup = await backupDatabase();
      closeDatabase();
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      previousDbPath = `${DB_FILE}.pre-migrate-${stamp}`;
      await fs.rename(DB_FILE, previousDbPath);
      for (const suffix of ["-wal", "-shm"]) {
        await fs.rm(`${DB_FILE}${suffix}`, { force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    getDatabase();
    newDbCreated = true;
    const projects = await migrateProjects();
    const jobs = await migrateJobs();
    const warnings = await validateMigration(projects, jobs.count);

    const finishedAt = nowIso();
    const reportPath = path.join(
      DB_DIR,
      `migration-report-${finishedAt.replace(/[:.]/g, "-")}.json`,
    );
    const report = {
      startedAt: snapshot.manifest.createdAt,
      finishedAt,
      snapshotDir: snapshot.dir,
      previousDatabaseBackup,
      previousDatabaseFile: previousDbPath,
      projects,
      jobs,
      warnings: [...projects.flatMap((item) => item.warnings), ...jobs.warnings],
      validation: "ok",
    };
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

    return {
      snapshotDir: snapshot.dir,
      reportPath,
      previousDatabaseBackup,
      projects,
      jobs: jobs.count,
      warnings: report.warnings,
    };
  } catch (error) {
    closeDatabase();
    if (newDbCreated) {
      await fs.rm(DB_FILE, { force: true }).catch(() => undefined);
      for (const suffix of ["-wal", "-shm"]) {
        await fs.rm(`${DB_FILE}${suffix}`, { force: true }).catch(() => undefined);
      }
    }
    if (previousDbPath) {
      await fs.rename(previousDbPath, DB_FILE).catch(() => undefined);
    }
    throw error;
  } finally {
    await releaseLock();
  }
}
