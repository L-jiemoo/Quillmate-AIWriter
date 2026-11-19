import { describe, expect, it } from "vitest";
import {
  architectMessages,
  auditMessages,
  chapterRepairMessages,
  chapterRepairPatchMessages,
  chapterRepairPlanMessages,
  characterMessages,
  extendMessages,
  factExtractorMessages,
  repairRegressionMessages,
  titleRepairMessages,
  writerMessages,
} from "@/lib/prompts";
import type { ChatMessage } from "@/lib/llm";
import type { ProjectDetail } from "@/lib/types";
import { reviewProject } from "./fixtures/review-scenarios";

const FORBIDDEN_IN_PROMPT = [
  "陈默",
  "陈玉华",
  "沈长庚",
  "周坤",
  "记录之书",
  "阴巷",
  "省城",
  "长夜教",
  "已噬",
];

function join(messages: ChatMessage[]): string {
  return messages.map((message) => message.content).join("\n");
}

function allAgentMessages(detail: ProjectDetail): Array<[string, ChatMessage[]]> {
  const chapter = detail.plan.chapters[3];
  const actor = detail.canon.characters[0].name;
  const body = `${actor}发现旧字。`;
  const issues = [
    {
      severity: "critical" as const,
      type: "剧情因果",
      evidence: body,
      detail: "与既定事实冲突。",
    },
  ];
  return [
    ["architect", architectMessages(detail.meta)],
    [
      "extend-plan",
      extendMessages(detail.meta, detail.plan, detail.bible, detail.outlineMd, [], 2, 6, {
        canon: detail.canon,
        characters: detail.characters,
      }),
    ],
    ["title-repair", titleRepairMessages([chapter], ["旧标题"])],
    ["character-designer", characterMessages(detail.meta, detail.bible, detail.outlineMd)],
    [
      "writer",
      writerMessages(detail.meta, detail.bible, detail.characters, chapter, "", [], {
        canon: detail.canon,
      }),
    ],
    [
      "fact-extractor",
      factExtractorMessages(detail.meta, detail.bible, chapter, body, detail.canon),
    ],
    [
      "auditor",
      auditMessages(
        detail.meta,
        detail.canon,
        detail.characters,
        chapter,
        body,
        "",
        [],
        "",
        "",
      ),
    ],
    [
      "repair-editor",
      chapterRepairMessages(
        detail.meta,
        chapter,
        body,
        issues,
        detail.canon,
        "",
        "",
        "",
        "",
      ),
    ],
    [
      "repair-plan",
      chapterRepairPlanMessages(
        detail.meta,
        chapter,
        body,
        issues,
        detail.canon,
        "",
        "",
        "",
        "",
      ),
    ],
    [
      "repair-patch",
      chapterRepairPatchMessages(
        detail.meta,
        chapter,
        body,
        issues,
        detail.canon,
        "",
        "",
        "",
        "",
      ),
    ],
    [
      "repair-regression",
      repairRegressionMessages(
        detail.meta,
        chapter,
        body,
        `${actor}看见了旧字。`,
        "",
        detail.canon,
        detail.characters,
        "",
        "",
      ),
    ],
  ];
}

function otherProject(): ProjectDetail {
  const detail = reviewProject();
  detail.meta = {
    ...detail.meta,
    slug: "other-fixture",
    title: "另一部作品",
    idea: "渡口失踪案",
  };
  detail.bible = "# 世界观\n## 世界规则\n- 子时不能进食。";
  detail.outlineMd = "# 主线\n- 王五追查失踪案。";
  detail.characters = [
    {
      name: "王五",
      role: "主角",
      gender: "女",
      age: "三十",
      appearance: "",
      personality: "多疑",
      background: "",
      goals: "找到失踪者",
      arc: "",
      relationships: "",
      speechStyle: "急促",
      source: "user",
    },
  ];
  detail.canon = {
    characters: [
      {
        name: "王五",
        aliases: [],
        status: "alive",
        location: "渡口",
        note: "在追查失踪者",
        statusChapter: 1,
        chapter: 2,
      },
    ],
    items: [],
    timeline: { currentDay: "第一日", deadlines: [] },
    rules: ["子时不能进食。"],
    lastChapter: 2,
    updatedAt: detail.canon.updatedAt,
  };
  detail.plan = {
    ...detail.plan,
    logline: "王五追查失踪案。",
    chapters: detail.plan.chapters.map((chapter) => ({
      ...chapter,
      title: `王五的第 ${chapter.index} 章`,
      summary: `王五推进失踪案第 ${chapter.index} 步。`,
    })),
  };
  return detail;
}

describe("通用 Prompt 与项目数据隔离", () => {
  it("所有发送给模型的提示词都不含特定小说的专属内容", () => {
    const detail = reviewProject();
    for (const [name, messages] of allAgentMessages(detail)) {
      const text = join(messages);
      for (const forbidden of FORBIDDEN_IN_PROMPT) {
        expect(text, `${name} 提示词泄露了专属内容：${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("通用因果审校规则完整保留", () => {
    const detail = reviewProject();
    const text = join(
      repairRegressionMessages(
        detail.meta,
        detail.plan.chapters[3],
        "张三发现旧字。",
        "张三看见了旧字。",
        "",
        detail.canon,
        detail.characters,
        "",
        "",
      ),
    );

    expect(text).toContain("动作的执行者是否被替换或拆分");
    expect(text).toContain("动作的直接作用对象是否改变");
    expect(text).toContain("被记录/改变/处理的对象与最终结果是否仍然对应");
    expect(text).toContain("中间对象、媒介或动作落点");
    expect(text).toContain("事件先后顺序是否改变");
    expect(text).toContain("结果是否指向了另一个人物或物体");
    expect(text).toContain("新增了需要额外解释的新规则");
    expect(text).toContain("SAFE_REPHRASE");
    expect(text).toContain("CAUSAL_EXPANSION");
    expect(text).toContain("CAUSAL_CHANGE");
    expect(text).toContain("CAUSAL_CONTRADICTION");
  });

  it("抽象示例标明不代表具体世界观，只用于说明分类标准", () => {
    const detail = reviewProject();
    const text = join(
      repairRegressionMessages(
        detail.meta,
        detail.plan.chapters[3],
        "张三发现旧字。",
        "张三看见了旧字。",
        "",
        detail.canon,
        detail.characters,
        "",
        "",
      ),
    );
    expect(text).toContain("抽象占位");
    expect(text).toContain("不代表任何具体作品的世界观机制");
  });

  it("切换项目后只注入当前项目的设定，不残留上一部作品", () => {
    const first = reviewProject();
    const second = otherProject();

    for (const [name, messages] of allAgentMessages(first)) {
      const text = join(messages);
      expect(text, `${name} 混入了另一项目的数据`).not.toContain("王五");
      expect(text, `${name} 混入了另一项目的规则`).not.toContain("子时不能进食");
    }
    for (const [name, messages] of allAgentMessages(second)) {
      const text = join(messages);
      expect(text, `${name} 混入了上一项目的人物`).not.toContain("张三");
      expect(text, `${name} 混入了上一项目的物品`).not.toContain("玉佩");
      expect(text, `${name} 混入了上一项目的规则`).not.toContain("夜间不能点灯");
    }
  });
});
