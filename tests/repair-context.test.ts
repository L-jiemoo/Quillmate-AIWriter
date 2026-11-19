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
  evidence: "陈玉华今晚不该在阴巷。",
  detail: "与第 4 章电话内容冲突。",
};

describe("修复原文证据检索", () => {
  it("问题明确提到第 4 章时，即使不在最近三章也能检索到原文", () => {
    const project = detail([
      chapter(1, "第一章：陈默进城。"),
      chapter(2, "第二章：陈默找到住处。"),
      chapter(3, "第三章：长夜教出现。"),
      chapter(4, "陈玉华在省城超市收银台旁接电话，警告陈默今晚不要去阴巷。"),
      chapter(5, "第五章：陈默收到消息。"),
      chapter(6, "第六章：陈默前往阴巷。"),
      chapter(7, "第七章：陈默见到陈玉华。"),
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
    expect(found?.snippet).toContain("陈玉华在省城超市收银台旁接电话");
    expect(found?.locator).toContain("第 4 章");
    expect(evidence.text).toContain("【原文证据");
    expect(evidence.text).toContain("（原文）");
  });

  it("问题未写章节时按涉及人物检索原文", () => {
    const project = detail([
      chapter(2, "陈玉华在电话里说自己在省城。"),
      chapter(3, "陈默独自调查。"),
      chapter(8, "本章正文。"),
    ]);
    project.characters = [
      {
        name: "陈玉华",
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
      evidence: "陈玉华突然出现在阴巷。",
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

  it("原文证据与事实台账分开标注", () => {
    const project = detail([
      chapter(4, "陈玉华在省城超市收银台旁接电话。"),
      chapter(8, "本章正文。"),
    ]);
    const canon: CanonFacts = {
      characters: [
        {
          name: "陈玉华",
          aliases: [],
          status: "alive",
          location: "省城",
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
    expect(evidence.text).toContain("人物状态：陈玉华");
    expect(evidence.text).toContain("【原文证据 1｜第 4 章");
  });
});
