import { promises as fs } from "node:fs";
import path from "node:path";
import { writeJsonSafe } from "../storage";
import { nowIso } from "../utils";
import { skillProjectDir } from "./config";
import {
  CHARACTER_DESIGN_FIELDS,
  SkillError,
  type CharacterDesignField,
  type CharacterDesignFields,
  type CharacterDesignPatch,
  type CharacterDesignRecord,
} from "./types";

export const CHARACTER_DESIGNS_FILENAME = "character-designs.json";

export function characterDesignsPath(slug: string): string {
  return path.join(skillProjectDir(slug), CHARACTER_DESIGNS_FILENAME);
}

export function emptyDesignFields(): CharacterDesignFields {
  const fields = {} as CharacterDesignFields;
  for (const key of CHARACTER_DESIGN_FIELDS) fields[key] = "";
  return fields;
}

function isDesignField(value: unknown): value is CharacterDesignField {
  return (
    typeof value === "string" &&
    (CHARACTER_DESIGN_FIELDS as readonly string[]).includes(value)
  );
}

function normalizeFields(raw: unknown): CharacterDesignFields {
  const record = (raw ?? {}) as Record<string, unknown>;
  const fields = emptyDesignFields();
  for (const key of CHARACTER_DESIGN_FIELDS) {
    fields[key] =
      typeof record[key] === "string"
        ? record[key].trim().slice(0, 2000)
        : "";
  }
  return fields;
}

function normalizeRecord(
  raw: unknown,
  fallbackName: string,
): CharacterDesignRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const name =
    typeof record.name === "string" && record.name.trim()
      ? record.name.trim().slice(0, 80)
      : fallbackName;
  if (!name) return null;
  const lockedFields = Array.isArray(record.lockedFields)
    ? [...new Set(record.lockedFields.filter(isDesignField))]
    : [];
  const source =
    record.source === "ai" || record.source === "user" || record.source === "mixed"
      ? record.source
      : "mixed";
  return {
    name,
    fields: normalizeFields(record.fields),
    lockedFields,
    source,
    skillVersion:
      typeof record.skillVersion === "string"
        ? record.skillVersion.slice(0, 40)
        : "",
    updatedAt:
      typeof record.updatedAt === "string" ? record.updatedAt : nowIso(),
  };
}

export async function loadCharacterDesigns(
  slug: string,
): Promise<Record<string, CharacterDesignRecord>> {
  const filePath = characterDesignsPath(slug);
  let raw = "";
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return {};
    }
    throw new SkillError(
      "SKILL_LOAD_FAILED",
      `人物设定文件读取失败：${String(error)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new SkillError(
      "SKILL_LOAD_FAILED",
      `人物设定 JSON 已损坏：${String(error)}`,
    );
  }

  const record = (parsed ?? {}) as Record<string, unknown>;
  const rawDesigns = (record.designs ?? {}) as Record<string, unknown>;
  const designs: Record<string, CharacterDesignRecord> = {};
  for (const [name, value] of Object.entries(rawDesigns)) {
    const normalized = normalizeRecord(value, name);
    if (normalized) designs[normalized.name] = normalized;
  }
  return designs;
}

export async function applyCharacterDesignPatch(
  slug: string,
  patch: CharacterDesignPatch,
  options: { force?: boolean; lockProvided?: boolean } = {},
): Promise<{
  record: CharacterDesignRecord;
  applied: CharacterDesignField[];
  skipped: CharacterDesignField[];
}> {
  const name = patch.name?.trim();
  if (!name) {
    throw new SkillError("SKILL_INPUT_INVALID", "人物姓名不能为空");
  }

  const designs = await loadCharacterDesigns(slug);
  const existing = designs[name];
  const fields = existing ? { ...existing.fields } : emptyDesignFields();
  const locked = new Set(existing?.lockedFields ?? []);
  const applied: CharacterDesignField[] = [];
  const skipped: CharacterDesignField[] = [];

  for (const key of CHARACTER_DESIGN_FIELDS) {
    if (!(key in patch.fields)) continue;
    const value = patch.fields[key];
    if (typeof value !== "string") {
      skipped.push(key);
      continue;
    }
    if (!options.force && locked.has(key)) {
      skipped.push(key);
      continue;
    }
    fields[key] = value.trim().slice(0, 2000);
    applied.push(key);
    // 作者手动保存的字段默认锁定，避免下一次 AI 覆盖。
    if (options.lockProvided) locked.add(key);
  }

  for (const key of patch.unlockFields ?? []) {
    if (isDesignField(key)) locked.delete(key);
  }
  for (const key of patch.lockFields ?? []) {
    if (isDesignField(key)) locked.add(key);
  }

  const record: CharacterDesignRecord = {
    name,
    fields,
    lockedFields: [...locked],
    source: patch.source ?? (options.force ? "user" : "ai"),
    skillVersion: patch.skillVersion ?? existing?.skillVersion ?? "",
    updatedAt: nowIso(),
  };

  const nextList = {
    ...designs,
    [name]: record,
  };
  await writeJsonSafe(
    characterDesignsPath(slug),
    {
      version: 1,
      designs: nextList,
      updatedAt: record.updatedAt,
    },
    {
      backup: {
        dir: path.join(skillProjectDir(slug), "backups"),
        name: CHARACTER_DESIGNS_FILENAME,
        keep: 20,
      },
    },
  );

  return { record, applied, skipped };
}
