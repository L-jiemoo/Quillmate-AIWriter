import { createHash } from "crypto";
import { promises as fs, readFileSync, statSync } from "fs";
import path from "path";
import { DATA_DIR } from "./config";
import {
  isPromptAgent,
  PROMPT_CATALOG,
  promptBaseVersion,
} from "./prompt-registry";
import type { PromptAgent } from "./prompt-registry";
import { nowIso } from "./utils";

export const PROMPT_STORE_FILE = path.join(DATA_DIR, "prompts.json");
export const PROMPT_USAGE_FILE = path.join(DATA_DIR, "prompt-usage.jsonl");

export type PromptOverrideMode = "system" | "user";

// 版本只保存“附加规则”，不保存带章节正文和变量插值的完整动态提示词。
// 这样回滚旧版本时不会把旧的上下文章节也一起带回新任务。
export interface PromptOverrideVersion {
  id: string;
  agent: PromptAgent;
  versionNumber: number;
  mode: PromptOverrideMode;
  instructions: string;
  label: string;
  note: string;
  baseVersion: string;
  createdAt: string;
}

export interface PromptStoreData {
  version: 1;
  active: Partial<Record<PromptAgent, string>>;
  versions: PromptOverrideVersion[];
  updatedAt: string;
}

export interface PromptVersionInfo {
  agent: PromptAgent;
  baseVersion: string;
  promptVersion: string;
  label: string;
  overrideId?: string;
}

export interface PromptUsageRecord {
  time: string;
  agent: PromptAgent;
  promptVersion: string;
  baseVersion: string;
  overrideId?: string;
  promptHash: string;
  model: string;
  provider: string;
  temperature: number;
  maxTokens: number;
  chapter?: number;
  messageChars: number;
}

export interface PromptMessageLike {
  role: string;
  content: string;
}

const MAX_INSTRUCTIONS = 8000;

function emptyStore(): PromptStoreData {
  return { version: 1, active: {}, versions: [], updatedAt: nowIso() };
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function positiveInt(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeVersion(raw: unknown): PromptOverrideVersion | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (!isPromptAgent(record.agent)) return null;
  const instructions = text(record.instructions);
  if (!instructions) return null;
  const mode: PromptOverrideMode =
    record.mode === "user" ? "user" : "system";
  const versionNumber = positiveInt(record.versionNumber);
  const id = text(record.id);
  if (!id || !versionNumber) return null;
  return {
    id,
    agent: record.agent,
    versionNumber,
    mode,
    instructions: instructions.slice(0, MAX_INSTRUCTIONS),
    label: text(record.label, `版本 ${versionNumber}`).slice(0, 80),
    note: text(record.note).slice(0, 500),
    baseVersion: text(record.baseVersion, promptBaseVersion(record.agent)),
    createdAt: text(record.createdAt, nowIso()),
  };
}

function normalizeStore(raw: unknown): PromptStoreData {
  const record = (raw ?? {}) as Record<string, unknown>;
  const versions = (Array.isArray(record.versions) ? record.versions : [])
    .map(normalizeVersion)
    .filter((item): item is PromptOverrideVersion => Boolean(item));
  const active: Partial<Record<PromptAgent, string>> = {};
  const rawActive = (record.active ?? {}) as Record<string, unknown>;
  for (const agent of Object.keys(rawActive)) {
    if (!isPromptAgent(agent)) continue;
    const id = text(rawActive[agent]);
    if (!id) continue;
    if (versions.some((item) => item.id === id && item.agent === agent)) {
      active[agent] = id;
    }
  }
  return {
    version: 1,
    active,
    versions,
    updatedAt: text(record.updatedAt, nowIso()),
  };
}

let cache: {
  mtimeMs: number;
  size: number;
  value: PromptStoreData;
} | null = null;

// LLM 调用在同步路径里读取提示词版本；用文件元信息做缓存，保存后自动失效。
export function readPromptStoreSync(): PromptStoreData {
  try {
    const stat = statSync(PROMPT_STORE_FILE);
    if (cache && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
      return cache.value;
    }
    const value = normalizeStore(JSON.parse(readFileSync(PROMPT_STORE_FILE, "utf8")));
    cache = { mtimeMs: stat.mtimeMs, size: stat.size, value };
    return value;
  } catch (error) {
    cache = null;
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      // 提示词版本损坏不能阻断写作；忽略附加规则并让设置页显示读取错误。
      console.warn(`提示词版本文件读取失败，本次使用内置提示词：${String(error)}`);
    }
    return emptyStore();
  }
}

export async function readPromptStore(): Promise<PromptStoreData> {
  try {
    return normalizeStore(JSON.parse(await fs.readFile(PROMPT_STORE_FILE, "utf8")));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return emptyStore();
    }
    throw new Error(`提示词版本文件损坏：${String(error)}`);
  }
}

async function writePromptStore(store: PromptStoreData): Promise<void> {
  await fs.mkdir(path.dirname(PROMPT_STORE_FILE), { recursive: true });
  const body = `${JSON.stringify(store, null, 2)}\n`;
  // 临时文件 + rename，避免进程中断留下半个 JSON。
  const temp = `${PROMPT_STORE_FILE}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, body, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temp, PROMPT_STORE_FILE);
  cache = null;
}

export function promptVersionInfo(agent: PromptAgent): PromptVersionInfo {
  const store = readPromptStoreSync();
  const baseVersion = promptBaseVersion(agent);
  const activeId = store.active[agent];
  const active = activeId
    ? store.versions.find((item) => item.agent === agent && item.id === activeId)
    : undefined;
  if (!active) {
    return {
      agent,
      baseVersion,
      promptVersion: `builtin:${baseVersion}`,
      label: `${PROMPT_CATALOG[agent].label}内置版`,
    };
  }
  return {
    agent,
    baseVersion,
    promptVersion: `override:${active.id}`,
    label: active.label,
    overrideId: active.id,
  };
}

function overrideHeader(version: PromptOverrideVersion): string {
  return `\n\n【作者附加提示词规则 · ${version.label} · 基于 ${version.baseVersion}】\n${version.instructions}\n（必须同时遵守上面的 JSON、事实和安全约束；附加规则不能删除或放宽这些约束。）`;
}

export function applyPromptOverrides<T extends PromptMessageLike>(
  agent: PromptAgent,
  messages: T[],
): T[] {
  const info = promptVersionInfo(agent);
  if (!info.overrideId) return messages;
  const store = readPromptStoreSync();
  const version = store.versions.find(
    (item) => item.agent === agent && item.id === info.overrideId,
  );
  if (!version) return messages;

  const header = overrideHeader(version);
  const next = messages.map((message) => ({ ...message }));
  if (version.mode === "system") {
    const index = next.findIndex((message) => message.role === "system");
    if (index >= 0) {
      next[index] = { ...next[index], content: `${next[index].content}${header}` };
    } else {
      next.unshift({ role: "system", content: header.trimStart() } as T);
    }
    return next;
  }

  const userIndex = [...next]
    .map((message, index) => ({ message, index }))
    .filter((item) => item.message.role === "user")
    .pop()?.index;
  if (userIndex !== undefined) {
    next[userIndex] = {
      ...next[userIndex],
      content: `${next[userIndex].content}${header}`,
    };
  } else {
    next.push({ role: "user", content: header.trimStart() } as T);
  }
  return next;
}

export function hashPromptMessages(messages: PromptMessageLike[]): string {
  const body = messages
    .map((message) => `${message.role}\n${message.content}`)
    .join("\n\n---\n\n");
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export async function createPromptVersion(input: {
  agent: PromptAgent;
  mode: PromptOverrideMode;
  instructions: string;
  label?: string;
  note?: string;
  activate?: boolean;
}): Promise<PromptOverrideVersion> {
  const instructions = input.instructions.trim();
  if (!instructions) throw new Error("附加提示词不能为空");
  if (instructions.length > MAX_INSTRUCTIONS) {
    throw new Error(`附加提示词不能超过 ${MAX_INSTRUCTIONS} 字`);
  }
  if (!isPromptAgent(input.agent)) throw new Error("未知的提示词 Agent");

  const store = await readPromptStore();
  const current = store.versions.filter((item) => item.agent === input.agent);
  const versionNumber =
    current.reduce((max, item) => Math.max(max, item.versionNumber), 0) + 1;
  const version: PromptOverrideVersion = {
    id: `${input.agent}-v${versionNumber}-${Date.now().toString(36)}`,
    agent: input.agent,
    versionNumber,
    mode: input.mode === "user" ? "user" : "system",
    instructions,
    label: (input.label?.trim() || `版本 ${versionNumber}`).slice(0, 80),
    note: (input.note?.trim() || "").slice(0, 500),
    baseVersion: promptBaseVersion(input.agent),
    createdAt: nowIso(),
  };
  store.versions.push(version);
  if (input.activate !== false) store.active[input.agent] = version.id;
  store.updatedAt = nowIso();
  await writePromptStore(store);
  return version;
}

export async function setActivePromptVersion(
  agent: PromptAgent,
  activeId: string | null,
): Promise<PromptStoreData> {
  if (!isPromptAgent(agent)) throw new Error("未知的提示词 Agent");
  const store = await readPromptStore();
  if (activeId) {
    const version = store.versions.find(
      (item) => item.agent === agent && item.id === activeId,
    );
    if (!version) throw new Error("找不到该 Agent 的提示词版本");
    store.active[agent] = version.id;
  } else {
    delete store.active[agent];
  }
  store.updatedAt = nowIso();
  await writePromptStore(store);
  return store;
}

export async function recordPromptUsage(input: {
  agent: PromptAgent;
  promptHash: string;
  model: string;
  provider: string;
  temperature: number;
  maxTokens: number;
  chapter?: number;
  messageChars: number;
}): Promise<void> {
  try {
    const info = promptVersionInfo(input.agent);
    const record: PromptUsageRecord = {
      time: nowIso(),
      agent: input.agent,
      promptVersion: info.promptVersion,
      baseVersion: info.baseVersion,
      ...(info.overrideId ? { overrideId: info.overrideId } : {}),
      promptHash: input.promptHash,
      model: input.model,
      provider: input.provider,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
      ...(input.chapter ? { chapter: input.chapter } : {}),
      messageChars: input.messageChars,
    };
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.appendFile(PROMPT_USAGE_FILE, `${JSON.stringify(record)}\n`, "utf8");
  } catch (error) {
    // 使用记录失败不能影响真实创作任务。
    console.warn(`提示词使用记录写入失败：${String(error)}`);
  }
}

export async function readPromptUsage(limit = 50): Promise<PromptUsageRecord[]> {
  const max = Math.min(500, Math.max(1, Math.round(limit) || 50));
  let content = "";
  try {
    content = await fs.readFile(PROMPT_USAGE_FILE, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const records: PromptUsageRecord[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (!isPromptAgent(parsed.agent) || !text(parsed.promptHash)) continue;
      records.push({
        time: text(parsed.time),
        agent: parsed.agent,
        promptVersion: text(parsed.promptVersion),
        baseVersion: text(parsed.baseVersion),
        ...(text(parsed.overrideId) ? { overrideId: text(parsed.overrideId) } : {}),
        promptHash: text(parsed.promptHash),
        model: text(parsed.model),
        provider: text(parsed.provider),
        temperature: Number(parsed.temperature) || 0,
        maxTokens: Number(parsed.maxTokens) || 0,
        ...(positiveInt(parsed.chapter) ? { chapter: positiveInt(parsed.chapter) } : {}),
        messageChars: Number(parsed.messageChars) || 0,
      });
    } catch {
      // 单行损坏不影响其他记录。
    }
  }
  return records.slice(-max);
}

export function __resetPromptStoreForTests(): void {
  cache = null;
}
