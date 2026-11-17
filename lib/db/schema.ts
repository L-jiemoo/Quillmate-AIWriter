import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "../utils";

export const SCHEMA_VERSION = 3;

// 结构化数据表。章节正文、世界观、大纲、审校报告等长文本仍保存在 Markdown 文件里。
const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL,
  description TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  genre TEXT NOT NULL DEFAULT '',
  tone TEXT NOT NULL DEFAULT '',
  idea TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT 'zh-CN',
  target_chapters INTEGER NOT NULL,
  words_per_chapter INTEGER NOT NULL,
  logline TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]',
  fanqie_enabled INTEGER NOT NULL DEFAULT 1,
  fanqie_book_id TEXT NOT NULL DEFAULT '',
  fanqie_book_name TEXT NOT NULL DEFAULT '',
  fanqie_auto_submit INTEGER NOT NULL DEFAULT 0,
  fanqie_headless INTEGER NOT NULL DEFAULT 0,
  fanqie_selectors_json TEXT NOT NULL DEFAULT '{}',
  state_updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chapters (
  slug TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
  chapter_index INTEGER NOT NULL CHECK(chapter_index > 0),
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  key_beats_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY(slug, chapter_index)
);

CREATE TABLE IF NOT EXISTS chapter_states (
  slug TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
  chapter_index INTEGER NOT NULL CHECK(chapter_index > 0),
  written INTEGER NOT NULL DEFAULT 0,
  written_summary TEXT NOT NULL DEFAULT '',
  content_path TEXT NOT NULL DEFAULT '',
  content_hash TEXT,
  word_count INTEGER NOT NULL DEFAULT 0,
  written_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(slug, chapter_index)
);

CREATE TABLE IF NOT EXISTS characters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  gender TEXT NOT NULL DEFAULT '',
  age TEXT NOT NULL DEFAULT '',
  appearance TEXT NOT NULL DEFAULT '',
  personality TEXT NOT NULL DEFAULT '',
  background TEXT NOT NULL DEFAULT '',
  goals TEXT NOT NULL DEFAULT '',
  arc TEXT NOT NULL DEFAULT '',
  relationships TEXT NOT NULL DEFAULT '',
  speech_style TEXT NOT NULL DEFAULT '',
  source TEXT,
  updated_at TEXT,
  UNIQUE(slug, name)
);

CREATE TABLE IF NOT EXISTS canon_meta (
  slug TEXT PRIMARY KEY REFERENCES projects(slug) ON DELETE CASCADE,
  current_day TEXT NOT NULL DEFAULT '',
  last_chapter INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS canon_characters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
  name TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  status_chapter INTEGER NOT NULL DEFAULT 0,
  chapter INTEGER NOT NULL DEFAULT 0,
  UNIQUE(slug, name)
);

CREATE TABLE IF NOT EXISTS canon_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
  name TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  holder TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  chapter INTEGER NOT NULL DEFAULT 0,
  UNIQUE(slug, name)
);

CREATE TABLE IF NOT EXISTS canon_deadlines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
  name TEXT NOT NULL,
  due TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  chapter INTEGER NOT NULL DEFAULT 0,
  UNIQUE(slug, name)
);

CREATE TABLE IF NOT EXISTS canon_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
  rule TEXT NOT NULL,
  UNIQUE(slug, rule)
);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
  chapter_index INTEGER NOT NULL CHECK(chapter_index > 0),
  summary TEXT NOT NULL DEFAULT '',
  continuity_ok INTEGER NOT NULL,
  repaired INTEGER,
  repair_attempts INTEGER,
  extraction_ok INTEGER,
  extraction_error TEXT,
  extraction_attempts INTEGER,
  updated_at TEXT NOT NULL,
  UNIQUE(slug, chapter_index)
);

CREATE TABLE IF NOT EXISTS review_issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  severity TEXT NOT NULL,
  issue_type TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  UNIQUE(review_id, position)
);

CREATE TABLE IF NOT EXISTS rejected_drafts (
  slug TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
  chapter_index INTEGER NOT NULL CHECK(chapter_index > 0),
  at TEXT NOT NULL,
  path TEXT NOT NULL,
  mode TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  review_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY(slug, chapter_index)
);

CREATE TABLE IF NOT EXISTS chapter_repairs (
  slug TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
  chapter_index INTEGER NOT NULL CHECK(chapter_index > 0),
  repaired_at TEXT NOT NULL,
  PRIMARY KEY(slug, chapter_index)
);

CREATE TABLE IF NOT EXISTS chapter_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
  chapter_index INTEGER NOT NULL CHECK(chapter_index > 0),
  version INTEGER NOT NULL CHECK(version > 0),
  created_at TEXT NOT NULL,
  source TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  note TEXT,
  content_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  previous_hash TEXT,
  word_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(slug, chapter_index, version)
);

CREATE TABLE IF NOT EXISTS publish_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  at TEXT NOT NULL,
  status TEXT NOT NULL,
  mode TEXT,
  message TEXT NOT NULL DEFAULT '',
  chapters_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS publish_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  book_id TEXT NOT NULL DEFAULT '',
  book_name TEXT NOT NULL DEFAULT '',
  chapter_index INTEGER NOT NULL CHECK(chapter_index > 0),
  status TEXT NOT NULL,
  at TEXT NOT NULL,
  job_id TEXT,
  message TEXT,
  UNIQUE(slug, platform, book_id, book_name, chapter_index)
);

CREATE TABLE IF NOT EXISTS publish_ledger_meta (
  slug TEXT PRIMARY KEY REFERENCES projects(slug) ON DELETE CASCADE,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL,
  params_json TEXT NOT NULL DEFAULT '{}',
  pause_requested INTEGER NOT NULL DEFAULT 0,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  cancel_reason TEXT,
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  time TEXT NOT NULL,
  message TEXT NOT NULL,
  UNIQUE(job_id, seq)
);

CREATE INDEX IF NOT EXISTS chapters_slug_index ON chapters(slug, chapter_index);
CREATE INDEX IF NOT EXISTS chapter_states_slug_written ON chapter_states(slug, written);
CREATE INDEX IF NOT EXISTS reviews_slug_index ON reviews(slug, chapter_index);
CREATE INDEX IF NOT EXISTS chapter_versions_slug_index ON chapter_versions(slug, chapter_index, version);
CREATE INDEX IF NOT EXISTS publish_records_slug_index ON publish_records(slug, id);
CREATE INDEX IF NOT EXISTS publish_ledger_lookup ON publish_ledger(slug, platform, chapter_index);
CREATE INDEX IF NOT EXISTS jobs_slug_status ON jobs(slug, status, updated_at);
CREATE INDEX IF NOT EXISTS job_logs_job_seq ON job_logs(job_id, seq);
`;

// v2 只新增长期记忆表，不修改 v1 的列；已有数据库打开时按版本追加。
const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS book_memory (
  slug TEXT PRIMARY KEY REFERENCES projects(slug) ON DELETE CASCADE,
  data_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS volume_memories (
  slug TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
  volume_id TEXT NOT NULL,
  start_chapter INTEGER NOT NULL CHECK(start_chapter > 0),
  end_chapter INTEGER NOT NULL CHECK(end_chapter >= start_chapter),
  data_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(slug, volume_id)
);

CREATE TABLE IF NOT EXISTS chapter_memories (
  slug TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
  chapter_index INTEGER NOT NULL CHECK(chapter_index > 0),
  data_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(slug, chapter_index)
);

CREATE INDEX IF NOT EXISTS volume_memories_slug_range ON volume_memories(slug, start_chapter, end_chapter);
CREATE INDEX IF NOT EXISTS chapter_memories_slug_index ON chapter_memories(slug, chapter_index);
`;

// v3 新增人物动态状态、关系、剧情事件和伏笔生命周期；同样只追加，不修改旧表。
const SCHEMA_V3 = `
CREATE TABLE IF NOT EXISTS story_character_states (
  slug TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
  state_id TEXT NOT NULL,
  chapter_index INTEGER NOT NULL CHECK(chapter_index > 0),
  character_name TEXT NOT NULL,
  data_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(slug, state_id)
);

CREATE TABLE IF NOT EXISTS story_relations (
  slug TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
  relation_id TEXT NOT NULL,
  chapter_index INTEGER NOT NULL CHECK(chapter_index > 0),
  from_name TEXT NOT NULL,
  to_name TEXT NOT NULL,
  data_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(slug, relation_id)
);

CREATE TABLE IF NOT EXISTS story_events (
  slug TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  chapter_index INTEGER NOT NULL CHECK(chapter_index > 0),
  name TEXT NOT NULL,
  data_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(slug, event_id)
);

CREATE TABLE IF NOT EXISTS story_foreshadows (
  slug TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
  foreshadow_id TEXT NOT NULL,
  planted_chapter INTEGER NOT NULL CHECK(planted_chapter > 0),
  status TEXT NOT NULL,
  data_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(slug, foreshadow_id)
);

CREATE TABLE IF NOT EXISTS story_meta (
  slug TEXT PRIMARY KEY REFERENCES projects(slug) ON DELETE CASCADE,
  updated_at TEXT NOT NULL,
  suppressed_json TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS story_states_slug_character ON story_character_states(slug, character_name, chapter_index);
CREATE INDEX IF NOT EXISTS story_relations_slug_chapter ON story_relations(slug, chapter_index);
CREATE INDEX IF NOT EXISTS story_events_slug_chapter ON story_events(slug, chapter_index);
CREATE INDEX IF NOT EXISTS story_foreshadows_slug_status ON story_foreshadows(slug, status, planted_chapter);
`;

export function ensureSchema(db: DatabaseSync): void {
  db.exec(SCHEMA_V1);
  db.exec(SCHEMA_V2);
  db.exec(SCHEMA_V3);

  const row = db
    .prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .get() as { version?: number | null } | undefined;
  const current = Number(row?.version ?? 0);
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `数据库 Schema 版本 ${current} 高于当前程序支持的 ${SCHEMA_VERSION}，请升级程序后再打开`,
    );
  }
  // 构建/开发时可能有多个进程同时首次打开数据库，迁移记录必须幂等。
  const insertMigration = db.prepare(
    "INSERT OR IGNORE INTO schema_migrations (version, applied_at, description) VALUES (?, ?, ?)",
  );
  if (current < 1) insertMigration.run(1, nowIso(), "initial sqlite schema");
  if (current < 2) insertMigration.run(2, nowIso(), "long-form layered memory");
  if (current < 3) {
    insertMigration.run(3, nowIso(), "character states, relations, plot events and foreshadows");
  }
  // 兼容早期 v3 测试库：story_meta 可能还没有 suppressed_json 列。
  const storyMetaColumns = db
    .prepare("PRAGMA table_info(story_meta)")
    .all() as unknown as Array<{ name: string }>;
  if (!storyMetaColumns.some((column) => column.name === "suppressed_json")) {
    db.exec(
      "ALTER TABLE story_meta ADD COLUMN suppressed_json TEXT NOT NULL DEFAULT '[]'",
    );
  }

  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}
