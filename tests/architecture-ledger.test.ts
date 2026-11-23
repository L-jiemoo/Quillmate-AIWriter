import { describe, expect, it } from "vitest";
import {
  assertValidPlanLedger,
  detectFuturePlanConsumption,
  ensureItemRegistryCoverage,
  normalizePlanLedger,
} from "@/lib/plan-ledger";
import { itemOwnershipAt, relationsAt } from "@/lib/plan-view";
import {
  buildInitialCanon,
  emptyCanon,
  formatCanonForPrompt,
  mergeCanon,
  normalizeArchitectureFacts,
  normalizeCanon,
} from "@/lib/canon";
import type {
  CanonFact,
  ChapterMemory,
  Character,
  ExtractedFacts,
  ProjectPlan,
} from "@/lib/types";

const plan: ProjectPlan = {
  logline: "",
  tags: [],
  chapters: [
    { index: 1, title: "开端", summary: "开端", keyBeats: [] },
    { index: 2, title: "转折", summary: "转折", keyBeats: [] },
    { index: 3, title: "收束", summary: "收束", keyBeats: [] },
    { index: 4, title: "余波", summary: "余波", keyBeats: [] },
  ],
};

function character(name: string): Character {
  return {
    name,
    role: "配角",
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

function ledger() {
  return normalizePlanLedger({
    events: [
      { id: "evt-1", name: "交接", chapter: 2, thread: "主线" },
    ],
    itemRegistry: [
      {
        id: "item-1",
        name: "账本",
        aliases: ["旧账"],
        holder: "角色甲",
        location: "书房",
        state: "完好",
        introducedChapter: 1,
      },
    ],
    items: [
      {
        id: "chg-1",
        item: "旧账",
        chapter: 2,
        changeType: "transfer",
        holder: "角色乙",
        location: "客厅",
        state: "完好",
        reason: "当面转交",
      },
      {
        id: "chg-2",
        item: "账本",
        chapter: 4,
        changeType: "state",
        state: "损毁",
        reason: "被撕毁",
      },
    ],
    relations: [
      {
        id: "rel-1",
        from: "角色甲",
        to: "角色乙",
        type: "同僚",
        strength: 4,
        direction: "two-way",
        startChapter: 1,
        endChapter: 3,
      },
      {
        id: "rel-2",
        from: "角色甲",
        to: "角色乙",
        type: "对手",
        strength: 5,
        direction: "one-way",
        startChapter: 4,
        endChapter: 0,
      },
    ],
  });
}

describe("架构关系图与物品归属", () => {
  it("关系按章节区间切片", () => {
    const value = ledger();
    expect(relationsAt(value, 2).map((item) => item.type)).toEqual(["同僚"]);
    expect(relationsAt(value, 4).map((item) => item.type)).toEqual(["对手"]);
  });

  it("物品快照按章节应用转移与状态变化", () => {
    const value = ledger();
    expect(itemOwnershipAt(value, 1)[0]).toMatchObject({
      item: "账本",
      holder: "角色甲",
      location: "书房",
      state: "完好",
    });
    expect(itemOwnershipAt(value, 2)[0]).toMatchObject({
      holder: "角色乙",
      location: "客厅",
      changedChapter: 2,
    });
    expect(itemOwnershipAt(value, 4)[0]).toMatchObject({
      holder: "角色乙",
      location: "客厅",
      state: "损毁",
      changedChapter: 4,
    });
  });

  it("introduce 变化会自动补进物品基线", () => {
    const value = normalizePlanLedger({
      items: [
        {
          id: "chg-1",
          item: "新钥匙",
          chapter: 3,
          changeType: "introduce",
          holder: "角色甲",
          location: "门房",
          state: "完好",
          reason: "本章取得",
        },
      ],
    });
    const covered = ensureItemRegistryCoverage(value);
    expect(covered.itemRegistry[0]).toMatchObject({
      name: "新钥匙",
      introducedChapter: 3,
      location: "门房",
    });
    expect(() => assertValidPlanLedger(covered, plan)).not.toThrow();
  });

  it("未登记的物品变化会自动补进基线，避免整批续排失败", () => {
    const value = normalizePlanLedger({
      itemRegistry: [
        {
          id: "item-1",
          name: "账本",
          holder: "角色甲",
          location: "书房",
          state: "完好",
          introducedChapter: 1,
        },
      ],
      items: [
        {
          id: "chg-1",
          item: "钥匙",
          chapter: 2,
          changeType: "transfer",
          holder: "角色乙",
          location: "门房",
          state: "完好",
          reason: "当面转交",
        },
      ],
    });
    const covered = ensureItemRegistryCoverage(value);
    expect(covered.itemRegistry.some((item) => item.name === "钥匙")).toBe(true);
    expect(() => assertValidPlanLedger(covered, plan)).not.toThrow();
  });

  it("关系端点必须存在于角色名单，物品变化必须引用已登记物品", () => {
    expect(() =>
      assertValidPlanLedger(ledger(), plan, [character("角色甲"), character("角色乙")]),
    ).not.toThrow();
    expect(() =>
      assertValidPlanLedger(ledger(), plan, [character("角色甲")]),
    ).toThrow(/不存在的人物/);

    const bad = normalizePlanLedger({
      itemRegistry: [
        {
          id: "item-1",
          name: "账本",
          holder: "角色甲",
          location: "书房",
          state: "完好",
          introducedChapter: 1,
        },
      ],
      items: [{ id: "chg-1", item: "钥匙", chapter: 2, holder: "角色乙" }],
    });
    expect(() => assertValidPlanLedger(bad, plan)).toThrow(/未登记/);
  });
});

describe("提前消费后续章节检测", () => {
  const memory: ChapterMemory = {
    index: 1,
    summary: "角色甲尸变失踪",
    events: ["角色甲尸变后在夜里失踪"],
    characters: [],
    actions: [],
    time: "",
    location: "",
    endingState: "",
    newSettings: [],
    foreshadowsPlanted: [],
    foreshadowsResolved: [],
    source: "ai",
    updatedAt: "",
  };

  it("本章写出后面章节的计划事件时判为 critical", () => {
    const value = normalizePlanLedger({
      events: [
        {
          id: "evt-4",
          name: "角色甲尸变失踪",
          chapter: 4,
          participants: ["角色甲"],
          process: "角色甲尸变后在夜里失踪",
        },
      ],
    });
    const issues = detectFuturePlanConsumption(value, 1, undefined, memory);
    expect(issues[0]?.severity).toBe("critical");
    expect(issues[0]?.type).toBe("提前消费后续章节");
  });

  it("无关内容不会误报", () => {
    const value = normalizePlanLedger({
      events: [
        {
          id: "evt-4",
          name: "角色甲尸变失踪",
          chapter: 4,
          participants: ["角色甲"],
          process: "角色甲尸变后在夜里失踪",
        },
      ],
    });
    expect(
      detectFuturePlanConsumption(value, 1, undefined, {
        ...memory,
        summary: "角色乙在集市买米",
        events: ["角色乙在集市买米"],
      }),
    ).toEqual([]);
  });
});

describe("架构事实台账", () => {
  const facts: CanonFact[] = [
    {
      id: "fact-1",
      kind: "world",
      content: "世界规则甲不可违反",
      establishedAt: "architecture",
      chapter: 0,
      immutable: true,
      note: "",
    },
  ];

  it("初始化时写入架构事实与物品基线", () => {
    const canon = buildInitialCanon([character("角色甲")], {
      facts,
      items: [
        {
          name: "账本",
          aliases: ["旧账"],
          holder: "角色甲",
          location: "书房",
          state: "完好",
          note: "",
          chapter: 1,
        },
      ],
    });
    const text = formatCanonForPrompt(canon);
    expect(text).toContain("既定事实与硬性规则");
    expect(text).toContain("世界规则甲不可违反");
    expect(text).toContain("位置：书房");
  });

  it("抽取不会覆盖架构事实，新规则补稳定事实 ID", () => {
    const canon = buildInitialCanon([character("角色甲")], { facts });
    const extracted: ExtractedFacts = {
      summary: "新规则出现",
      characters: [],
      items: [],
      timeline: null,
      rules: ["新的硬性规则"],
    };
    const { canon: merged } = mergeCanon(canon, extracted, 2);
    expect(merged.facts?.some((fact) => fact.id === "fact-1")).toBe(true);
    const rule = merged.facts?.find((fact) => fact.content === "新的硬性规则");
    expect(rule).toMatchObject({
      kind: "rule",
      establishedAt: "chapter",
      chapter: 2,
    });
  });

  it("模型误塞的未来事件不会按不可变硬事实渲染", () => {
    const architectureFacts = normalizeArchitectureFacts([
      {
        id: "fact-event-1",
        kind: "event",
        content: "后续章节才会发生的剧情事件",
        immutable: true,
      },
      {
        id: "fact-rule-1",
        kind: "rule",
        content: "不可违背的硬规则",
        immutable: true,
      },
    ]);
    expect(
      architectureFacts.find((fact) => fact.id === "fact-event-1")?.immutable,
    ).toBe(false);
    const text = formatCanonForPrompt(
      buildInitialCanon([], { facts: architectureFacts }),
    );
    expect(text).toContain("既定事实与硬性规则");
    expect(text).not.toContain("后续章节才会发生的剧情事件");
  });

  it("非不可变的规则事实仍会注入提示词，不会被规则去重漏掉", () => {
    const canon = buildInitialCanon([], {
      facts: [
        {
          id: "fact-rule-x",
          kind: "rule",
          content: "信物不得离身",
          establishedAt: "chapter",
          chapter: 2,
          immutable: false,
          note: "",
        },
      ],
    });
    canon.rules.push("信物不得离身");
    const text = formatCanonForPrompt(canon);
    expect(text).toContain("既定事实与硬性规则");
    expect(text).toContain("信物不得离身");
  });

  it("大量世界设定不会把规则类事实挤出提示词", () => {
    const facts: CanonFact[] = Array.from({ length: 50 }, (_, index) => ({
      id: `fact-world-${index}`,
      kind: "world" as const,
      content: `世界设定 ${index}`,
      establishedAt: "architecture" as const,
      chapter: 0,
      immutable: true,
      note: "",
    }));
    facts.push({
      id: "fact-rule-last",
      kind: "rule",
      content: "信物不得离身",
      establishedAt: "chapter",
      chapter: 2,
      immutable: false,
      note: "",
    });
    const text = formatCanonForPrompt(buildInitialCanon([], { facts }));
    expect(text).toContain("信物不得离身");
  });

  it("旧 canon 没有 facts 时归一化不会凭空补空数组", () => {
    const legacy = { ...emptyCanon() } as Record<string, unknown>;
    delete legacy.facts;
    expect(normalizeCanon(legacy).facts).toBeUndefined();
    const canon = buildInitialCanon([character("角色甲")]);
    expect(formatCanonForPrompt(canon)).toContain("角色甲");
  });
});
