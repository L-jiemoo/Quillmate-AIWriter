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

export type CharacterSource = "ai" | "user" | "system";

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
  // 旧版角色卡没有来源标记；重新生成架构时按“可能被用户编辑过”保守保留。
  source?: CharacterSource;
  updatedAt?: string;
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

// 章节记忆与事实台账一起抽取，但不参与台账合并；它记录的是“这一章发生了什么”，
// 供长篇写作时按相关度检索，而不是把所有正文塞回上下文。
export interface ExtractedMemory {
  events: string[];
  characters: string[];
  actions: string[];
  time: string;
  location: string;
  endingState: string;
  newSettings: string[];
  foreshadowsPlanted: string[];
  foreshadowsResolved: string[];
}

export type StorySource = "ai" | "summary" | "manual";

// 人物状态是“章节快照”，不是静态角色卡。查询某一章时取该人物最近的快照。
export interface CharacterState {
  id: string;
  name: string;
  chapter: number;
  identity: string;
  age: string;
  location: string;
  bodyState: string;
  lifeStatus: CanonCharacterStatus;
  abilities: string[];
  goals: string[];
  knowledge: string[];
  faction: string;
  experience: string;
  eventIds: string[];
  source: StorySource;
  updatedAt: string;
}

export interface CharacterRelation {
  id: string;
  from: string;
  to: string;
  type: string;
  status: string;
  chapter: number;
  eventIds: string[];
  source: StorySource;
  updatedAt: string;
}

export interface PlotEvent {
  id: string;
  name: string;
  chapter: number;
  time: string;
  location: string;
  participants: string[];
  cause: string;
  process: string;
  result: string;
  impact: string;
  relatedEventIds: string[];
  foreshadowIds: string[];
  source: StorySource;
  updatedAt: string;
}

export type ForeshadowStatus =
  | "planted"
  | "developing"
  | "pending"
  | "resolved"
  | "abandoned";

export interface ForeshadowRecord {
  id: string;
  text: string;
  plantedChapter: number;
  relatedCharacters: string[];
  expectedStartChapter: number;
  expectedEndChapter: number;
  status: ForeshadowStatus;
  eventIds: string[];
  resolution: string;
  resolvedChapter: number;
  // AI 只能在正文明确回收时给出候选，最终确认必须由作者完成。
  resolutionCandidate: string;
  source: StorySource;
  updatedAt: string;
}

export interface StoryLedger {
  version: number;
  states: CharacterState[];
  relations: CharacterRelation[];
  events: PlotEvent[];
  foreshadows: ForeshadowRecord[];
  // 作者删除的基础/自动记录 ID，防止下次 seed 时又被补回来。
  suppressedIds: string[];
  updatedAt: string;
}

export interface StoryRetrievalResult {
  chapter: number;
  text: string;
  tokenEstimate: number;
  truncated: boolean;
  chapterIndices: number[];
  sources: string[];
}

export interface StoryStatsView {
  states: number;
  relations: number;
  events: number;
  foreshadows: number;
  openForeshadows: number;
  overdueForeshadows: number;
  resolvedForeshadows: number;
  chaptersCovered: number;
  updatedAt: string;
}

export interface StoryCheckIssue {
  severity: "critical" | "warning";
  code:
    | "same-time-different-locations"
    | "dead-character-in-later-event"
    | "foreshadow-resolved-before-planted"
    | "broken-event-link"
    | "invalid-event-chapter"
    | "self-relation"
    | "revival-without-event";
  message: string;
  chapter: number;
  evidence: string;
}

export interface ExtractedCharacterState {
  name: string;
  identity: string;
  age: string;
  location: string;
  bodyState: string;
  lifeStatus: CanonCharacterStatus;
  abilities: string[];
  goals: string[];
  knowledge: string[];
  faction: string;
  experience: string;
  evidence: string;
}

export interface ExtractedRelation {
  from: string;
  to: string;
  type: string;
  status: string;
  evidence: string;
}

export interface ExtractedEvent {
  name: string;
  time: string;
  location: string;
  participants: string[];
  cause: string;
  process: string;
  result: string;
  impact: string;
  relatedEvents: string[];
  foreshadows: string[];
}

export interface ExtractedStory {
  states: ExtractedCharacterState[];
  relations: ExtractedRelation[];
  events: ExtractedEvent[];
}

export interface ExtractedFacts {
  summary: string;
  characters: FactCharacter[];
  items: FactItem[];
  timeline: FactTimeline | null;
  rules: string[];
  memory?: ExtractedMemory;
  story?: ExtractedStory;
}

export type MemorySource = "ai" | "summary" | "manual";

export interface ChapterMemory {
  index: number;
  summary: string;
  events: string[];
  characters: string[];
  actions: string[];
  time: string;
  location: string;
  endingState: string;
  newSettings: string[];
  foreshadowsPlanted: string[];
  foreshadowsResolved: string[];
  source: MemorySource;
  updatedAt: string;
}

export interface VolumeMemory {
  id: string;
  title: string;
  startChapter: number;
  endChapter: number;
  goal: string;
  events: string[];
  characterChanges: string[];
  conflicts: string[];
  foreshadows: string[];
  links: string;
  summary: string;
  source: "auto" | "manual";
  updatedAt: string;
}

export interface BookMemory {
  logline: string;
  tags: string[];
  worldview: string;
  mainline: string;
  coreCharacters: string[];
  coreRules: string[];
  finalGoal: string;
  keyConflicts: string[];
  summary: string;
  source: "auto" | "manual";
  updatedAt: string;
}

export interface ProjectMemory {
  version: number;
  book: BookMemory;
  volumes: VolumeMemory[];
  chapters: Record<string, ChapterMemory>;
  updatedAt: string;
}

export interface OpenForeshadow {
  text: string;
  plantedChapter: number;
}

export interface MemoryRetrievalResult {
  chapter: number;
  text: string;
  tokenEstimate: number;
  truncated: boolean;
  chapterIndices: number[];
  sources: string[];
  openForeshadows: OpenForeshadow[];
}

export interface MemoryStatsView {
  storedChapters: number;
  effectiveChapters: number;
  aiChapters: number;
  seedChapters: number;
  manualChapters: number;
  volumes: number;
  openForeshadows: number;
  updatedAt: string;
}

export type IssueSeverity = "critical" | "warning" | "ignore";

export interface ContinuityIssue {
  severity: IssueSeverity;
  type: string;
  evidence: string;
  detail: string;
  // 以下字段均为可选：旧项目数据只有前四个字段，读取时必须保持兼容。
  id?: string;
  sourceChapter?: number;
  sourceEvidence?: string;
  affectedCharacters?: string[];
  conflictCategory?:
    | "timeline"
    | "character-status"
    | "fact"
    | "foreshadow"
    | "causality"
    | "other";
  // 审校模型对问题性质的判断：明确矛盾 / 规则拓展 / 解释不足。
  classification?: "established-contradiction" | "rule-extension" | "clarity-gap";
  // 涉及世界观规则时，该规则的可信级别；人物自己的判断不等于客观规则。
  ruleLevel?: "hard" | "soft" | "unknown" | "character-belief";
  fingerprint?: string;
}

export interface ReviewResult {
  summary: string;
  issues: ContinuityIssue[];
  continuityOk: boolean;
  repaired?: boolean;
  repairAttempts?: number;
  // 事实抽取是否成功；旧版审校记录没有该字段，视为正常。
  extractionOk?: boolean;
  extractionError?: string;
  extractionAttempts?: number;
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

export type ChapterVersionSource =
  | "ai-write"
  | "ai-rewrite"
  | "ai-repair"
  | "user"
  | "restore"
  | "system";

// 章节正文的不可变版本记录：每次正式覆盖前先写入，保证旧稿可追溯、可恢复。
export interface ChapterVersion {
  index: number;
  version: number;
  createdAt: string;
  source: ChapterVersionSource;
  title: string;
  summary: string;
  content: string;
  previousContent: string;
  note?: string;
}

export interface ChapterVersionMeta {
  index: number;
  version: number;
  createdAt: string;
  source: ChapterVersionSource;
  title: string;
  summary: string;
  words: number;
  note?: string;
}

export interface PublishRecord {
  platform: "export" | "fanqie";
  at: string;
  chapters: number[];
  status: "success" | "failed";
  mode?: "publish" | "draft";
  message: string;
}

export type PublishLedgerStatus = "published" | "uncertain";

// 永久发布台账：只记录“确定发布成功”或“结果待人工确认”的章节，用于幂等去重。
export interface PublishLedgerEntry {
  platform: "fanqie";
  bookId: string;
  bookName: string;
  chapter: number;
  status: PublishLedgerStatus;
  at: string;
  jobId?: string;
  message?: string;
}

export interface PublishLedger {
  version: number;
  records: Record<string, PublishLedgerEntry>;
  updatedAt: string;
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
  memoryContext?: string;
  storyContext?: string;
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
  publishLedger: PublishLedger;
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

export interface JobParams {
  count?: number;
  indices?: number[];
  instruction?: string;
  useReview?: boolean;
  // 定点修复的问题来源：总体审校报告、章节审校遗留问题，或未采用草稿。
  source?: "audit" | "review" | "draft";
  // 番茄发布是有外部副作用的操作，必须由发起端显式确认。
  confirmPublish?: boolean;
  // 作者已确认的修复方向；带该 ID 重跑才允许跨章修改根因章节。
  decisionId?: string;
}

export type JobStatus =
  | "queued"
  | "running"
  | "paused"
  | "done"
  | "error"
  | "cancelled"
  | "interrupted";

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
    | "memory"
    | "audit"
    | "export"
    | "fanqie-login"
    | "fanqie-publish";
  status: JobStatus;
  params: JobParams;
  pauseRequested?: boolean;
  cancelRequested?: boolean;
  cancelReason?: "user" | "timeout";
  logs: JobLog[];
  result?: string;
  error?: string;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  updatedAt: string;
}
