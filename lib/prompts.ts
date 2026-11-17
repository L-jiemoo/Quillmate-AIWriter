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
${options.memoryContext?.trim() ? `\n【长期记忆（来自已写章节，按当前章节相关度检索）】\n${options.memoryContext.trim()}\n` : ""}${options.storyContext?.trim() ? `\n【剧情台账（人物动态状态、关系、事件与伏笔，按当前章节相关度检索）】\n${options.storyContext.trim()}\n` : ""}${options.reviewFeedback?.trim() ? `\n【上一版审校发现的严重问题（新稿中仍存在则必须解决，已不存在的不要强行改剧情）】\n${clip(options.reviewFeedback.trim(), 2400)}\n` : ""}
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
- 【长期记忆】只来自已写章节的摘要/事件/人物/规则检索结果；记忆中没有记录的人物、物品、关系和事件，不得补写成既定事实。检索不到时按本章细纲自然推进，不要虚构“前文已经发生”的内容。
- 如果【长期记忆】与事实台账冲突，以事实台账为准；如果与本章细纲冲突，以已写事实为准并自然处理。
- 【剧情台账】中的人物状态、关系、事件和伏笔也只来自已写章节；未记录的状态变化、关系和因果不得凭空补写。人物行为必须符合其当前生死、位置、身体、能力和掌握的信息。
- 伏笔只按台账中“未回收/待回收/发展中”的状态推进；不得在没有正文依据时宣布回收。若本章按细纲需要回收，必须写出明确回收情节。
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
- 只记录正文实际发生的事实。回忆、转述、猜测、计划、梦境不算“当前事实”。
- status 只能填 alive、dead、unknown，不要填中文；人物在本章死亡才填 dead。
- 被提到名字不等于复活：如果人物只是被回忆、尸体出现或被提及，不要标 alive。
- evidence 必须直接描述该人物本人的行动或状态。句子主体是“他/她/它/那人”时，只有上下文明确指向该人物才能算证据；不要把其他角色的打斗、受伤、抢夺等行动归到已死人物名下。
- 只出现在坟地、遗物、笔记、名单、回忆里的已死人物，status 填 dead 或 unknown，不要因为名字出现就标 alive。
- 只抽取有名字、会行动或状态发生变化的人物，以及推动剧情的关键物品。
- 不要臆造正文没有的姓名、物品、日期；summary 里不得出现正文没有的人名或事件。
- memory.events 只写本章正文实际推进的事件，不写细纲里计划但正文没发生的内容；memory.characters 中的名字必须在正文出现。
- memory.foreshadowsPlanted 只记录正文中明确留下、后续可能需要回收的线索；普通悬念不要全部算作伏笔。memory.foreshadowsResolved 只记录本章明确回收的旧伏笔。
- story.states 只写本章结束时的状态快照，不写计划、猜测或未来变化；lifeStatus 只能填 alive、dead、unknown，本章死亡才填 dead。
- story.relations 只写正文明确体现的关系或本章发生的关系变化；不要补写未出现的关系。
- story.events 只写正文实际发生的事件；participants 必须是正文出现的参与者。relatedEvents 只能引用本章事件名称；foreshadows 只关联正文明确涉及的伏笔。
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
): ChatMessage[] {
  return [
    {
      role: "system",
      content: `你是极其严格的中文小说责编，负责连续性与创作质量审校。你必须引用本章原文作为证据，不确定、证据不足或只是文风偏好的问题标为 ignore。${JSON_ONLY}`,
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

【前文衔接（上一章结尾与最近摘要）】
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
      "detail": "与第几章的哪条台账/规则/细纲冲突，为什么读者会觉得不合理"
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

判定规则：
- critical：与事实台账、前文或硬性规则直接矛盾，且不修会让读者认为前文写错。例如：已死人物以活人身份行动；关键物品的持有人、形态或来历被改写；日期、天数、期限算错；同一时间人物出现在两个相隔很远的地方；人物关系称谓突变。
- warning：表达含糊、缺少过渡、需要读者脑补，或明显偏离细纲/人物性格，但不构成硬数据矛盾；值得顺手修改。
- ignore：只是措辞、文风、细节偏好，或证据不足、可改可不改，不影响连续性和读者理解；定点修复不会处理这类问题。
- 每条问题必须有本章原文证据；detail 要写清与第几章、哪条台账、哪条规则或哪条细纲冲突。能定位时写“章内位置/人物动作/场景”，但不要编造不存在的原文。
- 回忆、尸体、幻象、转述中的死者不算复活；引用旧事不等于事实改变。
- 已死人物在本章说话、行走、战斗、持有物品或推动现场剧情，且上下文没有明确写成回忆、尸体、幻象、遗物或他人转述时，必须标为 critical。
- 重写章节时：台账里 statusChapter 等于本章序号的条目属于旧稿事实，可以在本章被改写，不要因此报 critical；statusChapter 小于本章序号的是硬约束；大于本章序号的是后文事实，只用于检查衔接，不要用它否定本章。
- 剧情台账和长期记忆是辅助线索，不是绝对真理：与事实台账冲突时以事实台账为准，与正文明确写出的事实冲突时以正文为准；不能因为台账没有记录就判定正文错误。
- 不允许为了通过审校而建议修改既定事实、台账或后文设定；如果正文与既定事实冲突，应指出正文需要修改，而不是让台账迁就正文。
- 自动检查线索只是待核实提示：核对后确认是回忆、尸体、幻象、遗物或他人转述的，不要输出这一条，也不要在 issues 里写“机械检查误报 / 不构成复活 / 不属问题 / 应标为 ignore”这类说明。
- issues 只保留确实需要作者修改的问题；确认不是问题就直接不输出，不要为了解释误报而保留一条空问题。
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
- 逐项核对问题涉及的人物行为合理性、人物性格一致性、时间线、地点、生死状态、物品归属、世界观规则、剧情因果、伏笔连续性和大纲偏离；只修与这些问题直接相关的段落。
- 只修改与上述问题直接相关的段落；其余段落尽量保持原样，不要重写整章。
- 不得复活已死亡人物，不得改动物品的持有人、形态和来历，不得改变已经确立的时间线和期限。
- 不得为了让本章通过而修改事实台账、删除既定剧情、改写其他章节或把矛盾解释成“回忆/幻觉”来蒙混；如果问题实际不成立，可以保留原段落。
- 涉及“已死人物仍以活人身份行动”的问题：必须删除或改写所有相关动作、对话和在场描写，只能保留回忆、尸体、幻象、遗物或他人转述；必要时让其他在世角色承担剧情功能。
- 修正后本章开头仍要承接上一章结尾，结尾仍要能过渡到下一章开头（如果有）。
- 如果某条问题实际不成立，可以保留原段落，但不得引入新的矛盾。
- 字数与原文接近。
- 直接输出完整的修订后正文，不要输出任何解释。`,
    },
  ];
}
