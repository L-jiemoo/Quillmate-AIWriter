import { promises as fs } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../lib/config";
import { closeDatabase } from "../lib/db/connection";
import { DB_FILE } from "../lib/storage-mode";

async function latestSnapshot(): Promise<string> {
  const root = path.join(DATA_DIR, "backups");
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const candidates = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("pre-sqlite-"))
    .map((entry) => path.join(root, entry.name))
    .sort();
  if (!candidates.length) {
    throw new Error("没有找到 pre-sqlite-* 迁移前快照");
  }
  return candidates[candidates.length - 1];
}

async function moveAside(name: string, stamp: string): Promise<void> {
  const source = path.join(DATA_DIR, name);
  try {
    await fs.access(source);
  } catch {
    return;
  }
  await fs.rename(source, path.join(DATA_DIR, `${name}.before-rollback-${stamp}`));
}

async function main(): Promise<void> {
  const confirmed = process.argv.includes("--yes");
  const snapshotArg = process.argv.find((arg) => arg.startsWith("--snapshot="));
  if (!confirmed) {
    throw new Error(
      "回滚会用迁移前快照覆盖当前数据，并删除 SQLite 数据库；确认后请加 --yes",
    );
  }

  const snapshot = snapshotArg
    ? path.resolve(snapshotArg.slice("--snapshot=".length))
    : await latestSnapshot();
  const manifestPath = path.join(snapshot, "manifest.json");
  await fs.access(manifestPath);

  closeDatabase();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  // 先保留迁移后的数据，避免回滚后无法人工找回迁移期间的新改动。
  await moveAside("projects", stamp);
  await moveAside("jobs", stamp);
  await moveAside("settings.json", stamp);

  for (const name of ["projects", "jobs", "settings.json"]) {
    const source = path.join(snapshot, name);
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

  await fs.rm(DB_FILE, { force: true });
  for (const suffix of ["-wal", "-shm"]) {
    await fs.rm(`${DB_FILE}${suffix}`, { force: true });
  }

  console.log(`已回滚到迁移前快照：${snapshot}`);
  console.log(`迁移期间的数据保留在 data/*.before-rollback-${stamp}`);
  console.log("现在应用会回到文件模式。");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
