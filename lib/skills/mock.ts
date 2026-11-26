import type {
  CharacterDesignFields,
  NamingBreakdown,
  NamingCandidate,
  NamingRoleInput,
  NamingStyle,
  ProseChange,
} from "./types";

const SURNAMES = [
  "沈",
  "陆",
  "顾",
  "江",
  "谢",
  "温",
  "裴",
  "秦",
  "许",
  "宋",
  "程",
  "周",
  "叶",
  "苏",
  "韩",
  "季",
  "白",
  "孟",
  "唐",
  "梁",
];

const GIVEN_NAMES = [
  "归舟",
  "知微",
  "砚",
  "青禾",
  "昭",
  "听澜",
  "行简",
  "晚照",
  "予安",
  "清让",
  "未迟",
  "明川",
  "观槿",
  "书宁",
  "若拙",
  "望舒",
  "云阶",
  "清和",
  "南枝",
  "临渊",
  "见微",
  "景行",
  "星阑",
  "怀瑾",
  "斯年",
  "照野",
];

const STYLE_LABELS: Record<NamingStyle, string> = {
  natural: "自然真实",
  literary: "文艺",
  simple: "简洁",
  distinctive: "有辨识度",
  custom: "自定义",
};

function breakdownFor(index: number): NamingBreakdown {
  return {
    background: Math.max(15, 22 - (index % 4)),
    era: Math.max(13, 18 - (index % 3)),
    distinctiveness: Math.max(12, 17 - (index % 5)),
    naturalness: Math.max(11, 13 - (index % 3)),
    uniqueness: Math.max(6, 9 - (index % 4)),
    styleFit: Math.max(6, 9 - (index % 2)),
  };
}

function scoreOf(breakdown: NamingBreakdown): number {
  return Object.values(breakdown).reduce((sum, value) => sum + value, 0);
}

function candidate(
  name: string,
  index: number,
  style: NamingStyle,
  role: NamingRoleInput,
): NamingCandidate {
  const breakdown = breakdownFor(index);
  const identity = role.identity || role.family || role.role || "人物";
  return {
    name,
    type: role.type?.trim() || "本名",
    style: STYLE_LABELS[style],
    score: scoreOf(breakdown),
    breakdown,
    scoreEvidence: `背景 ${breakdown.background}/25：与${identity}的处境相称；时代 ${breakdown.era}/20：用字符合题材语感；辨识度 ${breakdown.distinctiveness}/20：字面有记忆点；自然度 ${breakdown.naturalness}/15：读起来不拗口；区分度 ${breakdown.uniqueness}/10：与常见模板有距离；风格 ${breakdown.styleFit}/10：贴近${STYLE_LABELS[style]}。`,
    reason: `为${identity}准备的候选，兼顾身份感与可读性。`,
    risks: index % 4 === 0 ? ["姓氏在当前类型中较常见，需结合其他角色整体检查"] : [],
    similarityWarnings: [],
  };
}

export function mockNamingCandidates(
  role: NamingRoleInput,
  style: NamingStyle,
  existing: Set<string>,
  startIndex: number,
  count: number,
): NamingCandidate[] {
  const candidates: NamingCandidate[] = [];
  let cursor = 0;
  const total = SURNAMES.length * GIVEN_NAMES.length;
  while (candidates.length < count && cursor < total) {
    const absolute = startIndex + cursor;
    const surname = SURNAMES[absolute % SURNAMES.length];
    const given = GIVEN_NAMES[Math.floor(absolute / SURNAMES.length) % GIVEN_NAMES.length];
    cursor += 1;
    const name = `${surname}${given}`;
    if (existing.has(name)) continue;
    existing.add(name);
    candidates.push(candidate(name, candidates.length, style, role));
  }
  return candidates;
}

export function mockCharacterDesign(
  name: string,
  role: string,
  otherNames: string[],
): {
  design: CharacterDesignFields;
  similarities: { character: string; issue: string; suggestion: string }[];
} {
  const design: CharacterDesignFields = {
    coreDesire: `想守住${role || "自己"}最在意的人，并证明自己不是负担。`,
    fear: "再次因为判断失误失去重要的人。",
    weakness: "遇到亲近之人时容易犹豫，明知有风险也会先确认对方安全。",
    contradiction: "嘴上拒绝依赖，行动上却反复确认同伴的安危。",
    secret: "隐瞒了一次失败经历，只在被逼问时说出部分真相。",
    values: "认为承诺比性命重要，但不愿用别人的命去换自己的承诺。",
    habits: "紧张时用拇指摩挲随身物件，回答前先沉默半拍；决定后会先看出口再行动。",
    speechHabits: "句子短，少用敬语，常用反问；面对亲近的人时语速会放慢。",
    growthArc: "从独断专行、拒绝求助，经过一次失败的合作，逐步学会把后背交给同伴。",
    currentPsychology: "表面镇定，内心害怕重蹈覆辙；对善意保持警惕，但已经开始动摇。",
  };
  return {
    design,
    similarities: otherNames.slice(0, 2).map((other) => ({
      character: other,
      issue: `与「${other}」都可能用沉默掩饰恐惧，压力下的反应偏同质。`,
      suggestion: `让「${name}」在压力下用行动替代表达，让「${other}」保留语言防御，形成差异。`,
    })),
  };
}

interface Replacement {
  from: string;
  to: string;
  type: ProseChange["type"];
  reason: string;
}

const REPLACEMENTS: Replacement[] = [
  { from: "不由得", to: "", type: "cliche", reason: "删去套话，直接用动作承接情绪" },
  { from: "仿佛", to: "像是", type: "cliche", reason: "减少高频比喻词" },
  { from: "顿时", to: "随即", type: "wording", reason: "换用更具体的推进词" },
  { from: "缓缓地", to: "缓缓", type: "wording", reason: "删去冗余的“地”" },
  { from: "深深地", to: "深深", type: "wording", reason: "删去冗余的“地”" },
  { from: "心中暗道", to: "心想", type: "psychology", reason: "避免解释性心理描写" },
  { from: "非常", to: "极", type: "wording", reason: "压缩程度副词" },
  { from: "十分", to: "很", type: "wording", reason: "避免书面腔堆叠" },
];

export function mockPolish(text: string): {
  optimized: string;
  changes: ProseChange[];
} {
  let optimized = text;
  const changes: ProseChange[] = [];

  for (const item of REPLACEMENTS) {
    if (!optimized.includes(item.from)) continue;
    const excerpt = item.from;
    optimized = optimized.split(item.from).join(item.to);
    changes.push({ type: item.type, excerpt, reason: item.reason });
  }

  // 去掉相邻重复短句，这是最常见的“AI 复读”形态之一。
  const sentences = optimized.split(/(?<=[。！？!?])/u);
  const deduped: string[] = [];
  for (const sentence of sentences) {
    if (
      sentence.trim() &&
      deduped.length &&
      deduped[deduped.length - 1].trim() === sentence.trim()
    ) {
      changes.push({
        type: "repetition",
        excerpt: sentence.trim().slice(0, 80),
        reason: "相邻重复句，保留一次即可",
      });
      continue;
    }
    deduped.push(sentence);
  }
  optimized = deduped.join("");

  // 重复标点与多余空格属于安全修正，不涉及事实。
  const beforePunctuation = optimized;
  optimized = optimized.replace(/，，+/gu, "，").replace(/[ \t]{2,}/gu, " ");
  if (optimized !== beforePunctuation) {
    changes.push({
      type: "other",
      excerpt: "，，/多余空格",
      reason: "清理重复标点和多余空格",
    });
  }

  return { optimized: optimized.trim(), changes };
}
