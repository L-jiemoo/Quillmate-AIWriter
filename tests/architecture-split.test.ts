import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LLMClient } from "@/lib/llm";
import type { GeneratedPlan } from "@/lib/mock";
import type { Character, ProjectMeta } from "@/lib/types";

let dataDir: string;
let previousProvider: string | undefined;
let previousApiKey: string | undefined;
let previousMaxTokens: string | undefined;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "quillmate-architecture-split-"));
  previousProvider = process.env.LLM_PROVIDER;
  previousApiKey = process.env.LLM_API_KEY;
  previousMaxTokens = process.env.LLM_MAX_TOKENS;
  process.env.QUILLMATE_DATA_DIR = dataDir;
  process.env.LLM_PROVIDER = "openai-compatible";
  process.env.LLM_API_KEY = "sk-test";
  process.env.LLM_MAX_TOKENS = "16384";
  vi.resetModules();
});

afterEach(async () => {
  vi.resetModules();
  delete process.env.QUILLMATE_DATA_DIR;
  if (previousProvider === undefined) delete process.env.LLM_PROVIDER;
  else process.env.LLM_PROVIDER = previousProvider;
  if (previousApiKey === undefined) delete process.env.LLM_API_KEY;
  else process.env.LLM_API_KEY = previousApiKey;
  if (previousMaxTokens === undefined) delete process.env.LLM_MAX_TOKENS;
  else process.env.LLM_MAX_TOKENS = previousMaxTokens;
  await rm(dataDir, { recursive: true, force: true });
});

function meta(targetChapters: number): ProjectMeta {
  return {
    slug: "split-test",
    title: "测试长篇",
    genre: "悬疑",
    tone: "克制",
    idea: "",
    author: "",
    language: "中文",
    targetChapters,
    wordsPerChapter: 2000,
    createdAt: "2026-11-20T00:00:00.000Z",
    updatedAt: "2026-11-20T00:00:00.000Z",
  };
}

type Handler = (text: string) => Promise<unknown>;

function makeFake(handler: Handler) {
  const calls: string[] = [];
  const client = {
    json: async (messages: Array<{ content: string }>) => {
      const text = messages.map((message) => message.content).join("\n");
      calls.push(text);
      return handler(text);
    },
  } as unknown as LLMClient;
  return { client, calls };
}

function architectureHandler(options: {
  failChapterLabel?: string;
  truncateChapterLabel?: string;
  TruncatedError?: new (input: {
    content: string;
    finishReason: string;
    maxTokens: number;
    attempts: number;
  }) => Error;
} = {}): Handler {
  let failed = false;
  let truncated = false;
  return async (text) => {
    if (text.includes("第一阶段：全书架构")) {
      return {
        logline: "一句话卖点",
        tags: ["悬疑", "长篇"],
        bibleMd: "# 世界观\n规则稳定。",
        outlineMd: "# 主线\n分三卷推进。",
        volumes: [{ title: "第一卷", chapters: "第 1-10 章", goal: "建立冲突" }],
      };
    }

    const chapterMatch = text.match(/现在只生成第 (\d+)-(\d+) 章的细纲/);
    if (chapterMatch) {
      const start = Number(chapterMatch[1]);
      const end = Number(chapterMatch[2]);
      const label = `第 ${start}-${end} 章`;
      if (
        options.failChapterLabel &&
        !failed &&
        label === options.failChapterLabel
      ) {
        failed = true;
        throw new Error(`模拟${label}生成失败`);
      }
      if (
        options.truncateChapterLabel &&
        options.TruncatedError &&
        !truncated &&
        label === options.truncateChapterLabel
      ) {
        truncated = true;
        throw new options.TruncatedError({
          content: '{"chapters":[',
          finishReason: "length",
          maxTokens: 16384,
          attempts: 3,
        });
      }
      return {
        chapters: Array.from({ length: end - start + 1 }, (_, offset) => {
          const index = start + offset;
          return {
            index,
            title: `章节标题 ${index}`,
            summary: `第 ${index} 章推进主线。`,
            keyBeats: [`关键事件 ${index}`],
          };
        }),
      };
    }

    if (text.includes("请只为这些章节生成计划台账")) {
      const indexes = [
        ...new Set(
          [...text.matchAll(/第 (\d+) 章《/g)].map((match) => Number(match[1])),
        ),
      ].sort((a, b) => a - b);
      const batchMatch = text.match(/plan-arch-b(\d+)-event/);
      const batch = batchMatch?.[1] ?? "1";
      return {
        planLedger: {
          events: indexes.map((index) => ({
            id: `plan-arch-b${batch}-event-${index}`,
            name: `计划事件 ${index}`,
            chapter: index,
            participants: [],
            premise: "前提",
            process: "经过",
            expectedResult: "结果",
            impact: "影响",
            relatedEventIds: [],
            importance: "major",
          })),
          characterChanges: [],
          foreshadows: [],
          timeline: [],
          items: [],
        },
      };
    }

    if (text.includes("重新起标题")) return { titles: [] };
    throw new Error(`未识别的测试提示词：${text.slice(0, 80)}`);
  };
}

describe("架构分阶段与分批生成", () => {
  it("按批次生成连续章节和计划台账，不重复生成已完成批次", async () => {
    const { generatePlan } = await import("@/lib/agents");
    const { client, calls } = makeFake(architectureHandler());
    const progress: string[] = [];

    const generated = await generatePlan(meta(12), {
      client,
      onProgress: (message) => progress.push(message),
    });

    expect(generated.plan.chapters.map((chapter) => chapter.index)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
    expect(new Set(generated.plan.chapters.map((chapter) => chapter.title)).size).toBe(12);
    expect(generated.planLedger?.events).toHaveLength(12);
    expect(
      new Set(generated.planLedger?.events.map((event) => event.id)).size,
    ).toBe(12);
    for (let index = 1; index <= 12; index += 1) {
      expect(
        generated.planLedger?.events.some((event) => event.chapter === index),
      ).toBe(true);
    }

    expect(
      calls.filter((text) => text.includes("现在只生成第 1-10 章的细纲")),
    ).toHaveLength(1);
    expect(
      calls.filter((text) => text.includes("现在只生成第 11-12 章的细纲")),
    ).toHaveLength(1);
    expect(progress.some((message) => message.includes("计划台账已完成"))).toBe(true);
  });

  it("某一批失败只重试该批，不重新生成前面批次", async () => {
    const { generatePlan } = await import("@/lib/agents");
    const { client, calls } = makeFake(
      architectureHandler({ failChapterLabel: "第 11-12 章" }),
    );
    const progress: string[] = [];

    const generated = await generatePlan(meta(12), {
      client,
      onProgress: (message) => progress.push(message),
    });

    expect(generated.plan.chapters).toHaveLength(12);
    expect(
      calls.filter((text) => text.includes("现在只生成第 1-10 章的细纲")),
    ).toHaveLength(1);
    expect(
      calls.filter((text) => text.includes("现在只生成第 11-12 章的细纲")),
    ).toHaveLength(2);
    expect(progress.some((message) => message.includes("正在重试"))).toBe(true);
  });

  it("章节批次被截断时自动拆成更小批次继续生成", async () => {
    const { generatePlan } = await import("@/lib/agents");
    const { LLMOutputTruncatedError } = await import("@/lib/llm");
    const { client, calls } = makeFake(
      architectureHandler({
        truncateChapterLabel: "第 1-10 章",
        TruncatedError: LLMOutputTruncatedError,
      }),
    );

    const generated = await generatePlan(meta(12), { client });

    expect(generated.plan.chapters).toHaveLength(12);
    expect(
      calls.some((text) => text.includes("现在只生成第 1-5 章的细纲")),
    ).toBe(true);
    expect(
      calls.some((text) => text.includes("现在只生成第 6-10 章的细纲")),
    ).toBe(true);
  });

  it("跨批次的计划事件引用在合并后仍然有效", async () => {
    const { generatePlan } = await import("@/lib/agents");
    const base = architectureHandler();
    const { client } = makeFake(async (text) => {
      if (text.includes("请只为这些章节生成计划台账")) {
        const indexes = [
          ...new Set(
            [...text.matchAll(/第 (\d+) 章《/g)].map((match) => Number(match[1])),
          ),
        ].sort((a, b) => a - b);
        const batch = text.includes("plan-arch-b2-") ? 2 : 1;
        const priorId = text.match(/b1-plan-arch-b1-event-\d+/)?.[0];
        return {
          planLedger: {
            events: indexes.map((index) => ({
              id: `plan-arch-b${batch}-event-${index}`,
              name: `计划事件 ${index}`,
              chapter: index,
              participants: [],
              process: "经过",
              relatedEventIds:
                batch === 2 && index === 11 && priorId ? [priorId] : [],
            })),
            characterChanges: [],
            foreshadows: [],
            timeline: [],
            items: [],
          },
        };
      }
      return base(text);
    });

    const generated = await generatePlan(meta(12), { client });
    const firstEvent = generated.planLedger?.events.find(
      (event) => event.chapter === 1,
    );
    const crossBatchEvent = generated.planLedger?.events.find(
      (event) => event.chapter === 11,
    );
    expect(firstEvent).toBeTruthy();
    expect(crossBatchEvent?.relatedEventIds).toContain(firstEvent?.id);
  });

  it("计划台账缺少章节事件时用章节细纲补齐，保证每章有计划事件", async () => {
    const { generatePlan } = await import("@/lib/agents");
    const handler = architectureHandler();
    const { client } = makeFake(async (text) => {
      if (text.includes("请只为这些章节生成计划台账")) {
        const indexes = [
          ...new Set(
            [...text.matchAll(/第 (\d+) 章《/g)].map((match) => Number(match[1])),
          ),
        ].sort((a, b) => a - b);
        return {
          planLedger: {
            events: indexes.slice(0, 1).map((index) => ({
              id: `plan-arch-b1-event-${index}`,
              name: `计划事件 ${index}`,
              chapter: index,
              participants: [],
              process: "经过",
            })),
            characterChanges: [],
            foreshadows: [],
            timeline: [],
            items: [],
          },
        };
      }
      return handler(text);
    });

    const generated = await generatePlan(meta(12), { client });
    for (let index = 1; index <= 12; index += 1) {
      expect(
        generated.planLedger?.events.some((event) => event.chapter === index),
      ).toBe(true);
    }
  });
});

describe("续排大纲分批生成", () => {
  it("超过单批上限时按连续编号分批生成并合并台账", async () => {
    const { extendPlan } = await import("@/lib/agents");
    const { client, calls } = makeFake(async (text) => {
      const match = text.match(/现有大纲已排到第 (\d+) 章。请继续设计 (\d+) 章新细纲/);
      if (!match) throw new Error(`未识别续排提示词：${text.slice(0, 80)}`);
      const start = Number(match[1]) + 1;
      const count = Number(match[2]);
      return {
        chapters: Array.from({ length: count }, (_, offset) => {
          const index = start + offset;
          return {
            index,
            title: `续排标题 ${index}`,
            summary: `第 ${index} 章继续推进。`,
            keyBeats: [`续排事件 ${index}`],
          };
        }),
        planLedger: {
          events: Array.from({ length: count }, (_, offset) => {
            const index = start + offset;
            return {
              id: `plan-extend-event-${index}`,
              name: `续排计划 ${index}`,
              chapter: index,
              participants: [],
              process: "经过",
            };
          }),
          characterChanges: [],
          foreshadows: [],
          timeline: [],
          items: [],
        },
      };
    });

    const generated = await extendPlan(
      meta(15),
      {
        logline: "",
        tags: [],
        chapters: [1, 2, 3].map((index) => ({
          index,
          title: `旧标题 ${index}`,
          summary: `旧摘要 ${index}`,
          keyBeats: [],
        })),
      },
      "# 世界观",
      "# 主线",
      [],
      12,
      {},
      { client },
    );

    expect(generated.chapters.map((chapter) => chapter.index)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 4),
    );
    expect(generated.planLedger.events).toHaveLength(12);
    expect(new Set(generated.planLedger.events.map((event) => event.id)).size).toBe(12);
    expect(calls).toHaveLength(2);
  });
});

function character(index: number, overrides: Partial<Character> = {}): Character {
  return {
    name: `角色${index}号`,
    role: "核心配角",
    gender: "男",
    age: "二十岁",
    appearance: "普通外貌",
    personality: "谨慎",
    background: "测试背景",
    goals: "完成测试目标",
    arc: "学会合作",
    relationships: "与队友互相照应",
    speechStyle: "说话简短",
    ...overrides,
  };
}

function validCharacters(): Character[] {
  return Array.from({ length: 6 }, (_, index) => character(index + 1));
}

function generatedPlan(): GeneratedPlan {
  return {
    plan: { logline: "", tags: [], chapters: [] },
    bible: "# 世界观",
    outlineMd: "# 主线",
  };
}

describe("角色生成结构校验", () => {
  it("接受 6-10 位字段完整且姓名不重复的角色", async () => {
    const { validateGeneratedCharacters } = await import("@/lib/agents");
    expect(validateGeneratedCharacters(validCharacters())).toHaveLength(6);
  });

  it("角色数量不足、姓名重复或字段缺失都会被拒绝", async () => {
    const { validateGeneratedCharacters } = await import("@/lib/agents");
    expect(() => validateGeneratedCharacters(validCharacters().slice(0, 5))).toThrow(
      /6-10/,
    );
    expect(() =>
      validateGeneratedCharacters([
        ...validCharacters(),
        character(1, { name: "角色1号" }),
      ]),
    ).toThrow(/姓名重复/);
    expect(() =>
      validateGeneratedCharacters(
        validCharacters().map((item, index) =>
          index === 0 ? { ...item, goals: "" } : item,
        ),
      ),
    ).toThrow(/缺少：目标/);
  });

  it("结构校验失败时受控重试一次，成功返回完整角色", async () => {
    const { generateCharacters } = await import("@/lib/agents");
    let attempts = 0;
    const { client, calls } = makeFake(async (text) => {
      if (!text.includes("设计 6-10 位核心角色")) {
        throw new Error(`未识别提示词：${text.slice(0, 60)}`);
      }
      attempts += 1;
      const items = validCharacters();
      if (attempts === 1) items[1] = character(2, { name: "角色1号" });
      return { characters: items };
    });

    const characters = await generateCharacters(meta(12), generatedPlan(), { client });

    expect(characters).toHaveLength(6);
    expect(calls).toHaveLength(2);
  });

  it("角色 JSON 被截断时给出明确错误，不重复请求全部架构", async () => {
    const { generateCharacters } = await import("@/lib/agents");
    const { LLMOutputTruncatedError } = await import("@/lib/llm");
    const { client, calls } = makeFake(async () => {
      throw new LLMOutputTruncatedError({
        content: '{"characters":[',
        finishReason: "length",
        maxTokens: 16384,
        attempts: 3,
      });
    });

    await expect(
      generateCharacters(meta(12), generatedPlan(), { client }),
    ).rejects.toThrow(/角色生成失败.*Tokens 上限/);
    expect(calls).toHaveLength(1);
  });
});
