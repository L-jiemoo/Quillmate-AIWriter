import { describe, expect, it } from "vitest";
import { collectRepairEvidence } from "@/lib/repair-context";
import type {
  CanonFacts,
  ChapterContent,
  ChapterPlan,
  ContinuityIssue,
  ProjectDetail,
  StoryLedger,
} from "@/lib/types";

function chapter(index: number, content: string): ChapterContent {
  return {
    index,
    title: `第${index}章`,
    content,
    words: content.length,
    written: true,
  };
}

function detail(chapters: ChapterContent[]): ProjectDetail {
  return {
    meta: {} as ProjectDetail["meta"],
    plan: { logline: "", tags: [], chapters: [] },
    bible: "",
    outlineMd: "",
    characters: [],
    state: {} as ProjectDetail["state"],
    chapters,
    canon: {} as CanonFacts,
    publish: {} as ProjectDetail["publish"],
    publishLedger: {} as ProjectDetail["publishLedger"],
    pendingChapters: 0,
  };
}

const plan: ChapterPlan = { index: 8, title: "第八章", summary: "", keyBeats: [] };

const issue: ContinuityIssue = {
  severity: "critical",
  type: "时间线",
  evidence: "角色乙今晚不该在巷口。",
  detail: "与第 4 章电话内容冲突。",
};

describe("修复原文证据检索", () => {
  it("问题明确提到第 4 章时，即使不在最近三章也能检索到原文", () => {
    const project = detail([
      chapter(1, "第一章：角色甲进城。"),
      chapter(2, "第二章：角色甲找到住处。"),
      chapter(3, "第三章：某组织出现。"),
      chapter(4, "角色乙在外地超市收银台旁接电话，警告角色甲今晚不要去巷口。"),
      chapter(5, "第五章：角色甲收到消息。"),
      chapter(6, "第六章：角色甲前往巷口。"),
      chapter(7, "第七章：角色甲见到角色乙。"),
      chapter(8, "第八章：冲突爆发。"),
    ]);

    const evidence = collectRepairEvidence({
      project,
      chapter: plan,
      issues: [issue],
    });

    const found = evidence.snippets.find((item) => item.chapter === 4);
    expect(found).toBeTruthy();
    expect(found?.reason).toBe("问题引用章节");
    expect(found?.snippet).toContain("角色乙在外地超市收银台旁接电话");
    expect(found?.locator).toContain("第 4 章");
    expect(evidence.text).toContain("【原文证据");
    expect(evidence.text).toContain("（原文）");
  });

  it("问题证据用省略号拼接多段时，能分别检索到对应章节", () => {
    const project = detail([
      chapter(2, "前文留下过一枚旧铜牌。"),
      chapter(3, "第三章：无关内容。"),
      chapter(5, "后文又找到了同一枚旧铜牌。"),
      chapter(8, "本章正文。"),
    ]);
    const multi: ContinuityIssue = {
      severity: "critical",
      type: "物品归属",
      evidence: "前文留下过一枚旧铜牌。……后文又找到了同一枚旧铜牌。",
      detail: "铜牌出现两次，归属需要确认。",
    };

    const evidence = collectRepairEvidence({
      project,
      chapter: plan,
      issues: [multi],
    });

    expect(evidence.snippets.some((item) => item.chapter === 2)).toBe(true);
    expect(evidence.snippets.some((item) => item.chapter === 5)).toBe(true);
  });

  it("问题未写章节时按涉及人物检索原文", () => {
    const project = detail([
      chapter(2, "角色乙在电话里说自己在外地。"),
      chapter(3, "角色甲独自调查。"),
      chapter(8, "本章正文。"),
    ]);
    project.characters = [
      {
        name: "角色乙",
        role: "配角",
        gender: "女",
        age: "未知",
        appearance: "",
        personality: "",
        background: "",
        goals: "",
        arc: "",
        relationships: "",
        speechStyle: "",
      },
    ];
    const noRef: ContinuityIssue = {
      severity: "critical",
      type: "人物行为",
      evidence: "角色乙突然出现在巷口。",
      detail: "与既有行为不符。",
    };

    const evidence = collectRepairEvidence({
      project,
      chapter: plan,
      issues: [noRef],
    });

    expect(evidence.snippets.some((item) => item.chapter === 2)).toBe(true);
    expect(
      evidence.snippets.find((item) => item.chapter === 2)?.reason,
    ).toContain("涉及人物");
  });

  it("引用章节没有正文时明确提示缺失，不编造证据", () => {
    const project = detail([chapter(8, "本章正文。")]);
    const evidence = collectRepairEvidence({
      project,
      chapter: plan,
      issues: [issue],
    });

    expect(evidence.missingChapters).toContain(4);
    expect(evidence.text).toContain("缺失证据");
    expect(evidence.text).toContain("不能凭想象补写");
  });

  it("同一人物多个事件时按事件关键词定位到正确章节", () => {
    const project = detail([
      chapter(2, "第2章：角色乙在外地超市收银台旁接电话。"),
      chapter(3, "第3章：角色甲独自调查。"),
      chapter(6, "第6章：角色乙在巷口被某组织的人围住。"),
      chapter(8, "本章正文。"),
    ]);
    project.characters = [
      {
        name: "角色乙",
        role: "配角",
        gender: "女",
        age: "未知",
        appearance: "",
        personality: "",
        background: "",
        goals: "",
        arc: "",
        relationships: "",
        speechStyle: "",
      },
    ];
    const story: StoryLedger = {
      version: 1,
      states: [],
      relations: [],
      events: [
        {
          id: "event-1",
          name: "超市电话",
          chapter: 2,
          time: "白天",
          location: "外地超市",
          participants: ["角色乙"],
          cause: "",
          process: "",
          result: "",
          impact: "",
          relatedEventIds: [],
          foreshadowIds: [],
          source: "manual",
          updatedAt: "",
        },
        {
          id: "event-2",
          name: "巷口对峙",
          chapter: 6,
          time: "夜晚",
          location: "巷口",
          participants: ["角色乙"],
          cause: "",
          process: "",
          result: "",
          impact: "",
          relatedEventIds: [],
          foreshadowIds: [],
          source: "manual",
          updatedAt: "",
        },
      ],
      foreshadows: [],
      suppressedIds: [],
      updatedAt: "",
    };
    const eventIssue: ContinuityIssue = {
      severity: "critical",
      type: "人物行为",
      evidence: "角色乙在巷口被围住。",
      detail: "与既有事件不一致。",
    };

    const evidence = collectRepairEvidence({
      project,
      chapter: plan,
      issues: [eventIssue],
      story,
    });

    const found = evidence.snippets.find((item) => item.chapter === 6);
    expect(found).toBeTruthy();
    expect(found?.reason).toContain("事件");
    expect(found?.snippet).toContain("巷口");
  });

  it("超出检索上限的章节会明确记录，不静默丢弃", () => {
    const chapters = Array.from({ length: 10 }, (_, index) =>
      chapter(index + 1, `第${index + 1}章：角色乙说了一些话。`),
    );
    const project = detail(chapters);
    project.characters = [
      {
        name: "角色乙",
        role: "配角",
        gender: "女",
        age: "未知",
        appearance: "",
        personality: "",
        background: "",
        goals: "",
        arc: "",
        relationships: "",
        speechStyle: "",
      },
    ];
    const noRef: ContinuityIssue = {
      severity: "critical",
      type: "人物行为",
      evidence: "角色乙突然沉默。",
      detail: "与既有行为不符。",
    };

    const evidence = collectRepairEvidence({
      project,
      chapter: plan,
      issues: [noRef],
    });

    expect(evidence.excluded.length).toBeGreaterThan(0);
    expect(evidence.text).toContain("未纳入证据");
    expect(evidence.text).toContain("不得用推测替代");
  });

  it("原文证据与事实台账分开标注", () => {
    const project = detail([
      chapter(4, "角色乙在外地超市收银台旁接电话。"),
      chapter(8, "本章正文。"),
    ]);
    const canon: CanonFacts = {
      characters: [
        {
          name: "角色乙",
          aliases: [],
          status: "alive",
          location: "外地",
          note: "",
          statusChapter: 4,
          chapter: 4,
        },
      ],
      items: [],
      timeline: { currentDay: "", deadlines: [] },
      rules: [],
      lastChapter: 7,
      updatedAt: "",
    };
    const story: StoryLedger = {
      version: 1,
      states: [],
      relations: [],
      events: [],
      foreshadows: [],
      suppressedIds: [],
      updatedAt: "",
    };

    const evidence = collectRepairEvidence({
      project,
      chapter: plan,
      issues: [issue],
      canon,
      story,
    });

    expect(evidence.text).toContain("【事实台账（硬约束，不是原文摘录）】");
    expect(evidence.text).toContain("人物状态：角色乙");
    expect(evidence.text).toContain("【原文证据 1｜第 4 章");
  });
});
