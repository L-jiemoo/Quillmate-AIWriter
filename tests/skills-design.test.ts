import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Character } from "@/lib/types";
import type { LLMClient } from "@/lib/llm";

let dataDir: string;
let store: typeof import("@/lib/store");
let design: typeof import("@/lib/skills/design");
let designs: typeof import("@/lib/skills/designs");
let context: typeof import("@/lib/skills/context");
let prompts: typeof import("@/lib/prompts");

const MOCK_CLIENT = { isMock: true } as unknown as LLMClient;

function character(name: string, role: string): Character {
  return {
    name,
    role,
    gender: "男",
    age: "二十岁",
    appearance: "瘦高",
    personality: "谨慎",
    background: "镖局出身",
    goals: "查明旧案",
    arc: "学会信任同伴",
    relationships: "与王五是旧识",
    speechStyle: "话少",
  };
}

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "quillmate-skills-design-"));
  process.env.QUILLMATE_DATA_DIR = dataDir;
  vi.resetModules();
  store = await import("@/lib/store");
  design = await import("@/lib/skills/design");
  designs = await import("@/lib/skills/designs");
  context = await import("@/lib/skills/context");
  prompts = await import("@/lib/prompts");
});

afterEach(async () => {
  vi.resetModules();
  delete process.env.QUILLMATE_DATA_DIR;
  await rm(dataDir, { recursive: true, force: true });
});

async function projectWithCharacters(): Promise<string> {
  const slug = (await store.createProject({ title: "塑造测试", targetChapters: 2 }))
    .meta.slug;
  await store.savePlan(
    slug,
    {
      logline: "主线",
      tags: ["古装"],
      chapters: [
        {
          index: 1,
          title: "旧案",
          summary: "李明与王五在镖局重逢",
          keyBeats: ["李明发现旧刀"],
        },
        { index: 2, title: "追击", summary: "两人追查线索", keyBeats: [] },
      ],
    },
    "# 世界观",
    "# 主线",
  );
  await store.saveCharacters(slug, [
    character("李明", "主角"),
    character("王五", "核心配角"),
  ]);
  return slug;
}

describe("人物塑造 Skill", () => {
  it("基于人物档案生成完整内在设定，并给出差异化建议", async () => {
    const slug = await projectWithCharacters();
    const result = await design.runCharacterDesignSkill(
      slug,
      { characterName: "李明", mode: "design" },
      { client: MOCK_CLIENT },
    );

    expect(result.character).toBe("李明");
    expect(Object.values(result.design).every((value) => value.length >= 4)).toBe(true);
    expect(result.design.habits.length).toBeGreaterThan(8);
    expect(result.similarities.length).toBeGreaterThan(0);
    expect(result.appliedFields).toHaveLength(10);
    expect(result.lockedFields).toEqual([]);
  });

  it("用户锁定字段不会被 AI 覆盖，手动保存会锁定字段", async () => {
    const slug = await projectWithCharacters();
    const first = await design.runCharacterDesignSkill(
      slug,
      { characterName: "李明", mode: "design" },
      { client: MOCK_CLIENT },
    );
    await design.applyCharacterDesign(slug, "李明", first.design);

    const manual = await design.applyCharacterDesign(
      slug,
      "李明",
      { fear: "害怕再被旧案牵连家人" },
      { force: true },
    );
    expect(manual.record.lockedFields).toContain("fear");

    const second = await design.applyCharacterDesign(slug, "李明", {
      fear: "AI 想改掉这个恐惧",
      weakness: "AI 补充的弱点：遇事容易先怀疑同伴",
    });
    expect(second.skipped).toContain("fear");
    expect(second.applied).toContain("weakness");

    const stored = await designs.loadCharacterDesigns(slug);
    expect(stored["李明"].fields.fear).toBe("害怕再被旧案牵连家人");
    expect(stored["李明"].fields.weakness).toContain("怀疑同伴");
  });

  it("写作上下文只注入本章相关人物，并接入 writer 提示词", async () => {
    const slug = await projectWithCharacters();
    const first = await design.runCharacterDesignSkill(
      slug,
      { characterName: "李明", mode: "design" },
      { client: MOCK_CLIENT },
    );
    await design.applyCharacterDesign(slug, "李明", first.design);
    const detail = await store.getProjectDetail(slug);
    const stored = await designs.loadCharacterDesigns(slug);

    const text = context.formatCharacterDesignContext({
      characters: detail.characters,
      designs: stored,
      chapter: detail.plan.chapters[0],
    });
    expect(text).toContain("李明");
    expect(text).not.toContain("王五：");
    expect(text).toContain("欲望");

    const messages = prompts.writerMessages(
      detail.meta,
      detail.bible,
      detail.characters,
      detail.plan.chapters[0],
      "",
      [],
      {
        characterDesignContext: text,
        proseStyleContext: "- 整体文风：简洁克制",
      },
    );
    const body = messages.map((message) => message.content).join("\n");
    expect(body).toContain("相关人物内在设定");
    expect(body).toContain("整体文风：简洁克制");
  });

  it("技能配置损坏时写作上下文明确给出警告而不是静默忽略", async () => {
    const slug = await projectWithCharacters();
    const config = await import("@/lib/skills/config");
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(config.skillConfigPath(slug), "{broken", "utf8"),
    );
    const detail = await store.getProjectDetail(slug);
    const base = await context.loadWritingSkillBase(slug);
    expect(base.warning).toContain("技能配置读取失败");
    expect(context.buildWritingSkillContext(base, detail, detail.plan.chapters[0]))
      .toMatchObject({ designContext: "", proseContext: "" });
  });
});
