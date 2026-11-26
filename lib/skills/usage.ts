import { promises as fs } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../config";
import { redactSecrets } from "../api";
import {
  isSkillId,
  type SkillErrorCode,
  type SkillUsageRecord,
} from "./types";

export const SKILL_USAGE_FILE = path.join(DATA_DIR, "skills-usage.jsonl");

function clipped(value: unknown, max: number): string {
  return typeof value === "string"
    ? redactSecrets(value).trim().slice(0, max)
    : "";
}

// 技能日志只记录定位问题所需的最小信息：Skill/版本/任务/状态/耗时/错误码。
// 不记录项目正文、人物的完整档案，也不记录 API Key。
export async function recordSkillUsage(
  record: Omit<SkillUsageRecord, "time">,
): Promise<void> {
  try {
    const payload: SkillUsageRecord = {
      time: new Date().toISOString(),
      skillId: record.skillId,
      skillVersion: clipped(record.skillVersion, 40) || "unknown",
      task: clipped(record.task, 40) || "unknown",
      status: record.status,
      durationMs: Math.max(0, Math.round(record.durationMs)),
      mode: record.mode,
      provider: clipped(record.provider, 40) || "unknown",
      model: clipped(record.model, 80) || "unknown",
      promptVersion: clipped(record.promptVersion, 80) || "unknown",
      ...(record.errorCode ? { errorCode: record.errorCode } : {}),
      ...(record.message ? { message: clipped(record.message, 500) } : {}),
      ...(record.chapter ? { chapter: record.chapter } : {}),
      ...(record.inputChars !== undefined
        ? { inputChars: Math.max(0, Math.round(record.inputChars)) }
        : {}),
      ...(record.outputChars !== undefined
        ? { outputChars: Math.max(0, Math.round(record.outputChars)) }
        : {}),
    };
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.appendFile(SKILL_USAGE_FILE, `${JSON.stringify(payload)}\n`, "utf8");
  } catch (error) {
    // 日志失败不能影响创作；与 prompt usage 的处理保持一致。
    console.warn(`技能使用日志写入失败：${String(error)}`);
  }
}

const ERROR_CODES = new Set<SkillErrorCode | "UNKNOWN">([
  "SKILL_NOT_FOUND",
  "SKILL_DISABLED",
  "SKILL_LOAD_FAILED",
  "SKILL_INPUT_INVALID",
  "SKILL_OUTPUT_INVALID",
  "SKILL_LLM_FAILED",
  "UNKNOWN",
]);

export async function readSkillUsage(limit = 20): Promise<SkillUsageRecord[]> {
  const max = Math.min(200, Math.max(1, Math.round(limit) || 20));
  let content = "";
  try {
    content = await fs.readFile(SKILL_USAGE_FILE, "utf8");
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }

  const records: SkillUsageRecord[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (!isSkillId(parsed.skillId)) continue;
      const status =
        parsed.status === "success" ||
        parsed.status === "error" ||
        parsed.status === "cancelled"
          ? parsed.status
          : "error";
      const mode =
        parsed.mode === "mock" || parsed.mode === "llm" || parsed.mode === "local"
          ? parsed.mode
          : "llm";
      const errorCode =
        typeof parsed.errorCode === "string" &&
        ERROR_CODES.has(parsed.errorCode as SkillErrorCode | "UNKNOWN")
          ? (parsed.errorCode as SkillErrorCode | "UNKNOWN")
          : undefined;
      records.push({
        time: typeof parsed.time === "string" ? parsed.time : "",
        skillId: parsed.skillId,
        skillVersion:
          typeof parsed.skillVersion === "string" ? parsed.skillVersion : "",
        task: typeof parsed.task === "string" ? parsed.task : "",
        status,
        durationMs: Number(parsed.durationMs) || 0,
        mode,
        provider: typeof parsed.provider === "string" ? parsed.provider : "",
        model: typeof parsed.model === "string" ? parsed.model : "",
        promptVersion:
          typeof parsed.promptVersion === "string" ? parsed.promptVersion : "",
        ...(errorCode ? { errorCode } : {}),
        ...(typeof parsed.message === "string"
          ? { message: parsed.message }
          : {}),
        ...(Number.isInteger(parsed.chapter) && Number(parsed.chapter) > 0
          ? { chapter: Number(parsed.chapter) }
          : {}),
        ...(typeof parsed.inputChars === "number" &&
        Number.isFinite(parsed.inputChars)
          ? { inputChars: parsed.inputChars }
          : {}),
        ...(typeof parsed.outputChars === "number" &&
        Number.isFinite(parsed.outputChars)
          ? { outputChars: parsed.outputChars }
          : {}),
      });
    } catch {
      // 单行损坏不影响其他日志。
    }
  }
  return records.slice(-max);
}
