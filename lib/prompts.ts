import type { ChatMessage } from "./llm";
import type { ChapterPlan, Character, ProjectMeta } from "./types";

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
  history: string[],
): ChatMessage[] {
  const characterJson = JSON.stringify(characters, null, 2);
  const previous = history.length ? history.map((item, i) => `${i + 1}. ${item}`).join("\n") : "（本章为全书开头，无前情）";

  return [
    {
      role: "system",
      content: `你是一位签约中文网络小说作者，擅长画面感强、节奏明快的连载章节。你只输出章节正文，不要输出章节标题、写作说明或任何元信息。`,
    },
    {
      role: "user",
      content: `请续写《${meta.title}》（${meta.genre} / ${meta.tone}）。

【世界观摘要】
${clip(bible, 4000)}

【主要人物档案】
${clip(characterJson, 6000)}

【前情提要】
${previous}

【本章细纲】
第 ${chapter.index} 章：${chapter.title}
梗概：${chapter.summary}
关键事件：${chapter.keyBeats.join("；") || "（自由发挥，但需服务主线）"}

【写作要求】
- 字数约 ${meta.wordsPerChapter} 字（上下浮动 20% 以内）。
- 使用第三人称叙述，保持与前文一致的人设、称呼与设定。
- 用场景、动作和对话推进剧情，避免大段总结式叙述。
- 章末留下明确的悬念或钩子。

直接开始正文。`,
    },
  ];
}

export function reviewerMessages(
  meta: ProjectMeta,
  bible: string,
  chapter: ChapterPlan,
  chapterText: string,
): ChatMessage[] {
  return [
    {
      role: "system",
      content: `你是严谨的中文小说责编，负责检查人设、设定与时间线的一致性，并提炼章节摘要。${JSON_ONLY}`,
    },
    {
      role: "user",
      content: `请审校《${meta.title}》第 ${chapter.index} 章《${chapter.title}》。

【世界观要点】
${clip(bible, 3000)}

【本章大纲】
${chapter.summary}

【章节正文】
${clip(chapterText, 12000)}

请输出 JSON：
{
  "summary": "120-180 字本章摘要，供后续章节作为前情使用",
  "issues": ["一致性问题或改进建议，没有则为空数组"],
  "continuityOk": true
}`,
    },
  ];
}
