import { promises as fs } from "node:fs";
import path from "node:path";
import { restoreDatabase, restoreFullBackup } from "../lib/db/backup";

async function main(): Promise<void> {
  const source = process.argv[2];
  const confirmed = process.argv.includes("--yes");
  if (!source) {
    throw new Error("用法：npm run db:restore -- <完整备份目录或 .sqlite 文件> --yes");
  }
  if (!confirmed) {
    throw new Error("恢复会覆盖当前数据库和项目文件；确认后请加 --yes");
  }
  const resolved = path.resolve(source);
  const stat = await fs.stat(resolved);
  if (stat.isDirectory()) {
    await restoreFullBackup(resolved);
    console.log(`已从完整备份恢复数据库和项目文件：${resolved}`);
    console.log("恢复前的数据保留在 data/*.before-restore-*。");
  } else {
    await restoreDatabase(resolved);
    console.log(`已从数据库文件恢复：${resolved}`);
    console.log("注意：这个模式只恢复数据库元数据，Markdown 正文不会被覆盖。");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
