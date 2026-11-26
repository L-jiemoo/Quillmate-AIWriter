import { describe, expect, it } from "vitest";
import {
  classifyOpening,
  formulaicOpeningSuspicion,
  openingImagerySuspicion,
  openingLinkSuspicion,
  openingStructureSuspicion,
} from "@/lib/canon";
import {
  auditMessages,
  openingRepairMessages,
  writerMessages,
} from "@/lib/prompts";
import type { CanonFacts, ChapterPlan, ProjectMeta } from "@/lib/types";

const meta = {
  slug: "demo",
  title: "测试书",
  genre: "悬疑",
  tone: "冷峻",
  targetChapters: 2,
  createdAt: "",
  updatedAt: "",
} as unknown as ProjectMeta;

const canon: CanonFacts = {
  characters: [],
  items: [],
  timeline: { currentDay: "第一日", deadlines: [] },
  rules: [],
  lastChapter: 0,
  updatedAt: "",
};

const chapter: ChapterPlan = {
  index: 1,
  title: "夜行",
  summary: "夜行",
  keyBeats: [],
};

function joinedPrompt(messages: { content: string }[]): string {
  return messages.map((message) => message.content).join("\n");
}

describe("章首公式化检测", () => {
  it("命中「X 是被……吵醒的」这一式的开头", () => {
    const issues = formulaicOpeningSuspicion(
      "陆闲是被一阵急促的敲门声吵醒的。他翻身下床，摸到枕边的刀。",
      [],
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe("章首公式化");
    expect(issues[0].severity).toBe("warning");
    expect(issues[0].evidence).toContain("陆闲是被一阵急促的敲门声吵醒的");
    expect(issues[0].detail).toContain("事后结论");
  });

  it("连续多章同款开头时，指出具体章节", () => {
    const issues = formulaicOpeningSuspicion(
      "陆闲是被一阵急促的敲门声吵醒的。",
      [
        { index: 1, content: "陆闲是被窗外的雷声惊动的。他坐起身。" },
        { index: 2, content: "刀还没入鞘，门就响了。" },
      ],
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].detail).toContain("第 1 章");
    expect(issues[0].detail).toContain("模板");
  });

  it("正常现场描写不误报", () => {
    const issues = formulaicOpeningSuspicion(
      "刀还没入鞘，门就响了。陆闲盯着门缝下的那道影子。",
      [{ index: 1, content: "陆闲是被雷声惊醒的。" }],
    );
    expect(issues).toEqual([]);
  });

  it("公式化句子不在开头时不误报", () => {
    const issues = formulaicOpeningSuspicion(
      "雨下了整夜。陆闲是被一阵敲门声吵醒的。",
      [],
    );
    expect(issues).toEqual([]);
  });

  it("只看最近三章，更早的同款开头不计入", () => {
    const issues = formulaicOpeningSuspicion(
      "陆闲是被一阵敲门声吵醒的。",
      [
        { index: 1, content: "陆闲是被雷声惊醒的。" },
        { index: 2, content: "他推开门，院子里空着。" },
        { index: 3, content: "天亮时，雪停了。" },
        { index: 4, content: "他在灶前坐了半晌。" },
      ],
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].detail).not.toContain("第 1 章");
  });

  it("连续多章开头围着同一件道具写时给出提示", () => {
    const issues = openingImagerySuspicion(
      "门板还在震。陆闲没有立刻去开。",
      [
        { index: 1, content: "门板被敲得发颤。" },
        { index: 2, content: "他盯着门板看了很久。" },
      ],
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe("章首意象重复");
    expect(issues[0].detail).toContain("门板");
    expect(issues[0].detail).toContain("第 1 章");
    expect(issues[0].detail).toContain("第 2 章");
  });

  it("只有一章用过同一件道具时不提示", () => {
    const issues = openingImagerySuspicion("门板还在震，窗纸也响。", [
      { index: 1, content: "门板被敲得发颤。" },
      { index: 2, content: "他推开门，院子里空着。" },
    ]);
    expect(issues).toEqual([]);
  });

  it("人物姓名重复不算章首意象重复", () => {
    const issues = openingImagerySuspicion(
      "陆闲站在门口，没动。",
      [
        { index: 1, content: "陆闲把刀放在桌上。" },
        { index: 2, content: "陆闲听见楼下有人笑。" },
      ],
      ["陆闲"],
    );
    expect(issues).toEqual([]);
  });
});

describe("章首句式骨架与衔接", () => {
  it("换掉具体名词但保留同一副句式骨架时仍然命中", () => {
    const issues = openingStructureSuspicion("她是在一个雨天接到电话的。", [
      { index: 1, content: "陆闲是被一阵急促的敲门声吵醒的。" },
      { index: 2, content: "她是被那通电话惊醒的。" },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe("章首句式重复");
    expect(issues[0].detail).toContain("第 1 章");
    expect(issues[0].detail).toContain("第 2 章");
    // 提示里要同时给出改写方向和不许丢衔接的约束。
    expect(issues[0].detail).toContain("动作中间态");
    expect(issues[0].detail).toContain("衔接");
  });

  it("结构不同时不误报", () => {
    const issues = openingStructureSuspicion("刀还没入鞘，门就响了。", [
      { index: 1, content: "雨下了整夜。" },
      { index: 2, content: "他吹灭了灯。" },
    ]);
    expect(issues).toEqual([]);
  });

  it("开头没有沿用上一章结尾的任何人事物时提示衔接缺失", () => {
    const issues = openingLinkSuspicion(
      "城外的雪下了整夜，官道上没有一个人。",
      "他吹灭了灯，屋里彻底黑了，只剩窗缝透进来的一线月光。",
      3,
      ["陆闲"],
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe("章首衔接");
    expect(issues[0].detail).toContain("第 3 章");
  });

  it("开头点名主角时视为有衔接", () => {
    const issues = openingLinkSuspicion(
      "门板上的雪落了一层，陆闲伸手拂掉。",
      "他吹灭了灯，屋里彻底黑了，只剩窗缝透进来的一线月光。",
      3,
      ["陆闲"],
    );
    expect(issues).toEqual([]);
  });

  it("明确的时间推进视为有衔接", () => {
    const issues = openingLinkSuspicion(
      "次日清晨，雪停了。",
      "他吹灭了灯，屋里彻底黑了，只剩窗缝透进来的一线月光。",
      3,
      ["陆闲"],
    );
    expect(issues).toEqual([]);
  });

  it("全书第一章不判断衔接", () => {
    const issues = openingLinkSuspicion("城外的雪下了整夜。", "", 1, []);
    expect(issues).toEqual([]);
  });
});

describe("写作与审校提示词内置开头约束", () => {
  it("写作提示词要求承接三锚点并引入新要素", () => {
    const prompt = joinedPrompt(
      writerMessages(meta, "", [], chapter, "上一章结尾。", []),
    );
    expect(prompt).toContain("承接不等于继续描写上一章结尾");
    expect(prompt).toContain("开头第一段必须出现至少一个新要素");
    expect(prompt).toContain("人物被外界刺激唤醒");
  });

  it("写作提示词不再列举具体道具，避免示例变成新模板", () => {
    const prompt = joinedPrompt(
      writerMessages(meta, "", [], chapter, "上一章结尾。", []),
    );
    // 一旦把“敲门声”“门板”这类具体词写进提示词，模型就会把它当成默认开场意象。
    expect(prompt).not.toContain("敲门声");
    expect(prompt).not.toContain("门板");
  });

  it("审校提示词把章首承接列为检查项", () => {
    const prompt = joinedPrompt(
      auditMessages(meta, canon, [], chapter, "正文。", "", [], "", ""),
    );
    expect(prompt).toContain("章首承接");
  });

  it("写作时把最近三章的开头类型交给模型，但不透露原句", () => {
    const prompt = joinedPrompt(
      writerMessages(meta, "", [], chapter, "上一章结尾。", [], {
        previousOpenings: [
          { index: 1, opening: "陆闲是被一阵敲门声吵醒的。" },
          { index: 2, opening: "次日清晨，雪停了。" },
        ],
      }),
    );
    expect(prompt).toContain("最近三章的开头方式");
    expect(prompt).toContain("被动唤醒或打断式");
    expect(prompt).toContain("时间起兴式");
    // 前章原句不能进提示词，否则会被当成素材沿用。
    expect(prompt).not.toContain("陆闲是被一阵敲门声吵醒的");
  });

  it("开头重写提示只允许改第一段", () => {
    const content = openingRepairMessages("正文段落", [
      "章首公式化：开头把现场写成了事后结论",
    ])
      .map((message) => message.content)
      .join("\n");
    expect(content).toContain("章首公式化");
    expect(content).toContain("只改写第一段");
    expect(content).toContain("逐字保留");
    expect(content).toContain("正文段落");
  });
});

describe("开头类型分类", () => {
  it("覆盖常见开头类型", () => {
    expect(classifyOpening("陆闲是被一阵敲门声吵醒的。")).toBe("wake");
    expect(classifyOpening("次日清晨，雪停了。")).toBe("time");
    expect(classifyOpening("“开门。”门外的人又敲了一下。")).toBe("dialogue");
    expect(classifyOpening("天色暗下来，巷子里没有人。")).toBe("scene");
    expect(classifyOpening("这封信是被退回来的。")).toBe("judgement");
  });
});
