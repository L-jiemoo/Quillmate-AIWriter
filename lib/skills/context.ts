import type { ChapterPlan, ProjectDetail } from "../types";
import { errorMessage } from "../utils";
import {
  defaultProjectSkillConfig,
  readProjectSkillConfig,
} from "./config";
import { loadCharacterDesigns } from "./designs";
import {
  PROSE_PACE_LABELS,
  PROSE_RATIO_LABELS,
  PROSE_SENTENCE_LABELS,
  PROSE_STYLES,
  type CharacterDesignRecord,
  type ProseStyleConfig,
  type ProjectSkillConfig,
} from "./types";

function styleLabel(style: ProseStyleConfig["style"]): string {
  return PROSE_STYLES.find((item) => item.value === style)?.label ?? style;
}

export function formatProseStyleForPrompt(prose: ProseStyleConfig): string {
  const lines = [
    `- 整体文风：${styleLabel(prose.style)}${prose.style === "custom" && prose.customStyle ? `（${prose.customStyle}）` : ""}`,
    `- 句子长短：${PROSE_SENTENCE_LABELS[prose.sentenceLength]}`,
    `- 描写密度：${PROSE_RATIO_LABELS[prose.descriptionDensity]}`,
    `- 对话比例：${PROSE_RATIO_LABELS[prose.dialogueRatio]}`,
    `- 心理描写：${PROSE_RATIO_LABELS[prose.psychologyRatio]}`,
    `- 环境描写：${PROSE_RATIO_LABELS[prose.environmentRatio]}`,
    `- 叙事节奏：${PROSE_PACE_LABELS[prose.pace]}`,
  ];
  if (prose.bannedExpressions.length) {
    lines.push(`- 禁用表达：${prose.bannedExpressions.join("、")}`);
  }
  if (prose.preferredExpressions.length) {
    lines.push(`- 偏好表达：${prose.preferredExpressions.join("、")}`);
  }
  lines.push("- 文风只影响表达方式，不得改变事实、人物关系、人物认知或剧情结果。");
  return lines.join("\n");
}

function compactDesign(design: CharacterDesignRecord): string {
  const fields = design.fields;
  const parts = [
    ["欲望", fields.coreDesire],
    ["恐惧", fields.fear],
    ["弱点", fields.weakness],
    ["习惯", fields.habits],
    ["语言", fields.speechHabits],
    ["当前心理", fields.currentPsychology],
  ]
    .filter(([, value]) => value?.trim())
    .map(([label, value]) => `${label}：${value.trim()}`);
  return parts.join("；");
}

export function formatCharacterDesignContext(input: {
  characters: ProjectDetail["characters"];
  designs: Record<string, CharacterDesignRecord>;
  chapter: ChapterPlan;
  planParticipants?: string[];
}): string {
  const haystack = [
    input.chapter.title,
    input.chapter.summary,
    ...input.chapter.keyBeats,
  ].join("\n");
  const selected = new Set<string>();
  for (const character of input.characters) {
    const name = character.name.trim();
    if (!name) continue;
    if (haystack.includes(name)) selected.add(name);
  }
  for (const name of input.planParticipants ?? []) {
    if (name.trim()) selected.add(name.trim());
  }
  if (!selected.size) {
    const protagonist = input.characters.find(
      (character) => character.role.includes("主角") && character.name.trim(),
    );
    if (protagonist) selected.add(protagonist.name.trim());
  }
  if (!selected.size) return "";

  const lines: string[] = [];
  for (const name of selected) {
    const design = input.designs[name];
    if (!design) continue;
    const compact = compactDesign(design);
    if (compact) lines.push(`- ${name}：${compact}`);
    if (lines.join("\n").length > 1600) break;
  }
  if (!lines.length) return "";
  return `\n【相关人物内在设定（仅本章涉及人物）】\n${lines.join("\n")}\n- 以上只作为人物行为约束；人物只能基于自己已经获得的信息行动，不得把他人秘密当成已知。\n`;
}

export interface WritingSkillBase {
  config: ProjectSkillConfig;
  designs: Record<string, CharacterDesignRecord>;
  warning?: string;
}

export async function loadWritingSkillBase(
  slug: string,
): Promise<WritingSkillBase> {
  try {
    const config = await readProjectSkillConfig(slug);
    const designs = config.enabled["character-design"]
      ? await loadCharacterDesigns(slug)
      : {};
    return { config, designs };
  } catch (error) {
    // 技能是增强能力，不应阻断正文生成；但必须在任务日志里说明本轮没有注入，
    // 而不是静默使用空配置。
    return {
      config: defaultProjectSkillConfig(),
      designs: {},
      warning: `技能配置读取失败，本轮未注入技能上下文：${errorMessage(error)}`,
    };
  }
}

export function buildWritingSkillContext(
  base: WritingSkillBase,
  detail: ProjectDetail,
  chapter: ChapterPlan,
  planParticipants?: string[],
): { designContext: string; proseContext: string } {
  // 读取失败时 base 里是兜底默认配置；既然 warning 已经声明“本轮未注入”，
  // 这里就不能再把默认配置渲染成上下文，否则等于用默认文风静默顶替项目配置。
  if (base.warning) return { designContext: "", proseContext: "" };
  return {
    designContext: base.config.enabled["character-design"]
      ? formatCharacterDesignContext({
          characters: detail.characters,
          designs: base.designs,
          chapter,
          planParticipants,
        })
      : "",
    proseContext: base.config.enabled["prose-style"]
      ? formatProseStyleForPrompt(base.config.prose)
      : "",
  };
}
