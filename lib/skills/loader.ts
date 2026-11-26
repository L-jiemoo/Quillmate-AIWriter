import { promises as fs, statSync } from "node:fs";
import path from "node:path";
import {
  isSkillId,
  SKILL_IDS,
  SkillError,
  type SkillCatalogItem,
  type SkillId,
  type SkillManifest,
} from "./types";

export const SKILLS_DIR = process.env.QUILLMATE_SKILLS_DIR?.trim()
  ? path.resolve(process.env.QUILLMATE_SKILLS_DIR.trim())
  : path.join(process.cwd(), "skills");

interface SkillCacheEntry {
  mtimeMs: number;
  size: number;
  manifest: SkillManifest;
}

const cache = new Map<string, SkillCacheEntry>();

export function skillFilePath(id: SkillId, baseDir = SKILLS_DIR): string {
  return path.join(baseDir, id, "SKILL.md");
}

function requiredText(
  meta: Record<string, string>,
  key: string,
  filePath: string,
): string {
  const value = meta[key]?.trim() ?? "";
  if (!value) {
    throw new SkillError(
      "SKILL_LOAD_FAILED",
      `Skill 文件缺少必填字段 ${key}：${filePath}`,
    );
  }
  return value;
}

function listValue(
  meta: Record<string, string>,
  key: string,
  filePath: string,
): string[] {
  const raw = requiredText(meta, key, filePath);
  const items = raw
    .split(/[,，;；]/u)
    .map((item) => item.trim())
    .filter(Boolean);
  if (!items.length) {
    throw new SkillError(
      "SKILL_LOAD_FAILED",
      `Skill 字段 ${key} 不能为空：${filePath}`,
    );
  }
  return [...new Set(items)];
}

export function parseSkillDocument(
  raw: string,
  expectedId: SkillId,
  filePath: string,
): SkillManifest {
  const normalized = raw.replace(/^\uFEFF/u, "").trim();
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(normalized);
  if (!match) {
    throw new SkillError(
      "SKILL_LOAD_FAILED",
      `Skill 文件缺少合法的 YAML frontmatter：${filePath}`,
    );
  }

  const meta: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) {
      throw new SkillError(
        "SKILL_LOAD_FAILED",
        `Skill frontmatter 行格式不合法：${line.trim()}`,
      );
    }
    const key = line.slice(0, colon).trim();
    const value = line
      .slice(colon + 1)
      .trim()
      .replace(/^['"]|['"]$/gu, "");
    meta[key] = value;
  }

  const id = requiredText(meta, "id", filePath);
  if (!isSkillId(id) || id !== expectedId) {
    throw new SkillError(
      "SKILL_LOAD_FAILED",
      `Skill ID 与目录不一致：期望 ${expectedId}，文件写的是 ${id || "空"}`,
    );
  }
  const version = requiredText(meta, "version", filePath);
  if (!/^\d+\.\d+\.\d+$/u.test(version)) {
    throw new SkillError(
      "SKILL_LOAD_FAILED",
      `Skill 版本号必须是 x.y.z：${filePath}`,
    );
  }
  const description = requiredText(meta, "description", filePath);
  if (description.length < 10) {
    throw new SkillError(
      "SKILL_LOAD_FAILED",
      `Skill 功能描述过短，无法作为可维护清单：${filePath}`,
    );
  }

  const instructions = match[2].trim();
  if (instructions.length < 200) {
    throw new SkillError(
      "SKILL_LOAD_FAILED",
      `Skill 指令正文过短（至少 200 字）：${filePath}`,
    );
  }

  return {
    id,
    name: requiredText(meta, "name", filePath),
    version,
    description,
    tasks: listValue(meta, "tasks", filePath),
    triggers: listValue(meta, "triggers", filePath),
    inputs: listValue(meta, "inputs", filePath),
    outputs: listValue(meta, "outputs", filePath),
    qualityRules: listValue(meta, "qualityRules", filePath),
    errorHandling: listValue(meta, "errorHandling", filePath),
    instructions,
    path: filePath,
  };
}

export async function loadSkill(
  id: unknown,
  options: { baseDir?: string; noCache?: boolean } = {},
): Promise<SkillManifest> {
  if (!isSkillId(id)) {
    throw new SkillError("SKILL_NOT_FOUND", `未知 Skill：${String(id)}`);
  }
  const filePath = skillFilePath(id, options.baseDir ?? SKILLS_DIR);
  let stat: { mtimeMs: number; size: number };
  try {
    const info = statSync(filePath);
    stat = { mtimeMs: info.mtimeMs, size: info.size };
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
    if (code === "ENOENT") {
      throw new SkillError(
        "SKILL_NOT_FOUND",
        `Skill 文件不存在：${filePath}`,
      );
    }
    throw new SkillError(
      "SKILL_LOAD_FAILED",
      `Skill 文件无法读取：${filePath}`,
    );
  }

  const cached = cache.get(filePath);
  if (
    !options.noCache &&
    cached &&
    cached.mtimeMs === stat.mtimeMs &&
    cached.size === stat.size
  ) {
    return cached.manifest;
  }

  let raw = "";
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    throw new SkillError(
      "SKILL_LOAD_FAILED",
      `Skill 文件读取失败：${filePath}（${String(error)}）`,
    );
  }
  const manifest = parseSkillDocument(raw, id, filePath);
  cache.set(filePath, { ...stat, manifest });
  return manifest;
}

export async function listSkillCatalog(
  options: { baseDir?: string } = {},
): Promise<SkillCatalogItem[]> {
  const items: SkillCatalogItem[] = [];
  for (const id of SKILL_IDS) {
    try {
      const manifest = await loadSkill(id, options);
      items.push({
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        tasks: manifest.tasks,
        triggers: manifest.triggers,
        inputs: manifest.inputs,
        outputs: manifest.outputs,
        qualityRules: manifest.qualityRules,
        errorHandling: manifest.errorHandling,
        available: true,
      });
    } catch (error) {
      // 单个 Skill 损坏不能影响其他 Skill 的展示；这里显式记录不可用原因。
      items.push({
        id,
        name: id,
        version: "unknown",
        description: "",
        tasks: [],
        triggers: [],
        inputs: [],
        outputs: [],
        qualityRules: [],
        errorHandling: [],
        available: false,
        error:
          error instanceof SkillError
            ? error.message
            : `Skill 加载失败：${String(error)}`,
      });
    }
  }
  return items;
}

export function __resetSkillLoaderForTests(): void {
  cache.clear();
}
