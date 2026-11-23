import { describe, expect, it } from "vitest";
import {
  applyChapterStory,
  buildEffectiveStory,
  buildStoryContext,
  characterStatesAt,
  eventsForCharacter,
  finalizeStory,
  normalizeStory,
  storyChecks,
  storyStats,
  STORY_CHAR_BUDGET,
} from "@/lib/story";
import { buildEffectiveMemory } from "@/lib/memory";
import type { ExtractedStory, ProjectDetail, StoryLedger } from "@/lib/types";

const updatedAt = "2026-11-17T00:00:00.000Z";

function fixture(): ProjectDetail {
  return {
    meta: {
      slug: "story-test",
      title: "剧情测试",
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
        { index: 4, title: "深入", summary: "张三进入山洞寻找黑衣人。", keyBeats: ["进入山洞"] },
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
      {
        name: "王五",
        role: "反派",
        gender: "男",
        age: "三十",
        appearance: "",
        personality: "阴沉",
        background: "",
        goals: "夺回玉佩",
        arc: "",
        relationships: "与张三敌对",
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
          chapter: 3,
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
        deadlines: [{ name: "旧案重启", due: "三日后", note: "官府重查", chapter: 2 }],
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

function extractedChapterFour(): ExtractedStory {
  return {
    states: [
      {
        name: "张三",
        identity: "追查者",
        age: "二十",
        location: "山洞",
        bodyState: "手臂受伤",
        lifeStatus: "alive",
        abilities: [],
        goals: ["抓住黑衣人"],
        knowledge: ["玉佩可以开启机关"],
        faction: "",
        experience: "进入山洞",
        evidence: "张三走进山洞。",
      },
    ],
    relations: [
      {
        from: "张三",
        to: "王五",
        type: "敌对",
        status: "山洞对峙",
        evidence: "张三与黑衣人对峙。",
      },
    ],
    events: [
      {
        name: "山洞对峙",
        time: "第三日夜里",
        location: "山洞",
        participants: ["张三", "王五"],
        cause: "追踪黑衣人",
        process: "张三进入山洞，与王五对峙。",
        result: "张三受伤",
        impact: "玉佩机关暴露",
        relatedEvents: [],
        foreshadows: ["玉佩的秘密"],
      },
    ],
  };
}

describe("剧情台账生成与增量更新", () => {
  it("从章节记忆和台账离线生成人物状态与事件，不把大纲伏笔当成已埋设", () => {
    const detail = fixture();
    const story = buildEffectiveStory(detail, null, null);
    const states = characterStatesAt(story, 3);

    expect(states.find((item) => item.name === "张三")).toMatchObject({
      location: "客栈",
      lifeStatus: "alive",
    });
    expect(states.find((item) => item.name === "李四")).toMatchObject({
      chapter: 2,
      lifeStatus: "dead",
    });
    expect(states.find((item) => item.name === "王五")).toMatchObject({
      location: "城外",
      lifeStatus: "alive",
    });
    expect(story.events.map((event) => event.chapter)).toEqual([1, 2, 3]);

    // 大纲写了“第 1 章埋、第 3 章回收”，但正文抽取没有证据：
    // 剧情台账必须为空，只有计划台账登记 planned。
    expect(story.foreshadows).toEqual([]);

    const stats = storyStats(detail, story);
    expect(stats.openForeshadows).toBe(0);
    expect(stats.overdueForeshadows).toBe(0);
    expect(stats.states).toBeGreaterThanOrEqual(3);
    expect(stats.events).toBeGreaterThanOrEqual(3);
  });

  it("章节增量更新会写入状态、关系和事件，并保留手工记录", () => {
    const detail = fixture();
    detail.state.written = [1, 2, 3, 4];
    detail.state.summaries["4"] = "张三进入山洞与王五对峙。";
    detail.chapters[3].written = true;
    detail.chapters[3].content = "第四章正文";
    const memory = buildEffectiveMemory(detail, null);
    memory.chapters["4"] = {
      index: 4,
      summary: "张三进入山洞与王五对峙。",
      events: ["山洞对峙"],
      characters: ["张三", "王五"],
      actions: ["张三：进入山洞"],
      time: "第三日夜里",
      location: "山洞",
      endingState: "张三受伤",
      newSettings: ["玉佩机关"],
      foreshadowsPlanted: ["玉佩的秘密"],
      foreshadowsResolved: ["玉佩的秘密"],
      source: "ai",
      updatedAt,
    };

    const base = buildEffectiveStory(detail, memory, null);
    base.events.push({
      id: "evt-4-manual-1",
      name: "作者补录：洞外接应",
      chapter: 4,
      time: "第三日夜里",
      location: "洞外",
      participants: ["王五"],
      cause: "",
      process: "",
      result: "",
      impact: "",
      relatedEventIds: [],
      foreshadowIds: [],
      source: "manual",
      updatedAt,
    });
    base.states.push({
      id: "state-4-manual",
      name: "张三",
      chapter: 4,
      identity: "作者手写身份",
      age: "",
      location: "洞口",
      bodyState: "",
      lifeStatus: "alive",
      abilities: [],
      goals: [],
      knowledge: [],
      faction: "",
      experience: "",
      eventIds: [],
      source: "manual",
      updatedAt,
    });

    const next = applyChapterStory(
      detail,
      memory,
      base,
      4,
      extractedChapterFour(),
      memory.chapters["4"],
    );

    expect(next.events.some((event) => event.name === "山洞对峙")).toBe(true);
    expect(next.events.some((event) => event.id === "evt-4-manual-1")).toBe(true);
    expect(next.relations.some((relation) => relation.from === "张三" && relation.to === "王五")).toBe(
      true,
    );
    const manualState = next.states.find((state) => state.id === "state-4-manual");
    expect(manualState?.identity).toBe("作者手写身份");
    const aiState = next.states.find(
      (state) => state.chapter === 4 && state.name === "张三" && state.source === "ai",
    );
    expect(aiState).toBeUndefined();
    const stateAtFour = characterStatesAt(next, 4).find((state) => state.name === "张三");
    expect(stateAtFour?.identity).toBe("作者手写身份");

    const foreshadow = next.foreshadows.find((item) => item.text.includes("玉佩"));
    expect(foreshadow?.status).not.toBe("resolved");
    expect(foreshadow?.resolutionCandidate).toContain("第 4 章");
  });

  it("人工删除的基础记录不会被下一次 seed 补回来", () => {
    const detail = fixture();
    const memory = buildEffectiveMemory(detail, null);
    const story = buildEffectiveStory(detail, memory, null);
    const target = story.events.find((event) => event.chapter === 1)!;
    expect(target).toBeTruthy();

    const next = buildEffectiveStory(detail, memory, {
      ...story,
      suppressedIds: [target.id],
    });
    expect(next.events.some((event) => event.id === target.id)).toBe(false);
    expect(next.suppressedIds).toContain(target.id);
  });

  it("作者确认回收后，自动聚合不会把伏笔改回未回收", () => {
    const detail = fixture();
    const memory = buildEffectiveMemory(detail, null);
    const story = buildEffectiveStory(detail, memory, null);
    // 作者手工登记一条“已回收”伏笔；自动聚合不能把它改回未回收。
    story.foreshadows.push({
      id: "fs-manual-1",
      text: "玉佩的秘密",
      plantedChapter: 1,
      relatedCharacters: ["张三"],
      expectedStartChapter: 1,
      expectedEndChapter: 3,
      status: "resolved",
      eventIds: [],
      resolution: "作者确认第 3 章回收",
      resolvedChapter: 3,
      resolutionCandidate: "",
      source: "manual",
      updatedAt,
    });
    const record = story.foreshadows.find((item) => item.text.includes("玉佩"))!;

    const next = finalizeStory(detail, memory, story);
    const kept = next.foreshadows.find((item) => item.id === record.id);
    expect(kept).toMatchObject({
      source: "manual",
      status: "resolved",
      resolvedChapter: 3,
    });
  });

  it("一致性检查能发现同时间异地、死亡人物后续事件和断裂关联", () => {
    const detail = fixture();
    const ledger: StoryLedger = normalizeStory({
      version: 1,
      updatedAt,
      states: [
        {
          id: "state-2-lisi",
          name: "李四",
          chapter: 2,
          identity: "",
          age: "",
          location: "客栈",
          bodyState: "",
          lifeStatus: "dead",
          abilities: [],
          goals: [],
          knowledge: [],
          faction: "",
          experience: "遇害",
          eventIds: [],
          source: "ai",
          updatedAt,
        },
      ],
      relations: [],
      events: [
        {
          id: "evt-2-1",
          name: "客栈会面",
          chapter: 2,
          time: "第一日",
          location: "客栈",
          participants: ["张三"],
          cause: "",
          process: "",
          result: "",
          impact: "",
          relatedEventIds: [],
          foreshadowIds: [],
          source: "ai",
          updatedAt,
        },
        {
          id: "evt-3-1",
          name: "城外追击",
          chapter: 3,
          time: "第一日",
          location: "城外",
          participants: ["张三", "李四"],
          cause: "",
          process: "",
          result: "",
          impact: "",
          relatedEventIds: ["evt-missing"],
          foreshadowIds: [],
          source: "ai",
          updatedAt,
        },
      ],
      foreshadows: [],
    });

    const issues = storyChecks(detail, ledger);
    expect(issues.some((issue) => issue.code === "same-time-different-locations")).toBe(true);
    expect(issues.some((issue) => issue.code === "dead-character-in-later-event")).toBe(true);
    expect(issues.some((issue) => issue.code === "broken-event-link")).toBe(true);
  });

  it("同一地点的不同粒度不算两地", () => {
    const detail = fixture();
    const event = (id: string, name: string, location: string) => ({
      id,
      name,
      chapter: 2,
      time: "第一日",
      location,
      participants: ["张三"],
      cause: "",
      process: "",
      result: "",
      impact: "",
      relatedEventIds: [],
      foreshadowIds: [],
      source: "ai" as const,
      updatedAt,
    });
    const ledger = normalizeStory({
      version: 1,
      updatedAt,
      states: [],
      relations: [],
      events: [
        event("evt-2-1", "村口会面", "甲村"),
        event("evt-2-2", "院中议事", "甲村西空院"),
      ],
      foreshadows: [],
    });
    expect(
      storyChecks(detail, ledger).some(
        (issue) => issue.code === "same-time-different-locations",
      ),
    ).toBe(false);
  });

  it("写作前检索只包含目标章之前的状态、事件和未回收伏笔", () => {
    const detail = fixture();
    const memory = buildEffectiveMemory(detail, null);
    const story = buildEffectiveStory(detail, memory, null);
    const chapter = detail.plan.chapters[3];
    const retrieval = buildStoryContext(detail, chapter, memory, story);

    expect(retrieval.chapter).toBe(4);
    expect(retrieval.text).toContain("人物动态状态");
    expect(retrieval.text).toContain("未回收伏笔");
    expect(retrieval.text).toContain("张三");
    expect(retrieval.text).toContain("玉佩");
    expect(retrieval.chapterIndices).not.toContain(4);
    expect(retrieval.text.length).toBeLessThanOrEqual(STORY_CHAR_BUDGET + 20);
    expect(retrieval.sources.length).toBeGreaterThan(0);
    expect(
      eventsForCharacter(story, "李四").every((event) => event.chapter <= 3),
    ).toBe(true);
  });
});
