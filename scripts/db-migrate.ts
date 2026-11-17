import { migrateFilesToSqlite } from "../lib/db/migrate-files";

async function main(): Promise<void> {
  console.log("开始从 JSON/文件迁移到 SQLite；迁移前会创建完整数据快照。");
  const result = await migrateFilesToSqlite();
  console.log(`迁移完成：${result.projects.length} 个项目，${result.jobs} 个任务。`);
  console.log(`迁移前快照：${result.snapshotDir}`);
  console.log(`迁移报告：${result.reportPath}`);
  if (result.previousDatabaseBackup) {
    console.log(`旧数据库备份：${result.previousDatabaseBackup}`);
  }
  if (result.warnings.length) {
    console.log("警告：");
    for (const warning of result.warnings) console.log(`- ${warning}`);
  }
  console.log("应用下次启动时检测到数据库，会自动使用 SQLite 后端。");
}

main().catch((error) => {
  console.error("迁移失败，原始 JSON/Markdown 数据保持不变。");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
