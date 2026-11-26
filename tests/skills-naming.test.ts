import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Character } from "@/lib/types";
import type { LLMClient } from "@/lib/llm";
import type { BatchNamingResult, NamingResult } from "@/lib/skills/types";

let dataDir: string;
let store: typeof import("@/lib/store");
let naming: typeof import("@/lib/skills/naming");
let config: typeof import("@/lib/skills/config");

const MOCK_CLIENT = { isMock: true } as unknown as LLMClient;

function character(name: string, role = "配角"): Character {
  return {
    name,
    role,
    gender: "",
    age: "",
    appearance: "",
    personality: "",
    background: "",
    goals: "",
    arc: "",
    relationships: "",
    speechStyle: "",
  };
}

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "quillmate-skills-naming-"));
  process.env.QUILLMATE_DATA_DIR = dataDir;
  vi.resetModules();
  store = await import("@/lib/store");
  naming = await import("@/lib/skills/naming");
  config = await import("@/lib/skills/config");
});

afterEach(async () => {
  vi.resetModules();
  delete process.env.QUILLMATE_DATA_DIR;
  await rm(dataDir, { recursive: true, force: true });
});

async function projectWithCharacters(names: string[]): Promise<string> {
  const slug = (await store.createProject({ title: "命名测试", targetChapters: 2 }))
    .meta.slug;
  await store.savePlan(
    slug,
    {
      logline: "主线",
      tags: ["现代"],
      chapters: [
        { index: 1, title: "开端", summary: "开端", keyBeats: [] },
        { index: 2, title: "转折", summary: "转折", keyBeats: [] },
      ],
    },
    "# 世界观",
    "# 主线",
  );
  if (names.length) {
    await store.saveCharacters(slug, names.map((name) => character(name)));
  }
  return slug;
}

describe("人物命名 Skill", () => {
  it("生成至少 20 个候选并返回前 5 个，带分项评分依据", async () => {
    const slug = await projectWithCharacters(["李明"]);
    const result = (await naming.runNamingSkill(
      slug,
      {
        task: "generate",
        role: {
          role: "主角",
          gender: "男",
          age: "二十岁",
          identity: "旧城修表匠",
          background: "父母早逝，由外婆带大",
        },
        style: "natural",
        count: 20,
      },
      { client: MOCK_CLIENT },
    )) as NamingResult;

    expect(result.candidates).toHaveLength(5);
    expect(result.generatedCount).toBeGreaterThanOrEqual(20);
    expect(result.recommendation).toBe(result.candidates[0].name);
    expect(result.existingNames).toContain("李明");
    expect(result.candidates.map((item) => item.name)).not.toContain("李明");

    for (const candidate of result.candidates) {
      expect(candidate.score).toBeGreaterThan(0);
      expect(candidate.score).toBeLessThanOrEqual(100);
      expect(candidate.score).toBe(
        Object.values(candidate.breakdown).reduce((sum, value) => sum + value, 0),
      );
      expect(candidate.scoreEvidence.length).toBeGreaterThan(10);
      expect(candidate.breakdown.background).toBeLessThanOrEqual(25);
      expect(candidate.breakdown.era).toBeLessThanOrEqual(20);
    }
  });

  it("已有名字、禁用名字和锁定名字不会出现在候选里", async () => {
    const slug = await projectWithCharacters(["李明"]);
    await config.saveProjectSkillConfig(slug, {
      naming: { forbiddenNames: ["沈归舟"] },
    });

    const result = (await naming.runNamingSkill(
      slug,
      {
        task: "generate",
        role: { role: "配角" },
        lockedNames: ["陆知微"],
        count: 20,
      },
      { client: MOCK_CLIENT },
    )) as NamingResult;

    const names = result.candidates.map((item) => item.name);
    expect(names).not.toContain("李明");
    expect(names).not.toContain("沈归舟");
    expect(names).not.toContain("陆知微");
  });

  it("模型返回重名候选时会过滤并记录警告", async () => {
    const slug = await projectWithCharacters(["李明"]);
    const valid = (name: string) => ({
      name,
      type: "本名",
      style: "自然真实",
      reason: "符合人物背景",
      risks: [],
      similarityWarnings: [],
      breakdown: {
        background: 20,
        era: 15,
        distinctiveness: 15,
        naturalness: 12,
        uniqueness: 8,
        styleFit: 8,
      },
      scoreEvidence: "背景 20/25：符合身份；其余维度按项目内区分度评估。",
    });
    const fakeClient = {
      isMock: false,
      json: async () => ({
        candidates: [
          valid("李明"),
          valid("沈归舟"),
          valid("顾清和"),
          valid("江晚照"),
          valid("裴行简"),
          valid("温书宁"),
          valid("谢临渊"),
        ],
      }),
    } as unknown as LLMClient;

    const result = (await naming.runNamingSkill(
      slug,
      { task: "generate", role: { role: "主角" } },
      { client: fakeClient },
    )) as NamingResult;

    const names = result.candidates.map((item) => item.name);
    expect(names).not.toContain("李明");
    expect(result.warnings.join("\n")).toContain("已过滤");
    expect(result.candidates).toHaveLength(5);
  });

  it("相似度检查能识别完全重名、近音与一字之差", () => {
    const result = naming.checkNames([
      { name: "李明", source: "人物档案" },
      { name: "李明", source: "事实台账" },
      { name: "李鸣", source: "人物档案" },
      { name: "李铭", source: "人物档案" },
      { name: "周芷若", source: "人物档案" },
      { name: "周若", source: "人物档案" },
    ]);

    expect(result.checked).toBe(5);
    expect(result.duplicates[0]).toMatchObject({ name: "李明" });
    expect(
      result.similar.some(
        (item) =>
          (item.name === "李明" && item.other === "李鸣") ||
          (item.name === "李鸣" && item.other === "李明"),
      ),
    ).toBe(true);
    expect(result.similar.some((item) => item.level === "high")).toBe(true);
  });

  it("全书撞名检查会读取人物档案", async () => {
    const slug = await projectWithCharacters(["李明", "李鸣", "沈归舟"]);
    const result = await naming.checkProjectNames(slug);
    expect(result.checked).toBeGreaterThanOrEqual(3);
    expect(result.similar.length).toBeGreaterThan(0);
  });

  it("批量命名不会在不同角色之间重复使用同一个名字", async () => {
    const slug = await projectWithCharacters(["李明"]);
    const result = (await naming.runNamingSkill(
      slug,
      {
        task: "batch",
        count: 20,
        roles: [
          { role: "主角", gender: "男", identity: "捕快" },
          { role: "反派", gender: "女", identity: "商会主事" },
        ],
      },
      { client: MOCK_CLIENT },
    )) as BatchNamingResult;

    expect(result.results).toHaveLength(2);
    const first = result.results[0].candidates.map((item) => item.name);
    const second = result.results[1].candidates.map((item) => item.name);
    expect(first).toHaveLength(5);
    expect(second).toHaveLength(5);
    expect(first.filter((name) => second.includes(name))).toEqual([]);
    expect([...first, ...second]).not.toContain("李明");
  });

  it("模型输出候选不足或 JSON 非法时明确报错", async () => {
    const slug = await projectWithCharacters([]);
    const emptyClient = {
      isMock: false,
      json: async () => ({ candidates: [] }),
    } as unknown as LLMClient;
    await expect(
      naming.runNamingSkill(
        slug,
        { task: "generate", role: { role: "主角" } },
        { client: emptyClient },
      ),
    ).rejects.toMatchObject({ code: "SKILL_OUTPUT_INVALID" });

    const badJsonClient = {
      isMock: false,
      json: async () => {
        throw new Error("模型连续两次返回了不合法的 JSON。");
      },
    } as unknown as LLMClient;
    await expect(
      naming.runNamingSkill(
        slug,
        { task: "generate", role: { role: "主角" } },
        { client: badJsonClient },
      ),
    ).rejects.toMatchObject({ code: "SKILL_OUTPUT_INVALID" });
  });

  it("禁用技能后拒绝调用", async () => {
    const slug = await projectWithCharacters([]);
    await config.saveProjectSkillConfig(slug, {
      enabled: { "character-naming": false },
    });
    await expect(
      naming.runNamingSkill(
        slug,
        { task: "generate", role: { role: "主角" } },
        { client: MOCK_CLIENT },
      ),
    ).rejects.toMatchObject({ code: "SKILL_DISABLED" });
  });
});
