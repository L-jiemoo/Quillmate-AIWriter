import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Character } from "@/lib/types";

let dataDir: string;
let store: typeof import("@/lib/store");
let rename: typeof import("@/lib/skills/rename");
let route: typeof import("@/app/api/projects/[slug]/skills/naming/rename/route");

function character(name: string): Character {
  return {
    name,
    role: "主角",
    gender: "男",
    age: "二十岁",
    appearance: "",
    personality: "",
    background: "",
    goals: "",
    arc: "",
    relationships: "",
    speechStyle: "",
  };
}

function request(body: unknown): Request {
  return new Request("http://localhost/api/projects/demo/skills/naming/rename", {
    method: "POST",
    headers: { "Content-Type": "application/json", Host: "localhost" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "quillmate-skills-rename-"));
  process.env.QUILLMATE_DATA_DIR = dataDir;
  await fs.writeFile(
    path.join(dataDir, "settings.json"),
    JSON.stringify({
      provider: "mock",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
      apiKey: "",
      temperature: 0.8,
      maxTokens: 8192,
      storyContextChars: 4000,
      repairModel: "",
    }),
    "utf8",
  );
  vi.resetModules();
  store = await import("@/lib/store");
  rename = await import("@/lib/skills/rename");
  route = await import(
    "@/app/api/projects/[slug]/skills/naming/rename/route"
  );
});

afterEach(async () => {
  vi.resetModules();
  delete process.env.QUILLMATE_DATA_DIR;
  await rm(dataDir, { recursive: true, force: true });
});

async function project(): Promise<string> {
  const slug = (
    await store.createProject({ title: "改名测试", targetChapters: 2 })
  ).meta.slug;
  await store.savePlan(
    slug,
    {
      logline: "李明追查铜钱案",
      tags: ["悬疑"],
      chapters: [
        { index: 1, title: "夜行", summary: "李明夜行", keyBeats: ["李明发现铜钱"] },
        { index: 2, title: "追踪", summary: "李明跟踪线索", keyBeats: [] },
      ],
    },
    "# 世界观\n\n李明所在的县城。",
    "# 主线\n\n李明查案。",
  );
  // 刻意放一个包含「李明」的更长姓名，验证替换不会把它改坏。
  await store.saveCharacters(slug, [character("李明"), character("李明华")]);
  await store.saveCanon(slug, {
    characters: [
      {
        name: "李明",
        aliases: ["明哥"],
        status: "alive",
        location: "县城",
        note: "",
        statusChapter: 1,
        chapter: 1,
      },
    ],
    items: [],
    timeline: { currentDay: "第一日", deadlines: [] },
    rules: [],
    lastChapter: 1,
    updatedAt: new Date().toISOString(),
  });
  await store.saveChapter(
    slug,
    1,
    "李明不由得停住脚步。李明华看了他一眼，明哥没有说话。\n\n李明看见3枚铜钱。",
    "夜行",
  );
  await store.saveChapter(slug, 2, "夜色里，李明回头。", "追踪");
  return slug;
}

describe("全书改名", () => {
  it("预演只统计影响范围，不修改任何文件", async () => {
    const slug = await project();
    const report = await rename.renameCharacterEverywhere(slug, {
      from: "李明",
      to: "张伟",
      dryRun: true,
    });

    expect(report.applied).toBe(false);
    expect(report.known).toBe(true);
    // 第 1 章 2 次、第 2 章 1 次，「李明华」不计入。
    expect(report.totals.occurrences).toBe(3);
    expect(report.totals.chapters).toBe(2);
    expect(report.chapters.map((item) => item.index)).toEqual([1, 2]);

    const detail = await store.getProjectDetail(slug);
    expect(detail.characters.map((item) => item.name)).toContain("李明");
    expect(detail.chapters[0].content).toContain("李明");
    expect(detail.chapters[0].content).not.toContain("张伟");
  });

  it("执行后正文、人物档案与事实台账同步改名，且不破坏更长的人名", async () => {
    const slug = await project();
    const report = await rename.renameCharacterEverywhere(slug, {
      from: "李明",
      to: "张伟",
    });
    expect(report.applied).toBe(true);

    const detail = await store.getProjectDetail(slug);
    expect(detail.chapters[0].content).toContain("张伟不由得停住脚步");
    expect(detail.chapters[0].content).toContain("李明华看了他一眼");
    expect(detail.chapters[0].content).not.toContain("李明由");
    expect(detail.chapters[1].content).toContain("张伟回头");

    expect(detail.characters.map((item) => item.name)).toEqual([
      "张伟",
      "李明华",
    ]);
    expect(detail.canon.characters[0].name).toBe("张伟");
    expect(detail.plan.chapters[0].summary).toContain("张伟");
    expect(detail.plan.logline).toContain("张伟");
    expect(detail.bible).toContain("张伟");
    expect(detail.outlineMd).toContain("张伟");

    const versions = await store.listChapterVersions(slug, 1);
    expect(versions.length).toBeGreaterThan(0);
  });

  it("人物卡已改名、正文仍是旧名时也能把正文同步过来", async () => {
    const slug = await project();
    // 模拟用户只在人物卡里把「李明」改成了「张伟」。
    const before = await store.getProjectDetail(slug);
    await store.saveCharacters(
      slug,
      before.characters.map((item) =>
        item.name === "李明" ? { ...item, name: "张伟" } : item,
      ),
    );

    const report = await rename.renameCharacterEverywhere(slug, {
      from: "李明",
      to: "张伟",
    });
    expect(report.applied).toBe(true);
    // 人物卡里已经没有旧名，属于“补同步正文”场景。
    expect(report.totals.occurrences).toBe(3);

    const after = await store.getProjectDetail(slug);
    expect(after.chapters[0].content).toContain("张伟不由得停住脚步");
    expect(after.chapters[0].content).not.toContain("李明由");
    expect(after.chapters[0].content).toContain("李明华");
    expect(after.characters.map((item) => item.name)).toEqual([
      "张伟",
      "李明华",
    ]);
    expect(report.warnings.join(" ")).toContain("已经找不到");
  });

  it("新姓名与现有角色冲突时拒绝执行", async () => {
    const slug = await project();
    await expect(
      rename.renameCharacterEverywhere(slug, { from: "李明", to: "李明华" }),
    ).rejects.toMatchObject({ code: "SKILL_INPUT_INVALID" });

    const detail = await store.getProjectDetail(slug);
    expect(detail.characters.map((item) => item.name)).toEqual(["李明", "李明华"]);
  });

  it("改名后润色的人名保护会跟随新名字", async () => {
    const slug = await project();
    await rename.renameCharacterEverywhere(slug, { from: "李明", to: "张伟" });

    const prose = await import("@/lib/skills/prose");
    const detail = await store.getProjectDetail(slug);
    const original = detail.chapters[0].content;
    // 模型把新名字全换成代词：服务端应判定事实项丢失，强制人工复核。
    const fakeClient = {
      isMock: false,
      json: async () => ({
        optimized: original.replace(/张伟/gu, "他"),
        changes: [
          { type: "wording", excerpt: "张伟", reason: "测试：人名替换为代词" },
        ],
        factCheck: { unchanged: true, issues: [] },
        recommendation: "accept",
        warnings: [],
      }),
    } as unknown as import("@/lib/llm").LLMClient;

    const result = await prose.runProseSkill(
      slug,
      { index: 1 },
      { client: fakeClient },
    );
    expect(result.factCheck.unchanged).toBe(false);
    expect(result.factCheck.issues.some((item) => item.term === "张伟")).toBe(
      true,
    );
    expect(result.recommendation).toBe("review");
  });

  it("路由在不带 confirm 时拒绝执行，带 confirm 时才真正写入", async () => {
    const slug = await project();

    const blocked = await route.POST(request({ from: "李明", to: "张伟" }), {
      params: Promise.resolve({ slug }),
    });
    expect(blocked.status).toBe(400);
    const blockedData = (await blocked.json()) as { error?: string };
    expect(blockedData.error).toContain("二次确认");

    const preview = await route.POST(
      request({ from: "李明", to: "张伟", dryRun: true }),
      { params: Promise.resolve({ slug }) },
    );
    expect(preview.status).toBe(200);

    const applied = await route.POST(
      request({ from: "李明", to: "张伟", confirm: true }),
      { params: Promise.resolve({ slug }) },
    );
    expect(applied.status).toBe(200);
    const detail = await store.getProjectDetail(slug);
    expect(detail.chapters[0].content).toContain("张伟");
  });
});
