import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wrapUpMessages } from "@/lib/prompts";
import {
  applyWrapUpForeshadowPlans,
  normalizePlanLedger,
  openForeshadows,
  unresolvedForeshadows,
} from "@/lib/plan-ledger";
import type { LLMClient } from "@/lib/llm";
import type { Job, ProjectMeta, ProjectPlan } from "@/lib/types";

let dataDir: string;
let store: typeof import("@/lib/store");
let pipeline: typeof import("@/lib/pipeline");
let jobs: typeof import("@/lib/jobs");
let agents: typeof import("@/lib/agents");
let previousProvider: string | undefined;
let previousApiKey: string | undefined;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "quillmate-wrapup-"));
  previousProvider = process.env.LLM_PROVIDER;
  previousApiKey = process.env.LLM_API_KEY;
  process.env.QUILLMATE_DATA_DIR = dataDir;
  delete process.env.LLM_PROVIDER;
  delete process.env.LLM_API_KEY;
  vi.resetModules();
  store = await import("@/lib/store");
  pipeline = await import("@/lib/pipeline");
  jobs = await import("@/lib/jobs");
  agents = await import("@/lib/agents");
  jobs.__reloadJobStoreForTests();
});

afterEach(async () => {
  vi.resetModules();
  delete process.env.QUILLMATE_DATA_DIR;
  if (previousProvider === undefined) delete process.env.LLM_PROVIDER;
  else process.env.LLM_PROVIDER = previousProvider;
  if (previousApiKey === undefined) delete process.env.LLM_API_KEY;
  else process.env.LLM_API_KEY = previousApiKey;
  await rm(dataDir, { recursive: true, force: true });
});

function meta(): ProjectMeta {
  return {
    slug: "wrapup-test",
    title: "收尾测试书",
    genre: "悬疑",
    tone: "克制",
    idea: "",
    author: "",
    language: "中文",
    targetChapters: 3,
    wordsPerChapter: 2000,
    createdAt: "2026-11-20T00:00:00.000Z",
    updatedAt: "2026-11-20T00:00:00.000Z",
  };
}

function basePlan(): ProjectPlan {
  return {
    logline: "测试主线",
    tags: [],
    chapters: [1, 2, 3].map((index) => ({
      index,
      title: `章节${index}`,
      summary: `第 ${index} 章梗概`,
      keyBeats: [],
    })),
  };
}

function join(messages: Array<{ content: string }>): string {
  return messages.map((message) => message.content).join("\n");
}

async function waitForJob(id: string): Promise<Job> {
  const deadline = Date.now() + 20000;
  for (;;) {
    const job = jobs.getJob(id);
    if (job && ["done", "error", "paused", "cancelled"].includes(job.status)) return job;
    if (Date.now() > deadline) throw new Error(`等待任务 ${id} 超时`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function projectWithPlan(title: string): Promise<string> {
  const slug = (await store.createProject({ title, targetChapters: 3 })).meta.slug;
  const job = await pipeline.startJob(slug, "plan");
  const finished = await waitForJob(job.id);
  expect(finished.status, finished.error).toBe("done");
  return slug;
}

describe("收尾大纲提示词", () => {
  it("带入未回收伏笔、作者收尾要求与收尾约束", () => {
    const text = join(
      wrapUpMessages(meta(), basePlan(), "世界观", "# 主线", [], 3, 4, {
        openForeshadows: [
          { text: "测试伏笔甲", plantChapter: 1, plannedResolveChapter: 0, planted: true },
        ],
        brief: "必须让男主活到最后",
        writtenThrough: 2,
      }),
    );

    expect(text).toContain("测试伏笔甲");
    expect(text).toContain("未排期");
    expect(text).toContain("必须让男主活到最后");
    expect(text).toContain("正文已写到第 2 章");
    expect(text).toContain("不得开新坑");
    expect(text).toContain("plan-wrapup-");
    expect(text).toContain("最后一批收尾章节");
    // 收尾章必须能直接接完结章，且不能把作者要求降级成建议。
    expect(text).toContain("可以直接写完结章");
    expect(text).toContain("硬性约束");
  });

  it("非最后一批不按大结局节奏写", () => {
    const text = join(
      wrapUpMessages(meta(), basePlan(), "", "", [], 3, 4, { finalBatch: false }),
    );
    expect(text).toContain("本批不是最后一批收尾章节");
    expect(text).not.toContain("这是最后一批收尾章节");
  });

  it("已排期但正文没收掉的伏笔标注为逾期并要求改期", () => {
    const text = join(
      wrapUpMessages(meta(), basePlan(), "", "", [], 3, 4, {
        openForeshadows: [
          { text: "测试伏笔丙", plantChapter: 1, plannedResolveChapter: 3, planted: true },
        ],
      }),
    );
    expect(text).toContain("测试伏笔丙");
    expect(text).toContain("原计划第 3 章回收，正文未确认");
    expect(text).toContain("已经跳票");
  });

  it("正文未确认埋设的伏笔会标出来，不会被静默跳过", () => {
    const text = join(
      wrapUpMessages(meta(), basePlan(), "", "", [], 3, 4, {
        openForeshadows: [
          { text: "测试线索", plantChapter: 2, plannedResolveChapter: 0, planted: false },
        ],
      }),
    );
    expect(text).toContain("测试线索");
    expect(text).toContain("正文未确认埋设");
    expect(text).toContain("补写埋设");
  });
});

describe("收尾伏笔口径", () => {
  it("已排期未回收和正文未确认埋设的伏笔都算未回收", () => {
    const ledger = normalizePlanLedger({
      foreshadows: [
        { id: "fs-open", text: "未排期伏笔", plantChapter: 1, resolveChapter: 0 },
        { id: "fs-late", text: "逾期伏笔", plantChapter: 2, resolveChapter: 4 },
        { id: "fs-done", text: "已回收伏笔", plantChapter: 3, resolveChapter: 5 },
        {
          id: "fs-deviated",
          text: "从未埋设",
          plantChapter: 4,
          resolveChapter: 0,
          status: "deviated",
        },
      ],
    });
    ledger.foreshadows[2].actualResolveChapter = 5;

    // fs-done 已有实际回收章节被排除；从未埋设的 fs-deviated 仍要进收尾清单，
    // 否则整本伏笔都判偏离时收尾会误报“没有未回收伏笔”。
    expect(unresolvedForeshadows(ledger).map((item) => item.id)).toEqual([
      "fs-late",
      "fs-open",
      "fs-deviated",
    ]);
  });
});

describe("收尾伏笔回填", () => {
  it("新排定的回收章节写回既有未回收伏笔，不重复登记", () => {
    const base = normalizePlanLedger({
      foreshadows: [
        { id: "fs-open", text: "测试伏笔甲", plantChapter: 1, resolveChapter: 0 },
        {
          id: "fs-done",
          text: "测试伏笔乙",
          plantChapter: 2,
          resolveChapter: 5,
          actualResolveChapter: 5,
        },
      ],
    });
    const addition = normalizePlanLedger({
      foreshadows: [
        {
          id: "plan-wrapup-foreshadow-1",
          text: "测试伏笔甲。",
          plantChapter: 1,
          resolveChapter: 9,
        },
      ],
    });

    const result = applyWrapUpForeshadowPlans(base, addition);

    expect(result.base.foreshadows.find((item) => item.id === "fs-open")?.resolveChapter).toBe(9);
    expect(result.base.foreshadows.find((item) => item.id === "fs-done")?.resolveChapter).toBe(5);
    expect(result.addition.foreshadows).toHaveLength(0);
    expect(result.resolved).toEqual(["测试伏笔甲"]);
    expect(result.unassigned).toEqual([]);
    expect(openForeshadows(result.base)).toHaveLength(0);
  });

  it("逾期未回收的伏笔会被改期而不是结案", () => {
    const base = normalizePlanLedger({
      foreshadows: [
        { id: "fs-late", text: "测试伏笔丙", plantChapter: 1, resolveChapter: 3 },
      ],
    });
    base.foreshadows[0].actualPlantChapter = 1;
    const addition = normalizePlanLedger({
      foreshadows: [
        {
          id: "plan-wrapup-foreshadow-1",
          text: "测试伏笔丙",
          plantChapter: 1,
          resolveChapter: 9,
        },
      ],
    });

    const result = applyWrapUpForeshadowPlans(base, addition);

    expect(result.base.foreshadows[0].resolveChapter).toBe(9);
    expect(result.rescheduled).toEqual(["测试伏笔丙"]);
    expect(result.unassigned).toEqual([]);
  });

  it("对不上的回收计划保留为新增伏笔并提示", () => {
    const base = normalizePlanLedger({
      foreshadows: [{ id: "fs-open", text: "测试伏笔甲", plantChapter: 1, resolveChapter: 0 }],
    });
    const addition = normalizePlanLedger({
      foreshadows: [
        {
          id: "plan-wrapup-foreshadow-1",
          text: "完全不同的新线索",
          plantChapter: 1,
          resolveChapter: 7,
        },
      ],
    });

    const result = applyWrapUpForeshadowPlans(base, addition);

    expect(result.base.foreshadows[0].resolveChapter).toBe(0);
    expect(result.addition.foreshadows).toHaveLength(1);
    expect(result.unmatched).toEqual(["完全不同的新线索"]);
    expect(result.unassigned).toEqual(["测试伏笔甲"]);
  });
});

describe("收尾任务", () => {
  it("生成收尾章节并把未回收伏笔排进新章节", async () => {
    const slug = await projectWithPlan("收尾工程");
    const detail = await store.getProjectDetail(slug);
    const base = detail.planLedger ?? normalizePlanLedger({});
    const seeded = normalizePlanLedger({
      foreshadows: [
        { id: "fs-open", text: "测试伏笔甲", plantChapter: 1, resolveChapter: 0 },
      ],
    });
    await store.savePlanLedger(slug, {
      ...base,
      foreshadows: [...base.foreshadows, ...seeded.foreshadows],
    });

    const chapterCount = detail.plan.chapters.length;
    const startIndex = Math.max(...detail.plan.chapters.map((chapter) => chapter.index)) + 1;

    const job = await pipeline.startJob(slug, "wrapup", {
      count: 3,
      wrapUpBrief: "必须回收测试伏笔甲",
    });
    const finished = await waitForJob(job.id);
    expect(finished.status, finished.error).toBe("done");

    const after = await store.getProjectDetail(slug);
    expect(after.plan.chapters).toHaveLength(chapterCount + 3);
    expect(after.plan.chapters.map((chapter) => chapter.index)).toEqual(
      Array.from({ length: chapterCount + 3 }, (_, index) => index + 1),
    );
    const resolved = after.planLedger?.foreshadows.find((item) => item.id === "fs-open");
    expect(resolved?.resolveChapter).toBe(startIndex + 2);
    expect(openForeshadows(after.planLedger).some((item) => item.id === "fs-open")).toBe(false);
    expect(finished.logs.some((line) => line.message.includes("排定回收章节"))).toBe(true);
    expect(finished.result).toContain("收尾");
  });

  it("重复生成时撞上既有计划 ID 会自动加序号", async () => {
    const { namespaceLedgerIds } = await import("@/lib/agents");
    const ledger = normalizePlanLedger({
      events: [{ id: "plan-wrapup-char-1", name: "旧计划", chapter: 9 }],
      foreshadows: [
        {
          id: "plan-wrapup-foreshadow-1",
          text: "测试伏笔甲",
          plantChapter: 9,
          resolveChapter: 10,
          eventIds: ["plan-wrapup-char-1"],
        },
      ],
    });

    const namespaced = namespaceLedgerIds(
      ledger,
      "extend-b1",
      new Set(["extend-b1-plan-wrapup-char-1"]),
    );

    expect(namespaced.events[0].id).toBe("extend-b1-plan-wrapup-char-1-2");
    expect(namespaced.foreshadows[0].eventIds).toEqual(["extend-b1-plan-wrapup-char-1-2"]);
  });

  it("收尾前把剧情台账的未回收伏笔补进计划台账", async () => {
    const slug = await projectWithPlan("剧情台账补登");
    const { normalizeStory } = await import("@/lib/story");
    await store.saveStory(
      slug,
      normalizeStory({
        foreshadows: [
          {
            id: "fs-story",
            text: "测试伏笔丁",
            plantedChapter: 1,
            status: "developing",
            source: "manual",
          },
        ],
      }),
    );

    const job = await pipeline.startJob(slug, "wrapup", { count: 2 });
    const finished = await waitForJob(job.id);
    expect(finished.status, finished.error).toBe("done");

    const after = await store.getProjectDetail(slug);
    const added = after.planLedger?.foreshadows.find((item) =>
      item.id.startsWith("plan-story-"),
    );
    expect(added?.text).toBe("测试伏笔丁");
    expect(added?.actualPlantChapter).toBe(1);
    expect(finished.logs.some((line) => line.message.includes("补登"))).toBe(true);
  });

  it("没有大纲时拒绝收尾", async () => {
    const slug = (await store.createProject({ title: "空项目" })).meta.slug;
    const job = await pipeline.startJob(slug, "wrapup", { count: 2 });
    const finished = await waitForJob(job.id);

    expect(finished.status).toBe("error");
    expect(finished.error).toContain("还没有章节大纲");
  });

  it("已完结项目不能再补收尾大纲", async () => {
    const slug = await projectWithPlan("已完结项目");
    const detail = await store.getProjectDetail(slug);
    await store.savePlanLedger(slug, {
      ...(detail.planLedger ?? normalizePlanLedger({})),
      completedChapter: detail.plan.chapters.length,
    });

    const job = await pipeline.startJob(slug, "wrapup");
    const finished = await waitForJob(job.id);

    expect(finished.status).toBe("error");
    expect(finished.error).toContain("不能再补充收尾大纲");
  });

  it("收尾模式把作者要求与伏笔清单送进模型", async () => {
    process.env.LLM_PROVIDER = "openai-compatible";
    process.env.LLM_API_KEY = "sk-test";
    const calls: string[] = [];
    const client = {
      json: async (messages: Array<{ content: string }>) => {
        calls.push(join(messages));
        return {
          chapters: [
            {
              index: 4,
              title: "收束测试主线",
              summary: "回收旧玉佩伏笔，主线收束",
              keyBeats: ["回收伏笔"],
            },
          ],
          planLedger: {
            events: [
              {
                id: "plan-wrapup-event-4-1",
                name: "收束测试主线",
                chapter: 4,
                participants: [],
                importance: "major",
              },
            ],
            foreshadows: [
              {
                id: "plan-wrapup-foreshadow-1",
                text: "测试伏笔甲",
                plantChapter: 1,
                resolveChapter: 4,
              },
            ],
          },
        };
      },
    } as unknown as LLMClient;

    const result = await agents.extendPlan(
      meta(),
      basePlan(),
      "世界观",
      "# 主线",
      [],
      1,
      {},
      {
        client,
        mode: "wrapup",
        wrapUp: {
          brief: "必须回收测试伏笔甲",
          openForeshadows: [
            { text: "测试伏笔甲", plantChapter: 1, plannedResolveChapter: 0, planted: true },
          ],
          writtenThrough: 3,
        },
      },
    );

    expect(calls[0]).toContain("必须回收测试伏笔甲");
    expect(calls[0]).toContain("测试伏笔甲");
    expect(calls[0]).toContain("尚未回收的伏笔");
    expect(result.chapters[0].index).toBe(4);
    expect(result.planLedger.foreshadows[0].resolveChapter).toBe(4);
  });
});
