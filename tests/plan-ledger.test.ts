import { describe, expect, it } from "vitest";
import { mergeCanon } from "@/lib/canon";
import {
  assertValidPlanLedger,
  derivePlanLedger,
  formatPlanContext,
  normalizePlanLedger,
  reconcileChapterPlan,
  sanitizeGeneratedPlanLedger,
} from "@/lib/plan-ledger";
import type {
  CanonFacts,
  ChapterMemory,
  ExtractedFacts,
  PlanLedger,
  ProjectPlan,
} from "@/lib/types";

const AT = "2026-11-20T00:00:00.000Z";

function plan(): ProjectPlan {
  return {
    logline: "",
    tags: [],
    chapters: [1, 2, 3, 4].map((index) => ({
      index,
      title: `章节${index}`,
      summary: "",
      keyBeats: [],
    })),
  };
}

function canon(overrides: Partial<CanonFacts> = {}): CanonFacts {
  return {
    characters: [],
    items: [],
    timeline: { currentDay: "", deadlines: [] },
    rules: [],
    lastChapter: 1,
    updatedAt: AT,
    ...overrides,
  };
}

function memory(overrides: Partial<ChapterMemory> = {}): ChapterMemory {
  return {
    index: 1,
    summary: "",
    events: [],
    characters: [],
    actions: [],
    time: "",
    location: "",
    endingState: "",
    newSettings: [],
    foreshadowsPlanted: [],
    foreshadowsResolved: [],
    source: "ai",
    updatedAt: AT,
    ...overrides,
  };
}

function baseLedger(): PlanLedger {
  return normalizePlanLedger({
    version: 1,
    events: [
      {
        id: "plan-event-1",
        name: "发现玉佩",
        chapter: 1,
        participants: ["角色甲"],
        process: "角色甲在客栈发现玉佩",
        expectedResult: "得到关键线索",
      },
    ],
    foreshadows: [
      {
        id: "plan-foreshadow-1",
        text: "玉佩的秘密",
        plantChapter: 1,
        resolveChapter: 3,
        purpose: "引出旧案",
      },
    ],
    updatedAt: AT,
  });
}

describe("计划台账模型", () => {
  it("模型自报的 realized 会被降回 planned，且不能自带实际章节", () => {
    const ledger = sanitizeGeneratedPlanLedger({
      events: [
        {
          id: "plan-event-1",
          name: "计划事件",
          chapter: 1,
          status: "realized",
          actualChapter: 1,
          actualEventIds: ["evt-1"],
          evidence: "模型编造的证据",
        },
      ],
      foreshadows: [
        {
          id: "plan-foreshadow-1",
          text: "计划伏笔",
          plantChapter: 1,
          resolveChapter: 2,
          status: "realized",
          actualPlantChapter: 1,
          actualResolveChapter: 2,
        },
      ],
    });
    expect(ledger.events[0]).toMatchObject({
      status: "planned",
      actualChapter: 0,
      actualEventIds: [],
      evidence: "",
    });
    expect(ledger.foreshadows[0]).toMatchObject({
      status: "planned",
      actualPlantChapter: 0,
      actualResolveChapter: 0,
    });
  });

  it("校验会拒绝不存在的章节和断裂的事件引用", () => {
    const outOfRange = normalizePlanLedger({
      events: [{ id: "e1", name: "越界事件", chapter: 9 }],
    });
    expect(() => assertValidPlanLedger(outOfRange, plan())).toThrow(/不存在的第 9 章/);

    const brokenRef = normalizePlanLedger({
      events: [{ id: "e1", name: "事件", chapter: 1, relatedEventIds: ["missing"] }],
    });
    expect(() => assertValidPlanLedger(brokenRef, plan())).toThrow(/不存在的事件 ID/);

    const badForeshadow = normalizePlanLedger({
      foreshadows: [{ text: "伏笔", plantChapter: 3, resolveChapter: 2 }],
    });
    expect(() => assertValidPlanLedger(badForeshadow, plan())).toThrow(/回收章节早于埋设章节/);
  });

  it("旧大纲迁移只生成 planned，不产生实际埋设章节", () => {
    const ledger = derivePlanLedger(
      plan(),
      "- 伏笔：玉佩的秘密（第1章埋，第3章回收）。",
    );
    expect(ledger.foreshadows).toHaveLength(1);
    expect(ledger.foreshadows[0]).toMatchObject({
      plantChapter: 1,
      resolveChapter: 3,
      status: "planned",
      actualPlantChapter: 0,
      actualResolveChapter: 0,
    });
    expect(ledger.events.every((event) => event.status === "planned")).toBe(true);
  });

  it("只注入本章计划，不把未来章节当成已发生", () => {
    const ledger = normalizePlanLedger({
      events: [
        { id: "e1", name: "本章事件", chapter: 2 },
        { id: "e2", name: "未来事件", chapter: 4 },
      ],
    });
    const text = formatPlanContext(ledger, plan().chapters[1]);
    expect(text).toContain("本章事件");
    expect(text).not.toContain("未来事件");
  });
});

describe("事实台账冲突保护", () => {
  const base = canon({
    items: [
      {
        name: "玉佩",
        aliases: [],
        holder: "角色甲",
        state: "完整",
        note: "",
        chapter: 1,
      },
    ],
    lastChapter: 1,
  });

  function extracted(holder: string, evidence: string): ExtractedFacts {
    return {
      summary: "角色乙出现。",
      characters: [],
      items: [
        { name: "玉佩", aliases: [], holder, state: "完整", note: "", evidence },
      ],
      timeline: null,
      rules: [],
    };
  }

  it("物品转移证据不足时保留原持有人并记录冲突", () => {
    const result = mergeCanon(base, extracted("角色乙", "角色乙拿走了它。"), 2, "write");
    expect(result.canon.items[0].holder).toBe("角色甲");
    expect(result.conflicts.some((issue) => issue.type === "物品归属")).toBe(true);
  });

  it("证据同时点名物品和新持有人时才允许转移", () => {
    const result = mergeCanon(
      base,
      extracted("角色乙", "角色乙从角色甲手中拿走玉佩。"),
      2,
      "write",
    );
    expect(result.canon.items[0].holder).toBe("角色乙");
    expect(result.conflicts.some((issue) => issue.type === "物品归属")).toBe(false);
  });
});

describe("章节完成后的计划对账", () => {
  it("只有正文证据匹配时才标记 realized", () => {
    const result = reconcileChapterPlan({
      ledger: baseLedger(),
      chapter: 1,
      chapterMemory: memory({
        summary: "角色甲在客栈发现玉佩，得到旧案线索。",
        events: ["角色甲在客栈发现玉佩"],
      }),
      storyEvents: [
        {
          id: "evt-1-1",
          name: "角色甲在客栈发现玉佩",
          chapter: 1,
          time: "",
          location: "客栈",
          participants: ["角色甲"],
          cause: "",
          process: "角色甲在客栈发现玉佩，得到旧案线索。",
          result: "",
          impact: "",
          relatedEventIds: [],
          foreshadowIds: [],
          source: "ai",
          updatedAt: AT,
        },
      ],
      canon: canon(),
    });
    const event = result.ledger.events[0];
    expect(event.status).toBe("realized");
    expect(event.actualChapter).toBe(1);
    expect(event.actualEventIds).toEqual(["evt-1-1"]);
    expect(event.evidence).toContain("发现玉佩");
  });

  it("正文没有对应事件时标记偏离，并记录偏离原因", () => {
    const result = reconcileChapterPlan({
      ledger: baseLedger(),
      chapter: 1,
      chapterMemory: memory({ summary: "角色乙在码头等船，天气转冷。" }),
      canon: canon(),
    });
    expect(result.ledger.events[0].status).toBe("deviated");
    expect(result.ledger.events[0].actualChapter).toBe(1);
    const deviation = result.ledger.deviations.find(
      (item) => item.planType === "event" && item.planId === "plan-event-1",
    );
    expect(deviation?.chapter).toBe(1);
    expect(deviation?.reason).toContain("未落实");
  });

  it("计划伏笔没有正文埋设证据时不能升级为已埋设", () => {
    const result = reconcileChapterPlan({
      ledger: baseLedger(),
      chapter: 1,
      chapterMemory: memory({ summary: "角色甲在客栈休息。" }),
      canon: canon(),
    });
    const foreshadow = result.ledger.foreshadows[0];
    expect(foreshadow.status).toBe("deviated");
    expect(foreshadow.actualPlantChapter).toBe(0);
    expect(result.ledger.deviations.some((item) => item.planType === "foreshadow")).toBe(true);
  });

  it("正文确有伏笔证据时才记录实际埋设章节", () => {
    const result = reconcileChapterPlan({
      ledger: baseLedger(),
      chapter: 1,
      chapterMemory: memory({
        summary: "角色甲发现玉佩背面的刻字。",
        foreshadowsPlanted: ["玉佩的秘密"],
      }),
      canon: canon(),
    });
    const foreshadow = result.ledger.foreshadows[0];
    expect(foreshadow.actualPlantChapter).toBe(1);
    expect(foreshadow.evidence).toContain("玉佩的秘密");
    expect(foreshadow.status).not.toBe("deviated");
  });

  it("到达计划回收章节但没有回收证据时不能标记已回收", () => {
    const ledger = baseLedger();
    ledger.foreshadows[0].actualPlantChapter = 1;
    ledger.foreshadows[0].status = "partially_realized";
    const result = reconcileChapterPlan({
      ledger,
      chapter: 3,
      chapterMemory: memory({ index: 3, summary: "角色甲继续赶路。" }),
      canon: canon(),
    });
    const foreshadow = result.ledger.foreshadows[0];
    expect(foreshadow.actualResolveChapter).toBe(0);
    expect(foreshadow.status).toBe("partially_realized");
    expect(result.ledger.deviations.some((item) => item.planType === "foreshadow")).toBe(true);
  });

  it("计划中的人物死亡不会写进事实台账", () => {
    const ledger = normalizePlanLedger({
      characterChanges: [
        {
          id: "plan-char-1",
          character: "角色甲",
          chapter: 8,
          before: "存活",
          after: "死亡",
          reason: "剧情需要",
        },
      ],
    });
    const result = reconcileChapterPlan({
      ledger,
      chapter: 1,
      chapterMemory: memory({ summary: "角色甲正常行动。" }),
      canon: canon(),
    });
    expect(result.ledger.characterChanges[0].status).toBe("planned");
    expect(result.ledger.characterChanges[0].actualChapter).toBe(0);
    expect(
      result.ledger.deviations.some((item) => item.planType === "character-change"),
    ).toBe(false);
  });
});
