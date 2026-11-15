import { promises as fs } from "fs";
import path from "path";
import { emptyCanon, normalizeCanon, normalizeReviewResult } from "./canon";
import { PROJECTS_DIR } from "./config";
import {
  clampInt,
  countWords,
  isSafeSlug,
  nowIso,
  slugify,
} from "./utils";
import type {
  CanonFacts,
  ChapterContent,
  ChapterPlan,
  Character,
  FanqieConfig,
  ProjectDetail,
  ProjectFile,
  ProjectMeta,
  ProjectPlan,
  ProjectState,
  ProjectSummary,
  PublishRecord,
  RejectedDraft,
  ReviewResult,
} from "./types";

export const DEFAULT_PLAN: ProjectPlan = { logline: "", tags: [], chapters: [] };

export const DEFAULT_FANQIE: FanqieConfig = {
  enabled: true,
  bookId: "",
  bookName: "",
  autoSubmit: false,
  headless: false,
  selectors: {},
};

export interface CreateProjectInput {
  title: string;
  slug?: string;
  genre?: string;
  tone?: string;
  idea?: string;
  author?: string;
  language?: string;
  targetChapters?: number;
  wordsPerChapter?: number;
}

export interface UpdateProjectPatch {
  meta?: Partial<
    Pick<
      ProjectMeta,
      "title" | "genre" | "tone" | "idea" | "author" | "language" | "targetChapters" | "wordsPerChapter"
    >
  >;
  publish?: { fanqie?: Partial<FanqieConfig> };
}

function projectDir(slug: string): string {
  return path.join(PROJECTS_DIR, slug);
}

function projectFile(slug: string, ...parts: string[]): string {
  return path.join(projectDir(slug), ...parts);
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function readText(filePath: string, fallback = ""): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return fallback;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(filePath: string, value: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, value, "utf8");
}

function defaultState(): ProjectState {
  return {
    written: [],
    summaries: {},
    reviews: {},
    rejectedDrafts: {},
    repairs: {},
    publishHistory: [],
    updatedAt: nowIso(),
  };
}

async function readCanon(slug: string): Promise<CanonFacts> {
  const raw = await readJson<unknown>(projectFile(slug, "canon.json"), null);
  return raw ? normalizeCanon(raw) : emptyCanon();
}

export async function saveCanon(slug: string, canon: CanonFacts): Promise<void> {
  await writeJson(projectFile(slug, "canon.json"), canon);
  const file = await getProjectFile(slug);
  file.meta.updatedAt = nowIso();
  await writeJson(projectFile(slug, "project.json"), file);
}

export async function getCanon(slug: string): Promise<CanonFacts> {
  await getProjectFile(slug);
  return readCanon(slug);
}

function defaultProjectFile(meta: ProjectMeta): ProjectFile {
  return {
    meta,
    publish: { fanqie: { ...DEFAULT_FANQIE, bookName: meta.title } },
  };
}

async function readState(slug: string): Promise<ProjectState> {
  const raw = await readJson<Partial<ProjectState>>(projectFile(slug, "state.json"), {});
  // state.json 可能被手工编辑或由旧版本写入；统一去重、过滤非法序号并排序，
  // 避免统计和“已写章节”判断被脏数据带偏。旧版 reviews.issues 是字符串数组，
  // 这里一并归一化为带 severity 的结构，前端才能区分严重问题和建议。
  const reviews: Record<string, ReviewResult> = {};
  for (const [key, value] of Object.entries(raw.reviews ?? {})) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 1) continue;
    reviews[String(index)] = normalizeReviewResult(value, raw.summaries?.[key] ?? "");
  }

  const rejectedDrafts: Record<string, RejectedDraft> = {};
  for (const [key, value] of Object.entries(raw.rejectedDrafts ?? {})) {
    const record = (value ?? {}) as Partial<RejectedDraft>;
    const index = Number(record.index ?? key);
    const draftPath = typeof record.path === "string" ? record.path.trim() : "";
    if (!Number.isInteger(index) || index < 1 || !draftPath) continue;
    rejectedDrafts[String(index)] = {
      index,
      at: typeof record.at === "string" ? record.at : nowIso(),
      path: draftPath,
      mode: record.mode === "rewrite" ? "rewrite" : "write",
      reason: typeof record.reason === "string" ? record.reason : "",
      review: normalizeReviewResult(record.review, raw.summaries?.[String(index)] ?? ""),
    };
  }

  const repairs: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw.repairs ?? {})) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 1) continue;
    if (typeof value === "string" && value.trim()) repairs[String(index)] = value;
  }

  return {
    written: Array.from(new Set((raw.written ?? []).map(Number)))
      .filter((value) => Number.isInteger(value) && value > 0)
      .sort((a, b) => a - b),
    summaries: raw.summaries ?? {},
    reviews,
    rejectedDrafts,
    repairs,
    publishHistory: raw.publishHistory ?? [],
    updatedAt: raw.updatedAt ?? nowIso(),
  };
}

export function normalizeCharacter(input: unknown): Character {
  // 模型可能返回 snake_case 字段、漏字段或非字符串值；
  // 统一补成固定结构，避免角色卡渲染时出现 undefined。
  const record = (input ?? {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  return {
    name: text(record.name),
    role: text(record.role),
    gender: text(record.gender),
    age: text(record.age),
    appearance: text(record.appearance),
    personality: text(record.personality),
    background: text(record.background),
    goals: text(record.goals),
    arc: text(record.arc),
    relationships: text(record.relationships),
    speechStyle: text(record.speechStyle ?? record.speech_style),
  };
}

export async function createProject(input: CreateProjectInput): Promise<ProjectDetail> {
  const title = input.title.trim();
  if (!title) throw new Error("书名不能为空");

  const slug = (input.slug?.trim() || slugify(title)).toLowerCase();
  if (!isSafeSlug(slug)) throw new Error("slug 只能包含小写字母、数字和中划线");

  let exists = true;
  try {
    await fs.access(projectDir(slug));
  } catch {
    exists = false;
  }
  if (exists) throw new Error(`项目 ${slug} 已存在`);

  const now = nowIso();
  const meta: ProjectMeta = {
    slug,
    title,
    genre: input.genre?.trim() || "玄幻",
    tone: input.tone?.trim() || "热血",
    idea: input.idea?.trim() || "",
    author: input.author?.trim() || "",
    language: input.language?.trim() || "zh-CN",
    targetChapters: clampInt(input.targetChapters, 12, 1, 200),
    wordsPerChapter: clampInt(input.wordsPerChapter, 3000, 500, 10000),
    createdAt: now,
    updatedAt: now,
  };

  await fs.mkdir(projectFile(slug, "chapters"), { recursive: true });
  await writeJson(projectFile(slug, "project.json"), defaultProjectFile(meta));
  await writeJson(projectFile(slug, "plan.json"), DEFAULT_PLAN);
  await writeJson(projectFile(slug, "characters.json"), []);
  await writeJson(projectFile(slug, "state.json"), defaultState());
  await writeJson(projectFile(slug, "canon.json"), emptyCanon());
  await writeText(
    projectFile(slug, "world.md"),
    `# ${title} · 世界观圣经\n\n> 在「总览」中点击「生成架构」后，这里会自动填充。\n\n## 核心创意\n\n${meta.idea || "（尚未填写）"}\n`,
  );
  await writeText(
    projectFile(slug, "outline.md"),
    `# ${title} · 主线大纲\n\n> 在「总览」中点击「生成架构」后，这里会自动填充。\n`,
  );

  return getProjectDetail(slug);
}

export async function deleteProject(slug: string): Promise<void> {
  if (!isSafeSlug(slug)) throw new Error("slug 不合法");
  await getProjectFile(slug);
  await fs.rm(projectDir(slug), { recursive: true, force: true });
}

export async function getProjectFile(slug: string): Promise<ProjectFile> {
  const data = await readJson<ProjectFile | null>(projectFile(slug, "project.json"), null);
  if (!data || !data.meta) throw new Error(`项目 ${slug} 不存在`);
  // 旧项目或手工编辑过的 project.json 可能缺少发布配置；
  // 读取时与默认值做深合并，保证调用方拿到的结构始终完整。
  const fallback = defaultProjectFile(data.meta);
  data.publish = data.publish ?? fallback.publish;
  data.publish.fanqie = {
    ...fallback.publish.fanqie,
    ...(data.publish.fanqie ?? {}),
    selectors: { ...(data.publish.fanqie?.selectors ?? {}) },
  };
  return data;
}

export async function listProjects(): Promise<ProjectSummary[]> {
  let entries;
  try {
    entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }

  const summaries = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry): Promise<ProjectSummary | null> => {
        // 作品库需要尽量可用：单个项目文件损坏时返回 null 并在后面过滤掉，
        // 不让一个坏目录导致整个首页 500。
        try {
          const slug = entry.name;
          const file = await getProjectFile(slug);
          const plan = await readJson<ProjectPlan>(projectFile(slug, "plan.json"), DEFAULT_PLAN);
          const state = await readState(slug);
          let words = 0;
          for (const index of state.written) {
            words += countWords(await readText(projectFile(slug, "chapters", `${index}.md`)));
          }
          return {
            slug,
            title: file.meta.title,
            genre: file.meta.genre,
            tone: file.meta.tone,
            written: state.written.length,
            planned: plan.chapters.length,
            words,
            updatedAt: file.meta.updatedAt,
          };
        } catch {
          return null;
        }
      }),
  );

  return summaries
    .filter((item): item is ProjectSummary => Boolean(item))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getProjectDetail(slug: string): Promise<ProjectDetail> {
  const file = await getProjectFile(slug);
  const plan = await readJson<ProjectPlan>(projectFile(slug, "plan.json"), DEFAULT_PLAN);
  const characters = await readJson<Character[]>(projectFile(slug, "characters.json"), []);
  const state = await readState(slug);
  const canon = await readCanon(slug);
  const bible = await readText(projectFile(slug, "world.md"));
  const outlineMd = await readText(projectFile(slug, "outline.md"));
  const writtenSet = new Set(state.written);

  // 目录以 plan.chapters 为骨架；是否已写只看 state.written，
  // 字数则实时读取正文文件，避免 state 与磁盘内容不一致时统计失真。
  const chapters: ChapterContent[] = [];
  for (const chapter of plan.chapters) {
    const content = await readText(projectFile(slug, "chapters", `${chapter.index}.md`));
    chapters.push({
      index: chapter.index,
      title: chapter.title,
      content,
      words: countWords(content),
      written: writtenSet.has(chapter.index),
    });
  }

  return {
    meta: file.meta,
    plan,
    bible,
    outlineMd,
    characters,
    state,
    chapters,
    canon,
    publish: file.publish,
    pendingChapters: chapters.filter((chapter) => !chapter.written).length,
  };
}

export async function savePlan(
  slug: string,
  plan: ProjectPlan,
  bible: string,
  outlineMd: string,
): Promise<void> {
  const file = await getProjectFile(slug);
  await writeJson(projectFile(slug, "plan.json"), plan);
  await writeText(projectFile(slug, "world.md"), bible.endsWith("\n") ? bible : `${bible}\n`);
  await writeText(projectFile(slug, "outline.md"), outlineMd.endsWith("\n") ? outlineMd : `${outlineMd}\n`);
  file.meta.updatedAt = nowIso();
  await writeJson(projectFile(slug, "project.json"), file);
}

export async function appendChapters(
  slug: string,
  chapters: ChapterPlan[],
): Promise<ProjectPlan> {
  const file = await getProjectFile(slug);
  const plan = await readJson<ProjectPlan>(projectFile(slug, "plan.json"), DEFAULT_PLAN);
  // 以章节序号去重，防止模型重复返回已有章节；合并后重新排序，
  // 让目录始终按章节号递增，而不是按模型输出顺序排列。
  const existing = new Set(plan.chapters.map((chapter) => chapter.index));
  const additions = chapters.filter((chapter) => !existing.has(chapter.index));

  plan.chapters = [...plan.chapters, ...additions].sort((a, b) => a.index - b.index);
  await writeJson(projectFile(slug, "plan.json"), plan);

  file.meta.targetChapters = plan.chapters.length;
  file.meta.updatedAt = nowIso();
  await writeJson(projectFile(slug, "project.json"), file);

  return plan;
}

export async function appendOutlineSection(
  slug: string,
  chapters: ChapterPlan[],
): Promise<void> {
  if (!chapters.length) return;

  const sorted = [...chapters].sort((a, b) => a.index - b.index);
  const start = sorted[0].index;
  const end = sorted[sorted.length - 1].index;
  const lines = ["", "---", "", `## 补充章节（第 ${start}–${end} 章）`, ""];
  for (const chapter of sorted) {
    lines.push(`### 第 ${chapter.index} 章 · ${chapter.title}`, "", chapter.summary, "");
    if (chapter.keyBeats.length) {
      lines.push(...chapter.keyBeats.map((beat) => `- ${beat}`), "");
    }
  }

  // 主线的补充区段只追加到原文件末尾，不改写已有内容，
  // 这样用户在 outline.md 里的手工修订不会被补充大纲覆盖。
  const outlinePath = projectFile(slug, "outline.md");
  const current = (await readText(outlinePath)).trimEnd();
  await writeText(outlinePath, `${current}${current ? "\n" : ""}${lines.join("\n")}`);

  const file = await getProjectFile(slug);
  file.meta.updatedAt = nowIso();
  await writeJson(projectFile(slug, "project.json"), file);
}

export async function saveCharacters(slug: string, characters: Character[]): Promise<void> {
  const file = await getProjectFile(slug);
  await writeJson(projectFile(slug, "characters.json"), characters);
  file.meta.updatedAt = nowIso();
  await writeJson(projectFile(slug, "project.json"), file);
}

export async function updateProject(slug: string, patch: UpdateProjectPatch): Promise<ProjectMeta> {
  const file = await getProjectFile(slug);

  if (patch.meta) {
    const meta = patch.meta;
    if (typeof meta.title === "string" && meta.title.trim()) file.meta.title = meta.title.trim();
    if (typeof meta.genre === "string" && meta.genre.trim()) file.meta.genre = meta.genre.trim();
    if (typeof meta.tone === "string" && meta.tone.trim()) file.meta.tone = meta.tone.trim();
    if (typeof meta.idea === "string") file.meta.idea = meta.idea;
    if (typeof meta.author === "string") file.meta.author = meta.author;
    if (typeof meta.language === "string" && meta.language.trim()) file.meta.language = meta.language.trim();
    if (meta.targetChapters !== undefined) {
      file.meta.targetChapters = clampInt(meta.targetChapters, file.meta.targetChapters, 1, 200);
    }
    if (meta.wordsPerChapter !== undefined) {
      file.meta.wordsPerChapter = clampInt(meta.wordsPerChapter, file.meta.wordsPerChapter, 500, 10000);
    }
  }

  if (patch.publish?.fanqie) {
    file.publish.fanqie = {
      ...file.publish.fanqie,
      ...patch.publish.fanqie,
      selectors: {
        ...file.publish.fanqie.selectors,
        ...(patch.publish.fanqie.selectors ?? {}),
      },
    };
  }

  file.meta.updatedAt = nowIso();
  await writeJson(projectFile(slug, "project.json"), file);
  return file.meta;
}

export async function writeChapterFile(slug: string, index: number, content: string): Promise<void> {
  await writeText(
    projectFile(slug, "chapters", `${index}.md`),
    content.endsWith("\n") ? content : `${content}\n`,
  );
}

// 未通过连续性检查的稿子只进 drafts/，不覆盖 chapters/ 里的正式正文。
export async function saveRejectedDraft(
  slug: string,
  input: {
    index: number;
    content: string;
    mode: "write" | "rewrite";
    reason: string;
    review: ReviewResult;
  },
): Promise<RejectedDraft> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = projectFile(slug, "drafts", `${input.index}-${stamp}.md`);
  await writeText(
    target,
    input.content.endsWith("\n") ? input.content : `${input.content}\n`,
  );
  const record: RejectedDraft = {
    index: input.index,
    at: nowIso(),
    path: path.relative(process.cwd(), target).split(path.sep).join("/"),
    mode: input.mode,
    reason: input.reason,
    review: input.review,
  };
  const state = await readState(slug);
  state.rejectedDrafts = { ...state.rejectedDrafts, [String(input.index)]: record };
  state.updatedAt = nowIso();
  await writeJson(projectFile(slug, "state.json"), state);
  return record;
}

// 定点修复直接改写正文，动手前先把原稿留一份，方便人工回退。
export async function saveRepairBackup(
  slug: string,
  index: number,
  content: string,
): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = projectFile(slug, "drafts", `${index}-before-repair-${stamp}.md`);
  await writeText(
    target,
    content.endsWith("\n") ? content : `${content}\n`,
  );
  return path.relative(process.cwd(), target).split(path.sep).join("/");
}

export async function markChapterRepaired(slug: string, index: number): Promise<void> {
  const state = await readState(slug);
  state.repairs[String(index)] = nowIso();
  state.updatedAt = nowIso();
  await writeJson(projectFile(slug, "state.json"), state);
}

export async function markChapterWritten(
  slug: string,
  index: number,
  summary: string,
  review: ReviewResult,
): Promise<void> {
  const state = await readState(slug);
  if (!state.written.includes(index)) {
    state.written = [...state.written, index].sort((a, b) => a - b);
  }
  state.summaries[String(index)] = summary;
  state.reviews[String(index)] = review;
  delete state.rejectedDrafts[String(index)];
  state.updatedAt = nowIso();
  await writeJson(projectFile(slug, "state.json"), state);

  const file = await getProjectFile(slug);
  file.meta.updatedAt = nowIso();
  await writeJson(projectFile(slug, "project.json"), file);
}

export async function updateChapterSummary(
  slug: string,
  index: number,
  summary: string,
): Promise<void> {
  const state = await readState(slug);
  const trimmed = summary.trim();
  if (!trimmed) return;
  state.summaries[String(index)] = trimmed;
  const review = state.reviews[String(index)];
  if (review) review.summary = trimmed;
  state.updatedAt = nowIso();
  await writeJson(projectFile(slug, "state.json"), state);
}

export async function saveChapter(
  slug: string,
  index: number,
  content: string,
  title?: string,
): Promise<ChapterContent> {
  if (!Number.isInteger(index) || index < 1) throw new Error("章节序号不合法");

  const plan = await readJson<ProjectPlan>(projectFile(slug, "plan.json"), DEFAULT_PLAN);
  const chapter = plan.chapters.find((item) => item.index === index);
  if (!chapter) throw new Error(`第 ${index} 章不在当前大纲中`);

  // 标题属于 plan.json，正文属于 chapters/*.md；保存时两边都要落盘，
  // 再同步 state 和项目更新时间，首页统计才不会落后于编辑器。
  if (title && title.trim()) {
    chapter.title = title.trim();
    await writeJson(projectFile(slug, "plan.json"), plan);
  }
  await writeChapterFile(slug, index, content);

  const state = await readState(slug);
  if (content.trim() && !state.written.includes(index)) {
    state.written = [...state.written, index].sort((a, b) => a - b);
  }
  if (content.trim()) delete state.rejectedDrafts[String(index)];
  state.summaries[String(index)] = state.summaries[String(index)] ?? chapter.summary;
  state.updatedAt = nowIso();
  await writeJson(projectFile(slug, "state.json"), state);

  const file = await getProjectFile(slug);
  file.meta.updatedAt = nowIso();
  await writeJson(projectFile(slug, "project.json"), file);

  return {
    index,
    title: chapter.title,
    content,
    words: countWords(content),
    written: true,
  };
}

export async function buildBookText(slug: string): Promise<{
  text: string;
  title: string;
  chapters: number;
  words: number;
}> {
  const detail = await getProjectDetail(slug);
  const written = detail.chapters.filter((chapter) => chapter.written && chapter.content.trim());

  const header = [
    `# ${detail.meta.title}`,
    detail.meta.author ? `作者：${detail.meta.author}` : "",
    detail.plan.logline ? `> ${detail.plan.logline}` : "",
    detail.plan.tags.length ? `标签：${detail.plan.tags.join(" / ")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const body = written
    .map(
      (chapter) =>
        `\n\n---\n\n## 第 ${chapter.index} 章 ${chapter.title}\n\n${chapter.content.trim()}`,
    )
    .join("");

  const text = `${header}${body}\n`;
  return {
    text,
    title: detail.meta.title,
    chapters: written.length,
    words: countWords(text),
  };
}

export async function exportBookFile(slug: string): Promise<{
  relativePath: string;
  chapters: number;
  words: number;
}> {
  const book = await buildBookText(slug);
  const target = projectFile(slug, "exports", "全书.md");
  await writeText(target, book.text);
  return {
    relativePath: path.relative(process.cwd(), target).split(path.sep).join("/"),
    chapters: book.chapters,
    words: book.words,
  };
}

export async function writeAuditReport(slug: string, content: string): Promise<string> {
  await getProjectFile(slug);
  const target = projectFile(slug, "audit.md");
  await writeText(target, content.endsWith("\n") ? content : `${content}\n`);
  return path.relative(process.cwd(), target).split(path.sep).join("/");
}

export interface AuditReport {
  content: string;
  updatedAt: string | null;
}

export async function getAuditReport(slug: string): Promise<AuditReport> {
  await getProjectFile(slug);
  const target = projectFile(slug, "audit.md");
  try {
    const [content, stat] = await Promise.all([
      fs.readFile(target, "utf8"),
      fs.stat(target),
    ]);
    return { content, updatedAt: stat.mtime.toISOString() };
  } catch {
    return { content: "", updatedAt: null };
  }
}

export async function getWrittenChapters(
  slug: string,
): Promise<{ index: number; title: string; content: string }[]> {
  const detail = await getProjectDetail(slug);
  return detail.chapters
    .filter((chapter) => chapter.written && chapter.content.trim())
    .map((chapter) => ({ index: chapter.index, title: chapter.title, content: chapter.content }));
}

export async function appendPublishRecord(slug: string, record: PublishRecord): Promise<void> {
  const state = await readState(slug);
  // 发布历史只保留最近 100 条，避免长期连载后 state.json 无限膨胀。
  // 注意：超过上限后最早的成功记录也会被裁掉，对应章节将重新被视为待发布。
  state.publishHistory = [...state.publishHistory, record].slice(-100);
  state.updatedAt = nowIso();
  await writeJson(projectFile(slug, "state.json"), state);
}

export async function clearPublishHistory(slug: string): Promise<void> {
  const state = await readState(slug);
  // 发布记录同时承担去重作用：清空后所有已写章节都会重新被视为待发布。
  state.publishHistory = [];
  state.updatedAt = nowIso();
  await writeJson(projectFile(slug, "state.json"), state);
}
