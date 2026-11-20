import path from "path";
import { readSettingsSync } from "./settings";
import {
  DEFAULT_STORY_CONTEXT_CHARS,
  normalizeStoryContextChars,
} from "./story-context-tiers";
import { DEFAULT_OUTPUT_TOKENS, normalizeOutputTokens } from "./token-tiers";

// QUILLMATE_DATA_DIR 只用于测试隔离；未设置时仍使用项目下的 data/。
export const DATA_DIR = process.env.QUILLMATE_DATA_DIR?.trim()
  ? path.resolve(process.env.QUILLMATE_DATA_DIR.trim())
  : path.join(process.cwd(), "data");
export const PROJECTS_DIR = path.join(DATA_DIR, "projects");
export const JOBS_DIR = path.join(DATA_DIR, "jobs");
export const BROWSER_PROFILE_DIR = path.join(DATA_DIR, "browser", "fanqie");
export const ARTIFACT_DIR = path.join(DATA_DIR, "publish-artifacts");

export type LLMProvider = "mock" | "openai-compatible";

export interface RuntimeConfig {
  provider: LLMProvider;
  baseUrl: string;
  model: string;
  apiKey: string;
  temperature: number;
  maxTokens: number;
  // 剧情台账注入写作/审校提示词的字符预算，按三档归一化。
  storyContextChars: number;
  // 修复 Agent 单独使用的模型；留空表示沿用 model。
  repairModel: string;
}

export type BrowserChannel = "msedge" | "chrome" | undefined;

export function getBrowserChannel(): BrowserChannel {
  // 默认复用系统 Edge，省去下载 Playwright 浏览器；
  // 只有显式设置 BROWSER_CHANNEL=chromium 时才使用自带内核。
  const raw = process.env.BROWSER_CHANNEL?.trim().toLowerCase();
  if (raw === "chromium" || raw === "bundled" || raw === "none") return undefined;
  if (raw === "chrome") return "chrome";
  return "msedge";
}

export type ConfigSource = "settings" | "env" | "default";

export function getConfigSource(): ConfigSource {
  if (readSettingsSync()) return "settings";
  if (process.env.LLM_API_KEY?.trim() || process.env.LLM_PROVIDER?.trim()) return "env";
  return "default";
}

export function getRuntimeConfig(): RuntimeConfig {
  // 配置优先级：页面保存的 settings.json > .env.local > 默认值。
  // 页面设置存在但没有 API Key 时强制回落 mock，避免向未配置的服务发起请求。
  const saved = readSettingsSync();
  if (saved) {
    return {
      provider:
        saved.provider === "mock" || !saved.apiKey ? "mock" : "openai-compatible",
      baseUrl: saved.baseUrl,
      model: saved.model,
      apiKey: saved.apiKey,
      temperature: saved.temperature,
      maxTokens: saved.maxTokens,
      storyContextChars: saved.storyContextChars,
      repairModel: saved.repairModel,
    };
  }

  const apiKey = process.env.LLM_API_KEY?.trim() ?? "";
  const rawProvider = process.env.LLM_PROVIDER?.trim().toLowerCase();
  const provider: LLMProvider =
    rawProvider === "mock"
      ? "mock"
      : rawProvider === "openai" || rawProvider === "openai-compatible"
        ? "openai-compatible"
        : apiKey
          ? "openai-compatible"
          : "mock";

  return {
    provider,
    baseUrl: process.env.LLM_BASE_URL?.trim() || "https://api.deepseek.com/v1",
    model: process.env.LLM_MODEL?.trim() || "deepseek-chat",
    apiKey,
    temperature: Number(process.env.LLM_TEMPERATURE ?? 0.85),
    maxTokens: normalizeOutputTokens(process.env.LLM_MAX_TOKENS, DEFAULT_OUTPUT_TOKENS),
    storyContextChars: normalizeStoryContextChars(
      process.env.STORY_CONTEXT_CHARS,
      DEFAULT_STORY_CONTEXT_CHARS,
    ),
    repairModel: process.env.LLM_REPAIR_MODEL?.trim() || "",
  };
}
