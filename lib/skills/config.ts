import { promises as fs } from "node:fs";
import path from "node:path";
import { PROJECTS_DIR } from "../config";
import { writeJsonSafe, type BackupOptions } from "../storage";
import { isSafeSlug, nowIso } from "../utils";
import {
  NAMING_STYLES,
  PROSE_STYLES,
  SkillError,
  type NamingStyle,
  type ProsePace,
  type ProseRatio,
  type ProseSentenceLength,
  type ProseStyle,
  type ProseStyleConfig,
  type ProjectSkillConfig,
  type SkillId,
} from "./types";

export const SKILL_CONFIG_FILENAME = "skills.json";

export function skillProjectDir(slug: string): string {
  if (!isSafeSlug(slug)) {
    throw new SkillError("SKILL_INPUT_INVALID", "项目标识不合法");
  }
  return path.join(PROJECTS_DIR, slug);
}

export function skillConfigPath(slug: string): string {
  return path.join(skillProjectDir(slug), SKILL_CONFIG_FILENAME);
}

function skillBackup(slug: string): BackupOptions {
  return {
    dir: path.join(skillProjectDir(slug), "backups"),
    name: SKILL_CONFIG_FILENAME,
    keep: 20,
  };
}

export function defaultProjectSkillConfig(): ProjectSkillConfig {
  return {
    version: 1,
    enabled: {
      "character-naming": true,
      "character-design": true,
      "prose-style": true,
    },
    naming: {
      style: "natural",
      customStyle: "",
      forbiddenNames: [],
      forbiddenStyles: [],
    },
    prose: {
      style: "natural",
      customStyle: "",
      sentenceLength: "mixed",
      descriptionDensity: "medium",
      dialogueRatio: "medium",
      psychologyRatio: "medium",
      environmentRatio: "medium",
      pace: "medium",
      bannedExpressions: [],
      preferredExpressions: [],
      autoSuggestAfterWrite: false,
    },
    updatedAt: nowIso(),
  };
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function textList(value: unknown, maxItems = 200, maxLength = 60): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const items: string[] = [];
  for (const item of value) {
    const normalized = text(item, maxLength);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    items.push(normalized);
    if (items.length >= maxItems) break;
  }
  return items;
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

export function normalizeProseStyleConfig(raw: unknown): ProseStyleConfig {
  const record = (raw ?? {}) as Record<string, unknown>;
  const defaults = defaultProjectSkillConfig().prose;
  const style = oneOf<ProseStyle>(
    record.style,
    PROSE_STYLES.map((item) => item.value),
    defaults.style,
  );
  return {
    style,
    customStyle: text(record.customStyle, 2000),
    sentenceLength: oneOf<ProseSentenceLength>(
      record.sentenceLength,
      ["short", "medium", "long", "mixed"],
      defaults.sentenceLength,
    ),
    descriptionDensity: oneOf<ProseRatio>(
      record.descriptionDensity,
      ["low", "medium", "high"],
      defaults.descriptionDensity,
    ),
    dialogueRatio: oneOf<ProseRatio>(
      record.dialogueRatio,
      ["low", "medium", "high"],
      defaults.dialogueRatio,
    ),
    psychologyRatio: oneOf<ProseRatio>(
      record.psychologyRatio,
      ["low", "medium", "high"],
      defaults.psychologyRatio,
    ),
    environmentRatio: oneOf<ProseRatio>(
      record.environmentRatio,
      ["low", "medium", "high"],
      defaults.environmentRatio,
    ),
    pace: oneOf<ProsePace>(
      record.pace,
      ["slow", "medium", "fast"],
      defaults.pace,
    ),
    bannedExpressions: textList(record.bannedExpressions),
    preferredExpressions: textList(record.preferredExpressions),
    autoSuggestAfterWrite: record.autoSuggestAfterWrite === true,
  };
}

export function normalizeProjectSkillConfig(
  raw: unknown,
): ProjectSkillConfig {
  const record = (raw ?? {}) as Record<string, unknown>;
  const defaults = defaultProjectSkillConfig();
  const rawEnabled = (record.enabled ?? {}) as Record<string, unknown>;
  const rawNaming = (record.naming ?? {}) as Record<string, unknown>;
  const namingStyle = oneOf<NamingStyle>(
    rawNaming.style,
    NAMING_STYLES.map((item) => item.value),
    defaults.naming.style,
  );

  const enabled = {} as Record<SkillId, boolean>;
  for (const id of Object.keys(defaults.enabled) as SkillId[]) {
    enabled[id] = rawEnabled[id] !== false;
  }

  return {
    version: 1,
    enabled,
    naming: {
      style: namingStyle,
      customStyle: text(rawNaming.customStyle, 2000),
      forbiddenNames: textList(rawNaming.forbiddenNames),
      forbiddenStyles: textList(rawNaming.forbiddenStyles),
    },
    prose: normalizeProseStyleConfig(record.prose),
    updatedAt: text(record.updatedAt, 40) || nowIso(),
  };
}

export async function readProjectSkillConfig(
  slug: string,
): Promise<ProjectSkillConfig> {
  const filePath = skillConfigPath(slug);
  let raw = "";
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      // 旧项目没有 skills.json，直接使用默认配置，不写文件、不做迁移。
      return defaultProjectSkillConfig();
    }
    throw new SkillError(
      "SKILL_LOAD_FAILED",
      `技能配置读取失败：${String(error)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new SkillError(
      "SKILL_LOAD_FAILED",
      `技能配置 JSON 已损坏：${String(error)}`,
    );
  }
  return normalizeProjectSkillConfig(parsed);
}

export async function saveProjectSkillConfig(
  slug: string,
  patch: unknown,
): Promise<ProjectSkillConfig> {
  const current = await readProjectSkillConfig(slug);
  const record = (patch ?? {}) as Record<string, unknown>;
  const next = normalizeProjectSkillConfig({
    ...current,
    ...record,
    enabled: { ...current.enabled, ...((record.enabled ?? {}) as object) },
    naming: { ...current.naming, ...((record.naming ?? {}) as object) },
    prose: { ...current.prose, ...((record.prose ?? {}) as object) },
    updatedAt: nowIso(),
  });
  await writeJsonSafe(skillConfigPath(slug), next, {
    backup: skillBackup(slug),
  });
  return next;
}

export function assertSkillEnabled(
  config: ProjectSkillConfig,
  id: SkillId,
): void {
  if (!config.enabled[id]) {
    throw new SkillError(
      "SKILL_DISABLED",
      `「${id}」Skill 已在项目设置中禁用，请先在「技能」页启用`,
    );
  }
}
