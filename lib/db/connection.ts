import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DB_FILE } from "../storage-mode";
import { ensureSchema } from "./schema";

let active: DatabaseSync | null = null;
let activePath = "";

export function getDatabase(): DatabaseSync {
  if (active && activePath === DB_FILE) return active;
  closeDatabase();

  mkdirSync(path.dirname(DB_FILE), { recursive: true });
  const db = new DatabaseSync(DB_FILE);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  ensureSchema(db);
  active = db;
  activePath = DB_FILE;
  return db;
}

export function closeDatabase(): void {
  if (!active) return;
  try {
    active.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    // 连接已不可用时只需要继续关闭。
  }
  try {
    active.close();
  } catch {
    // 关闭失败不能阻止后续重新打开。
  }
  active = null;
  activePath = "";
}

// node:sqlite 是同步 API；事务内不要再 await 外部 I/O，避免其他请求混入同一事务。
export function withTransaction<T>(fn: (db: DatabaseSync) => T): T {
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn(db);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // 回滚失败时保留原始错误。
    }
    throw error;
  }
}
