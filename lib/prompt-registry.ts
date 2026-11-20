export type PromptAgent =
  | "architect"
  | "extend-plan"
  | "title-repair"
  | "character-designer"
  | "writer"
  | "fact-extractor"
  | "auditor"
  | "repair-editor";

export interface PromptCatalogEntry {
  label: string;
  version: string;
  description: string;
}

// 提示词内容一旦修改，同步提升对应版本号；使用记录会带上这里的版本，便于回溯。
export const PROMPT_CATALOG: Record<PromptAgent, PromptCatalogEntry> = {
  architect: {
    label: "架构师",
    version: "2026.11.20-p9",
    description: "生成世界观、主线大纲、章节细纲和结构化计划台账。",
  },
  "extend-plan": {
    label: "大纲续排",
    version: "2026.11.20-p9",
    description: "在既有大纲后续排新章节，并同步登记计划台账。",
  },
  "title-repair": {
    label: "章节改名",
    version: "2026.11.18-p7",
    description: "为重复章节标题重新起名。",
  },
  "character-designer": {
    label: "角色设计",
    version: "2026.11.18-p7",
    description: "生成核心人物卡。",
  },
  writer: {
    label: "写作",
    version: "2026.11.20-p9",
    description: "续写或重写章节正文，并区分计划、事实与实际剧情。",
  },
  "fact-extractor": {
    label: "事实抽取",
    version: "2026.11.18-p7",
    description: "从正文抽取事实台账、长期记忆和剧情台账。",
  },
  auditor: {
    label: "连续性与质量审校",
    version: "2026.11.19-p8",
    description: "检查人物、时间线、规则、因果、伏笔和章节重复。",
  },
  "repair-editor": {
    label: "定点修复",
    version: "2026.11.19-p8",
    description: "只修改与审校问题直接相关的正文段落。",
  },
};

export const PROMPT_AGENTS = Object.keys(PROMPT_CATALOG) as PromptAgent[];

export function isPromptAgent(value: unknown): value is PromptAgent {
  return typeof value === "string" && value in PROMPT_CATALOG;
}

export function promptBaseVersion(agent: PromptAgent): string {
  return PROMPT_CATALOG[agent].version;
}
