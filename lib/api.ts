import { NextResponse } from "next/server";
import { StorageError } from "./storage";
import { SkillError } from "./skills/types";
import { errorMessage, isSafeSlug } from "./utils";

const MAX_JSON_BYTES = 5 * 1024 * 1024;

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function assertSafeSlugParam(slug: string): string {
  if (!isSafeSlug(slug)) throw new ApiError(400, "项目标识不合法");
  return slug;
}

export function parsePositiveInt(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ApiError(400, `${label}必须是大于 0 的整数`);
  }
  return parsed;
}

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  // 非浏览器请求通常没有 Origin；本地脚本和测试仍然可用。
  if (!origin) return;
  const host = request.headers.get("host");
  if (!host) throw new ApiError(403, "请求来源无法校验");
  if (origin === "null") throw new ApiError(403, "不允许跨站请求");

  let originHost = "";
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new ApiError(403, "请求来源不合法");
  }
  if (originHost.toLowerCase() !== host.toLowerCase()) {
    throw new ApiError(403, "不允许跨站请求");
  }
}

export async function readJsonBody<T extends Record<string, unknown>>(
  request: Request,
): Promise<T> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(length) && length > MAX_JSON_BYTES) {
    throw new ApiError(413, "请求内容过大");
  }

  const text = await request.text();
  if (text.length > MAX_JSON_BYTES) throw new ApiError(413, "请求内容过大");
  if (!text.trim()) return {} as T;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError(400, "请求内容不是合法 JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiError(400, "请求体必须是 JSON 对象");
  }
  return parsed as T;
}

export function requireConfirm(
  body: Record<string, unknown>,
  field: string,
  expected: unknown,
  message = "该操作需要二次确认",
): void {
  if (body[field] !== expected) throw new ApiError(400, message);
}

export function redactSecrets(message: string): string {
  return message
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, "[密钥已脱敏]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[已脱敏]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|secret)\s*[:=]\s*)[^\s,;"']+/gi,
      "$1[已脱敏]",
    )
    .replace(/\b[A-Za-z]:\\(?:[^\\\s"']+\\)*[^\\\s"']*/g, "[本地路径]")
    .replace(/\/(?:Users|home|root|tmp|var|opt|mnt)\/[^\s"',;)]+/g, "[本地路径]");
}

function storageMessage(error: StorageError): { status: number; message: string } {
  switch (error.code) {
    case "not_found":
      return { status: 404, message: "项目或文件不存在" };
    case "corrupted":
      return { status: 500, message: "数据文件损坏，请先备份并检查" };
    default:
      return { status: 500, message: "本地文件读写失败，请检查权限或磁盘空间" };
  }
}

export function apiError(error: unknown, fallbackStatus = 400): NextResponse {
  if (error instanceof ApiError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof StorageError) {
    const mapped = storageMessage(error);
    return NextResponse.json({ error: mapped.message }, { status: mapped.status });
  }
  if (error instanceof SkillError) {
    return NextResponse.json(
      { error: redactSecrets(error.message), code: error.code },
      { status: error.status },
    );
  }

  const message = redactSecrets(errorMessage(error)).trim() || "操作失败";
  return NextResponse.json({ error: message }, { status: fallbackStatus });
}

export function noStoreJson(value: unknown, init?: ResponseInit): NextResponse {
  const response = NextResponse.json(value, init);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
