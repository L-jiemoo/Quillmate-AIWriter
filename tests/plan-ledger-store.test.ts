import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizePlanLedger } from "@/lib/plan-ledger";
import { buildEffectiveMemory } from "@/lib/memory";
import { buildEffectiveStory, buildStoryContext } from "@/lib/story";
import type { Character, PlanLedger, ProjectPlan } from "@/lib/types";

let dataDir: string;
let store: typeof import("@/lib/store");
let pipeline: typeof import("@/lib/pipeline");
let jobs: typeof import("@/lib/jobs");

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "quillmate-plan-ledger-"));
  process.env.QUILLMATE_DATA_DIR = dataDir;
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

function projectPath(slug: string): string {
  return path.join(dataDir, "projects", slug);
}

async function waitForJob(id: string): Promise<import("@/lib/types").Job> {
  const deadline = Date.now() + 15000;
  for (;;) {
    const job = jobs.getJob(id);
    if (job && ["done", "error", "paused"].includes(job.status)) return job;
    if (Date.now() > deadline) throw new Error(`等待任务 ${id} 超时`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function plan(count = 3): ProjectPlan {
  return {
    logline: "测试主线",
    tags: ["测试"],
    chapters: Array.from({ length: count }, (_, index) => ({
      index: index + 1,
      title: `章节${index + 1}`,
      summary: `第 ${index + 1} 章梗概`,
      keyBeats: [`事件${index + 1}`],
    })),
  };
}

function characters(): Character[] {
  return [
    {
      name: "角色甲",
      role: "主角",
      gender: "男",
      age: "二十",
      appearance: "",
      personality: "",
      background: "",
      goals: "",
      arc: "",
      relationships: "",
      speechStyle: "",
    },
  ];
}

function ledger(): PlanLedger {
  return normalizePlanLedger({
    events: [
      {
        id: "plan-event-1",
        name: "发现线索",
        chapter: 1,
        participants: ["角色甲"],
        process: "角色甲发现线索",
        expectedResult: "进入主线",
      },
    ],
    characterChanges: [
      {
        id: "plan-char-1",
        character: "角色甲",
        chapter: 3,
        before: "存活",
        after: "死亡",
      },
    ],
    foreshadows: [
      {
        id: "plan-foreshadow-1",
        text: "旧玉佩的裂痕",
        plantChapter: 1,
        resolveChapter: 3,
      },
    ],
    items: [
      {
        id: "plan-item-1",
        item: "旧玉佩",
        chapter: 1,
        holder: "角色乙",
        stateChange: "从角色甲转交给角色乙",
      },
    ],
  });
}

describe("计划台账持久化", () => {
  it("新项目建立空的独立计划台账", async () => {
    const detail = await store.createProject({ title: "计划台账", targetChapters: 3 });
    const raw = JSON.parse(
      await fs.readFile(path.join(projectPath(detail.meta.slug), "plan-ledger.json"), "utf8"),
    );
    expect(raw.version).toBe(1);
    expect(raw.events).toEqual([]);
    expect(detail.planLedger?.events).toEqual([]);
  });

  it("架构提交时与大纲、人物一起写入计划台账", async () => {
    const slug = (await store.createProject({ title: "架构台账", targetChapters: 3 }))
      .meta.slug;
    await store.commitArchitecture(
      slug,
      {
        plan: plan(),
        bible: "# 世界观",
        outlineMd: "# 主线\n\n- 伏笔：旧玉佩的裂痕（第1章埋，第3章回收）。",
        planLedger: ledger(),
      },
      characters(),
      { seedCanon: true },
    );

    const detail = await store.getProjectDetail(slug);
    expect(detail.planLedger?.events[0]).toMatchObject({
      name: "发现线索",
      status: "planned",
      actualChapter: 0,
    });
    expect(detail.planLedger?.foreshadows[0]).toMatchObject({
      plantChapter: 1,
      resolveChapter: 3,
      actualPlantChapter: 0,
    });
    // 计划在第 3 章死亡，不能提前写进事实台账。
    expect(detail.canon.characters.every((item) => item.status === "unknown")).toBe(true);
    expect(detail.canon.characters.find((item) => item.name === "角色甲")?.status).not.toBe(
      "dead",
    );
    // 计划中的物品转移也不能提前进入事实台账。
    expect(detail.canon.items).toEqual([]);
    expect(detail.planLedger?.items[0]).toMatchObject({
      item: "旧玉佩",
      holder: "角色乙",
      status: "planned",
      actualChapter: 0,
    });
  });

  it("计划台账校验失败时整个架构不提交", async () => {
    const slug = (await store.createProject({ title: "校验失败", targetChapters: 3 })).meta.slug;
    await store.savePlan(slug, plan(), "# 旧世界观", "# 旧主线");
    const before = {
      plan: await fs.readFile(path.join(projectPath(slug), "plan.json"), "utf8"),
      outline: await fs.readFile(path.join(projectPath(slug), "outline.md"), "utf8"),
      ledger: await fs.readFile(path.join(projectPath(slug), "plan-ledger.json"), "utf8"),
    };

    await expect(
      store.commitArchitecture(
        slug,
        {
          plan: plan(),
          bible: "# 新世界观",
          outlineMd: "# 新主线",
          planLedger: normalizePlanLedger({
            events: [{ id: "e1", name: "越界事件", chapter: 9 }],
          }),
        },
        characters(),
        { seedCanon: true },
      ),
    ).rejects.toThrow(/不存在的第 9 章/);

    expect(await fs.readFile(path.join(projectPath(slug), "plan.json"), "utf8")).toBe(
      before.plan,
    );
    expect(await fs.readFile(path.join(projectPath(slug), "outline.md"), "utf8")).toBe(
      before.outline,
    );
    expect(await fs.readFile(path.join(projectPath(slug), "plan-ledger.json"), "utf8")).toBe(
      before.ledger,
    );
  });

  it("旧项目缺少计划台账文件时仍能打开，并按大纲派生 planned 记录", async () => {
    const slug = (await store.createProject({ title: "旧项目", targetChapters: 3 })).meta.slug;
    await store.savePlan(
      slug,
      plan(),
      "# 世界观",
      "# 主线\n\n- 伏笔：旧玉佩的裂痕（第1章埋，第3章回收）。",
    );
    await fs.rm(path.join(projectPath(slug), "plan-ledger.json"));

    const detail = await store.getProjectDetail(slug);
    expect(detail.plan.chapters).toHaveLength(3);
    expect(detail.planLedger?.foreshadows[0]).toMatchObject({
      text: "旧玉佩的裂痕",
      status: "planned",
      actualPlantChapter: 0,
    });

    // 旧项目仍然可以继续写作，并在第一次写完后生成正式计划台账文件。
    const job = await pipeline.startJob(slug, "write", { count: 1 });
    const finished = await waitForJob(job.id);
    expect(finished.status, finished.error).toBe("done");
    const afterWrite = await store.getProjectDetail(slug);
    expect(afterWrite.chapters.filter((chapter) => chapter.written)).toHaveLength(1);
    expect(
      JSON.parse(
        await fs.readFile(path.join(projectPath(slug), "plan-ledger.json"), "utf8"),
      ).events[0].actualChapter,
    ).toBe(1);
  });

  it("续排新章节与计划台账在同一次提交中落盘", async () => {
    const slug = (await store.createProject({ title: "续排台账", targetChapters: 3 })).meta.slug;
    await store.commitArchitecture(
      slug,
      { plan: plan(3), bible: "# 世界观", outlineMd: "# 主线", planLedger: ledger() },
      characters(),
      { seedCanon: true },
    );

    await store.appendChapters(
      slug,
      [{ index: 4, title: "新章", summary: "新章梗概", keyBeats: [] }],
      normalizePlanLedger({
        ...ledger(),
        events: [
          ...ledger().events,
          { id: "plan-event-4", name: "新章事件", chapter: 4 },
        ],
      }),
    );

    const detail = await store.getProjectDetail(slug);
    expect(detail.plan.chapters).toHaveLength(4);
    expect(detail.planLedger?.events.map((item) => item.id)).toContain("plan-event-4");
  });
});

describe("计划伏笔与剧情台账隔离", () => {
  it("计划第 2 章埋的伏笔，正文没写时第 3 章检索不到", async () => {
    const slug = (await store.createProject({ title: "伏笔隔离", targetChapters: 4 }))
      .meta.slug;
    await store.commitArchitecture(
      slug,
      {
        plan: plan(4),
        bible: "# 世界观",
        outlineMd: "# 主线\n\n- 伏笔：旧玉佩的裂痕（第2章埋，第4章回收）。",
        planLedger: normalizePlanLedger({
          events: [{ id: "e1", name: "铺垫", chapter: 1 }],
          foreshadows: [
            {
              id: "plan-foreshadow-2",
              text: "旧玉佩的裂痕",
              plantChapter: 2,
              resolveChapter: 4,
            },
          ],
        }),
      },
      characters(),
      { seedCanon: true },
    );

    const detail = await store.getProjectDetail(slug);
    const memory = buildEffectiveMemory(detail, null);
    const story = buildEffectiveStory(detail, memory, null);
    expect(story.foreshadows).toEqual([]);
    expect(story.events.some((event) => event.name === "发现线索")).toBe(false);

    const chapter = detail.plan.chapters[2];
    const retrieval = buildStoryContext(detail, chapter, memory, story);
    expect(retrieval.text).not.toContain("旧玉佩的裂痕");

    // 计划台账仍然保留这条未来计划，但明确是 planned。
    expect(detail.planLedger?.foreshadows[0]).toMatchObject({
      plantChapter: 2,
      status: "planned",
      actualPlantChapter: 0,
    });
  });

  it("正文确实埋设后，下一章可以从剧情台账检索到", async () => {
    const slug = (await store.createProject({ title: "伏笔确认", targetChapters: 4 }))
      .meta.slug;
    await store.commitArchitecture(
      slug,
      {
        plan: plan(4),
        bible: "# 世界观",
        outlineMd: "# 主线",
        planLedger: normalizePlanLedger({
          events: [{ id: "e1", name: "铺垫", chapter: 1 }],
          foreshadows: [
            { id: "fs-2", text: "旧玉佩的裂痕", plantChapter: 2, resolveChapter: 4 },
          ],
        }),
      },
      characters(),
      { seedCanon: true },
    );
    await store.saveChapter(slug, 2, "第二章正文：角色甲发现旧玉佩的裂痕。", "发现裂痕");
    await store.markChapterWritten(slug, 2, "发现裂痕", {
      summary: "发现裂痕",
      issues: [],
      continuityOk: true,
    });

    const detail = await store.getProjectDetail(slug);
    const memory = buildEffectiveMemory(detail, null);
    memory.chapters["2"].source = "ai";
    memory.chapters["2"].foreshadowsPlanted = ["旧玉佩的裂痕"];
    const story = buildEffectiveStory(detail, memory, null);
    expect(story.foreshadows).toHaveLength(1);
    expect(story.foreshadows[0]).toMatchObject({
      text: "旧玉佩的裂痕",
      plantedChapter: 2,
      status: "planted",
    });

    const retrieval = buildStoryContext(detail, detail.plan.chapters[2], memory, story);
    expect(retrieval.text).toContain("旧玉佩的裂痕");
    expect(retrieval.text).toContain("未回收伏笔");
  });
});
