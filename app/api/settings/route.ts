import { NextResponse } from "next/server";
import {
  apiError,
  assertSameOrigin,
  noStoreJson,
  readJsonBody,
} from "@/lib/api";
import { getConfigSource, getRuntimeConfig } from "@/lib/config";
import type { LLMProvider } from "@/lib/config";
import {
  previewKey,
  readSettings,
  toPublicSettings,
  writeSettings,
} from "@/lib/settings";
import type { SavedSettings } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function envDefaults(): SavedSettings {
  const temperature = Number(process.env.LLM_TEMPERATURE ?? 0.85);
  const maxTokens = Number(process.env.LLM_MAX_TOKENS ?? 8192);
  return {
    provider:
      process.env.LLM_PROVIDER?.trim().toLowerCase() === "mock"
        ? "mock"
        : "openai-compatible",
    baseUrl: process.env.LLM_BASE_URL?.trim() || "https://api.deepseek.com/v1",
    model: process.env.LLM_MODEL?.trim() || "deepseek-chat",
    apiKey: process.env.LLM_API_KEY?.trim() || "",
    temperature: Number.isFinite(temperature) ? temperature : 0.85,
    maxTokens: Number.isFinite(maxTokens) ? maxTokens : 8192,
  };
}

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function validBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

async function snapshot() {
  const saved = await readSettings();
  const effective = getRuntimeConfig();
  // 对外只返回脱敏预览和“是否已配置”，完整 apiKey 不出服务端；
  // saved 与 effective 分开是为了让页面知道当前值来自文件还是环境变量。
  return {
    saved: saved ? toPublicSettings(saved) : null,
    effective: {
      provider: effective.provider,
      baseUrl: effective.baseUrl,
      model: effective.model,
      temperature: effective.temperature,
      maxTokens: effective.maxTokens,
      apiKeySet: Boolean(effective.apiKey),
      apiKeyPreview: previewKey(effective.apiKey),
    },
    source: getConfigSource(),
    envConfigured: Boolean(process.env.LLM_API_KEY?.trim()),
  };
}

export async function GET() {
  return noStoreJson(await snapshot());
}

export async function PUT(request: Request) {
  try {
    assertSameOrigin(request);
    const body = await readJsonBody<{
      provider?: string;
      baseUrl?: string;
      model?: string;
      apiKey?: string;
      temperature?: number;
      maxTokens?: number;
      clearApiKey?: boolean;
    }>(request);

    const current = (await readSettings()) ?? envDefaults();
    const provider: LLMProvider =
      body.provider === "mock" ? "mock" : "openai-compatible";
    const baseUrl =
      typeof body.baseUrl === "string" && body.baseUrl.trim()
        ? body.baseUrl.trim()
        : current.baseUrl;
    const model =
      typeof body.model === "string" && body.model.trim() ? body.model.trim() : current.model;

    if (!validBaseUrl(baseUrl)) {
      return NextResponse.json(
        { error: "接口地址必须以 http:// 或 https:// 开头" },
        { status: 400 },
      );
    }
    if (!model) {
      return NextResponse.json({ error: "模型名称不能为空" }, { status: 400 });
    }

    // 表单不回显完整密钥，所以“留空”表示沿用旧值；
    // 只有显式 clearApiKey 才清空，避免用户每次保存其他字段都把 Key 抹掉。
    let apiKey = current.apiKey;
    if (typeof body.apiKey === "string" && body.apiKey.trim()) {
      apiKey = body.apiKey.trim();
    }
    if (body.clearApiKey === true) apiKey = "";

    await writeSettings({
      provider,
      baseUrl,
      model,
      apiKey,
      temperature: clamp(body.temperature, current.temperature, 0, 2),
      maxTokens: Math.round(clamp(body.maxTokens, current.maxTokens, 1, 32768)),
    });

    return noStoreJson(await snapshot());
  } catch (error) {
    return apiError(error);
  }
}
