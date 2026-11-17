import { existsSync } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config";

export type StorageMode = "auto" | "file" | "sqlite";

export const DB_DIR = path.join(DATA_DIR, "db");
export const DB_FILE = path.join(DB_DIR, "quillmate.sqlite");

export function getStorageMode(): StorageMode {
  const raw = process.env.QUILLMATE_STORAGE?.trim().toLowerCase();
  if (raw === "sqlite" || raw === "file" || raw === "auto") return raw;
  return "auto";
}

// auto 只根据数据库文件是否存在选择后端；Schema 兼容性由连接层负责校验。
export function shouldUseSqlite(): boolean {
  const mode = getStorageMode();
  if (mode === "sqlite") return true;
  if (mode === "file") return false;
  return existsSync(DB_FILE);
}
