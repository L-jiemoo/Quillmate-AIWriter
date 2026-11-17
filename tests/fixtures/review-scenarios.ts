import type { ProjectDetail } from "@/lib/types";

export const FIXTURE_TIME = "2026-11-17T00:00:00.000Z";

export const LONG_PARAGRAPH =
  "张三把玉佩放在灯下，看见背面刻着一行极细的旧字，像是有人用指甲一点点划出来的，墨色里还混着干涸的血迹。";

export function reviewProject(): ProjectDetail {
  return {
    meta: {
      slug: "review-fixture",
      title: "审校场景测试",
      genre: "悬疑",
      tone: "阴沉",
      idea: "玉佩与旧案",
      author: "测试",
      language: "zh-CN",
      targetChapters: 5,
      wordsPerChapter: 2000,
      createdAt: FIXTURE_TIME,
      updatedAt: FIXTURE_TIME,
    },
    plan: {
      logline: "少年追查玉佩旧案。",
      tags: ["悬疑"],
      chapters: [
        {
          index: 1,
          title: "发现",
          summary: "张三在客栈发现玉佩。",
          keyBeats: ["发现玉佩"],
        },
        {
          index: 2,
          title: "死亡",
          summary: "李四在客栈遇害。",
          keyBeats: ["李四死亡"],
        },
        {
          index: 3,
          title: "追查",
          summary: "张三追查黑衣人。",
          keyBeats: ["追踪黑衣人"],
        },
        {
          index: 4,
          title: "密室",
          summary: "张三打开密室机关。",
          keyBeats: ["打开密室机关"],
        },
        {
          index: 5,
          title: "余波",
          summary: "旧案继续发酵。",
          keyBeats: ["旧案余波"],
        },
      ],
    },
    bible: `# 世界观\n## 世界规则\n- 夜间不能点灯。`,
    outlineMd: `# 主线\n## 分卷结构\n- 第一卷（1-2章）：开端。\n- 第二卷（3-5章）：追查。\n## 伏笔与回收点\n- 伏笔：玉佩的秘密（第1章埋，第4章回收）。`,
    characters: [
      {
        name: "张三",
        role: "主角",
        gender: "男",
        age: "二十",
        appearance: "",
        personality: "冷静、执拗",
        background: "",
        goals: "查清旧案",
        arc: "",
        relationships: "与李四是朋友",
        speechStyle: "话少",
        source: "user",
      },
    ],
    state: {
      written: [1, 2, 3],
      summaries: {
        "1": "张三在客栈发现玉佩。",
        "2": "李四在客栈遇害，张三被追捕。",
        "3": "张三追查黑衣人。",
      },
      reviews: {},
      rejectedDrafts: {},
      repairs: {},
      publishHistory: [],
      updatedAt: FIXTURE_TIME,
    },
    chapters: [
      { index: 1, title: "发现", content: "第一章正文。", words: 6, written: true },
      { index: 2, title: "死亡", content: "第二章正文。", words: 6, written: true },
      { index: 3, title: "追查", content: "第三章正文。", words: 6, written: true },
      { index: 4, title: "密室", content: "", words: 0, written: false },
      { index: 5, title: "余波", content: "", words: 0, written: false },
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
        deadlines: [],
      },
      rules: ["夜间不能点灯。"],
      lastChapter: 3,
      updatedAt: FIXTURE_TIME,
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
    publishLedger: { version: 1, records: {}, updatedAt: FIXTURE_TIME },
    pendingChapters: 2,
  };
}

export interface ReviewScenario {
  name: string;
  chapterIndex: number;
  text: string;
  keyBeats?: string[];
  previousContent?: string;
  expectedType: string;
}

export const REVIEW_SCENARIOS: ReviewScenario[] = [
  {
    name: "死亡人物以活人身份出现",
    chapterIndex: 4,
    text: "李四推开客栈的门，走到张三面前坐下，端起茶碗喝了一口。",
    expectedType: "死亡人物出现",
  },
  {
    name: "章节偏离细纲",
    chapterIndex: 4,
    text: "张三在集市买了一壶酒，随后回到客栈睡下，直到天亮才醒来。",
    keyBeats: ["打开密室机关"],
    expectedType: "大纲偏离",
  },
  {
    name: "大段复述旧章",
    chapterIndex: 4,
    text: `张三低头看着玉佩。${LONG_PARAGRAPH}他忽然听见门外有脚步声。`,
    previousContent: `张三低头看着玉佩。${LONG_PARAGRAPH}他忽然听见门外有脚步声。`,
    expectedType: "章节重复",
  },
];
