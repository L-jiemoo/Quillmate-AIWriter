import { LLMClient } from "../llm";
import { getRuntimeConfig } from "../config";
import { promptVersionInfo } from "../prompt-store";
import type { PromptAgent } from "../prompt-registry";
import { errorMessage } from "../utils";
import { loadSkill } from "./loader";
import { recordSkillUsage } from "./usage";
import {
  SkillError,
  type SkillErrorCode,
  type SkillId,
  type SkillManifest,
  type SkillUsageRecord,
} from "./types";

export function skillAgent(id: SkillId): PromptAgent {
  // Skill ID 与提示词 Agent 同名，使用记录、版本覆盖和设置页可以复用同一套机制。
  return id;
}

export async function loadSkillForRun(
  id: SkillId,
  task: string,
  slug: string,
): Promise<SkillManifest> {
  try {
    return await loadSkill(id);
  } catch (error) {
    await recordSkillUsage({
      skillId: id,
      skillVersion: "unknown",
      task,
      status: "error",
      durationMs: 0,
      mode: "local",
      provider: "unknown",
      model: "unknown",
      promptVersion: "unknown",
      errorCode: error instanceof SkillError ? error.code : "UNKNOWN",
      message: errorMessage(error),
    });
    throw error;
  }
}

function classifyError(error: unknown): SkillErrorCode | "UNKNOWN" {
  if (error instanceof SkillError) return error.code;
  if (error instanceof Error && /JSON/u.test(error.message)) {
    return "SKILL_OUTPUT_INVALID";
  }
  return "SKILL_LLM_FAILED";
}

export interface SkillLogContext {
  slug: string;
  manifest: SkillManifest;
  task: string;
  mode: SkillUsageRecord["mode"];
  client?: LLMClient;
  chapter?: number;
  inputChars?: number;
}

// 统一记录 Skill 执行日志：成功、失败、输出不合格都能在「技能」页回看。
// 这里只记录元数据；项目正文与人物档案不写入全局日志。
export async function withSkillLog<T>(
  context: SkillLogContext,
  run: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  const config = getRuntimeConfig();
  const agent = skillAgent(context.manifest.id);
  const promptVersion = promptVersionInfo(agent).promptVersion;
  try {
    const result = await run();
    const outputChars =
      typeof result === "string"
        ? result.length
        : Array.isArray(result)
          ? JSON.stringify(result).length
          : JSON.stringify(result ?? {}).length;
    await recordSkillUsage({
      skillId: context.manifest.id,
      skillVersion: context.manifest.version,
      task: context.task,
      status: "success",
      durationMs: Date.now() - started,
      mode: context.mode,
      provider: config.provider,
      model: config.model,
      promptVersion,
      ...(context.chapter ? { chapter: context.chapter } : {}),
      ...(context.inputChars !== undefined
        ? { inputChars: context.inputChars }
        : {}),
      outputChars,
    });
    return result;
  } catch (error) {
    const code = classifyError(error);
    await recordSkillUsage({
      skillId: context.manifest.id,
      skillVersion: context.manifest.version,
      task: context.task,
      status: "error",
      durationMs: Date.now() - started,
      mode: context.mode,
      provider: config.provider,
      model: config.model,
      promptVersion,
      errorCode: code,
      message: errorMessage(error),
      ...(context.chapter ? { chapter: context.chapter } : {}),
      ...(context.inputChars !== undefined
        ? { inputChars: context.inputChars }
        : {}),
    });
    if (error instanceof SkillError) throw error;
    if (code === "SKILL_OUTPUT_INVALID") {
      throw new SkillError(
        "SKILL_OUTPUT_INVALID",
        `Skill 输出不合格：${errorMessage(error)}`,
      );
    }
    throw new SkillError(
      "SKILL_LLM_FAILED",
      `Skill 模型调用失败：${errorMessage(error)}`,
    );
  }
}

export function resolveClient(client?: LLMClient): LLMClient {
  return client ?? new LLMClient();
}
