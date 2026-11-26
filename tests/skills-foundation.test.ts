import { promises as fs } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dataDir: string;
let store: typeof import("@/lib/store");
let loader: typeof import("@/lib/skills/loader");
let config: typeof import("@/lib/skills/config");

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "quillmate-skills-foundation-"));
  process.env.QUILLMATE_DATA_DIR = dataDir;
  vi.resetModules();
  store = await import("@/lib/store");
  loader = await import("@/lib/skills/loader");
  config = await import("@/lib/skills/config");
  loader.__resetSkillLoaderForTests();
});

afterEach(async () => {
  vi.resetModules();
  delete process.env.QUILLMATE_DATA_DIR;
  await rm(dataDir, { recursive: true, force: true });
});

async function project(title = "技能基础"): Promise<string> {
  return (await store.createProject({ title, targetChapters: 3 })).meta.slug;
}

describe("Skill 加载器", () => {
  it("加载三个内置 Skill，并解析版本、任务、触发条件与指令", async () => {
    const ids = ["character-naming", "character-design", "prose-style"] as const;
    for (const id of ids) {
      const manifest = await loader.loadSkill(id);
      expect(manifest.id).toBe(id);
      expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/u);
      expect(manifest.name.length).toBeGreaterThan(2);
      expect(manifest.tasks.length).toBeGreaterThan(0);
      expect(manifest.triggers.length).toBeGreaterThan(0);
      expect(manifest.qualityRules.length).toBeGreaterThan(0);
      expect(manifest.instructions.length).toBeGreaterThan(200);
      expect(manifest.instructions).not.toContain("李汉");
    }

    const catalog = await loader.listSkillCatalog();
    expect(catalog).toHaveLength(3);
    expect(catalog.every((item) => item.available)).toBe(true);
  });

  it("未知 Skill 与损坏的 SKILL.md 会明确报错", async () => {
    await expect(loader.loadSkill("unknown-skill")).rejects.toMatchObject({
      code: "SKILL_NOT_FOUND",
    });

    const baseDir = path.join(dataDir, "custom-skills");
    await mkdir(path.join(baseDir, "character-naming"), { recursive: true });
    await fs.writeFile(
      path.join(baseDir, "character-naming", "SKILL.md"),
      `---\nid: prose-style\nname: 错误\nversion: 1.0\n---\n\n太短`,
      "utf8",
    );
    // 不想依赖类实例：模块在 beforeEach 里重新加载后，静态导入的 SkillError
    // 与 loader 实际抛出的构造函数不是同一个引用，只能校验错误名与错误码。
    await expect(
      loader.loadSkill("character-naming", { baseDir }),
    ).rejects.toMatchObject({ name: "SkillError" });
    await expect(
      loader.loadSkill("character-naming", { baseDir }),
    ).rejects.toMatchObject({ code: "SKILL_LOAD_FAILED" });
  });
});

describe("项目级技能配置", () => {
  it("旧项目没有 skills.json 时使用默认配置", async () => {
    const slug = await project();
    const defaults = await config.readProjectSkillConfig(slug);
    expect(defaults.enabled).toEqual({
      "character-naming": true,
      "character-design": true,
      "prose-style": true,
    });
    expect(defaults.naming.style).toBe("natural");
    expect(defaults.prose.style).toBe("natural");
    await expect(fs.access(config.skillConfigPath(slug))).rejects.toBeTruthy();
  });

  it("保存开关、命名禁用项与文风设置后可重新读取", async () => {
    const slug = await project();
    const saved = await config.saveProjectSkillConfig(slug, {
      enabled: { "prose-style": false },
      naming: {
        style: "literary",
        forbiddenNames: ["张三", "张三", ""],
        forbiddenStyles: ["古风复姓"],
      },
      prose: {
        style: "concise",
        sentenceLength: "short",
        dialogueRatio: "high",
        bannedExpressions: ["不由得"],
      },
    });

    expect(saved.enabled["prose-style"]).toBe(false);
    expect(saved.naming.forbiddenNames).toEqual(["张三"]);
    expect(saved.prose.sentenceLength).toBe("short");

    const reloaded = await config.readProjectSkillConfig(slug);
    expect(reloaded).toEqual(saved);

    // assertSkillEnabled 是同步校验函数，直接断言抛出而不是用 rejects。
    let disabledError: unknown;
    try {
      config.assertSkillEnabled(reloaded, "prose-style");
    } catch (error) {
      disabledError = error;
    }
    expect(disabledError).toMatchObject({ code: "SKILL_DISABLED" });
  });

  it("损坏的 skills.json 不会被静默当成默认配置", async () => {
    const slug = await project();
    await fs.mkdir(path.dirname(config.skillConfigPath(slug)), { recursive: true });
    await fs.writeFile(config.skillConfigPath(slug), "{oops", "utf8");
    await expect(config.readProjectSkillConfig(slug)).rejects.toMatchObject({
      code: "SKILL_LOAD_FAILED",
    });
  });
});
