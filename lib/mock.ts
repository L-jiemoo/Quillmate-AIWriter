import type { ChapterPlan, Character, ProjectMeta, ProjectPlan, ReviewResult } from "./types";

export interface GeneratedPlan {
  plan: ProjectPlan;
  bible: string;
  outlineMd: string;
}

export function mockPlan(meta: ProjectMeta): GeneratedPlan {
  const count = Math.min(Math.max(meta.targetChapters || 12, 1), 30);
  const chapters: ChapterPlan[] = Array.from({ length: count }, (_, i) => ({
    index: i + 1,
    title: `示例章节 ${i + 1}`,
    summary: `第 ${i + 1} 章示例梗概：主角围绕「${meta.idea || meta.title}」推进主线，遭遇新的阻碍，并在章末埋下钩子。`,
    keyBeats: ["冲突升级", "人物关系推进", "结尾留悬念"],
  }));

  return {
    plan: {
      logline: `（mock 示例）${meta.title}：在「${meta.tone}」的基调中展开一段${meta.genre}旅程。`,
      tags: [meta.genre, meta.tone, "示例数据"],
      chapters,
    },
    bible: `# ${meta.title} · 世界观圣经

（mock 模式自动生成，仅用于跑通流程）

## 世界规则
- 这是一个围绕「${meta.idea || "核心创意"}」展开的世界。
- 力量与代价相互绑定，越强的能力需要越昂贵的付出。

## 主要势力
- 秩序维护者：掌控规则，也依赖规则。
- 边缘游走者：在夹缝中生存，掌握灰色情报。
- 未知的第三方：真正的幕后推手。

## 基调
- ${meta.tone}
- 长篇连载，保留扩展空间。
`,
    outlineMd: `# ${meta.title} · 主线大纲

（mock 模式自动生成）

## 第一幕
- 主角被卷入核心事件，获得关键能力或线索。

## 第二幕
- 冲突升级，盟友与对手同时登场，旧秩序开始松动。

## 第三幕
- 伏笔回收，主角完成阶段性成长，并为下一卷留下更大的谜团。
`,
  };
}

export function mockExtendedChapters(
  meta: ProjectMeta,
  startIndex: number,
  count: number,
): ChapterPlan[] {
  return Array.from({ length: count }, (_, i) => {
    const index = startIndex + i;
    return {
      index,
      title: `示例章节 ${index}`,
      summary: `第 ${index} 章示例梗概：主线继续推进，围绕「${meta.idea || meta.title}」出现新的变数，人物关系与代价同步升级。`,
      keyBeats: ["新冲突出现", "旧伏笔推进", "结尾留悬念"],
    };
  });
}

export function mockCharacters(meta: ProjectMeta): Character[] {
  return [
    {
      name: "沈烛",
      role: "主角",
      gender: "男",
      age: "十九岁",
      appearance: "瘦高，左眉有一道旧疤，常年提一盏暗色提灯。",
      personality: "冷静、执拗，对失去的记忆异常敏感。",
      background: `在${meta.genre}世界的边缘长大，靠修补旧灯为生。`,
      goals: "找回被自己亲手抹去的那段记忆。",
      arc: "从只想活下去，到愿意为他人点亮灯。",
      relationships: "与顾晚舟互相利用又彼此依赖；视守灯会为最大障碍。",
      speechStyle: "话少，偶尔冷幽默，习惯用反问结束对话。",
    },
    {
      name: "顾晚舟",
      role: "核心配角",
      gender: "女",
      age: "二十三岁",
      appearance: "短发，常穿深青色风衣，手指沾着洗不掉的墨。",
      personality: "圆滑、重情，擅长在谎言里说真话。",
      background: "守灯会的叛逃记录官，掌握大量被删除的记忆。",
      goals: "把真相完整地送出去。",
      arc: "从自保的旁观者，变成愿意承担后果的记录者。",
      relationships: "与沈烛是交易伙伴；对守灯会既恐惧又憎恨。",
      speechStyle: "语速快，喜欢用比喻，笑起来带刺。",
    },
    {
      name: "灯婆",
      role: "导师",
      gender: "女",
      age: "不详",
      appearance: "白发盘成高髻，眼睛像两枚冷却的灯芯。",
      personality: "温和而有耐心，从不直接回答问题。",
      background: "最后一位初代点灯人，守着城中心那盏不灭的灯。",
      goals: "等待一个能接替她的人。",
      arc: "从神秘的引导者，逐渐暴露自己也可能是共谋。",
      relationships: "沈烛名义上的师父；与守灯会高层有旧账。",
      speechStyle: "慢条斯理，常用反问和古老的灯谚。",
    },
  ];
}

export function mockChapter(meta: ProjectMeta, chapter: ChapterPlan): string {
  return `（mock 占位正文：配置真实模型后，这里会生成完整的章节内容。）

夜色压在屋檐上，像一层没有晾干的墨。沈烛提着灯走过长街，灯芯里的火苗缩成一小粒，照着脚前三步远的地方。

“你又在想那段记忆了。”顾晚舟从巷口的阴影里走出来，手里攥着一卷被雨打湿的纸。

沈烛没有回头。他知道她看得见自己灯里少了一截光，就像别人看得见他少了一块过去。

远处，城中心那盏不灭的灯忽然闪了一下。这是《${meta.title}》第 ${chapter.index} 章《${chapter.title}》的开端，也是麻烦真正开始的地方。

（本章为 mock 示例，剧情梗概：${chapter.summary}）`;
}

export function mockReview(chapter: ChapterPlan): ReviewResult {
  return {
    summary: `（mock）第 ${chapter.index} 章围绕「${chapter.title}」推进主线：${chapter.summary}`,
    issues: [],
    continuityOk: true,
  };
}
