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

export interface ReviewResult {
  summary: string;
  issues: string[];
  continuityOk: boolean;
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

export interface ProjectDetail {
  meta: ProjectMeta;
  plan: ProjectPlan;
  bible: string;
  outlineMd: string;
  characters: Character[];
  state: ProjectState;
  chapters: ChapterContent[];
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
  type: "plan" | "extend" | "write" | "export" | "fanqie-login" | "fanqie-publish";
  status: "queued" | "running" | "done" | "error";
  logs: JobLog[];
  result?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}
