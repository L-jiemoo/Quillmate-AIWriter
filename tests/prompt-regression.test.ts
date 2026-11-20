import { describe, expect, it } from "vitest";
import {
  architectMessages,
  auditMessages,
  chapterRepairMessages,
  chapterRepairPlanMessages,
  characterMessages,
  extendMessages,
  factExtractorMessages,
  repairRegressionMessages,
  titleRepairMessages,
  writerMessages,
} from "@/lib/prompts";
import { PROMPT_AGENTS, PROMPT_CATALOG } from "@/lib/prompt-registry";
import type { ChatMessage } from "@/lib/llm";
import { reviewProject } from "./fixtures/review-scenarios";

const DIMENSIONS = [
  "人物行为合理性",
  "人物性格一致性",
  "时间线连续性",
  "地点连续性",
  "人物生死状态",
  "物品归属",
  "世界观规则冲突",
  "剧情因果关系",
  "伏笔连续性",
  "章节内容重复",
  "章节与大纲偏离",
];

function join(messages: ChatMessage[]): string {
  return messages.map((message) => message.content).join("\n");
}

describe("典型小说审校提示词回归", () => {
  it("审校提示词包含全部 11 个维度、人物卡、剧情台账和证据要求", () => {
    const detail = reviewProject();
    const chapter = detail.plan.chapters[3];
    const text = auditMessages(
      detail.meta,
      detail.canon,
      detail.characters,
      chapter,
      "张三在密室里发现了一行旧字。",
      "上一章结尾：张三推开门。",
      [
        {
          severity: "warning",
          type: "死亡人物出现",
          evidence: "李四走进来",
          detail: "李四已在第 2 章死亡。",
        },
      ],
      "下一章开头：旧字发光。",
      "【人物动态状态】李四：第 2 章死亡。",
    )
      .map((message) => message.content)
      .join("\n");

    for (const dimension of DIMENSIONS) {
      expect(text).toContain(dimension);
    }
    expect(text).toContain("核心人物档案");
    expect(text).toContain("剧情台账");
    expect(text).toContain("本章正文中的原文短句");
    expect(text).toContain("不允许为了通过审校而建议修改既定事实");
  });

  it("审校提示词要求识别真正问题，同时避免过度审校", () => {
    const detail = reviewProject();
    const text = join(
      auditMessages(
        detail.meta,
        detail.canon,
        detail.characters,
        detail.plan.chapters[3],
        "张三进入密室。",
        "",
        [],
        "",
        "",
      ),
    );

    expect(text).toContain("不做文风警察");
    expect(text).toContain("不要为了完成审校清单而强行生成问题");
    expect(text).toContain("同一根本原因导致的多个表现应尽量合并");
    expect(text).toContain("合理悬念");
    expect(text).toContain("人物有意隐瞒信息");
    expect(text).toContain("人物做出意外选择");
    expect(text).toContain("不要要求每章都必须有冲突、反转或悬念");
    expect(text).toContain("warning：存在疑点，但仍有合理解释空间");
  });

  it("审校提示词要求区分明确矛盾、规则拓展与解释不足", () => {
    const detail = reviewProject();
    const text = join(
      auditMessages(
        detail.meta,
        detail.canon,
        detail.characters,
        detail.plan.chapters[3],
        "张三进入密室。",
        "",
        [],
        "",
        "",
      ),
    );

    expect(text).toContain("ESTABLISHED_CONTRADICTION");
    expect(text).toContain("RULE_EXTENSION");
    expect(text).toContain("CLARITY_GAP");
    expect(text).toContain("HARD_RULE");
    expect(text).toContain("SOFT_RULE");
    expect(text).toContain("UNKNOWN_RULE");
    expect(text).toContain("CHARACTER_BELIEF");
    expect(text).toContain("冲突双方的原文证据");
    expect(text).toContain("以前没有出现过");
    expect(text).toContain("人物说出的判断不能自动当作客观世界观规则");
    expect(text).toContain("唯一证据就是被后文解释为伪造");
    expect(text).toContain("人物台词、转述和角色推断不是客观事实");
    expect(text).toContain("人物估测属于 CHARACTER_BELIEF");
    expect(text).toContain("承载物与被收纳对象");
  });

  it("回归审校提示词沿用分类规则，避免把规则拓展判成严重矛盾", () => {
    const detail = reviewProject();
    const text = join(
      repairRegressionMessages(
        detail.meta,
        detail.plan.chapters[3],
        "张三进入密室。",
        "张三走进密室，发现旧字。",
        "",
        detail.canon,
        detail.characters,
        "",
        "",
      ),
    );

    expect(text).toContain("RULE_EXTENSION");
    expect(text).toContain("CLARITY_GAP");
    expect(text).toContain("不得为了回归通过而判 critical");
    expect(text).toContain("SAFE_REPHRASE");
    expect(text).toContain("CAUSAL_EXPANSION");
    expect(text).toContain("CAUSAL_CHANGE");
    expect(text).toContain("CAUSAL_CONTRADICTION");
    expect(text).toContain("causalChanges");
    expect(text).toContain("丙页");
    expect(text).toContain("抽象占位");
    expect(text).toContain("新增了原文没有建立因果关系的中间对象");
  });

  it("修复方案提示词要求先提取修复前因果结构", () => {
    const detail = reviewProject();
    const text = join(
      chapterRepairPlanMessages(
        detail.meta,
        detail.plan.chapters[3],
        "角色甲说出了角色乙的罪证，记录载体自动生成角色乙的记录页。",
        [
          {
            severity: "critical",
            type: "剧情因果",
            evidence: "角色甲说出了角色乙的罪证。",
            detail: "与第 4 章冲突。",
          },
        ],
        detail.canon,
        "",
        "",
        "",
        "",
      ),
    );

    expect(text).toContain("causalBaseline");
    expect(text).toContain("修复前原文");
    expect(text).toContain("动作直接作用对象");
    expect(text).toContain("被记录/改变/处理的对象");
    expect(text).toContain("不能写成计划中的新剧情");
    expect(text).toContain("中间对象");
  });

  it("修复提示词要求局部修改且不得改台账既定剧情", () => {
    const detail = reviewProject();
    const chapter = detail.plan.chapters[3];
    const text = chapterRepairMessages(
      detail.meta,
      chapter,
      "张三在密室里发现了一行旧字。",
      [
        {
          severity: "critical",
          type: "人物生死状态",
          evidence: "李四走进来",
          detail: "李四已在第 2 章死亡。",
        },
      ],
      detail.canon,
      "",
      "",
      "",
      "",
    )
      .map((message) => message.content)
      .join("\n");

    expect(text).toContain("人物行为合理性");
    expect(text).toContain("伏笔连续性");
    expect(text).toContain("只修与这些问题直接相关的段落");
    expect(text).toContain("不得为了让本章通过而修改事实台账");
    expect(text).toContain("不得删除关键剧情来掩盖问题");
    expect(text).toContain("不得为了消除一个矛盾而制造新的时间线");
    expect(text).toContain("不得擅自新增人物、事件、设定、物品、能力或伏笔");
    expect(text).toContain("如果某条问题无法在不破坏其他内容的前提下安全修复");
  });

  it("草稿修复提示词才追加本轮问题清单约束", () => {
    const detail = reviewProject();
    const chapter = detail.plan.chapters[3];
    const build = (draftRepair: boolean) =>
      chapterRepairMessages(
        detail.meta,
        chapter,
        "张三在密室里发现了一行旧字。",
        [
          {
            severity: "critical",
            type: "人物生死状态",
            evidence: "李四走进来",
            detail: "李四已在第 2 章死亡。",
          },
        ],
        detail.canon,
        "",
        "",
        "",
        "",
        { draftRepair },
      )
        .map((message) => message.content)
        .join("\n");

    const draft = build(true);
    expect(draft).toContain("本轮为草稿修复");
    expect(draft).toContain("不处理已解决、未列出或证据已消失的问题");
    expect(draft).toContain("保留原段落");
    expect(build(false)).not.toContain("本轮为草稿修复");
  });
});

describe("各 Agent 的增量提示词约束", () => {
  it("架构师要求全书主线、分卷目标、冲突因果和伏笔登记", () => {
    const detail = reviewProject();
    const text = join(architectMessages(detail.meta));

    expect(text).toContain("起点、发展阶段、关键转折和终局方向");
    expect(text).toContain("每卷要有独立的阶段目标");
    expect(text).toContain("起因、发展、代价和后果");
    expect(text).toContain("埋设章节、作用和预计回收位置");
    expect(text).toContain("过渡章允许铺垫和情绪沉淀");
    expect(text).not.toContain("每章都要有明确冲突或钩子");
    expect(text).toContain('"chapters"');
    expect(text).toContain('"planLedger"');
    expect(text).toContain('"characterChanges"');
    expect(text).toContain("不得包含 status、actualChapter");
    expect(text).toContain("人物计划在第 8 章死亡");
  });

  it("大纲续排注入事实台账、人物档案和剧情台账", () => {
    const detail = reviewProject();
    const text = join(
      extendMessages(
        detail.meta,
        detail.plan,
        detail.bible,
        detail.outlineMd,
        ["第 3 章：张三追查黑衣人。"],
        2,
        6,
        {
          canon: detail.canon,
          characters: detail.characters,
          storyContext: "【人物动态状态】张三：在客栈；李四已死亡。",
        },
      ),
    );

    expect(text).toContain("【不可违背的事实台账（来自已写章节）】");
    expect(text).toContain("李四（第 2 章死亡）");
    expect(text).toContain("【核心人物档案】");
    expect(text).toContain("张三（主角）");
    expect(text).toContain("【剧情台账（人物状态、关系、事件与未回收伏笔）】");
    expect(text).toContain("张三：在客栈；李四已死亡。");
    expect(text).toContain("不得推翻或改写已经发生的事实");
    expect(text).toContain("尚未回收的伏笔");
    expect(text).toContain("相邻章节之间要有合理的因果联系");
    expect(text).toContain("不要连续多章重复相同的冲突模式");
    expect(text).toContain('"planLedger"');
    expect(text).toContain("plan-extend-");
    expect(text).toContain("只描述未来计划");
  });

  it("大纲续排没有上下文时给出明确占位，并截断过长剧情台账", () => {
    const detail = reviewProject();
    const build = (storyContext?: string) =>
      join(
        extendMessages(
          detail.meta,
          detail.plan,
          detail.bible,
          detail.outlineMd,
          [],
          2,
          6,
          storyContext ? { storyContext } : {},
        ),
      );

    const bare = build();
    expect(bare).toContain("（暂无事实台账）");
    expect(bare).toContain("（暂无人物卡）");
    expect(bare).toContain("（未检索到剧情台账");

    const long = build(`${"剧".repeat(5000)}尾部标记`);
    expect(long).toContain("内容已截断");
    expect(long).not.toContain("尾部标记");
  });

  it("章节改名使用关键事件，并要求不剧透、不重复句式", () => {
    const text = join(
      titleRepairMessages(
        [
          {
            index: 30,
            title: "旧标题",
            summary: "张三进入密室，发现暗门。",
            keyBeats: ["发现机关", "打开暗门"],
          },
        ],
        ["旧标题"],
      ),
    );

    expect(text).toContain("关键事件：发现机关；打开暗门");
    expect(text).toContain("核心事件、情绪或关键变化");
    expect(text).toContain("避免重复使用相似句式和词汇");
    expect(text).toContain("不得提前透露本章尚未揭晓的关键秘密和反转");
  });

  it("角色设计要求独立目标、真实缺陷、反派立场和语言差异", () => {
    const detail = reviewProject();
    const text = join(characterMessages(detail.meta, detail.bible, detail.outlineMd));

    expect(text).toContain("独立的目标、利益诉求和行为逻辑");
    expect(text).toContain("外在目标与内心需求可以存在差异");
    expect(text).toContain("缺陷必须能够实际影响其选择和行为");
    expect(text).toContain("反派应当有自己的立场、动机和合理性");
    expect(text).toContain("配角应有一定自主性");
    expect(text).toContain("避免所有角色使用同一种语气");
  });

  it("写作沿用前文视角，允许节奏变化，不把细纲当机械模板", () => {
    const detail = reviewProject();
    const text = join(
      writerMessages(
        detail.meta,
        detail.bible,
        detail.characters,
        detail.plan.chapters[3],
        "上一章结尾：张三推开门。",
        ["前情：张三发现玉佩。"],
        {
          canon: detail.canon,
          memoryContext: "【未回收伏笔】玉佩的秘密。",
          storyContext: "【人物动态状态】张三：在客栈。",
          planContext: "第 4 章计划事件：张三进入密室（未执行）。",
        },
      ),
    );

    expect(text).toContain("【人物与叙事原则】");
    expect(text).toContain("优先沿用已有正文的叙事视角");
    expect(text).toContain("没有前文时再使用第三人称");
    expect(text).not.toContain("使用第三人称叙述");
    expect(text).toContain("不要每章都制造强冲突、强反转和强悬念");
    expect(text).toContain("章末应按章节定位自然收束或留钩子");
    expect(text).toContain("细纲是创作依据，不是必须逐句执行的机械模板");
    expect(text).toContain("不得把人物猜测、谎言或计划写成客观事实");
    expect(text).toContain("【长期记忆（来自已写章节，按当前章节相关度检索）】");
    expect(text).toContain("【剧情台账（人物动态状态、关系、事件与伏笔，按当前章节相关度检索）】");
    expect(text).toContain("【本章计划台账（创作计划，不代表已经发生）】");
    expect(text).toContain("张三进入密室");
    expect(text).toContain("正文没有实际写出的计划事件");
    expect(text).toContain("计划与事实台账或实际剧情冲突时");
    expect(text).toContain("事实台账 > 实际剧情台账/长期记忆 > 计划台账");
  });

  it("事实抽取区分计划、怀疑、评价和未知信息", () => {
    const detail = reviewProject();
    const text = join(
      factExtractorMessages(
        detail.meta,
        detail.bible,
        detail.plan.chapters[3],
        "张三把玉佩放在桌上，怀疑李四是凶手，但没有任何证据。",
        detail.canon,
      ),
    );

    expect(text).toContain("人物的计划不代表计划已经实现");
    expect(text).toContain("人物的怀疑不代表怀疑对象确实如此");
    expect(text).toContain("人物对其他人的评价不一定是客观事实");
    expect(text).toContain("标记为 unknown 或保持为空");
    expect(text).toContain("不得把本章细纲中计划但正文没有发生的事件");
    expect(text).toContain("alive | dead | unknown");
  });

  it("8 个 Agent 都保留原有输出结构和调用形式", () => {
    const detail = reviewProject();
    const chapter = detail.plan.chapters[3];
    const entries: Array<[string, ChatMessage[]]> = [
      ["architect", architectMessages(detail.meta)],
      [
        "extend-plan",
        extendMessages(detail.meta, detail.plan, detail.bible, detail.outlineMd, [], 2, 6, {
          canon: detail.canon,
          characters: detail.characters,
        }),
      ],
      [
        "title-repair",
        titleRepairMessages([chapter], ["旧标题"]),
      ],
      ["character-designer", characterMessages(detail.meta, detail.bible, detail.outlineMd)],
      [
        "writer",
        writerMessages(detail.meta, detail.bible, detail.characters, chapter, "", [], {
          canon: detail.canon,
        }),
      ],
      [
        "fact-extractor",
        factExtractorMessages(detail.meta, detail.bible, chapter, "正文", detail.canon),
      ],
      [
        "auditor",
        auditMessages(
          detail.meta,
          detail.canon,
          detail.characters,
          chapter,
          "正文",
          "",
          [],
          "",
          "",
        ),
      ],
      [
        "repair-editor",
        chapterRepairMessages(detail.meta, chapter, "正文", [], detail.canon, "", "", "", ""),
      ],
    ];

    const expectedFragments: Record<string, string[]> = {
      architect: ['"logline"', '"chapters"'],
      "extend-plan": ['"chapters"'],
      "title-repair": ['"titles"'],
      "character-designer": ['"characters"'],
      writer: ["直接开始正文"],
      "fact-extractor": ['"summary"', '"story"'],
      auditor: ['"issues"', '"continuityOk"'],
      "repair-editor": ["直接输出完整的修订后正文"],
    };

    for (const [name, messages] of entries) {
      expect(messages.length).toBeGreaterThan(0);
      expect(messages.every((message) => message.content.trim().length > 0)).toBe(true);
      const text = join(messages);
      for (const fragment of expectedFragments[name]) {
        expect(text, `${name} 缺少 ${fragment}`).toContain(fragment);
      }
    }
  });

  it("所有模型 Agent 都有稳定的内置提示词版本", () => {
    expect(PROMPT_AGENTS).toHaveLength(8);
    for (const agent of PROMPT_AGENTS) {
      expect(PROMPT_CATALOG[agent].version).toMatch(/^\d{4}\./);
      expect(PROMPT_CATALOG[agent].label.length).toBeGreaterThan(0);
    }
  });
});
