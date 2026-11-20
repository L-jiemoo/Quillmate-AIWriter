import { formatCanonForPrompt, formatIssuesForPrompt } from "./canon";
import { formatCausalBaseline, type CausalBaseline } from "./repair-causal";

import type { ChatMessage } from "./llm";
import type {
  CanonFacts,
  ChapterPlan,
  ChapterWriteOptions,
  Character,
  ContinuityIssue,
  ProjectMeta,
} from "./types";

const JSON_ONLY = "你的输出必须是严格合法的 JSON，不要输出 JSON 之外的任何文字。";

// 世界观、大纲和正文会随连载不断变长，直接整段塞进提示词会超出上下文。
// 按用途设置不同上限，并在截断处明确告知模型，避免它把省略号当成正文。
function clip(text: string, max = 6000): string {
  return text.length > max ? `${text.slice(0, max)}\n……（内容已截断）` : text;
}

export function architectMessages(meta: ProjectMeta): ChatMessage[] {
  return [
    {
      role: "system",
      content: `你是一位资深中文网络小说策划与架构师，擅长世界观设计、主线冲突与商业连载的节奏安排。你先保证故事因果和人物动机成立，再设计爽点。${JSON_ONLY}`,
    },
    {
      role: "user",
      content: `请为下面这部小说设计整体架构。

书名：${meta.title}
类型：${meta.genre}
基调：${meta.tone}
核心创意：${meta.idea || "（未提供，请自行补全一个高概念创意）"}
目标语言：${meta.language}
单章目标字数：约 ${meta.wordsPerChapter} 字
本次规划章节数：${meta.targetChapters} 章

请输出 JSON，字段如下：
{
  "logline": "一句话卖点（不超过 60 字）",
  "tags": ["标签1", "标签2", "标签3"],
  "bibleMd": "世界观圣经（Markdown）：世界规则、力量体系、地理势力、历史背景、核心矛盾、基调与禁忌",
  "outlineMd": "全书主线大纲（Markdown）：分卷结构、主线冲突、伏笔与回收点、爽点节奏",
  "chapters": [
    {"index": 1, "title": "章节标题（不含“第X章”前缀）", "summary": "本章 80-150 字剧情梗概", "keyBeats": ["关键事件1", "关键事件2"]}
  ],
  "planLedger": {
    "events": [
      {"id": "plan-event-1", "name": "计划事件名称", "chapter": 1, "participants": ["人物"], "premise": "事件前提", "process": "事件经过", "expectedResult": "预期结果", "impact": "对后续剧情的影响", "relatedEventIds": [], "importance": "core"}
    ],
    "characterChanges": [
      {"id": "plan-char-1", "character": "人物姓名", "chapter": 8, "before": "变化前状态", "after": "变化后状态", "reason": "变化原因", "eventIds": ["plan-event-1"]}
    ],
    "foreshadows": [
      {"id": "plan-foreshadow-1", "text": "伏笔内容", "plantChapter": 2, "resolveChapter": 12, "purpose": "伏笔作用", "eventIds": ["plan-event-1"], "resolveCondition": "回收条件"}
    ],
    "timeline": [
      {"id": "plan-time-1", "chapter": 1, "time": "计划时间", "eventIds": ["plan-event-1"], "sequence": "事件先后关系", "constraints": "时间约束", "participants": ["人物"]}
    ],
    "items": [
      {"id": "plan-item-1", "item": "重要物品", "chapter": 5, "holder": "预计持有人", "stateChange": "预计状态变化", "eventIds": ["plan-event-1"]}
    ]
  }
}

要求：
- chapters 从 index 1 开始连续编号，数量为 ${meta.targetChapters}。
- planLedger 是“创作计划”，只描述未来准备发生什么；不得包含 status、actualChapter 或任何“已经发生”的字段。
- 每个章节至少关联一个计划事件；events 的 chapter 必须落在 1-${meta.targetChapters}。
- 所有 id 必须唯一且稳定，relatedEventIds/eventIds 只能引用本 planLedger 中存在的 id。
- 人物变化必须写成计划：例如人物计划在第 8 章死亡，只能在 characterChanges 中登记第 8 章“存活 → 死亡”，绝不能写成当前已经死亡。
- 物品和时间线也必须是计划中的变化，不能提前写成既定事实。
- 先定全书主线的起点、发展阶段、关键转折和终局方向，再拆分卷；每卷要有独立的阶段目标，并服务于全书主线。
- 重要冲突要写清起因、发展、代价和后果，不能只堆事件。
- 人物行动必须符合其性格、目标、认知和当前处境，不要为了爽点牺牲人物逻辑和故事因果。
- 重要伏笔在 outlineMd 和 planLedger.foreshadows 中同时记录埋设章节、作用和预计回收位置；伏笔必须有实际剧情价值，不得为了制造悬念而随意设置。
- 世界观规则必须内部一致，为长篇连载留出扩展空间，但不得前后矛盾。
- 每章都要有明确推进作用；关键节点章要有冲突或钩子，过渡章允许铺垫和情绪沉淀，不必章章强反转。
- 避免生成只有事件堆积、缺少人物动机和情节联系的大纲。`,
    },
  ];
}

// 架构拆成三个阶段，避免一次请求同时生成世界观、全部细纲和大型台账而触发输出上限。
export function architectFoundationMessages(meta: ProjectMeta): ChatMessage[] {
  return [
    {
      role: "system",
      content: `你是一位资深中文网络小说策划与架构师，擅长世界观设计、主线冲突与商业连载的节奏安排。${JSON_ONLY}`,
    },
    {
      role: "user",
      content: `请先为下面这部小说完成「第一阶段：全书架构」，不要生成逐章细纲或结构化计划台账。

书名：${meta.title}
类型：${meta.genre}
基调：${meta.tone}
核心创意：${meta.idea || "（未提供，请自行补全一个高概念创意）"}
目标语言：${meta.language}
单章目标字数：约 ${meta.wordsPerChapter} 字
本次规划章节数：${meta.targetChapters} 章

请输出 JSON：
{
  "logline": "一句话卖点（不超过 60 字）",
  "tags": ["标签1", "标签2", "标签3"],
  "bibleMd": "世界观圣经（Markdown）：世界规则、力量体系、地理势力、历史背景、核心矛盾、基调与禁忌",
  "outlineMd": "全书主线大纲（Markdown）：分卷结构、各卷阶段目标、关键转折、伏笔与回收点、爽点节奏",
  "volumes": [
    {"title": "卷名", "chapters": "第 1-10 章", "goal": "本卷阶段目标", "turningPoints": ["关键转折"]}
  ]
}

要求：
- outlineMd 必须包含分卷结构和全书主线的起点、发展阶段、关键转折与终局方向。
- 每卷要有独立阶段目标，并服务于全书主线；重要冲突写清起因、发展、代价和后果。
- 人物行动必须符合性格、目标、认知和当前处境，不要为了爽点牺牲因果。
- 重要伏笔在 outlineMd 中记录埋设位置、作用和预计回收方向，不得为了悬念随意设置。
- 世界观规则必须内部一致，为长篇连载留出扩展空间。
- 本阶段只输出整体架构，不要输出 chapters、planLedger 或逐章梗概。`,
    },
  ];
}

export function architectChapterBatchMessages(
  meta: ProjectMeta,
  foundation: { bible: string; outlineMd: string },
  startIndex: number,
  count: number,
  previousChapters: ChapterPlan[],
): ChatMessage[] {
  const endIndex = startIndex + count - 1;
  const tail = previousChapters
    .slice(-8)
    .map((chapter) => `第 ${chapter.index} 章《${chapter.title}》：${chapter.summary}`)
    .join("\n");
  return [
    {
      role: "system",
      content: `你是一位资深中文网络小说策划与架构师，负责在既定全书架构下拆分连续章节细纲，保持主线、人物动机和因果一致。${JSON_ONLY}`,
    },
    {
      role: "user",
      content: `《${meta.title}》（${meta.genre} / ${meta.tone}）已经完成全书架构。现在只生成第 ${startIndex}-${endIndex} 章的细纲。

【世界观圣经】
${clip(foundation.bible, 2600)}

【全书主线大纲与分卷规划】
${clip(foundation.outlineMd, 3200)}

【前面已生成的章节细纲（最近 8 章）】
${tail || "（这是第一批章节，暂无前序细纲）"}

请输出 JSON：
{
  "chapters": [
    {"index": ${startIndex}, "title": "章节标题（不含“第X章”前缀）", "summary": "本章 80-150 字剧情梗概", "keyBeats": ["关键事件1", "关键事件2"]}
  ]
}

要求：
- 必须恰好生成 ${count} 章，index 从 ${startIndex} 连续到 ${endIndex}，不得缺失、重复或跳号。
- 章节标题必须互不相同，且自然、简洁、有画面感，不提前剧透本章反转。
- 本批章节必须承接前序章节，并与全书主线、当前分卷阶段目标保持一致。
- 每章要有明确推进作用；关键节点章保留冲突或钩子，过渡章允许铺垫和情绪沉淀。
- 人物不得知道其尚未掌握的信息，不得为了爽点破坏既定因果。
- 本阶段只输出 chapters，不要输出 bibleMd、outlineMd 或 planLedger。`,
    },
  ];
}

export function architectLedgerBatchMessages(
  meta: ProjectMeta,
  foundation: { bible: string; outlineMd: string },
  chapters: ChapterPlan[],
  priorEvents: Array<{ id: string; name: string; chapter: number }>,
  batchNo: number,
): ChatMessage[] {
  const list = chapters
    .map((chapter) => {
      const beats = chapter.keyBeats?.length ? `；关键事件：${chapter.keyBeats.join("；")}` : "";
      return `第 ${chapter.index} 章《${chapter.title}》：${chapter.summary}${beats}`;
    })
    .join("\n");
  const events = priorEvents
    .slice(-80)
    .map((event) => `${event.id}（第 ${event.chapter} 章：${event.name}）`)
    .join("、");
  const first = chapters[0]?.index ?? 1;
  const last = chapters[chapters.length - 1]?.index ?? first;
  return [
    {
      role: "system",
      content: `你是一位中文小说策划，负责把已确定的章节细纲整理成结构化创作计划台账。计划只描述未来准备发生什么，不能写成已经发生的事实。${JSON_ONLY}`,
    },
    {
      role: "user",
      content: `《${meta.title}》（${meta.genre} / ${meta.tone}）的第 ${first}-${last} 章细纲如下，请只为这些章节生成计划台账。

【世界观规则摘要】
${clip(foundation.bible, 1600)}

【全书主线与分卷目标】
${clip(foundation.outlineMd, 1800)}

【本批章节细纲】
${list}

【前面批次已有的计划事件 ID】
${events || "（这是第一批，暂无既有事件）"}

请输出 JSON：
{
  "planLedger": {
    "events": [
      {"id": "plan-arch-b${batchNo}-event-1", "name": "计划事件名称", "chapter": ${first}, "participants": ["人物"], "premise": "事件前提", "process": "事件经过", "expectedResult": "预期结果", "impact": "对后续剧情的影响", "relatedEventIds": [], "importance": "core"}
    ],
    "characterChanges": [
      {"id": "plan-arch-b${batchNo}-char-1", "character": "人物姓名", "chapter": ${first}, "before": "变化前状态", "after": "变化后状态", "reason": "变化原因", "eventIds": []}
    ],
    "foreshadows": [
      {"id": "plan-arch-b${batchNo}-foreshadow-1", "text": "伏笔内容", "plantChapter": ${first}, "resolveChapter": 0, "purpose": "伏笔作用", "eventIds": [], "resolveCondition": "回收条件"}
    ],
    "timeline": [
      {"id": "plan-arch-b${batchNo}-time-1", "chapter": ${first}, "time": "计划时间", "eventIds": [], "sequence": "事件先后关系", "constraints": "时间约束", "participants": ["人物"]}
    ],
    "items": [
      {"id": "plan-arch-b${batchNo}-item-1", "item": "重要物品", "chapter": ${first}, "holder": "预计持有人", "stateChange": "预计状态变化", "eventIds": []}
    ]
  }
}

要求：
- events 必须覆盖第 ${first}-${last} 章的每一章，至少每章一个计划事件；chapter 不得超出本批范围。
- 本批所有 id 必须唯一，并以 plan-arch-b${batchNo}- 开头；relatedEventIds/eventIds 只能引用前面批次已有事件或本批事件。
- 只描述未来计划，不得包含 status、actualChapter、evidence 或任何“已经发生”的字段。
- 人物变化必须写成计划（例如“计划第 8 章由存活转为死亡”），不能写成当前已经死亡。
- 伏笔埋设章节必须在本批或前文合理位置；回收章节可以是未来章节，不确定时填 0。
- 时间线和物品变化同样是计划，不是既定事实。`,
    },
  ];
}

export function extendMessages(
  meta: ProjectMeta,
  plan: { chapters: ChapterPlan[] },
  bible: string,
  outlineMd: string,
  recentSummaries: string[],
  count: number,
  startIndex: number,
  context: {
    canon?: CanonFacts;
    characters?: Character[];
    storyContext?: string;
  } = {},
): ChatMessage[] {
  const tail = plan.chapters
    .slice(-8)
    .map((chapter) => `第 ${chapter.index} 章《${chapter.title}》：${chapter.summary}`)
    .join("\n");
  // 只把最近 80 个标题列给模型，控制提示词长度；
  // 模型忽略约束时，agents.ts 里还会再做一次归一化去重兜底。
  const existingTitles = plan.chapters
    .slice(-80)
    .map((chapter) => `第 ${chapter.index} 章《${chapter.title}》`)
    .join("、");
  const summaries = recentSummaries.length
    ? recentSummaries.join("\n")
    : "（还没有已写章节摘要）";

  return [
    {
      role: "system",
      content: `你是一位资深中文网络小说策划与架构师，负责在既有大纲基础上续排后续章节，尊重已发生事实并保持主线连贯。${JSON_ONLY}`,
    },
    {
      role: "user",
      content: `《${meta.title}》（${meta.genre} / ${meta.tone}）的现有大纲已排到第 ${startIndex - 1} 章。请继续设计 ${count} 章新细纲。

【世界观圣经】
${clip(bible, 3000)}

【主线大纲】
${clip(outlineMd, 3000)}

【最近章节细纲】
${tail || "（暂无）"}

【现有章节标题（不得复用）】
${existingTitles || "（暂无）"}

【最近已写章节摘要】
${clip(summaries, 3000)}

【不可违背的事实台账（来自已写章节）】
${formatCanonForPrompt(context.canon)}

【核心人物档案】
${formatCharacterProfiles(context.characters ?? [])}

【剧情台账（人物状态、关系、事件与未回收伏笔）】
${clip(context.storyContext?.trim() || "（未检索到剧情台账；不得虚构已发生事实）", 4000)}

请输出 JSON：
{
  "chapters": [
    {"index": ${startIndex}, "title": "章节标题（不含“第X章”前缀）", "summary": "本章 80-150 字剧情梗概", "keyBeats": ["关键事件1", "关键事件2"]}
  ],
  "planLedger": {
    "events": [
      {"id": "plan-extend-event-${startIndex}-1", "name": "计划事件名称", "chapter": ${startIndex}, "participants": ["人物"], "premise": "事件前提", "process": "事件经过", "expectedResult": "预期结果", "impact": "对后续剧情的影响", "relatedEventIds": [], "importance": "major"}
    ],
    "characterChanges": [],
    "foreshadows": [
      {"id": "plan-extend-foreshadow-1", "text": "伏笔内容", "plantChapter": ${startIndex}, "resolveChapter": 0, "purpose": "伏笔作用", "eventIds": [], "resolveCondition": "回收条件"}
    ],
    "timeline": [],
    "items": []
  }
}

要求：
- chapters 从 index ${startIndex} 开始连续编号，共 ${count} 章。
- planLedger 只登记本批新章节的计划，chapter 必须落在 ${startIndex}-${startIndex + count - 1}；不要重复登记已有章节。
- 新 id 统一使用 plan-extend- 前缀，不得复用已有台账 id；只描述未来计划，不得包含 status 或 actualChapter。
- 每个新章节至少关联一个计划事件；人物变化、物品和时间线也只写成计划，不代表已经发生。
- 新章节标题必须互不相同，且不得与【现有章节标题（不得复用）】中的任何一条重复；尤其不要复用现有最后一章的标题。
- 续排必须尊重事实台账、人物档案和剧情台账，不得推翻或改写已经发生的事实。
- 充分考虑人物当前状态、人物关系、已发生事件和未解决冲突；人物不得知道其尚未掌握的信息。
- 关注尚未回收的伏笔，避免遗忘或过早回收；伏笔回收必须有前文依据。
- 每章要有明确的剧情推进作用，相邻章节之间要有合理的因果联系；不要连续多章重复相同的冲突模式。
- 不要为了制造悬念而刻意拖延已经具备解决条件的剧情；允许合理意外，但不能破坏已经确定的核心事实。
- 按当前分卷的阶段目标递进，关键节点章保留冲突或钩子，过渡章允许铺垫和情绪沉淀，不必章章升级冲突。
- 续排内容必须与全书主线和当前分卷目标保持一致，不要重述已写内容。`,
    },
  ];
}

export function titleRepairMessages(
  chapters: ChapterPlan[],
  forbiddenTitles: string[],
): ChatMessage[] {
  const list = chapters
    .map((chapter) => {
      const beats = chapter.keyBeats?.length
        ? `；关键事件：${chapter.keyBeats.join("；")}`
        : "";
      return `第 ${chapter.index} 章，原标题《${chapter.title}》，本章梗概：${chapter.summary}${beats}`;
    })
    .join("\n\n");

  return [
    {
      role: "system",
      content: `你是中文小说编辑，擅长为章节起简洁、自然、有画面感且不剧透的标题。${JSON_ONLY}`,
    },
    {
      role: "user",
      content: `以下新章节的标题与已有章节或彼此重复，请只为这些章节重新起标题。

【禁止使用的标题】
${forbiddenTitles.join("、") || "（暂无）"}

【需要改名的章节】
${list}

请输出 JSON：
{
  "titles": [
    {"index": 30, "title": "新标题（2-8 个字，不含“第X章”前缀）"}
  ]
}

要求：
- 每个标题必须简洁、自然、有画面感，且彼此不同。
- 标题应体现本章的核心事件、情绪或关键变化，符合中文网络小说阅读习惯。
- 避免重复使用相似句式和词汇，不要单纯堆砌辞藻。
- 不得提前透露本章尚未揭晓的关键秘密和反转，不得改变章节实际表达的含义。
- 不得与【禁止使用的标题】中的任何标题重复。
- 只输出需要改名的章节。`,
    },
  ];
}

export function characterMessages(
  meta: ProjectMeta,
  bible: string,
  outlineMd: string,
  feedback?: string[],
): ChatMessage[] {
  return [
    {
      role: "system",
      content: `你是一位擅长群像塑造的中文小说角色设计师，人物必须有独立目标、欲望、缺陷与成长弧光，并能依靠自己的动机推动剧情。${JSON_ONLY}`,
    },
    {
      role: "user",
      content: `请为《${meta.title}》（${meta.genre} / ${meta.tone}）设计 6-10 位核心角色。

世界观圣经：
${clip(bible)}

主线大纲：
${clip(outlineMd)}

请输出 JSON：
{
  "characters": [
    {
      "name": "姓名",
      "role": "主角 / 核心配角 / 反派 / 导师等",
      "gender": "性别",
      "age": "年龄或年龄段",
      "appearance": "外貌与标志性特征",
      "personality": "性格（含缺陷）",
      "background": "出身与关键经历",
      "goals": "核心欲望与当前目标",
      "arc": "人物成长弧光",
      "relationships": "与其他角色的关系",
      "speechStyle": "说话风格与口头禅"
    }
  ]
}

要求：
- 每个重要人物都应有独立的目标、利益诉求和行为逻辑；外在目标与内心需求可以存在差异。
- 人物缺陷必须能够实际影响其选择和行为；成长要有原因、过程和代价，不能突然改变性格。
- 重要人物之间应有真实的利益、价值观或情感冲突，关系可以随剧情发展发生变化。
- 反派应当有自己的立场、动机和合理性，不能只是阻碍主角的工具；配角应有一定自主性，不应只在主角需要时出现。
- 人物说话方式应体现其身份、性格、经历和当前情绪，避免所有角色使用同一种语气。
- 角色之间必须有利益冲突和情感牵绊，避免功能重复。${
      feedback?.length
        ? `\n\n【上一轮输出未通过校验，请修正】
${feedback.join("\n")}
请补全所有字段，确保恰好 6-10 位角色且姓名互不重复。`
        : ""
    }`,
    },
  ];
}

export function writerMessages(
  meta: ProjectMeta,
  bible: string,
  characters: Character[],
  chapter: ChapterPlan,
  previousEnding: string,
  history: string[],
  options: ChapterWriteOptions = {},
): ChatMessage[] {
  const characterJson = JSON.stringify(characters, null, 2);
  const previous = history.length ? history.map((item, i) => `${i + 1}. ${item}`).join("\n") : "（本章为全书开头，无前情）";
  // 摘要只能说明“发生了什么”，上一章原文结尾才能告诉模型“现在停在哪个画面”。
  // 只截取结尾，既控制提示词长度，又保留人物动作、场景和情绪。
  const ending = previousEnding.trim()
    ? clip(previousEnding.trim(), 1800)
    : "（本章为全书开头，没有上一章结尾）";
  // 重写中间章节时，下一章已经存在；把它的开头也交给模型，
  // 避免重写后的结尾和旧下一章开头互相打架。
  const nextOpening = options.nextOpening?.trim() ?? "";
  const rewriteNote = options.rewriteInstruction?.trim() ?? "";

  return [
    {
      role: "system",
      content: `你是一位签约中文网络小说作者，擅长画面感强、节奏张弛有度、以人物驱动剧情的连载章节。你只输出章节正文，不要输出章节标题、写作说明或任何元信息。`,
    },
    {
      role: "user",
      content: `请${options.mode === "rewrite" ? "重写" : "续写"}《${meta.title}》（${meta.genre} / ${meta.tone}）。

【世界观摘要】
${clip(bible, 4000)}

【主要人物档案】
${clip(characterJson, 6000)}

【不可违背的事实台账（来自已写章节）】
${formatCanonForPrompt(options.canon)}
${options.memoryContext?.trim() ? `\n【长期记忆（来自已写章节，按当前章节相关度检索）】\n${options.memoryContext.trim()}\n` : ""}${options.storyContext?.trim() ? `\n【剧情台账（人物动态状态、关系、事件与伏笔，按当前章节相关度检索）】\n${options.storyContext.trim()}\n` : ""}${options.planContext?.trim() ? `\n【本章计划台账（创作计划，不代表已经发生）】\n${clip(options.planContext.trim(), 2400)}\n` : ""}${options.reviewFeedback?.trim() ? `\n【上一版审校发现的严重问题（新稿中仍存在则必须解决，已不存在的不要强行改剧情）】\n${clip(options.reviewFeedback.trim(), 2400)}\n` : ""}
【上一章结尾（原文）】
${ending}
${nextOpening ? `\n【下一章开头（供收束参考）】\n${clip(nextOpening, 800)}\n` : ""}
【前情提要】
${previous}

【本章细纲】
第 ${chapter.index} 章：${chapter.title}
梗概：${chapter.summary}
关键事件：${chapter.keyBeats.join("；") || "（自由发挥，但需服务主线）"}

【人物与叙事原则】
- 人物必须依据自身性格、认知、目标和当前处境行动，不要只为完成本章细纲而机械行动。
- 对话要体现角色差异，避免所有人物使用同一种表达方式；情绪应通过语言、动作、神态和行为自然表现，不要反复解释已经通过行动表现出来的心理。
- 优先沿用已有正文的叙事视角、时态和语言风格；没有前文时再使用第三人称。
- 场景描写要服务于氛围、人物和剧情，不要为了描写而描写；对话、动作、环境和心理活动应自然结合。
- 避免连续使用相同句式、段落结构和情绪表达，避免反复总结刚刚发生的事情。
- 根据剧情需要控制节奏，允许安静、过渡、铺垫和情绪沉淀；重要转折要有充分铺垫，不要每章都制造强冲突、强反转和强悬念。
- 章末应按章节定位自然收束或留钩子，不要每次都用刻意悬念。细纲是创作依据，不是必须逐句执行的机械模板。
- 不得把人物猜测、谎言或计划写成客观事实；如果细纲与事实台账冲突，以事实台账为准，并在正文中自然暴露冲突。

【写作要求】
${options.mode === "rewrite" ? "- 这是在重写已有章节：不要照抄旧稿，按细纲和重写要求重新组织场景与叙述。\n" : ""}${rewriteNote ? `- 本次重写要求：${rewriteNote}\n` : ""}- 本章开头必须直接承接【上一章结尾（原文）】中的人物动作、场景和情绪，不要复述上一章，也不要无交代地另起一场戏。
- 如果本章细纲要求换场或时间跳跃，必须在前 200 字内用动作、对话或叙述交代过渡。
${nextOpening ? "- 本章结尾必须能自然过渡到【下一章开头（供收束参考）】，不要与其矛盾。\n" : ""}- 严格遵守【不可违背的事实台账】：已死亡角色不得以活人身份行动；关键物品的持有人、形态与状态不得随意改写；日期、天数和死线必须前后一致。
- 【长期记忆】只来自已写章节的摘要/事件/人物/规则检索结果；记忆中没有记录的人物、物品、关系和事件，不得补写成既定事实。检索不到时按本章细纲自然推进，不要虚构“前文已经发生”的内容。
- 如果【长期记忆】与事实台账冲突，以事实台账为准；如果与本章细纲冲突，以已写事实为准并自然处理。
- 【剧情台账】中的人物状态、关系、事件和伏笔也只来自已写章节；未记录的状态变化、关系和因果不得凭空补写。人物行为必须符合其当前生死、位置、身体、能力和掌握的信息。
- 【本章计划台账】只是创作计划，不代表这些事情已经发生；正文没有实际写出的计划事件、人物变化、物品转移或伏笔，不得当成既定事实。
- 计划与事实台账或实际剧情冲突时，以事实台账和已写剧情为准；不得为了完成计划而强行制造不符合前文的剧情。
- 三种台账冲突时的优先级：事实台账 > 实际剧情台账/长期记忆 > 计划台账。已确认事实不能被计划覆盖。
- 伏笔只按台账中“未回收/待回收/发展中”的状态推进；不得在没有正文依据时宣布回收。若本章按细纲需要回收，必须写出明确回收情节。
- 已死角色只能以回忆、尸体、幻象、遗物或他人转述出现；不得说话、行走、战斗、持有物品或推动现场剧情。若细纲要求其行动，改用其他在世角色承担该行动，或明确处理为上述非活人形式。
- 字数约 ${meta.wordsPerChapter} 字（上下浮动 20% 以内）。
- 保持与前文一致的人设、称呼与设定。
- 用场景、动作和对话推进剧情，避免大段总结式叙述。

直接开始正文。`,
    },
  ];
}

export function factExtractorMessages(
  meta: ProjectMeta,
  bible: string,
  chapter: ChapterPlan,
  chapterText: string,
  canon: CanonFacts,
): ChatMessage[] {
  return [
    {
      role: "system",
      content: `你是严谨的中文小说连续性编辑。你的任务只是从正文中抽取“已经发生的事实”并写摘要，不创作、不补写、不推断正文没有写的内容，并严格区分客观事实与人物主观信息。${JSON_ONLY}`,
    },
    {
      role: "user",
      content: `请从《${meta.title}》第 ${chapter.index} 章《${chapter.title}》的正文中抽取事实台账和本章摘要。

【世界观要点（仅用于辨认名词）】
${clip(bible, 2000)}

【已有事实台账】
${formatCanonForPrompt(canon, { includeChapters: true })}

【本章细纲（只作参考，不得把细纲里写了、但正文没写的事件当成事实）】
梗概：${chapter.summary}
关键事件：${chapter.keyBeats.join("；") || "（无）"}

【本章正文】
${clip(chapterText, 16000)}

请输出 JSON：
{
  "summary": "120-180 字本章摘要，只写正文实际发生的内容，供后续章节作为前情",
  "characters": [
    {
      "name": "正文使用的正式姓名或称呼",
      "aliases": ["本章出现的其他称呼"],
      "status": "alive | dead | unknown",
      "location": "本章结束时所在位置，未知则留空",
      "note": "本章确认或改变的关键事实，如死亡方式、身份、关系",
      "evidence": "正文中的短句依据"
    }
  ],
  "items": [
    {
      "name": "物品名",
      "aliases": ["别名或描述"],
      "holder": "本章结束时持有人",
      "state": "完整/分裂/遗失/被封印等",
      "note": "形态、纹饰、能力、来历等硬设定",
      "evidence": "正文中的短句依据"
    }
  ],
  "timeline": {
    "currentDay": "本章结束时的故事内时间/天数，未知则留空",
    "deadlines": [
      {"name": "期限名", "due": "到期时间", "note": "剩余时间或后果"}
    ]
  },
  "rules": ["本章确立的、后续不能违背的硬性规则"],
  "memory": {
    "events": ["本章实际发生的关键事件"],
    "characters": ["本章实际出场或行动的人物"],
    "actions": ["人物名：本章完成的关键行动"],
    "time": "本章结束时的故事内时间；未知则留空",
    "location": "本章结束时主要人物所在地点；未知则留空",
    "endingState": "章末人物处境、局势或悬念",
    "newSettings": ["本章新增且后续需要记住的设定"],
    "foreshadowsPlanted": ["本章新埋下的伏笔"],
    "foreshadowsResolved": ["本章明确回收的旧伏笔"]
  },
  "story": {
    "states": [
      {
        "name": "正文中的正式姓名",
        "identity": "当前身份/职业/伪装身份；未知则留空",
        "age": "故事时间对应的年龄；未知则留空",
        "location": "本章结束时所在地点；未知则留空",
        "bodyState": "伤势、疾病、中毒、虚弱等身体状态；未知则留空",
        "lifeStatus": "alive | dead | unknown",
        "abilities": ["本章确认或变化的能力"],
        "goals": ["人物当前目标"],
        "knowledge": ["人物当前明确掌握的信息/秘密"],
        "faction": "所属阵营；未知则留空",
        "experience": "本章发生的重要经历",
        "evidence": "正文中的短句依据"
      }
    ],
    "relations": [
      {
        "from": "人物名",
        "to": "人物名",
        "type": "师徒/父子/敌对/盟友等",
        "status": "当前关系状态或本章变化",
        "evidence": "正文中的短句依据"
      }
    ],
    "events": [
      {
        "name": "事件名称",
        "time": "事件发生的故事内时间；未知则留空",
        "location": "事件发生地点；未知则留空",
        "participants": ["实际参与者"],
        "cause": "事件起因",
        "process": "事件过程",
        "result": "事件结果",
        "impact": "对后续剧情的影响",
        "relatedEvents": ["本章内因果相关的事件名称"],
        "foreshadows": ["本事件关联的伏笔原文或摘要"]
      }
    ]
  }
}

要求：
- 只记录正文实际发生的事实。回忆、转述、猜测、计划、梦境不算“当前事实”或已发生事件。
- 只抽取正文明确表达或能够直接确认的事实；不得根据常识、剧情猜测或上下文自行补全。
- 必须区分客观事实、人物主观认知、猜测、谎言和未知信息：人物的计划不代表计划已经实现，人物的怀疑不代表怀疑对象确实如此，人物对其他人的评价不一定是客观事实。
- 无法确定的信息标记为 unknown 或保持为空，不得为了让事实台账看起来完整而编造缺失信息。
- status 只能填 alive、dead、unknown，不要填中文；人物在本章死亡才填 dead。
- 被提到名字不等于复活：如果人物只是被回忆、尸体出现或被提及，不要标 alive。
- evidence 必须直接描述该人物本人的行动或状态。句子主体是“他/她/它/那人”时，只有上下文明确指向该人物才能算证据；不要把其他角色的打斗、受伤、抢夺等行动归到已死人物名下。
- 只出现在坟地、遗物、笔记、名单、回忆里的已死人物，status 填 dead 或 unknown，不要因为名字出现就标 alive。
- aliases 只填正文中能唯一指向该人物的称呼；不要填“老东西”“爷爷”“老小子”“师傅”这类通用骂法、亲属称谓或身份称呼，也不要填其他角色的名字。拿不准时留空。
- 只抽取有名字、会行动或状态发生变化的人物，以及推动剧情的关键物品。
- 不要臆造正文没有的姓名、物品、日期；summary 里不得出现正文没有的人名或事件。
- memory.events 只写本章正文实际推进的事件，不写细纲里计划但正文没发生的内容；memory.characters 中的名字必须在正文出现。
- memory.foreshadowsPlanted 只记录正文中明确留下、后续可能需要回收的线索；普通悬念不要全部算作伏笔。memory.foreshadowsResolved 只记录本章明确回收的旧伏笔。
- story.states 只写本章结束时的状态快照，不写计划、猜测或未来变化；lifeStatus 只能填 alive、dead、unknown，本章死亡才填 dead。
- story.relations 只写正文明确体现的关系或本章发生的关系变化；不要补写未出现的关系。
- story.events 只写正文实际发生的事件；participants 必须是正文出现的参与者。relatedEvents 只能引用本章事件名称；foreshadows 只关联正文明确涉及的伏笔。
- 事件应尽量保留发生时间、地点、涉及人物和结果；伏笔的埋设和回收必须有正文依据。
- 不得把本章细纲中计划但正文没有发生的事件写入事实、记忆或剧情台账。
- evidence 必须摘自本章正文。`,
    },
  ];
}

function formatCharacterProfiles(characters: Character[]): string {
  if (!characters.length) return "（暂无人物卡）";
  return characters
    .slice(0, 12)
    .map((character) => {
      const parts = [`${character.name}（${character.role || "角色"}）`];
      if (character.personality) parts.push(`性格：${clip(character.personality, 120)}`);
      if (character.goals) parts.push(`目标：${clip(character.goals, 100)}`);
      if (character.speechStyle) parts.push(`说话：${clip(character.speechStyle, 80)}`);
      if (character.relationships) parts.push(`关系：${clip(character.relationships, 120)}`);
      return `- ${parts.join("；")}`;
    })
    .join("\n");
}

export function auditMessages(
  meta: ProjectMeta,
  canon: CanonFacts,
  characters: Character[],
  chapter: ChapterPlan,
  chapterText: string,
  previousContext: string,
  suspicions: ContinuityIssue[],
  nextContext: string,
  storyContext: string,
  evidenceContext = "",
): ChatMessage[] {
  return [
    {
      role: "system",
      content: `你是严谨的中文小说责编，负责连续性与创作质量审校。你优先发现影响剧情成立的重大问题，不做文风警察；必须引用本章原文作为证据，不确定、证据不足或只是文风偏好的问题标为 ignore。${JSON_ONLY}`,
    },
    {
      role: "user",
      content: `请审校《${meta.title}》第 ${chapter.index} 章《${chapter.title}》。

【事实台账（含每条事实确立的章节号）】
${formatCanonForPrompt(canon, { includeChapters: true })}

【核心人物档案（用于人物性格与行为一致性）】
${formatCharacterProfiles(characters)}

【剧情台账（人物状态/关系/事件/伏笔，来自已写章节）】
${clip(storyContext || "（未检索到剧情台账）", 4000)}

${evidenceContext ? `【相关原文证据（按当前问题检索；原文与台账已分开标注，不要混用）】\n${clip(evidenceContext, 6000)}\n\n` : ""}【前文衔接（上一章结尾与最近摘要）】
${clip(previousContext || "（无）", 4000)}

【后文参考（重写时用于衔接下一章）】
${clip(nextContext || "（无）", 2500)}

【本章自动检查线索（可能误报，需结合正文判断）】
${formatIssuesForPrompt(suspicions)}

【本章细纲】
${chapter.summary}
关键事件：${chapter.keyBeats.join("；") || "（无）"}

【本章正文】
${clip(chapterText, 16000)}

请输出 JSON：
{
  "summary": "120-180 字本章摘要，只写正文实际发生的内容",
  "issues": [
    {
      "severity": "critical | warning | ignore",
      "type": "人物行为 | 人物性格 | 时间线 | 地点 | 死亡状态 | 物品归属 | 世界观规则 | 剧情因果 | 伏笔连续性 | 章节重复 | 大纲偏离 | 称谓 | 人物关系 | 其他",
      "evidence": "本章正文中的原文短句；不得只写摘要",
      "detail": "与第几章的哪条台账/规则/细纲冲突，为什么读者会觉得不合理",
      "sourceChapter": 4,
      "sourceEvidence": "被冲突的前文原文短句（能定位时填写）",
      "affectedCharacters": ["涉及人物名"],
      "conflictCategory": "timeline | character-status | fact | foreshadow | causality | other",
      "classification": "ESTABLISHED_CONTRADICTION | RULE_EXTENSION | CLARITY_GAP",
      "ruleLevel": "涉及世界观规则时填 HARD_RULE | SOFT_RULE | UNKNOWN_RULE | CHARACTER_BELIEF，否则省略"
    }
  ],
  "continuityOk": true
}

审校维度（逐项检查）：
1. 人物行为合理性：行动是否符合处境、能力、目标和已知信息。
2. 人物性格一致性：言行是否与人物卡和既有塑造一致。
3. 时间线连续性：日期、天数、期限、事件先后。
4. 地点连续性：同一时间的位置关系、移动是否可能。
5. 人物生死状态：已死人物是否被错误地写成活人行动。
6. 物品归属：关键物品的持有人、形态、来历是否被改写。
7. 世界观规则冲突：是否违反已确立的硬性规则。
8. 剧情因果关系：事件是否有足够起因，结果是否承接过程。
9. 伏笔连续性：回收是否有埋设依据，是否提前宣布回收。
10. 章节内容重复：是否大段复述前文或与旧章重复。
11. 章节与大纲偏离：本章是否明显缺少细纲要求的关键事件。

问题判断：
- 不要为了完成审校清单而强行生成问题；没有问题就返回空 issues。
- 同一根本原因导致的多个表现应尽量合并，不要拆分重复计数。
- 拿不准、证据不足或只是文风偏好时标 ignore；有疑点但仍有合理解释空间时标 warning；只有明确硬冲突才标 critical。
- 不要硬抠字眼：同一意思的不同说法、近义词替换、称呼或量词的细微变化、标点断句和叙述顺序调整，都不算矛盾。只有当字面差异改变了事实（谁做了什么、何时何地、物品在谁手里、人物是死是活）时才报问题。
- 正文只是把疗程写得更长、用量更大（例如重症需要连敷数日），不算否定既有解毒规则；只有明确说既有手段无效、不能根治或被降级时，才按规则冲突处理。
- 文学表达、艺术留白、合理悬念、人物有意隐瞒信息、人物做出意外选择，不得直接判定为逻辑错误或性格崩坏。
- 尚未解释的事件要考虑后续是否存在合理解释空间，不能仅因暂时没有解释就认定矛盾。
- 不要要求每章都必须有冲突、反转或悬念。

判定规则：
- critical：与事实台账、前文或硬性规则发生明确重大冲突，且不修会让读者认为前文写错。例如：已死人物以活人身份行动；关键物品的持有人、形态或来历被改写；日期、天数、期限算错；同一时间人物出现在两个相隔很远的地方；人物关系称谓突变。
- warning：存在疑点，但仍有合理解释空间，或明显偏离细纲/人物性格、需要作者关注；不构成硬数据矛盾，也不是单纯润色。
- ignore：只是措辞、文风、细节偏好，或证据不足、可改可不改，不影响连续性和读者理解；已确认是回忆、尸体、幻象或他人转述的死者出场也归入此类；定点修复不会处理这类问题。
- 每条问题必须有本章原文证据；detail 要写清与第几章、哪条台账、哪条规则或哪条细纲冲突。能定位时写“章内位置/人物动作/场景”，但不要编造不存在的原文。
- 回忆、尸体、幻象、转述中的死者不算复活；引用旧事不等于事实改变。
- 已死人物在本章说话、行走、战斗、持有物品或推动现场剧情，且上下文没有明确写成回忆、尸体、幻象、遗物或他人转述时，必须标为 critical。
- 重写章节时：台账里 statusChapter 等于本章序号的条目属于旧稿事实，可以在本章被改写，不要因此报 critical；statusChapter 小于本章序号的是硬约束；大于本章序号的是后文事实，只用于检查衔接，不要用它否定本章。
- 剧情台账和长期记忆是辅助线索，不是绝对真理：与事实台账冲突时以事实台账为准，与正文明确写出的事实冲突时以正文为准；不能因为台账没有记录就判定正文错误。
- 不允许为了通过审校而建议修改既定事实、台账或后文设定；如果正文与既定事实冲突，应指出正文需要修改，而不是让台账迁就正文。
- 自动检查线索只是待核实提示：核对后确认是回忆、尸体、幻象、遗物或他人转述的，不要输出这一条，也不要在 issues 里写“机械检查误报 / 不构成复活 / 不属问题 / 应标为 ignore”这类说明。
- issues 只保留确实需要作者修改的问题；确认不是问题就直接不输出，不要为了解释误报而保留空问题，也不要为了凑问题把可忽略项标成 warning。
- continuityOk 只有在没有任何 critical 时才为 true。

问题分类（每条问题必须标注 classification）：
- ESTABLISHED_CONTRADICTION：与正文明确建立的事实、人物状态、时间线或不可违反的硬规则冲突，且当前文本没有合理解释。只有这一类可以判 critical。
- RULE_EXTENSION：出现此前未明确建立的能力、现象或规则，可能拓展规则边界，但尚不能证明直接违反硬规则。默认 warning，不得判 critical；应说明与哪些既有规则存在潜在张力，以及新规则可以如何成立。
- CLARITY_GAP：剧情逻辑可能成立，但关键过程、术语或机制没有向读者交代。默认 warning 或 ignore，不阻止写回，不得为了消除它强制重写剧情。
- 没有出现过某种能力，不等于这种能力不可能存在。只有新内容直接否定已有明确规则时，才按矛盾处理。
- critical 必须写全：冲突双方的原文证据、具体章节、已建立的规则或事实、当前文本违反规则的具体方式、为何无法通过合理解释兼容。只能证明存在疑问时不得判 critical。
- 禁止仅凭“以前没有出现过”“与常见设定不同”判定严重问题。

世界观规则分级（涉及规则冲突时填写 ruleLevel）：
- HARD_RULE 明确不可违反；SOFT_RULE 是常见规律、允许例外；UNKNOWN_RULE 尚未明确；CHARACTER_BELIEF 只是人物自身相信的判断。
- 人物说出的判断不能自动当作客观世界观规则，必须核对规则来源、上下文和可信程度。

针对性判断：
- 时间线冲突必须核对冲突时刻人物的实际位置与可达性。若“人物当时在异地”的唯一证据就是被后文解释为伪造/冒充的那通电话（声音、背景音、通话内容），该证据随之失效，不得再用它反推人物时间线；只有存在独立于该电话场景的正文旁白或既定事实时，才可保留时间线矛盾。
- 人物台词、转述和角色推断不是客观事实。像“大约早到了半天”这类人物估测属于 CHARACTER_BELIEF，不能当作精确时刻；除非它与独立旁白直接冲突，否则不能据此判 critical。
- 作者已经在正文中明确写出解释（如“电话是伪造的”）时，不要因为缺少进一步铺垫、途中细节或读者可能追问就判 critical；确实无法理解事件如何发生时才标 CLARITY_GAP，且只记录不阻断。
- 区分承载物与被收纳对象：既有规则只禁止某种实体进入某物时，不能直接推断该实体的衍生形态不能作为独立对象被收纳；自定义状态词（如“已清除”）是否违反既有定义需单独审查，不能把整段情节一并判为严重矛盾。`,
    },
  ];
}

export function chapterRepairMessages(
  meta: ProjectMeta,
  chapter: ChapterPlan,
  chapterText: string,
  issues: ContinuityIssue[],
  canon: CanonFacts,
  previousEnding: string,
  nextOpening: string,
  rewriteInstruction: string,
  reviewFeedback: string,
  options: { draftRepair?: boolean; evidenceContext?: string; planText?: string } = {},
): ChatMessage[] {
  return [
    {
      role: "system",
      content: "你是中文小说修订编辑。你的任务是只处理当前确认的问题，优先局部修改，尽量保留原稿的文风、节奏、人物语言和绝大多数句子。只输出修订后的完整章节正文，不要输出标题、说明或修改记录。",
    },
    {
      role: "user",
      content: `《${meta.title}》第 ${chapter.index} 章《${chapter.title}》存在以下连续性问题，请做定点修订。

【必须解决的问题】
${formatIssuesForPrompt(issues)}
${reviewFeedback.trim() ? `\n【上一版审校记录（仅作参考，当前问题以“必须解决的问题”为准；已解决项不要重做）】\n${clip(reviewFeedback.trim(), 2400)}\n` : ""}
【不可违背的事实台账】
${formatCanonForPrompt(canon)}

${options.evidenceContext ? `【相关原文证据（按问题检索；原文与台账已分开标注）】\n${clip(options.evidenceContext, 6000)}\n\n` : ""}${options.planText ? `【已通过约束检查的修复方案（必须按方案执行，不得扩大修改范围）】\n${clip(options.planText, 4000)}\n\n` : ""}【上一章结尾（用于保持开头衔接）】
${clip(previousEnding || "（无）", 1500)}

${nextOpening ? `【下一章开头（用于保持结尾衔接）】\n${clip(nextOpening, 800)}\n` : ""}${rewriteInstruction ? `【本次重写要求】\n${rewriteInstruction}\n\n` : ""}【当前章节正文】
${clip(chapterText, 16000)}

修订要求：
- 只处理【必须解决的问题】中列出的当前有效问题；不要重复修复已经解决、证据已消失或未列出的问题。
- 逐项核对问题涉及的人物行为合理性、人物性格一致性、时间线、地点、生死状态、物品归属、世界观规则、剧情因果、伏笔连续性和大纲偏离；只修与这些问题直接相关的段落。
- 优先修改问题直接涉及的句子和段落；其余内容尽量逐字保留，不得为了修复一个问题重写整章。
- 不得删除关键剧情来掩盖问题；不得为了消除一个矛盾而制造新的时间线、人物关系、身份或因果矛盾。
- 不得擅自新增人物、事件、设定、物品、能力或伏笔；不得改变已确认的人物动机、关系和世界观。
- 不得复活已死亡人物，不得改动物品的持有人、形态和来历，不得改变已经确立的时间线和期限。
- 不得为了让本章通过而修改事实台账、删除既定剧情、改写其他章节或把矛盾解释成“回忆/幻觉”来蒙混；如果问题实际不成立，可以保留原段落。
- 必须依据【相关原文证据】核对前文事实；不得删除、截断或改写证据原文来规避矛盾，也不得把摘要或推断当成原文事实。
- 涉及“已死人物仍以活人身份行动”的问题：必须删除或改写所有相关动作、对话和在场描写，只能保留回忆、尸体、幻象、遗物或他人转述；必要时让其他在世角色承担剧情功能。
- 修正后本章开头仍要承接上一章结尾，结尾仍要能过渡到下一章开头（如果有）。
- 如果某条问题无法在不破坏其他内容的前提下安全修复，保留原段落，不要强行改写；不得引入新的矛盾。
- 保持原文风格、叙事节奏和人物语言习惯，字数与原文接近。
${
  options.draftRepair
    ? `- 本轮为草稿修复：只以【必须解决的问题】为准，不处理已解决、未列出或证据已消失的问题；如果必须新增剧情信息或重写整章才能修复，保留原段落。
`
    : ""
}- 直接输出完整的修订后正文，不要输出任何解释。`,
    },
  ];
}

// 修复后回归审校：不只看修改段落，还要核对来源章节因果、相邻章节、人物时间线和伏笔生命周期。
export function repairRegressionMessages(
  meta: ProjectMeta,
  chapter: ChapterPlan,
  originalText: string,
  repairedText: string,
  evidenceContext: string,
  canon: CanonFacts,
  characters: Character[],
  previousEnding: string,
  nextOpening: string,
  regressionScope = "",
  causalBaselines: CausalBaseline[] = [],
): ChatMessage[] {
  return [
    {
      role: "system",
      content: `你是中文小说修复回归审校员。修复稿可能解决了原问题却引入新矛盾，必须同时核对来源章节因果、相邻章节衔接、人物状态与关系、时间地点连续性、剧情因果和伏笔生命周期。只报告修复稿中真实存在、且需要作者处理的问题；没有问题就返回空 issues。${JSON_ONLY}`,
    },
    {
      role: "user",
      content: `请审校《${meta.title}》第 ${chapter.index} 章《${chapter.title}》的修复稿。

【事实台账】
${formatCanonForPrompt(canon, { includeChapters: true })}

【核心人物档案】
${formatCharacterProfiles(characters)}

【修复前检索到的相关原文证据（原文与台账已分开标注）】
${clip(evidenceContext || "（未检索到原文证据）", 6000)}

【上一章结尾】
${clip(previousEnding || "（无）", 1200)}

${nextOpening ? `【下一章开头】\n${clip(nextOpening, 800)}\n` : ""}${regressionScope.trim() ? `【本次回归审校扩大范围】\n${clip(regressionScope.trim(), 1200)}\n\n` : ""}${causalBaselines.length ? `【修复前因果结构（必须保持；不得改变执行者、动作、作用对象、处理对象和事件顺序）】\n${clip(causalBaselines.map(formatCausalBaseline).join("\n\n"), 4000)}\n\n` : ""}【修复前正文（仅作对比参考）】
${clip(originalText, 12000)}

【修复后正文（本次审校对象）】
${clip(repairedText, 16000)}

请只输出 JSON：
{
  "issues": [
    {
      "severity": "critical | warning | ignore",
      "type": "时间线 | 人物行为 | 死亡状态 | 物品归属 | 剧情因果 | 伏笔连续性 | 世界观规则 | 人物关系 | 其他",
      "evidence": "修复后正文中的原文短句",
      "detail": "与第几章/哪条事实冲突，为什么修复后反而不成立",
      "sourceChapter": 4,
      "affectedCharacters": ["涉及人物名"],
      "conflictCategory": "timeline | character-status | fact | foreshadow | causality | other",
      "classification": "ESTABLISHED_CONTRADICTION | RULE_EXTENSION | CLARITY_GAP",
      "ruleLevel": "涉及世界观规则时填 HARD_RULE | SOFT_RULE | UNKNOWN_RULE | CHARACTER_BELIEF，否则省略"
    }
  ],
  "causalChanges": [
    {
      "issueIndex": 1,
      "classification": "SAFE_REPHRASE | CAUSAL_EXPANSION | CAUSAL_CHANGE | CAUSAL_CONTRADICTION",
      "before": "修复前的动作/对象/结果",
      "after": "修复后的动作/对象/结果",
      "explanation": "为什么属于该分类"
    }
  ],
  "continuityOk": true
}

回归审校要求（逐项执行，不能只看修改段落）：
1. 原有问题是否真正解决，而不是通过删除原文证据、改变证据含义或回避关键剧情来掩盖。
2. 是否产生新的 critical。
3. 是否产生新的 warning（包括表达建议与审校不确定性，按严重程度如实标注）。
4. 是否破坏人物状态（生死、身份、所在位置、掌握的信息）。
5. 是否破坏人物关系（关系类型、亲疏、敌对/同盟是否被改写）。
6. 是否破坏时间线（同一时间是否出现在多个地点、事件先后是否颠倒）。
7. 是否破坏地点连续性（人物转场是否有依据、地点描写是否与前文冲突）。
8. 是否改变已经确立的事件因果（原因、经过、结果或影响是否被替换）。
9. 是否破坏伏笔生命周期（不能未埋先收、提前回收、删掉埋设或改写回收内容）。
10. 是否通过删除或改写原文证据来规避矛盾。
11. 是否修改了问题授权范围之外的段落，或顺带润色无关内容。
12. 是否与上一章结尾、下一章开头或来源章节产生新的冲突。
问题分类规则与章节审校相同：只有 ESTABLISHED_CONTRADICTION 才能判 critical；RULE_EXTENSION 和 CLARITY_GAP 按 warning 记录，不得为了回归通过而判 critical；“以前没出现”“与常见设定不同”不构成 critical 证据。

因果结构对比（必须逐项执行，并始终返回 causalChanges 数组；没有变化时返回空数组）：
1. 动作的执行者是否被替换或拆分？
2. 动作的直接作用对象是否改变？
3. 被记录/改变/处理的对象与最终结果是否仍然对应？例如在记录类载体中，被记录对象与记录位置的归属是否错位？
4. 是否新增了原文没有建立因果关系的中间对象、媒介或动作落点？
5. 事件先后顺序是否改变？
6. 结果是否指向了另一个人物或物体？
7. 是否新增了需要额外解释的新规则，或删除了原文必要的因果环节？
分类标准：
- SAFE_REPHRASE：只改变措辞，因果结构不变。
- CAUSAL_EXPANSION：增加合理的动作、过渡或细节，但不改变原有因果链；仍要检查是否引入新规则。
- CAUSAL_CHANGE：改变动作对象、作用对象、事件顺序、结果指向或因果链，或新增无依据的中间对象。
- CAUSAL_CONTRADICTION：修复后与原文既定事实或世界观规则直接冲突。
同一场景中出现的对象不能互相替换；不能因为两个对象都在场，就认为记录对象、作用对象可以互换。
示例（甲、乙、丙及载体均为抽象占位，仅用于说明分类标准，不代表任何具体作品的世界观机制）：原文是“甲说出了乙的罪证，记录载体自动生成乙的记录页”。修复稿若变成“甲把手指按在丙页空白处，说出乙的罪证，记录载体在丙页之后翻出乙的记录页”，却没有解释丙页与乙的记录之间的关联，必须判为 CAUSAL_CHANGE，不能只因为句子更生动就放过。

只有修复稿中真实存在的问题才报告；纯文风偏好标 ignore，不要求整章重写。修复范围之外发现的历史问题不要当作本次修复引入的新问题。`,
    },
  ];
}

// 第一次修复后：独立确认候选稿新增的严重问题是否真的由本次修复引入。
export function repairRegressionConfirmMessages(
  meta: ProjectMeta,
  chapter: ChapterPlan,
  originalText: string,
  candidateText: string,
  baselineIssues: ContinuityIssue[],
  newIssues: ContinuityIssue[],
  evidenceContext = "",
): ChatMessage[] {
  const baseline = baselineIssues
    .map((issue, index) => `${index + 1}. [${issue.id ?? `issue-${index + 1}`}] ${issue.type}：${issue.evidence}｜${issue.detail}`)
    .join("\n");
  const candidates = newIssues
    .map((issue, index) => `${index + 1}. ${issue.type}：${issue.evidence}｜${issue.detail}`)
    .join("\n");
  return [
    {
      role: "system",
      content: `你是独立的问题确认员，不参与制定修复方案，也不修改正文。你的任务是判断候选稿中的每个新增严重问题是否真的由本次修复引入。必须依据原文证据，不能接受推测。${JSON_ONLY}`,
    },
    {
      role: "user",
      content: `请确认《${meta.title}》第 ${chapter.index} 章《${chapter.title}》修复候选稿中的新增严重问题。

【修复前已确认的问题】
${baseline || "（无）"}

【待确认的新增严重问题】
${candidates || "（无）"}

${evidenceContext ? `【相关原文证据】\n${clip(evidenceContext, 5000)}\n\n` : ""}【修复前正文】
${clip(originalText, 10000)}

【修复后候选稿】
${clip(candidateText, 12000)}

请只输出 JSON：
{
  "confirmations": [
    {
      "index": 1,
      "verdict": "confirmed_new | pre_existing | false_positive | uncertain",
      "explanation": "依据原文说明判断",
      "schemeLevelFailure": false
    }
  ]
}

判定规则：
- confirmed_new：修复前原文没有该问题，候选稿中的证据明确引入或改变了相关事实、因果、对象或状态。
- pre_existing：该问题在修复前正文中已经存在，不能算作本次修复回归。
- false_positive：候选稿中找不到所引证据，或问题与原文、台账并不冲突。
- uncertain：证据不足、无法判断是否由本次修复引入；不得猜成 confirmed_new。
- 如果新增问题说明第一次修复方案本身不成立（例如为修复一个问题而新增违反世界观的能力、改变核心人物身份、新增未授权关键事件），把 schemeLevelFailure 设为 true。
- 只判断【待确认的新增严重问题】，不要重新审校整章，也不要提出修改建议。`,
    },
  ];
}

// Repair Agent 第一阶段：只出方案，不改正文。方案需通过约束检查后才能进入执行阶段。
export function chapterRepairPlanMessages(
  meta: ProjectMeta,
  chapter: ChapterPlan,
  chapterText: string,
  issues: ContinuityIssue[],
  canon: CanonFacts,
  previousEnding: string,
  nextOpening: string,
  rewriteInstruction: string,
  reviewFeedback: string,
  options: {
    draftRepair?: boolean;
    evidenceContext?: string;
    crossChapterContext?: string;
    authorDirective?: string;
  } = {},
): ChatMessage[] {
  return [
    {
      role: "system",
      content: `你是中文小说修订策划编辑。当前阶段只分析问题并制定定点修复方案，不修改正文。必须依据原文证据和事实台账；证据不足时明确要求作者决定，不得编造剧情解释。若冲突根源在更早章节，不得只在当前章硬圆，应给出需要作者选择的跨章方案。${JSON_ONLY}`,
    },
    {
      role: "user",
      content: `请为《${meta.title}》第 ${chapter.index} 章《${chapter.title}》制定修复方案。

【需要解决的问题（按序号对应，方括号内为问题 ID）】
${formatIssuesForPrompt(issues, { withIds: true })}
${reviewFeedback.trim() ? `\n【上一版审校记录（仅作参考）】\n${clip(reviewFeedback.trim(), 1800)}\n` : ""}
【不可违背的事实台账】
${formatCanonForPrompt(canon)}

${options.evidenceContext ? `【相关原文证据（按问题检索；原文与台账分开标注）】\n${clip(options.evidenceContext, 6000)}\n\n` : ""}${options.crossChapterContext ? `【问题涉及的此前章节原文（只读参考，用于判断是否需要跨章修复）】\n${clip(options.crossChapterContext, 8000)}\n\n` : ""}${options.authorDirective ? `【作者已确认的修复方向（必须严格遵守，不得再要求作者决定）】\n${clip(options.authorDirective, 2000)}\n\n` : ""}【上一章结尾】
${clip(previousEnding || "（无）", 1200)}

${nextOpening ? `【下一章开头】\n${clip(nextOpening, 800)}\n` : ""}${rewriteInstruction ? `【本次修复要求】\n${rewriteInstruction}\n\n` : ""}【当前章节正文】
${clip(chapterText, 12000)}

请只输出 JSON 修复方案：
{
  "issuePlans": [
    {
      "issueIndex": 1,
      "rootCause": "问题的根本原因",
      "evidence": "支持判断的原文短句（必须来自给定正文或证据）",
      "locations": ["计划修改的段首短句或章内位置"],
      "strategy": "最小化修改策略，说明如何在不引入新矛盾的前提下修复",
      "affectedFacts": ["可能受影响的人物/物品/时间线/伏笔事实"],
      "sideEffects": "潜在副作用及规避方式",
      "regressionScope": "需要扩大回归审校的范围，例如涉及的来源章节、人物、事件、地点",
      "causalBaseline": {
        "actor": "动作执行者（必须是修复前原文中的）",
        "action": "动作",
        "target": "动作直接作用的对象",
        "object": "被记录/改变/处理的对象",
        "location": "动作发生位置",
        "sequence": "事件先后顺序",
        "cause": "事件触发原因",
        "effect": "事件结果",
        "rule": "涉及的世界观规则；没有则写“无”"
      }
    }
  ],
  "needsAuthorDecision": false,
  "decisionReason": "需要作者决定时说明缺什么证据或需要作者确认什么",
  "decisionOptions": [
    {
      "label": "方案 A：一句话标题",
      "description": "选择该方案后具体要改哪些章节、哪些事实，以及保留什么",
      "affectedChapters": [4, 5],
      "anchors": ["方案依赖的原文短句，必须逐字来自对应章节正文"],
      "introducedFacts": ["该方案会新增的设定、物品或来源；没有新增就写空数组"],
      "recommended": true
    }
  ]
}

约束：
- issueIndex 必须对应【需要解决的问题】的序号从 1 开始。
- 如果冲突根源在更早章节、只改当前章必然制造新矛盾，必须把 needsAuthorDecision 设为 true，并给出 2-4 个互斥的 decisionOptions；每个方案必须写清 affectedChapters 和真实存在的 anchors。
- 如果冲突只是角色台词、解释或动机与台账/前文口径不一致，优先改本章台词使其与台账一致，不要要求作者重新定义规则，也不要生成决策方案。
- 只有正文之间的事件事实互斥（谁做了什么、谁死谁活、物品在谁手里、何时何地）且无法只改本章解决时，才把 needsAuthorDecision 设为 true。
- 任何会新增或改写设定、规则、物品来源的内容，都必须写进对应方案的 introducedFacts；只是让台词与既有台账一致不算新增。
- 不得通过否定既有规则来制造紧迫感；紧迫感应来自既有的封僵条件、期限、物品归属或人物目标。
- decisionOptions 必须恰好有一个方案标 "recommended": true，优先推荐对已写正文改动最少、与既定事实冲突最小、后续章节最容易衔接的方案；其余方案标 false。
- 不得用原文和台账里不存在的人物、物品、来源或规则来解题（例如“某某其实私藏了另一块玉”）。如果方案确实必须新增设定，必须逐条写进 introducedFacts，并在 label 开头标明“新增设定”；有新增设定的方案不能标 recommended，除非所有方案都不得不新增设定。
- 优先给出只改本章、或只改最少章节且不新增设定的方案；没有安全方案时应明确说明，而不是编造新设定。
- 如果【作者已确认的修复方向】已给出，必须按该方向制定方案，不得再要求作者决定；affectedChapters 只能包含当前章和该方向涉及的此前章节。
- 每个问题都必须有可执行的 strategy；没有足够证据时把 needsAuthorDecision 设为 true，不要编造。
- evidence 必须是当前正文或给定原文证据中真实存在的短句，不能用事实台账、摘要或你的推断冒充原文。
- locations 必须是当前正文中真实存在的段首短句或位置；找不到可定位的原文时不要臆造。
- regressionScope 必须写明需要扩大到哪些来源章节、人物、事件或地点，供回归审校使用。
- 不允许通过删除关键剧情、改写证据、修改台账或把矛盾解释成回忆/幻觉来修复。
- 只做必要的最小修改，不重写整章，不新增人物、设定或伏笔。
- affectedFacts 和 sideEffects 必须如实填写，供后续回归审校使用。
- causalBaseline 必须描述**修复前原文**的真实因果结构，不能写成计划中的新剧情；actor/action/target/object/effect 不得留空。仅做表达调整时，各字段写“仅表达调整”，但 actor/action/effect 仍要给出。
- 必须区分动作发生位置、动作直接作用对象、最终产生结果的对象；不能因为它们在同一个场景出现就当作可以互换。
- 修复时必须保持 causalBaseline 中的执行者、动作、作用对象、处理对象和事件顺序；不得新增原文没有的中间对象或动作落点来连接因果。`,
    },
  ];
}

// Repair Agent 第二阶段：按已通过约束检查的方案输出结构化补丁，不返回整章正文。
export function chapterRepairPatchMessages(
  meta: ProjectMeta,
  chapter: ChapterPlan,
  chapterText: string,
  issues: ContinuityIssue[],
  canon: CanonFacts,
  previousEnding: string,
  nextOpening: string,
  rewriteInstruction: string,
  reviewFeedback: string,
  options: {
    draftRepair?: boolean;
    evidenceContext?: string;
    planText?: string;
    crossChapterContext?: string;
    authorDirective?: string;
    affectedChapters?: number[];
  } = {},
): ChatMessage[] {
  const crossChapters = (options.affectedChapters ?? []).filter(
    (index) => index !== chapter.index,
  );
  return [
    {
      role: "system",
      content: `你是中文小说局部修订编辑。你不能重写整章，只能针对每个已确认问题输出最小修改补丁。补丁必须锚定对应章节中真实存在且唯一的原文片段，程序会逐条校验后应用；任何一项校验失败，整批补丁都不会被采用。${JSON_ONLY}`,
    },
    {
      role: "user",
      content: `请为《${meta.title}》第 ${chapter.index} 章《${chapter.title}》输出局部修复补丁。

【待修问题（必须全部覆盖，方括号内为问题 ID）】
${formatIssuesForPrompt(issues, { withIds: true })}
${reviewFeedback.trim() ? `\n【上一版审校记录（仅作参考，当前问题以“待修问题”为准）】\n${clip(reviewFeedback.trim(), 1800)}\n` : ""}
【不可违背的事实台账（不是原文，不得当作补丁锚点）】
${formatCanonForPrompt(canon)}

${options.evidenceContext ? `【相关原文证据（按问题检索；原文与台账已分开标注）】\n${clip(options.evidenceContext, 6000)}\n\n` : ""}${options.planText ? `【已通过约束检查的修复方案（必须按方案执行，不得扩大修改范围）】\n${clip(options.planText, 4000)}\n\n` : ""}${options.authorDirective ? `【作者已确认的修复方向（必须严格遵守）】\n${clip(options.authorDirective, 2000)}\n\n` : ""}${options.crossChapterContext ? `【允许修改的此前章节原文（只读锚点来源）】\n${clip(options.crossChapterContext, 8000)}\n\n` : ""}${crossChapters.length ? `【跨章修改许可】允许修改的章节：当前第 ${chapter.index} 章，以及第 ${crossChapters.join("、")} 章。其他章节一律禁止修改。\n\n` : ""}【上一章结尾】
${clip(previousEnding || "（无）", 1200)}

${nextOpening ? `【下一章开头】\n${clip(nextOpening, 800)}\n` : ""}${rewriteInstruction ? `【本次修复要求】\n${rewriteInstruction}\n\n` : ""}【当前章节正文（补丁锚点必须逐字来自这里）】
${clip(chapterText, 16000)}

请只输出 JSON 补丁：
{
  "patches": [
    {
      "issueId": "对应的问题 ID",
      "edits": [
        {
          "chapterIndex": 5,
          "originalText": "必须逐字复制对应章节正文中的一个完整短句或段落，且在该章中只出现一次",
          "replacement": "替换后的文本，保留原句其余部分，只改必要内容",
          "reason": "这处修改如何解决对应问题"
        }
      ]
    }
  ]
}

约束：
- 每个待修问题都必须至少有一个 edit；没有把握安全修改时不要编造锚点。
- chapterIndex 默认当前章 ${chapter.index}${crossChapters.length ? `；只有本次允许的第 ${crossChapters.join("、")} 章可以例外` : "；本次不允许修改其他章节"}。
- originalText 必须逐字存在于对应 chapterIndex 的章节正文且只出现一次；不能用台账、摘要、上一版或推断文本作为锚点。
- 只允许修改包含问题证据或方案位置的段落；不得修改未授权段落，不得顺带润色无关内容。
- 不同 edit 的原文锚点不得重叠；同一段落内多处修改请分别给出互不重叠的锚点。
- replacement 必须保留原段落中与问题无关的内容，不得删除关键证据来规避矛盾。
- 不得新增人物、事件、设定、物品、能力或伏笔；不得改变已确认的事实、时间线和伏笔生命周期。
- 必须保持方案中的因果结构：动作执行者、动作、直接作用对象、被记录/改变对象、事件顺序和结果都不能改变。
- 不得为了增强画面感新增原文没有的中间对象、动作落点或媒介；不得让结果指向另一个人物或物体。
- 如果按原因果结构无法修复，保留原段落，不要自行设计新的因果机制。
- 直接输出 JSON，不要输出解释或修改记录。`,
    },
  ];
}
