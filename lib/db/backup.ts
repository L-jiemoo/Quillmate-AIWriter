import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { backup } from "node:sqlite";
import { DATA_DIR } from "../config";
import { DB_FILE } from "../storage-mode";
import { closeDatabase, getDatabase } from "./connection";

export interface SnapshotManifest {
  source: string;
  createdAt: string;
  files: Record<string, { size: number; sha256: string }>;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function hashFile(filePath: string): Promise<string> {
  const data = await fs.readFile(filePath);
  return createHash("sha256").update(data).digest("hex");
}

async function collectFiles(root: string, prefix = ""): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(full, relative)));
    else if (entry.isFile()) files.push(relative);
  }
  return files.sort();
}

export async function buildManifest(root: string): Promise<Record<string, { size: number; sha256: string }>> {
  const files = await collectFiles(root);
  const manifest: Record<string, { size: number; sha256: string }> = {};
  for (const relative of files) {
    const full = path.join(root, relative.split("/").join(path.sep));
    const stat = await fs.stat(full);
    manifest[relative] = { size: stat.size, sha256: await hashFile(full) };
  }
  return manifest;
}

// 迁移前把项目、任务和设置复制到独立快照；不复制 backups 自身，避免递归膨胀。
export async function createDataSnapshot(label: string): Promise<{ dir: string; manifest: SnapshotManifest }> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(DATA_DIR, "backups", `${label}-${stamp}`);
  await fs.mkdir(dir, { recursive: true });

  for (const name of ["projects", "jobs", "settings.json"]) {
    const source = path.join(DATA_DIR, name);
    const target = path.join(dir, name);
    try {
      const stat = await fs.stat(source);
      if (stat.isDirectory()) {
        await fs.cp(source, target, { recursive: true, force: false, errorOnExist: false });
      } else {
        await fs.copyFile(source, target);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  const manifest: SnapshotManifest = {
    source: DATA_DIR,
    createdAt: new Date().toISOString(),
    files: await buildManifest(dir),
  };
  await fs.writeFile(
    path.join(dir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return { dir, manifest };
}

export async function backupDatabase(target?: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(DATA_DIR, "backups", "db");
  await fs.mkdir(dir, { recursive: true });
  const filePath = target ?? path.join(dir, `quillmate-${stamp}.sqlite`);
  await backup(getDatabase(), filePath);
  return filePath;
}

export async function restoreDatabase(source: string): Promise<void> {
  closeDatabase();
  await fs.mkdir(path.join(DATA_DIR, "db"), { recursive: true });
  await fs.copyFile(source, path.join(DATA_DIR, "db", "quillmate.sqlite"));
  for (const suffix of ["-wal", "-shm"]) {
    await fs.rm(path.join(DATA_DIR, "db", `quillmate.sqlite${suffix}`), { force: true });
  }
}

// 正文仍在 Markdown 文件里，完整备份必须同时包含数据库和 projects/jobs/settings。
export async function createFullBackup(label = "manual"): Promise<{
  dir: string;
  database: string;
  manifest: SnapshotManifest;
}> {
  const snapshot = await createDataSnapshot(label);
  const database = path.join(snapshot.dir, "quillmate.sqlite");
  await backupDatabase(database);
  const manifest: SnapshotManifest = {
    ...snapshot.manifest,
    files: await buildManifest(snapshot.dir),
  };
  await fs.writeFile(
    path.join(snapshot.dir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return { dir: snapshot.dir, database, manifest };
}

export async function restoreFullBackup(dir: string): Promise<void> {
  const manifestPath = path.join(dir, "manifest.json");
  const database = path.join(dir, "quillmate.sqlite");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as SnapshotManifest;
  const expected = manifest.files["quillmate.sqlite"];
  if (!expected) throw new Error(`备份缺少 quillmate.sqlite：${dir}`);
  const actual = (await buildManifest(dir))["quillmate.sqlite"];
  if (!actual || actual.sha256 !== expected.sha256 || actual.size !== expected.size) {
    throw new Error(`备份数据库校验失败：${database}`);
  }

  closeDatabase();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (const name of ["projects", "jobs", "settings.json"]) {
    const target = path.join(DATA_DIR, name);
    try {
      await fs.access(target);
      await fs.rename(target, path.join(DATA_DIR, `${name}.before-restore-${stamp}`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  for (const name of ["projects", "jobs", "settings.json"]) {
    const source = path.join(dir, name);
    const target = path.join(DATA_DIR, name);
    try {
      const stat = await fs.stat(source);
      if (stat.isDirectory()) {
        await fs.cp(source, target, { recursive: true, force: true });
      } else {
        await fs.copyFile(source, target);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  await fs.mkdir(path.dirname(DB_FILE), { recursive: true });
  await fs.copyFile(database, DB_FILE);
  for (const suffix of ["-wal", "-shm"]) {
    await fs.rm(`${DB_FILE}${suffix}`, { force: true });
  }
}
