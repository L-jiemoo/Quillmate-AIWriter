import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Character, Job } from "@/lib/types";

const agentState = vi.hoisted(() => ({
  failCharacters: false,
  badPlan: false,
}));

vi.mock("../lib/agents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/agents")>();
  return {
    ...actual,
    generatePlan: async (meta: Parameters<typeof actual.generatePlan>[0]) => {
      if (agentState.badPlan) {
        return {
          plan: {
            logline: "坏大纲",
            tags: [],
            chapters: [
              { index: 1, title: "开端", summary: "一", keyBeats: [] },
              { index: 1, title: "重复", summary: "二", keyBeats: [] },
              { index: 2, title: "后续", summary: "三", keyBeats: [] },
            ],
          },
          bible: "# 新世界观",
          outlineMd: "# 新主线大纲",
        };
      }
      return actual.generatePlan(meta);
    },
    generateCharacters: async (
      ...args: Parameters<typeof actual.generateCharacters>
    ) => {
      if (agentState.failCharacters) throw new Error("模拟角色生成失败");
      return actual.generateCharacters(...args);
    },
  };
});

let dataDir: string;
let store: typeof import("@/lib/store");
let pipeline: typeof import("@/lib/pipeline");
let jobs: typeof import("@/lib/jobs");

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "quillmate-architecture-"));
  process.env.QUILLMATE_DATA_DIR = dataDir;
  agentState.failCharacters = false;
  agentState.badPlan = false;
  vi.resetModules();
  store = await import("@/lib/store");
  pipeline = await import("@/lib/pipeline");
  jobs = await import("@/lib/jobs");
  jobs.__reloadJobStoreForTests();
});

afterEach(async () => {
  vi.resetModules();
  delete process.env.QUILLMATE_DATA_DIR;
  await rm(dataDir, { recursive: true, force: true });
});

async function waitForJob(id: string): Promise<Job> {
  const deadline = Date.now() + 20000;
  for (;;) {
    const job = jobs.getJob(id);
    if (job && ["done", "error", "paused", "cancelled"].includes(job.status)) return job;
    if (Date.now() > deadline) throw new Error(`等待任务 ${id} 超时`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function projectPath(slug: string): string {
  return path.join(dataDir, "projects", slug);
}

async function readProjectFiles(slug: string): Promise<Record<string, string>> {
  const names = [
    "plan.json",
    "world.md",
    "outline.md",
    "characters.json",
    "project.json",
    "canon.json",
  ];
  const entries = await Promise.all(
    names.map(async (name) => [
      name,
      await fs.readFile(path.join(projectPath(slug), name), "utf8"),
    ]),
  );
  return Object.fromEntries(entries);
}

describe("架构统一提交", () => {
  it("人物生成失败时，大纲、世界观、主线大纲和人物卡都保持原样", async () => {
    const slug = (await store.createProject({ title: "统一提交" })).meta.slug;
    await store.savePlan(
      slug,
      {
        logline: "旧故事",
        tags: [],
        chapters: [
          { index: 1, title: "旧章", summary: "旧摘要", keyBeats: [] },
        ],
      },
      "# 旧世界观",
      "# 旧主线大纲",
    );
    await fs.writeFile(
      path.join(projectPath(slug), "characters.json"),
      JSON.stringify([{ name: "旧角色", role: "主角", source: "user" }], null, 2),
      "utf8",
    );
    const before = await readProjectFiles(slug);

    agentState.failCharacters = true;
    const job = await pipeline.startJob(slug, "plan");
    const finished = await waitForJob(job.id);

    expect(finished.status).toBe("error");
    expect(finished.error).toContain("模拟角色生成失败");
    expect(await readProjectFiles(slug)).toEqual(before);
    expect((await store.getCanon(slug)).characters).toEqual([]);
  });

  it("架构生成成功后建立人物基线，等待正文确认", async () => {
    const slug = (await store.createProject({ title: "初始台账", targetChapters: 3 }))
      .meta.slug;

    const job = await pipeline.startJob(slug, "plan");
    const finished = await waitForJob(job.id);
    expect(finished.status, finished.error).toBe("done");

    const detail = await store.getProjectDetail(slug);
    expect(detail.canon.lastChapter).toBe(0);
    expect(detail.canon.characters.map((item) => item.name).sort()).toEqual(
      detail.characters.map((item) => item.name).sort(),
    );
    expect(
      detail.canon.characters.every(
        (item) =>
          item.chapter === 0 &&
          item.statusChapter === 0 &&
          item.status === "unknown",
      ),
    ).toBe(true);
    expect(detail.canon.items).toEqual([]);
    expect(detail.canon.rules).toEqual([]);
    expect(detail.canon.timeline).toEqual({ currentDay: "", deadlines: [] });
    expect(
      finished.logs.some((line) => line.message.includes("架构初始事实台账")),
    ).toBe(true);
  });

  it("已有正文时不初始化台账，避免把未知状态当成事实", async () => {
    const slug = (await store.createProject({ title: "已有正文", targetChapters: 3 }))
      .meta.slug;
    await store.savePlan(
      slug,
      {
        logline: "",
        tags: [],
        chapters: [
          { index: 1, title: "旧章", summary: "旧摘要", keyBeats: [] },
        ],
      },
      "# 旧世界观",
      "# 旧大纲",
    );
    await store.writeChapterFile(slug, 1, "已有正文", {
      source: "user",
      title: "旧章",
      summary: "旧摘要",
    });
    await store.markChapterWritten(slug, 1, "旧摘要", {
      summary: "旧摘要",
      issues: [],
      continuityOk: true,
    });
    const before = await store.getCanon(slug);
    expect(before.characters).toEqual([]);

    const job = await pipeline.startJob(slug, "plan");
    const finished = await waitForJob(job.id);
    expect(finished.status, finished.error).toBe("done");
    expect(await store.getCanon(slug)).toEqual(before);
  });

  it("已有手工台账时不覆盖", async () => {
    const slug = (await store.createProject({ title: "手工台账", targetChapters: 3 }))
      .meta.slug;
    const manual = {
      characters: [
        {
          name: "沈烛",
          aliases: ["提灯人"],
          status: "alive" as const,
          location: "长街",
          note: "手工确认：第一章已在长街登场",
          statusChapter: 1,
          chapter: 1,
        },
      ],
      items: [],
      timeline: { currentDay: "第一日", deadlines: [] },
      rules: ["手工规则：灯灭即死"],
      lastChapter: 1,
      updatedAt: "2026-11-17T00:00:00.000Z",
    };
    await store.saveCanon(slug, manual);

    const job = await pipeline.startJob(slug, "plan");
    const finished = await waitForJob(job.id);
    expect(finished.status, finished.error).toBe("done");
    expect(await store.getCanon(slug)).toEqual(manual);
  });

  it("成功后保留用户人物卡、更新 AI 人物并补齐大纲章节", async () => {
    const slug = (await store.createProject({ title: "保留人物", targetChapters: 3 }))
      .meta.slug;
    const seedCharacters: Character[] = [
      {
        name: "沈烛",
        role: "主角",
        gender: "男",
        age: "十九岁",
        appearance: "",
        personality: "手动设定：沉默但护短",
        background: "",
        goals: "",
        arc: "",
        relationships: "",
        speechStyle: "",
        source: "user",
      },
      {
        name: "顾晚舟",
        role: "配角",
        gender: "女",
        age: "二十三岁",
        appearance: "",
        personality: "旧 AI 设定",
        background: "",
        goals: "",
        arc: "",
        relationships: "",
        speechStyle: "",
        source: "ai",
      },
    ];
    await fs.writeFile(
      path.join(projectPath(slug), "characters.json"),
      JSON.stringify(seedCharacters, null, 2),
      "utf8",
    );

    const job = await pipeline.startJob(slug, "plan");
    const finished = await waitForJob(job.id);
    expect(finished.status, finished.error).toBe("done");

    const detail = await store.getProjectDetail(slug);
    expect(detail.plan.chapters).toHaveLength(3);
    expect(detail.outlineMd).toContain("### 第 3 章");

    const byName = new Map(detail.characters.map((item) => [item.name, item]));
    expect(byName.get("沈烛")?.personality).toBe("手动设定：沉默但护短");
    expect(byName.get("沈烛")?.source).toBe("user");
    expect(byName.get("顾晚舟")?.personality).not.toBe("旧 AI 设定");
    expect(byName.get("顾晚舟")?.source).toBe("ai");
    expect(byName.has("灯婆")).toBe(true);

    const integrity = await store.checkProjectIntegrity(slug);
    expect(integrity.ok, JSON.stringify(integrity.issues)).toBe(true);
  });

  it("生成的大纲编号不合法时拦截保存，旧大纲不变", async () => {
    const slug = (await store.createProject({ title: "坏大纲" })).meta.slug;
    await store.savePlan(
      slug,
      {
        logline: "",
        tags: [],
        chapters: [{ index: 1, title: "旧章", summary: "旧摘要", keyBeats: [] }],
      },
      "# 旧世界观",
      "# 旧大纲",
    );
    const planPath = path.join(projectPath(slug), "plan.json");
    const before = await fs.readFile(planPath, "utf8");

    agentState.badPlan = true;
    const job = await pipeline.startJob(slug, "plan");
    const finished = await waitForJob(job.id);

    expect(finished.status).toBe("error");
    expect(finished.error).toContain("章节序号重复");
    expect(await fs.readFile(planPath, "utf8")).toBe(before);
  });
});
