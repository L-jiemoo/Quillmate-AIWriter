import { promises as fs, readFileSync, statSync } from "fs";
import path from "path";
import type { LLMProvider } from "./config";

const DATA_DIR = process.env.QUILLMATE_DATA_DIR?.trim()
  ? path.resolve(process.env.QUILLMATE_DATA_DIR.trim())
  : path.join(process.cwd(), "data");
export const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

export interface SavedSettings {
  provider: LLMProvider;
  baseUrl: string;
  model: string;
  apiKey: string;
  temperature: number;
  maxTokens: number;
}

export interface PublicSettings {
  provider: LLMProvider;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  apiKeySet: boolean;
  apiKeyPreview: string;
}

const DEFAULT_BASE_URL = "https://api.deepseek.com/v1";
const DEFAULT_MODEL = "deepseek-chat";

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalize(raw: unknown): SavedSettings | null {
  // settings.json 可能被手工修改或由旧版本写入；
  // 读取时统一字段类型并夹紧取值范围，避免 NaN、负数或超长 token 进入请求。
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const text = (value: unknown, fallback: string) =>
    typeof value === "string" && value.trim() ? value.trim() : fallback;

  return {
    provider: record.provider === "mock" ? "mock" : "openai-compatible",
    baseUrl: text(record.baseUrl, DEFAULT_BASE_URL),
    model: text(record.model, DEFAULT_MODEL),
    apiKey: typeof record.apiKey === "string" ? record.apiKey.trim() : "",
    temperature: clampNumber(record.temperature, 0.85, 0, 2),
    maxTokens: Math.round(clampNumber(record.maxTokens, 8192, 1, 32768)),
  };
}

// 设置会被每条写作提示词读取，不能每次都同步读盘。
// 用 mtime + size 做缓存键：设置页保存后文件变化，缓存自动失效，
// 后台任务无需重启就能读到新配置。
let cache: { mtimeMs: number; size: number; value: SavedSettings | null } | null = null;

export function readSettingsSync(): SavedSettings | null {
  try {
    const stat = statSync(SETTINGS_FILE);
    if (cache && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
      return cache.value;
    }
    const value = normalize(JSON.parse(readFileSync(SETTINGS_FILE, "utf8")));
    cache = { mtimeMs: stat.mtimeMs, size: stat.size, value };
    return value;
  } catch {
    cache = null;
    return null;
  }
}

export async function readSettings(): Promise<SavedSettings | null> {
  try {
    return normalize(JSON.parse(await fs.readFile(SETTINGS_FILE, "utf8")));
  } catch {
    return null;
  }
}

export async function writeSettings(settings: SavedSettings): Promise<void> {
  await fs.mkdir(path.dirname(SETTINGS_FILE), { recursive: true });
  // 文件里有明文 API Key，尽量收紧为仅当前用户可读写；
  // Windows 对 mode 的支持有限，所以同时依赖 .gitignore 防止误提交。
  await fs.writeFile(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  cache = null;
}

export function previewKey(apiKey: string): string {
  // 只暴露前 3 位和后 4 位，用于让用户确认“是哪把钥匙”，
  // 完整密钥永远不进入 API 响应或前端状态。
  if (!apiKey) return "";
  if (apiKey.length <= 8) return "••••";
  return `${apiKey.slice(0, 3)}…${apiKey.slice(-4)}`;
}

export function toPublicSettings(settings: SavedSettings): PublicSettings {
  return {
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    model: settings.model,
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
    apiKeySet: Boolean(settings.apiKey),
    apiKeyPreview: previewKey(settings.apiKey),
  };
}
