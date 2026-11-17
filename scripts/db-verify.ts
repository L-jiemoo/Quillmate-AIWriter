import { promises as fs } from "node:fs";
import { DB_FILE } from "../lib/storage-mode";
import { getDatabase } from "../lib/db/connection";
import * as sqliteStore from "../lib/store-sqlite";

async function main(): Promise<void> {
  try {
    await fs.access(DB_FILE);
  } catch {
    throw new Error(`数据库不存在：${DB_FILE}`);
  }

  const db = getDatabase();
  const integrity = db.prepare("PRAGMA integrity_check").get() as
    | { integrity_check: string }
    | undefined;
  if (integrity?.integrity_check !== "ok") {
    throw new Error(`完整性检查失败：${integrity?.integrity_check ?? "unknown"}`);
  }
  const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeys.length) {
    throw new Error(`外键检查失败：${JSON.stringify(foreignKeys.slice(0, 5))}`);
  }

  const tableCount = (table: string): number => {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
      count: number;
    };
    return Number(row.count);
  };

  const projects = db.prepare("SELECT slug, title FROM projects ORDER BY slug").all() as
    | Array<{ slug: string; title: string }>;
  for (const project of projects) {
    const detail = await sqliteStore.getProjectDetail(project.slug);
    const memory = await sqliteStore.getMemory(project.slug);
    const story = await sqliteStore.getStory(project.slug);
    const integrityReport = await sqliteStore.checkProjectIntegrity(project.slug);
    console.log(
      `${project.slug}：《${project.title}》${detail.plan.chapters.length} 章，` +
        `${detail.characters.length} 位角色，已写 ${detail.state.written.length} 章，` +
        `记忆 ${Object.keys(memory.chapters).length} 章/${memory.volumes.length} 卷，` +
        `剧情台账 ${story.states.length} 状态/${story.relations.length} 关系/` +
        `${story.events.length} 事件/${story.foreshadows.length} 伏笔，` +
        `一致性 ${integrityReport.ok ? "通过" : "有严重问题"}`,
    );
    if (!integrityReport.ok) {
      for (const issue of integrityReport.issues.filter((item) => item.severity === "critical")) {
        console.log(`  - ${issue.code}: ${issue.message}`);
      }
    }
  }

  console.log(
    `数据库校验通过：${projects.length} 个项目，${tableCount("chapters")} 条大纲章节，` +
      `${tableCount("chapter_states")} 条章节状态，${tableCount("characters")} 张人物卡，` +
      `${tableCount("chapter_memories")} 条章节记忆，` +
      `${tableCount("story_character_states")} 条人物状态、${tableCount("story_relations")} 条关系、` +
      `${tableCount("story_events")} 条剧情事件、${tableCount("story_foreshadows")} 条伏笔，` +
      `${tableCount("chapter_versions")} 个版本，${tableCount("jobs")} 个任务。`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
