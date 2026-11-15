import { formatCanonForPrompt, formatIssuesForPrompt } from "./canon";

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
      content: `你是一位资深中文网络小说策划与架构师，擅长世界观设计、主线冲突与商业连载的节奏安排。${JSON_ONLY}`,
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
  ]
}

要求：
- chapters 从 index 1 开始连续编号，数量为 ${meta.targetChapters}。
- 每章都要有明确冲突或钩子，章末留悬念。
- 世界观要为长篇连载留出扩展空间。`,
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
      content: `你是一位资深中文网络小说策划与架构师，负责在既有大纲基础上续排后续章节，保持主线连贯并持续升级冲突。${JSON_ONLY}`,
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

请输出 JSON：
{
  "chapters": [
    {"index": ${startIndex}, "title": "章节标题（不含“第X章”前缀）", "summary": "本章 80-150 字剧情梗概", "keyBeats": ["关键事件1", "关键事件2"]}
  ]
}

要求：
- chapters 从 index ${startIndex} 开始连续编号，共 ${count} 章。
- 新章节标题必须互不相同，且不得与【现有章节标题（不得复用）】中的任何一条重复；尤其不要复用现有最后一章的标题。
- 延续现有主线、人物状态与伏笔，不要重述已写内容。
- 冲突、代价与风险逐章升级，为后续留出空间。
- 每章都要有明确冲突或钩子，章末留悬念。`,
    },
  ];
}

export function titleRepairMessages(
  chapters: ChapterPlan[],
  forbiddenTitles: string[],
): ChatMessage[] {
  const list = chapters
    .map(
      (chapter) =>
        `第 ${chapter.index} 章，原标题《${chapter.title}》，本章梗概：${chapter.summary}`,
    )
    .join("\n\n");

  return [
    {
      role: "system",
      content: `你是中文小说编辑，擅长为章节起简洁、有画面感的标题。${JSON_ONLY}`,
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
- 每个标题必须简洁、有画面感，且彼此不同。
- 不得与【禁止使用的标题】中的任何标题重复。
- 只输出需要改名的章节。`,
    },
  ];
}

export function characterMessages(meta: ProjectMeta, bible: string, outlineMd: string): ChatMessage[] {
  return [
    {
      role: "system",
      content: `你是一位擅长群像塑造的中文小说角色设计师，人物必须有欲望、缺陷与成长弧光。${JSON_ONLY}`,
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

要求：角色之间必须有利益冲突和情感牵绊，避免功能重复。`,
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
      content: `你是一位签约中文网络小说作者，擅长画面感强、节奏明快的连载章节。你只输出章节正文，不要输出章节标题、写作说明或任何元信息。`,
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
${options.reviewFeedback?.trim() ? `\n【上一版审校发现的严重问题（新稿中仍存在则必须解决，已不存在的不要强行改剧情）】\n${clip(options.reviewFeedback.trim(), 2400)}\n` : ""}
【上一章结尾（原文）】
${ending}
${nextOpening ? `\n【下一章开头（供收束参考）】\n${clip(nextOpening, 800)}\n` : ""}
【前情提要】
${previous}

【本章细纲】
第 ${chapter.index} 章：${chapter.title}
梗概：${chapter.summary}
关键事件：${chapter.keyBeats.join("；") || "（自由发挥，但需服务主线）"}

【写作要求】
${options.mode === "rewrite" ? "- 这是在重写已有章节：不要照抄旧稿，按细纲和重写要求重新组织场景与叙述。\n" : ""}${rewriteNote ? `- 本次重写要求：${rewriteNote}\n` : ""}- 本章开头必须直接承接【上一章结尾（原文）】中的人物动作、场景和情绪，不要复述上一章，也不要无交代地另起一场戏。
- 如果本章细纲要求换场或时间跳跃，必须在前 200 字内用动作、对话或叙述交代过渡。
${nextOpening ? "- 本章结尾必须能自然过渡到【下一章开头（供收束参考）】，不要与其矛盾。\n" : ""}- 严格遵守【不可违背的事实台账】：已死亡角色不得以活人身份行动；关键物品的持有人、形态与状态不得随意改写；日期、天数和死线必须前后一致。
- 已死角色只能以回忆、尸体、幻象、遗物或他人转述出现；不得说话、行走、战斗、持有物品或推动现场剧情。若细纲要求其行动，改用其他在世角色承担该行动，或明确处理为上述非活人形式。
- 如果本章细纲与事实台账冲突，以事实台账为准，并在正文中自然处理；不得为了迎合细纲而复活死者或改写既定事实。
- 字数约 ${meta.wordsPerChapter} 字（上下浮动 20% 以内）。
- 使用第三人称叙述，保持与前文一致的人设、称呼与设定。
- 用场景、动作和对话推进剧情，避免大段总结式叙述。
- 章末留下明确的悬念或钩子。

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
      content: `你是严谨的中文小说连续性编辑。你的任务只是从正文中抽取“已经发生的事实”并写摘要，不创作、不补写、不推断正文没有写的内容。${JSON_ONLY}`,
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
  "rules": ["本章确立的、后续不能违背的硬性规则"]
}

要求：
- 只记录正文实际发生的事实。回忆、转述、猜测、计划、梦境不算“当前事实”。
- status 只能填 alive、dead、unknown，不要填中文；人物在本章死亡才填 dead。
- 被提到名字不等于复活：如果人物只是被回忆、尸体出现或被提及，不要标 alive。
- evidence 必须直接描述该人物本人的行动或状态。句子主体是“他/她/它/那人”时，只有上下文明确指向该人物才能算证据；不要把其他角色的打斗、受伤、抢夺等行动归到已死人物名下。
- 只出现在坟地、遗物、笔记、名单、回忆里的已死人物，status 填 dead 或 unknown，不要因为名字出现就标 alive。
- 只抽取有名字、会行动或状态发生变化的人物，以及推动剧情的关键物品。
- 不要臆造正文没有的姓名、物品、日期；summary 里不得出现正文没有的人名或事件。
- evidence 必须摘自本章正文。`,
    },
  ];
}

export function auditMessages(
  meta: ProjectMeta,
  canon: CanonFacts,
  chapter: ChapterPlan,
  chapterText: string,
  previousContext: string,
  suspicions: ContinuityIssue[],
  nextContext: string,
): ChatMessage[] {
  return [
    {
      role: "system",
      content: `你是极其严格的中文小说责编，只负责找前后矛盾。你必须引用本章原文作为证据，不确定或只是文风偏好的问题标为 ignore。${JSON_ONLY}`,
    },
    {
      role: "user",
      content: `请审校《${meta.title}》第 ${chapter.index} 章《${chapter.title}》与已写内容的连续性。

【事实台账（含每条事实确立的章节号）】
${formatCanonForPrompt(canon, { includeChapters: true })}

【前文衔接（上一章结尾与最近摘要）】
${clip(previousContext || "（无）", 4000)}

【后文参考（重写时用于衔接下一章）】
${clip(nextContext || "（无）", 2500)}

【机械检查线索（可能误报，需结合正文判断）】
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
      "type": "死亡状态 | 物品 | 时间线 | 位置 | 称谓 | 人物关系 | 能力规则 | 其他",
      "evidence": "本章正文中的原文短句",
      "detail": "与台账或第几章的什么事实冲突，为什么读者会觉得前后不一致"
    }
  ],
  "continuityOk": true
}

判定规则：
- critical：与台账或前文直接矛盾，且不修会让读者认为前文写错。例如：已死人物以活人身份行动；关键物品的持有人、形态或来历被改写；日期、天数、期限算错；同一时间人物出现在两个相隔很远的地方；人物关系称谓突变。
- warning：表达含糊、缺少过渡、需要读者脑补，但不构成硬矛盾；值得顺手修改。
- ignore：只是措辞、文风、细节偏好，或证据不足、可改可不改，不影响连续性和读者理解；定点修复不会处理这类问题。
- 回忆、尸体、幻象、转述中的死者不算复活；引用旧事不等于事实改变。
- 已死人物在本章说话、行走、战斗、持有物品或推动现场剧情，且上下文没有明确写成回忆、尸体、幻象、遗物或他人转述时，必须标为 critical。
- 重写章节时：台账里 statusChapter 等于本章序号的条目属于旧稿事实，可以在本章被改写，不要因此报 critical；statusChapter 小于本章序号的是硬约束；大于本章序号的是后文事实，只用于检查衔接，不要用它否定本章。
- 拿不准是否构成矛盾、或只是润色建议时标 ignore；不要为了凑问题把可忽略项标成 warning。
- continuityOk 只有在没有任何 critical 时才为 true。`,
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
): ChatMessage[] {
  return [
    {
      role: "system",
      content: "你是中文小说修订编辑。你的任务是只修正连续性问题，尽量保留原稿的文风、节奏和绝大多数句子。只输出修订后的完整章节正文，不要输出标题、说明或修改记录。",
    },
    {
      role: "user",
      content: `《${meta.title}》第 ${chapter.index} 章《${chapter.title}》存在以下连续性问题，请做定点修订。

【必须解决的问题】
${formatIssuesForPrompt(issues)}
${reviewFeedback.trim() ? `\n【上一版审校记录（可能已过时；新稿中仍存在则必须解决）】\n${clip(reviewFeedback.trim(), 2400)}\n` : ""}
【不可违背的事实台账】
${formatCanonForPrompt(canon)}

【上一章结尾（用于保持开头衔接）】
${clip(previousEnding || "（无）", 1500)}

${nextOpening ? `【下一章开头（用于保持结尾衔接）】\n${clip(nextOpening, 800)}\n` : ""}${rewriteInstruction ? `【本次重写要求】\n${rewriteInstruction}\n\n` : ""}【当前章节正文】
${clip(chapterText, 16000)}

修订要求：
- 只修改与上述问题直接相关的段落；其余段落尽量保持原样，不要重写整章。
- 不得复活已死亡人物，不得改动物品的持有人、形态和来历，不得改变已经确立的时间线和期限。
- 涉及“已死人物仍以活人身份行动”的问题：必须删除或改写所有相关动作、对话和在场描写，只能保留回忆、尸体、幻象、遗物或他人转述；必要时让其他在世角色承担剧情功能。
- 修正后本章开头仍要承接上一章结尾，结尾仍要能过渡到下一章开头（如果有）。
- 如果某条问题实际不成立，可以保留原段落，但不得引入新的矛盾。
- 字数与原文接近。
- 直接输出完整的修订后正文，不要输出任何解释。`,
    },
  ];
}
