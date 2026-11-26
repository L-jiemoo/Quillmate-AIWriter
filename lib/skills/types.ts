export const SKILL_IDS = [
  "character-naming",
  "character-design",
  "prose-style",
] as const;

export type SkillId = (typeof SKILL_IDS)[number];

export function isSkillId(value: unknown): value is SkillId {
  return (
    typeof value === "string" &&
    (SKILL_IDS as readonly string[]).includes(value)
  );
}

export type SkillErrorCode =
  | "SKILL_NOT_FOUND"
  | "SKILL_DISABLED"
  | "SKILL_LOAD_FAILED"
  | "SKILL_INPUT_INVALID"
  | "SKILL_OUTPUT_INVALID"
  | "SKILL_LLM_FAILED";

const SKILL_ERROR_STATUS: Record<SkillErrorCode, number> = {
  SKILL_NOT_FOUND: 404,
  SKILL_DISABLED: 409,
  SKILL_LOAD_FAILED: 500,
  SKILL_INPUT_INVALID: 400,
  SKILL_OUTPUT_INVALID: 502,
  SKILL_LLM_FAILED: 502,
};

// Skill 错误必须可区分“技能不存在/被禁用”“模型请求失败”“输出不合格”，
// 这样任务日志和 API 才能给出可操作的提示，而不是一律 500。
export class SkillError extends Error {
  readonly code: SkillErrorCode;
  readonly status: number;

  constructor(code: SkillErrorCode, message: string) {
    super(message);
    this.name = "SkillError";
    this.code = code;
    this.status = SKILL_ERROR_STATUS[code];
  }
}

export interface SkillManifest {
  id: SkillId;
  name: string;
  version: string;
  description: string;
  tasks: string[];
  triggers: string[];
  inputs: string[];
  outputs: string[];
  qualityRules: string[];
  errorHandling: string[];
  // SKILL.md 正文：工作流程、输出格式和质量约束。运行时与项目上下文拼接，
  // Skill 文件本身不包含任何具体项目的人物或剧情数据。
  instructions: string;
  path: string;
}

export interface SkillCatalogItem {
  id: SkillId;
  name: string;
  version: string;
  description: string;
  tasks: string[];
  triggers: string[];
  inputs: string[];
  outputs: string[];
  qualityRules: string[];
  errorHandling: string[];
  available: boolean;
  error?: string;
}

export type SkillRunStatus = "success" | "error" | "cancelled";

export interface SkillUsageRecord {
  time: string;
  skillId: SkillId;
  skillVersion: string;
  task: string;
  status: SkillRunStatus;
  durationMs: number;
  mode: "mock" | "llm" | "local";
  provider: string;
  model: string;
  promptVersion: string;
  errorCode?: SkillErrorCode | "UNKNOWN";
  message?: string;
  chapter?: number;
  inputChars?: number;
  outputChars?: number;
}

export type NamingStyle =
  | "natural"
  | "literary"
  | "simple"
  | "distinctive"
  | "custom";

export const NAMING_STYLES: { value: NamingStyle; label: string }[] = [
  { value: "natural", label: "自然真实" },
  { value: "literary", label: "文艺" },
  { value: "simple", label: "简洁" },
  { value: "distinctive", label: "有辨识度" },
  { value: "custom", label: "自定义" },
];

export interface NamingSkillConfig {
  style: NamingStyle;
  customStyle: string;
  forbiddenNames: string[];
  forbiddenStyles: string[];
}

export type ProseStyle =
  | "natural"
  | "concise"
  | "literary"
  | "fast"
  | "suspense"
  | "humorous"
  | "custom";

export const PROSE_STYLES: { value: ProseStyle; label: string }[] = [
  { value: "natural", label: "自然写实" },
  { value: "concise", label: "简洁克制" },
  { value: "literary", label: "文学性" },
  { value: "fast", label: "快节奏网文" },
  { value: "suspense", label: "悬疑紧张" },
  { value: "humorous", label: "轻松幽默" },
  { value: "custom", label: "自定义" },
];

export type ProseRatio = "low" | "medium" | "high";
export type ProseSentenceLength = "short" | "medium" | "long" | "mixed";
export type ProsePace = "slow" | "medium" | "fast";

export const PROSE_RATIO_LABELS: Record<ProseRatio, string> = {
  low: "低",
  medium: "中",
  high: "高",
};

export const PROSE_SENTENCE_LABELS: Record<ProseSentenceLength, string> = {
  short: "偏短",
  medium: "中等",
  long: "偏长",
  mixed: "长短混合",
};

export const PROSE_PACE_LABELS: Record<ProsePace, string> = {
  slow: "舒缓",
  medium: "适中",
  fast: "紧凑",
};

export interface ProseStyleConfig {
  style: ProseStyle;
  customStyle: string;
  sentenceLength: ProseSentenceLength;
  descriptionDensity: ProseRatio;
  dialogueRatio: ProseRatio;
  psychologyRatio: ProseRatio;
  environmentRatio: ProseRatio;
  pace: ProsePace;
  bannedExpressions: string[];
  preferredExpressions: string[];
  // 章节写完后提示作者可以润色；不会自动覆盖正文。
  autoSuggestAfterWrite: boolean;
}

export interface ProjectSkillConfig {
  version: 1;
  enabled: Record<SkillId, boolean>;
  naming: NamingSkillConfig;
  prose: ProseStyleConfig;
  updatedAt: string;
}

export const CHARACTER_DESIGN_FIELDS = [
  "coreDesire",
  "fear",
  "weakness",
  "contradiction",
  "secret",
  "values",
  "habits",
  "speechHabits",
  "growthArc",
  "currentPsychology",
] as const;

export type CharacterDesignField = (typeof CHARACTER_DESIGN_FIELDS)[number];

export function isCharacterDesignField(
  value: unknown,
): value is CharacterDesignField {
  return (
    typeof value === "string" &&
    (CHARACTER_DESIGN_FIELDS as readonly string[]).includes(value)
  );
}

export type CharacterDesignFields = Record<CharacterDesignField, string>;

export interface CharacterDesignRecord {
  name: string;
  fields: CharacterDesignFields;
  // 作者手动编辑或显式锁定的字段不参与 AI 覆盖。
  lockedFields: CharacterDesignField[];
  source: "ai" | "user" | "mixed";
  skillVersion: string;
  updatedAt: string;
}

export interface CharacterDesignPatch {
  name: string;
  fields: Partial<CharacterDesignFields>;
  lockFields?: CharacterDesignField[];
  unlockFields?: CharacterDesignField[];
  source?: "ai" | "user" | "mixed";
  skillVersion?: string;
}

export interface CharacterDesignResult {
  character: string;
  design: CharacterDesignFields;
  behaviorChecks: {
    chapter: number;
    issue: string;
    evidence: string;
    suggestion: string;
  }[];
  similarities: {
    character: string;
    issue: string;
    suggestion: string;
  }[];
  warnings: string[];
  lockedFields: CharacterDesignField[];
  appliedFields: CharacterDesignField[];
  skippedFields: CharacterDesignField[];
  skillVersion: string;
}

export interface NamingBreakdown {
  background: number;
  era: number;
  distinctiveness: number;
  naturalness: number;
  uniqueness: number;
  styleFit: number;
}

export interface NamingCandidate {
  name: string;
  type: string;
  style: string;
  score: number;
  breakdown: NamingBreakdown;
  scoreEvidence: string;
  reason: string;
  risks: string[];
  similarityWarnings: string[];
}

export interface NamingResult {
  skillId: "character-naming";
  skillVersion: string;
  task: NamingTask;
  candidates: NamingCandidate[];
  recommendation: string;
  warnings: string[];
  generatedCount: number;
  existingNames: string[];
}

export type NamingTask = "generate" | "regenerate" | "batch";

export interface NamingRoleInput {
  role?: string;
  gender?: string;
  age?: string;
  identity?: string;
  family?: string;
  socialClass?: string;
  personality?: string;
  background?: string;
  style?: NamingStyle | string;
  type?: string;
}

export interface NamingSkillInput {
  task: NamingTask;
  role?: NamingRoleInput;
  roles?: NamingRoleInput[];
  style?: NamingStyle;
  customStyle?: string;
  count?: number;
  forbiddenNames?: string[];
  forbiddenStyles?: string[];
  lockedNames?: string[];
  avoidNames?: string[];
}

export interface BatchNamingItem {
  index: number;
  candidates: NamingCandidate[];
  recommendation: string;
  warnings: string[];
}

export interface BatchNamingResult {
  skillId: "character-naming";
  skillVersion: string;
  task: "batch";
  results: BatchNamingItem[];
  existingNames: string[];
}

export interface NameCheckResult {
  checked: number;
  duplicates: {
    name: string;
    sources: string[];
  }[];
  similar: {
    name: string;
    other: string;
    level: "high" | "medium";
    reason: string;
  }[];
}

export type ProseChangeType =
  | "repetition"
  | "cliche"
  | "description"
  | "psychology"
  | "dialogue"
  | "rhythm"
  | "wording"
  | "other";

export interface ProseChange {
  type: ProseChangeType;
  excerpt: string;
  reason: string;
}

export type DiffBlockType = "equal" | "added" | "removed";

export interface DiffBlock {
  type: DiffBlockType;
  text: string;
}

export interface ProseFactIssue {
  type: "missing-name" | "missing-number" | "missing-item" | "missing-term";
  term: string;
  message: string;
}

export interface ProseFactCheck {
  unchanged: boolean;
  issues: ProseFactIssue[];
}

export type ProseRecommendation = "accept" | "review" | "reject";

export interface ProsePolishResult {
  skillId: "prose-style";
  skillVersion: string;
  index: number;
  candidateId: string;
  original: string;
  optimized: string;
  diff: DiffBlock[];
  changes: ProseChange[];
  factCheck: ProseFactCheck;
  recommendation: ProseRecommendation;
  warnings: string[];
  createdAt: string;
}

export interface ProseCandidateRecord {
  version: 1;
  id: string;
  index: number;
  chapterTitle: string;
  originalHash: string;
  original: string;
  optimized: string;
  diff: DiffBlock[];
  changes: ProseChange[];
  factCheck: ProseFactCheck;
  recommendation: ProseRecommendation;
  warnings: string[];
  style: ProseStyleConfig;
  skillVersion: string;
  promptVersion: string;
  status: "pending" | "applied" | "rejected";
  createdAt: string;
  appliedAt?: string;
}
