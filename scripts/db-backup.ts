import { promises as fs } from "node:fs";
import { createFullBackup } from "../lib/db/backup";
import { DB_FILE } from "../lib/storage-mode";

async function main(): Promise<void> {
  try {
    await fs.access(DB_FILE);
  } catch {
    throw new Error(`数据库不存在，无法备份：${DB_FILE}`);
  }
  const result = await createFullBackup("manual");
  console.log(`完整备份已生成：${result.dir}`);
  console.log(`数据库备份：${result.database}`);
  console.log("备份包含 SQLite 数据库、projects/、jobs/ 和 settings.json。");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
