import { describe, expect, it } from "vitest";
import {
  applyChapterMemory,
  buildChapterMemory,
  buildEffectiveMemory,
  buildMemoryContext,
  collectOpenForeshadows,
  MEMORY_CHAR_BUDGET,
  MEMORY_TOKEN_BUDGET,
  parseOutlineForeshadows,
  parseVolumesFromOutline,
} from "@/lib/memory";
import type { ProjectDetail } from "@/lib/types";

const updatedAt = "2026-11-17T00:00:00.000Z";

function fixture(): ProjectDetail {
  return {
    meta: {
      slug: "memory-test",
      title: "记忆测试",
      genre: "玄幻",
      tone: "悬疑",
      idea: "玉佩与旧案",
      author: "测试",
      language: "zh-CN",
      targetChapters: 4,
      wordsPerChapter: 2000,
      createdAt: updatedAt,
      updatedAt,
    },
    plan: {
      logline: "少年追查玉佩背后的旧案。",
      tags: ["玄幻", "悬疑"],
      chapters: [
        { index: 1, title: "开端", summary: "张三在客栈发现玉佩。", keyBeats: ["发现玉佩"] },
        { index: 2, title: "变故", summary: "李四在客栈遇害，张三被追捕。", keyBeats: ["李四死亡"] },
        { index: 3, title: "追查", summary: "张三追查黑衣人，玉佩秘密揭开。", keyBeats: ["追踪黑衣人"] },
        { index: 4, title: "深入", summary: "张三追查玉佩的下落。", keyBeats: ["追查玉佩"] },
      ],
    },
    bible: `# 世界观
## 世界规则
- 夜间不能点灯。
## 核心矛盾
- 旧案真相与活人利益的冲突。`,
    outlineMd: `# 全书主线大纲
## 分卷结构
- 第一卷（1-2章）：开端。张三发现玉佩并卷入旧案。
- 第二卷（3-4章）：追查。张三追查黑衣人。
## 主线冲突
- 张三与黑衣人争夺玉佩。
## 伏笔与回收点
- 伏笔：玉佩的秘密（第1章埋，第3章回收）。
### 第 3 章 · 追查
### 第 4 章 · 深入`,
    characters: [
      {
        name: "张三",
        role: "主角",
        gender: "男",
        age: "二十",
        appearance: "",
        personality: "冷静",
        background: "",
        goals: "查清旧案",
        arc: "",
        relationships: "与李四是朋友",
        speechStyle: "",
        source: "user",
      },
    ],
    state: {
      written: [1, 2, 3],
      summaries: {
        "1": "张三在客栈发现玉佩，黑衣人出现。",
        "2": "李四在客栈遇害，张三被追捕。",
        "3": "张三追查黑衣人，玉佩秘密揭开。",
      },
      reviews: {},
      rejectedDrafts: {},
      repairs: {},
      publishHistory: [],
      updatedAt,
    },
    chapters: [
      { index: 1, title: "开端", content: "第一章正文", words: 6, written: true },
      { index: 2, title: "变故", content: "第二章正文", words: 6, written: true },
      { index: 3, title: "追查", content: "第三章正文", words: 6, written: true },
      { index: 4, title: "深入", content: "", words: 0, written: false },
    ],
    canon: {
      characters: [
        {
          name: "张三",
          aliases: [],
          status: "alive",
          location: "客栈",
          note: "持有玉佩",
          statusChapter: 1,
          chapter: 2,
        },
        {
          name: "李四",
          aliases: [],
          status: "dead",
          location: "客栈",
          note: "第2章遇害",
          statusChapter: 2,
          chapter: 2,
        },
        {
          name: "王五",
          aliases: ["黑衣人"],
          status: "alive",
          location: "城外",
          note: "追捕张三",
          statusChapter: 3,
          chapter: 3,
        },
      ],
      items: [
        {
          name: "玉佩",
          aliases: [],
          holder: "张三",
          state: "完整",
          note: "刻有旧案纹样",
          chapter: 1,
        },
      ],
      timeline: {
        currentDay: "第三日",
        deadlines: [
          { name: "旧案重启", due: "三日后", note: "官府重查", chapter: 2 },
        ],
      },
      rules: ["夜间不能点灯。", "玉佩不可离身。"],
      lastChapter: 3,
      updatedAt,
    },
    publish: {
      fanqie: {
        enabled: true,
        bookId: "",
        bookName: "",
        autoSubmit: false,
        headless: false,
        selectors: {},
      },
    },
    publishLedger: { version: 1, records: {}, updatedAt },
    pendingChapters: 1,
  };
}

describe("分层记忆解析与聚合", () => {
  it("解析分卷结构和伏笔回收点", () => {
    const detail = fixture();
    const volumes = parseVolumesFromOutline(detail.outlineMd);
    expect(volumes.map((item) => [item.startChapter, item.endChapter])).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(volumes[0].title).toContain("第1卷");
    expect(volumes[0].goal).toContain("玉佩");

    const foreshadows = parseOutlineForeshadows(detail.outlineMd);
    expect(foreshadows).toHaveLength(1);
    expect(foreshadows[0]).toMatchObject({
      plantedChapter: 1,
      resolvedChapter: 3,
    });
    expect(foreshadows[0].text).toContain("玉佩");
  });

  it("从现有摘要、台账和大纲生成基础记忆与全书/分卷聚合", () => {
    const detail = fixture();
    const memory = buildEffectiveMemory(detail, null);

    expect(Object.keys(memory.chapters).sort()).toEqual(["1", "2", "3"]);
    expect(memory.chapters["1"].source).toBe("summary");
    expect(memory.chapters["1"].characters).toContain("张三");
    expect(memory.chapters["1"].newSettings).toContain("物品：玉佩");
    // 大纲伏笔只进计划台账，不能因为章节已写就被当成实际埋设。
    expect(memory.chapters["1"].foreshadowsPlanted).toEqual([]);
    expect(memory.chapters["3"].foreshadowsResolved).toEqual([]);
    expect(memory.volumes).toHaveLength(2);
    expect(memory.book.logline).toContain("玉佩");
    expect(memory.book.keyConflicts.join("")).toContain("黑衣人");
    expect(memory.book.finalGoal).toContain("旧案");
  });

  it("只有正文抽取出的伏笔才会进入待回收列表", () => {
    const detail = fixture();
    const planOnly = buildEffectiveMemory(detail, null);
    // 大纲计划第 1 章埋、第 3 章回收，但正文抽取没有记录，检索不到。
    expect(collectOpenForeshadows(planOnly, 3)).toEqual([]);
    expect(collectOpenForeshadows(planOnly, 4)).toEqual([]);

    const memory = buildEffectiveMemory(detail, null);
    memory.chapters["1"].source = "ai";
    memory.chapters["3"].source = "ai";
    memory.chapters["1"].foreshadowsPlanted = ["玉佩的秘密"];
    memory.chapters["3"].foreshadowsResolved = ["玉佩的秘密"];
    expect(collectOpenForeshadows(memory, 3).map((item) => item.text)).toEqual([
      "玉佩的秘密",
    ]);
    expect(collectOpenForeshadows(memory, 4)).toEqual([]);
  });

  it("区分本次注入条数与记忆中真实的未回收总数", () => {
    const detail = fixture();
    const memory = buildEffectiveMemory(detail, null);
    memory.chapters["1"].source = "ai";
    memory.chapters["1"].foreshadowsPlanted = Array.from(
      { length: 15 },
      (_, index) => `伏笔线索${index + 1}`,
    );

    const retrieval = buildMemoryContext(detail, detail.plan.chapters[3], memory, {
      recentWindow: 0,
    });

    // 注入有 12 条上限，但日志要能说出真实还有多少条。
    expect(retrieval.openForeshadows).toHaveLength(12);
    expect(retrieval.openForeshadowTotal).toBe(15);
  });

  it("旧项目 summary 记忆中的大纲伏笔不会被当成实际埋设", () => {
    const detail = fixture();
    const memory = buildEffectiveMemory(detail, null);
    memory.chapters["1"].foreshadowsPlanted = ["玉佩的秘密"];
    memory.chapters["3"].foreshadowsResolved = ["玉佩的秘密"];
    expect(collectOpenForeshadows(memory, 3)).toEqual([]);
    expect(collectOpenForeshadows(memory, 4)).toEqual([]);
  });

  it("动态检索只使用当前章之前的记忆，并遵守预算", () => {
    const detail = fixture();
    const memory = buildEffectiveMemory(detail, null);
    const chapter = detail.plan.chapters[3];
    const retrieval = buildMemoryContext(detail, chapter, memory, { recentWindow: 0 });

    expect(retrieval.chapter).toBe(4);
    expect(retrieval.chapterIndices).not.toContain(4);
    expect(retrieval.chapterIndices.length).toBeGreaterThan(0);
    expect(retrieval.text).toContain("全书记忆");
    expect(retrieval.text).toContain("张三");
    expect(retrieval.text).toContain("玉佩");
    expect(retrieval.text).toContain("第 1 章");
    expect(retrieval.tokenEstimate).toBeLessThanOrEqual(MEMORY_TOKEN_BUDGET);
    expect(retrieval.text.length).toBeLessThanOrEqual(MEMORY_CHAR_BUDGET + 20);
    expect(retrieval.sources.length).toBeGreaterThan(0);

    const tight = buildMemoryContext(detail, chapter, memory, {
      recentWindow: 0,
      budget: 500,
    });
    expect(tight.truncated).toBe(true);
    expect(tight.text.length).toBeLessThanOrEqual(520);
  });

  it("预算紧张时优先保留人物生死和未回收伏笔", () => {
    const detail = fixture();
    const memory = buildEffectiveMemory(detail, null);
    memory.chapters["1"].source = "ai";
    memory.chapters["1"].foreshadowsPlanted = ["玉佩的秘密"];
    const chapter = detail.plan.chapters[3];
    const retrieval = buildMemoryContext(detail, chapter, memory, {
      recentWindow: 0,
      budget: 260,
    });
    expect(retrieval.truncated).toBe(true);
    expect(retrieval.text).toContain("李四");
    expect(retrieval.text).toContain("第 2 章死亡");
    expect(retrieval.text).toContain("玉佩的秘密");
    expect(retrieval.text.length).toBeLessThanOrEqual(280);
  });

  it("手工维护的全书和分卷记忆不会被章节更新覆盖", () => {
    const detail = fixture();
    const stored = buildEffectiveMemory(detail, null);
    stored.book.source = "manual";
    stored.book.logline = "手工主线";
    stored.volumes[0].source = "manual";
    stored.volumes[0].goal = "手工卷目标";

    const chapter = buildChapterMemory(
      4,
      "第四章摘要",
      undefined,
      "ai",
    );
    const next = applyChapterMemory(detail, stored, chapter);

    expect(next.chapters["4"].summary).toBe("第四章摘要");
    expect(next.book.source).toBe("manual");
    expect(next.book.logline).toBe("手工主线");
    expect(next.volumes[0].source).toBe("manual");
    expect(next.volumes[0].goal).toBe("手工卷目标");
  });
});
