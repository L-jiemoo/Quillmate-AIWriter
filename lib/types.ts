export interface ProjectMeta {
  slug: string;
  title: string;
  genre: string;
  tone: string;
  idea: string;
  author: string;
  language: string;
  targetChapters: number;
  wordsPerChapter: number;
  createdAt: string;
  updatedAt: string;
}

export interface ChapterPlan {
  index: number;
  title: string;
  summary: string;
  keyBeats: string[];
}

export interface ProjectPlan {
  logline: string;
  tags: string[];
  chapters: ChapterPlan[];
}

export interface Character {
  name: string;
  role: string;
  gender: string;
  age: string;
  appearance: string;
  personality: string;
  background: string;
  goals: string;
  arc: string;
  relationships: string;
  speechStyle: string;
}

export type CanonCharacterStatus = "alive" | "dead" | "unknown";

// 事实台账：只记录“正文里已经发生”的硬事实，供后续章节强制参考。
// chapter 是最近一次确认/更新的章节，statusChapter 是当前生死状态确立的章节。
export interface CanonCharacter {
  name: string;
  aliases: string[];
  status: CanonCharacterStatus;
  location: string;
  note: string;
  statusChapter: number;
  chapter: number;
}

export interface CanonItem {
  name: string;
  aliases: string[];
  holder: string;
  state: string;
  note: string;
  chapter: number;
}

export interface CanonDeadline {
  name: string;
  due: string;
  note: string;
  chapter: number;
}

export interface CanonTimeline {
  currentDay: string;
  deadlines: CanonDeadline[];
}

export interface CanonFacts {
  characters: CanonCharacter[];
  items: CanonItem[];
  timeline: CanonTimeline;
  rules: string[];
  lastChapter: number;
  updatedAt: string;
}

// 事实抽取 Agent 的原始输出：允许附带 evidence，但不直接落盘。
export interface FactCharacter {
  name: string;
  aliases: string[];
  status: CanonCharacterStatus;
  location: string;
  note: string;
  evidence: string;
}

export interface FactItem {
  name: string;
  aliases: string[];
  holder: string;
  state: string;
  note: string;
  evidence: string;
}

export interface FactDeadline {
  name: string;
  due: string;
  note: string;
}

export interface FactTimeline {
  currentDay: string;
  deadlines: FactDeadline[];
}

export interface ExtractedFacts {
  summary: string;
  characters: FactCharacter[];
  items: FactItem[];
  timeline: FactTimeline | null;
  rules: string[];
}

export type IssueSeverity = "critical" | "warning" | "ignore";

export interface ContinuityIssue {
  severity: IssueSeverity;
  type: string;
  evidence: string;
  detail: string;
}

export interface ReviewResult {
  summary: string;
  issues: ContinuityIssue[];
  continuityOk: boolean;
  repaired?: boolean;
  repairAttempts?: number;
}

// 总体审校的结构化结果：按章节保存，供连续性页按“章节审校”的样式展示。
export interface AuditChapterResult {
  index: number;
  title: string;
  issues: ContinuityIssue[];
}

export interface AuditResult {
  chapters: AuditChapterResult[];
  critical: number;
  warnings: number;
  ignored: number;
}

// 未通过连续性检查的稿子不会写进 chapters/，单独存到 drafts/ 供人工查看。
export interface RejectedDraft {
  index: number;
  at: string;
  path: string;
  mode: "write" | "rewrite";
  reason: string;
  review: ReviewResult;
}

export interface PublishRecord {
  platform: "export" | "fanqie";
  at: string;
  chapters: number[];
  status: "success" | "failed";
  mode?: "publish" | "draft";
  message: string;
}

export interface ProjectState {
  written: number[];
  summaries: Record<string, string>;
  reviews: Record<string, ReviewResult>;
  rejectedDrafts: Record<string, RejectedDraft>;
  // 总体审校之后做过定点修复的章节，用于提示报告快照已过期。
  repairs: Record<string, string>;
  publishHistory: PublishRecord[];
  updatedAt: string;
}

export interface FanqieSelectors {
  bookEntry: string[];
  createChapter: string[];
  titleInput: string[];
  contentEditor: string[];
  saveButton: string[];
  publishButton: string[];
  confirmButton: string[];
}

export interface FanqieConfig {
  enabled: boolean;
  bookId: string;
  bookName: string;
  autoSubmit: boolean;
  headless: boolean;
  selectors: Partial<FanqieSelectors>;
}

export interface ProjectPublish {
  fanqie: FanqieConfig;
}

export interface ProjectFile {
  meta: ProjectMeta;
  publish: ProjectPublish;
}

export interface ChapterContent {
  index: number;
  title: string;
  content: string;
  words: number;
  written: boolean;
}

export interface ChapterWriteOptions {
  mode?: "write" | "rewrite";
  rewriteInstruction?: string;
  reviewFeedback?: string;
  nextOpening?: string;
  canon?: CanonFacts;
}

export interface ProjectDetail {
  meta: ProjectMeta;
  plan: ProjectPlan;
  bible: string;
  outlineMd: string;
  characters: Character[];
  state: ProjectState;
  chapters: ChapterContent[];
  canon: CanonFacts;
  publish: ProjectPublish;
  pendingChapters: number;
}

export interface ProjectSummary {
  slug: string;
  title: string;
  genre: string;
  tone: string;
  written: number;
  planned: number;
  words: number;
  updatedAt: string;
}

export interface JobLog {
  time: string;
  message: string;
}

export type StartJobFn = (
  type: Job["type"],
  payload?: Record<string, unknown>,
) => Promise<void>;

export interface Job {
  id: string;
  slug: string;
  type:
    | "plan"
    | "extend"
    | "write"
    | "rewrite"
    | "repair"
    | "recanon"
    | "audit"
    | "export"
    | "fanqie-login"
    | "fanqie-publish";
  status: "queued" | "running" | "paused" | "done" | "error";
  pauseRequested?: boolean;
  logs: JobLog[];
  result?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}
