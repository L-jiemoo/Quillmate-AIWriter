import { describe, expect, it } from "vitest";
import { buildEffectiveMemory } from "@/lib/memory";
import { reviewSuspicions } from "@/lib/review";
import {
  buildEffectiveStory,
  emptyStory,
  normalizeStory,
  storyChecks,
} from "@/lib/story";
import type {
  ExtractedStory,
  ForeshadowRecord,
  ProjectMemory,
  StoryLedger,
} from "@/lib/types";
import {
  FIXTURE_TIME,
  REVIEW_SCENARIOS,
  reviewProject,
} from "./fixtures/review-scenarios";

function base() {
  const detail = reviewProject();
  const memory = buildEffectiveMemory(detail, undefined);
  const story = buildEffectiveStory(detail, memory, undefined);
  return { detail, memory, story };
}

function event(name: string, time: string, location: string, participants: string[]) {
  return {
    name,
    time,
    location,
    participants,
    cause: "",
    process: "",
    result: "",
    impact: "",
    relatedEvents: [],
    foreshadows: [],
  };
}

function extracted(events: ReturnType<typeof event>[]): ExtractedStory {
  return { states: [], relations: [], events };
}

describe("典型小说场景审校回归", () => {
  it.each(REVIEW_SCENARIOS)("$name", (scenario) => {
    const data = base();
    const chapter =
      data.detail.plan.chapters.find((item) => item.index === scenario.chapterIndex) ??
      data.detail.plan.chapters[0];
    const result = reviewSuspicions({
      project: data.detail,
      chapter: {
        ...chapter,
        ...(scenario.keyBeats ? { keyBeats: scenario.keyBeats } : {}),
      },
      text: scenario.text,
      canon: data.detail.canon,
      memory: data.memory,
      story: data.story,
      previousEnding: scenario.previousContent ?? "第三章正文。",
      previousChapters: [
        {
          index: 3,
          content: scenario.previousContent ?? "第三章正文。",
        },
      ],
    });
    expect(result.suspicions.map((issue) => issue.type)).toContain(
      scenario.expectedType,
    );
  });

  it("已死人物作为新事件参与者会形成剧情台账死亡提示", () => {
    const data = base();
    const chapter = data.detail.plan.chapters.find((item) => item.index === 4)!;
    const result = reviewSuspicions({
      project: data.detail,
      chapter,
      text: "夜里，客栈的门被人从外面推开，李四走进来。",
      canon: data.detail.canon,
      memory: data.memory,
      story: data.story,
      previousEnding: "第三章结尾。",
      previousChapters: [{ index: 3, content: "第三章正文。" }],
      extracted: extracted([event("李四现身", "第三日夜", "客栈", ["李四"])]),
    });
    expect(
      result.suspicions.some(
        (issue) => issue.type === "死亡状态" && issue.detail.includes("剧情台账"),
      ),
    ).toBe(true);
  });

  it("同一时间同一人物出现在两个地点会形成地点/时间线提示", () => {
    const data = base();
    const chapter = data.detail.plan.chapters.find((item) => item.index === 4)!;
    const result = reviewSuspicions({
      project: data.detail,
      chapter,
      text: "第三日夜里，张三先在客栈会面，随后又出现在城外。",
      canon: data.detail.canon,
      memory: data.memory,
      story: data.story,
      previousEnding: "第三章结尾。",
      previousChapters: [{ index: 3, content: "第三章正文。" }],
      extracted: extracted([
        event("客栈会面", "第三日夜", "客栈", ["张三"]),
        event("城外追踪", "第三日夜", "城外", ["张三"]),
      ]),
    });
    expect(result.suspicions.map((issue) => issue.type)).toContain("地点/时间线");
  });

  it("伏笔回收早于埋设会进入强制保留的严重问题", () => {
    const data = base();
    const chapter = data.detail.plan.chapters.find((item) => item.index === 4)!;
    const record: ForeshadowRecord = {
      id: "fs-4-test",
      text: "玉佩背面的旧字",
      plantedChapter: 4,
      relatedCharacters: ["张三"],
      expectedStartChapter: 4,
      expectedEndChapter: 5,
      status: "resolved",
      eventIds: [],
      resolution: "手工标记",
      resolvedChapter: 3,
      resolutionCandidate: "",
      source: "manual",
      updatedAt: FIXTURE_TIME,
    };
    const story: StoryLedger = normalizeStory({
      ...emptyStory(FIXTURE_TIME),
      foreshadows: [record],
    });
    const result = reviewSuspicions({
      project: data.detail,
      chapter,
      text: "张三翻开玉佩，背面旧字已经淡去。",
      canon: data.detail.canon,
      memory: data.memory as ProjectMemory,
      story,
      previousEnding: "第三章结尾。",
      previousChapters: [{ index: 3, content: "第三章正文。" }],
    });
    expect(
      result.hardIssues.some((issue) => issue.type === "伏笔连续性"),
    ).toBe(true);
  });
});

describe("剧情台账底层检查", () => {
  it("事件关联不存在时报告 broken-event-link", () => {
    const detail = reviewProject();
    const ledger = normalizeStory({
      ...emptyStory(FIXTURE_TIME),
      events: [
        {
          id: "evt-4-1",
          name: "密室机关",
          chapter: 4,
          time: "第四日",
          location: "密室",
          participants: ["张三"],
          cause: "",
          process: "",
          result: "",
          impact: "",
          relatedEventIds: ["evt-999"],
          foreshadowIds: [],
          source: "manual",
          updatedAt: FIXTURE_TIME,
        },
      ],
    });
    expect(
      storyChecks(detail, ledger).some((issue) => issue.code === "broken-event-link"),
    ).toBe(true);
  });
});
