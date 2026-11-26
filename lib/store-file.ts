import { randomUUID } from "node:crypto";
import { promises as fs } from "fs";
import path from "path";
import {
  buildInitialCanon,
  emptyCanon,
  isCanonEmpty,
  normalizeCanon,
  normalizeReviewResult,
} from "./canon";
import { PROJECTS_DIR } from "./config";
import { emptyMemory, normalizeMemory } from "./memory";
import {
  assertValidPlanLedger,
  derivePlanLedger,
  emptyPlanLedger,
  mergePlanLedgers,
  normalizePlanLedger,
  planEntriesForChapters,
} from "./plan-ledger";
import { emptyStory, normalizeStory } from "./story";
import {
  appendChapterOutline,
  checkPlanOutlineConsistency,
  ensurePlanOutlineSync,
  missingOutlineChapters,
} from "./plan-consistency";
import { assertValidChapterPlans } from "./plan-validation";
import {
  applyPublishStates,
  derivePublishLedger,
  normalizePublishLedger,
  upsertPublishEntry,
} from "./publish-ledger";
import {
  backupFile,
  readJsonOptional,
  readJsonStrict,
  readTextOptional,
  readTextStrict,
  StorageError,
  writeFileAtomic,
  writeJsonSafe,
  writeTextSafe,
  type BackupOptions,
} from "./storage";
import { assertDeletableChapter, buildChapterDeletion } from "./chapter-deletion";
import { removeRepairDecisionsForChapter } from "./repair-decision";
import {
  assertSafeSlug,
  clampInt,
  countWords,
  errorMessage,
  isSafeSlug,
  nowIso,
  slugify,
} from "./utils";
import type {
  CanonFact,
  CanonFacts,
  ChapterContent,
  ChapterPlan,
  ChapterVersion,
  ChapterVersionMeta,
  ChapterVersionSource,
  Character,
  CharacterSource,
  FanqieConfig,
  ProjectDetail,
  ProjectFile,
  ProjectMemory,
  PlanLedger,
  ProjectMeta,
  ProjectPlan,
  ProjectState,
  ProjectSummary,
  PlanItem,
  PublishLedger,
  PublishLedgerStatus,
  PublishRecord,
  RejectedDraft,
  ReviewResult,
  StoryLedger,
} from "./types";

export const DEFAULT_PLAN: ProjectPlan = { logline: "", tags: [], chapters: [] };

export const DEFAULT_FANQIE: FanqieConfig = {
  enabled: true,
  bookId: "",
  bookName: "",
  autoSubmit: false,
  aiAssisted: true,
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

export function projectDir(slug: string): string {
  assertSafeSlug(slug);
  return path.join(PROJECTS_DIR, slug);
}

export function projectFile(slug: string, ...parts: string[]): string {
  return path.join(projectDir(slug), ...parts);
}

export function memoryFile(slug: string): string {
  return projectFile(slug, "memory.json");
}

export function storyFile(slug: string): string {
  return projectFile(slug, "story.json");
}

export function planLedgerFile(slug: string): string {
  return projectFile(slug, "plan-ledger.json");
}

const BACKUP_KEEP = 20;

export function projectBackup(slug: string, relativePath: string): BackupOptions {
  return {
    dir: projectFile(slug, "backups"),
    name: relativePath,
    keep: BACKUP_KEEP,
  };
}

// 缺失的文件可以按调用方约定使用默认值；损坏或 IO 错误必须向上抛出，
// 绝不能把空数据当成真实内容继续写回磁盘。
async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  return readJsonOptional(filePath, fallback);
}

export async function readText(filePath: string, fallback = ""): Promise<string> {
  return readTextOptional(filePath, fallback);
}

async function writeJson(
  filePath: string,
  value: unknown,
  backup?: BackupOptions,
): Promise<void> {
  await writeJsonSafe(filePath, value, backup ? { backup } : {});
}

export async function writeText(
  filePath: string,
  value: string,
  backup?: BackupOptions,
): Promise<void> {
  await writeTextSafe(filePath, value, backup ? { backup } : {});
}

export function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function textWithNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

export interface PendingWrite {
  filePath: string;
  content: string;
  backupName: string;
}

// 文件系统没有跨文件事务，这里用“先快照、再逐个原子写、失败按快照回滚”
// 把大纲、世界观、人物和元数据尽量作为一个整体提交。
export async function commitProjectWrites(
  slug: string,
  writes: PendingWrite[],
): Promise<void> {
  const snapshots: (string | null)[] = [];
  for (const write of writes) {
    try {
      snapshots.push(await fs.readFile(write.filePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") snapshots.push(null);
      else throw error;
    }
  }

  const completed: number[] = [];
  try {
    for (let i = 0; i < writes.length; i += 1) {
      const write = writes[i];
      await writeTextSafe(write.filePath, write.content, {
        backup: projectBackup(slug, write.backupName),
      });
      completed.push(i);
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const index of [...completed].reverse()) {
      const write = writes[index];
      try {
        if (snapshots[index] === null) {
          await fs.rm(write.filePath, { force: true });
        } else {
          await writeFileAtomic(write.filePath, snapshots[index] as string);
        }
      } catch (rollbackError) {
        rollbackErrors.push(`${write.backupName}：${errorMessage(rollbackError)}`);
      }
    }
    if (rollbackErrors.length) {
      throw new Error(
        `多文件提交失败，且回滚不完整（${rollbackErrors.join("；")}）。原始错误：${errorMessage(error)}`,
      );
    }
    throw error;
  }
}

export function defaultState(): ProjectState {
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
  // canon.json 缺失视为旧项目（空台账）；损坏则直接抛错，避免空台账覆盖真实事实。
  const raw = await readJsonOptional<unknown>(projectFile(slug, "canon.json"), null);
  return raw ? normalizeCanon(raw) : emptyCanon();
}

export async function saveCanon(slug: string, canon: CanonFacts): Promise<void> {
  // 先确认项目文件可读，再写台账，避免台账已落盘但项目元数据损坏的半提交状态。
  const file = await getProjectFile(slug);
  await writeJson(
    projectFile(slug, "canon.json"),
    canon,
    projectBackup(slug, "canon.json"),
  );
  file.meta.updatedAt = nowIso();
  await writeJson(
    projectFile(slug, "project.json"),
    file,
    projectBackup(slug, "project.json"),
  );
}

export async function getCanon(slug: string): Promise<CanonFacts> {
  await getProjectFile(slug);
  return readCanon(slug);
}

// 记忆是派生数据，但用户可能手工修正；缺失视为空记忆，损坏仍要显式报错。
export async function getMemory(slug: string): Promise<ProjectMemory> {
  const file = await getProjectFile(slug);
  const raw = await readJsonOptional<unknown>(memoryFile(slug), null);
  if (raw === null) return emptyMemory(file.meta.updatedAt);
  return normalizeMemory(raw);
}

export async function saveMemory(slug: string, memory: ProjectMemory): Promise<void> {
  await getProjectFile(slug);
  const normalized = normalizeMemory(memory);
  await writeJson(
    memoryFile(slug),
    normalized,
    projectBackup(slug, "memory.json"),
  );
}

export async function getStory(slug: string): Promise<StoryLedger> {
  const file = await getProjectFile(slug);
  const raw = await readJsonOptional<unknown>(storyFile(slug), null);
  if (raw === null) return emptyStory(file.meta.updatedAt);
  return normalizeStory(raw);
}

export async function saveStory(slug: string, story: StoryLedger): Promise<void> {
  await getProjectFile(slug);
  await writeJson(
    storyFile(slug),
    normalizeStory(story),
    projectBackup(slug, "story.json"),
  );
}

// 计划台账缺失时按大纲派生 planned 记录，兼容没有该文件的旧项目。
// 派生结果只在本次读取中存在，普通读取不写盘。
export async function getPlanLedger(slug: string): Promise<PlanLedger> {
  const file = await getProjectFile(slug);
  const raw = await readJsonOptional<unknown>(planLedgerFile(slug), null);
  if (raw !== null) return normalizePlanLedger(raw, file.meta.updatedAt);
  const plan = await readJson<ProjectPlan>(projectFile(slug, "plan.json"), DEFAULT_PLAN);
  const outline = await readText(projectFile(slug, "outline.md"));
  return derivePlanLedger(plan, outline, file.meta.updatedAt);
}

export async function savePlanLedger(slug: string, ledger: PlanLedger): Promise<void> {
  await getProjectFile(slug);
  const normalized = normalizePlanLedger(ledger);
  await writeJson(
    planLedgerFile(slug),
    normalized,
    projectBackup(slug, "plan-ledger.json"),
  );
}

// 台账重建成功后的统一提交：先写摘要，最后写 canon.json。
// 摘要写入失败时旧台账仍是完整的；不能反过来先写台账，否则摘要失败会留下半提交状态。
export async function commitCanonRebuild(
  slug: string,
  canon: CanonFacts,
  summaries: Record<string, string>,
): Promise<void> {
  await getProjectFile(slug);
  const entries = Object.entries(summaries).filter(([, summary]) => summary.trim());
  if (entries.length) {
    const state = await readState(slug);
    for (const [key, summary] of entries) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 1) continue;
      state.summaries[key] = summary;
      const review = state.reviews[key];
      if (review) review.summary = summary;
    }
    state.updatedAt = nowIso();
    await writeJson(
      projectFile(slug, "state.json"),
      state,
      projectBackup(slug, "state.json"),
    );
  }
  await saveCanon(slug, canon);
}

export function defaultProjectFile(meta: ProjectMeta): ProjectFile {
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
  const character: Character = {
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
  if (
    record.source === "ai" ||
    record.source === "user" ||
    record.source === "system"
  ) {
    character.source = record.source;
  }
  if (typeof record.updatedAt === "string" && record.updatedAt) {
    character.updatedAt = record.updatedAt;
  }
  return character;
}

export function characterFingerprint(character: Character): string {
  return JSON.stringify([
    character.name.trim(),
    character.role,
    character.gender,
    character.age,
    character.appearance,
    character.personality,
    character.background,
    character.goals,
    character.arc,
    character.relationships,
    character.speechStyle,
  ]);
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
  await writeJson(memoryFile(slug), emptyMemory(now));
  await writeJson(storyFile(slug), emptyStory(now));
  await writeJson(planLedgerFile(slug), emptyPlanLedger(now));
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
  let data: ProjectFile;
  try {
    data = await readJsonStrict<ProjectFile>(projectFile(slug, "project.json"));
  } catch (error) {
    if (error instanceof StorageError && error.code === "not_found") {
      throw new StorageError(
        "not_found",
        projectFile(slug, "project.json"),
        `项目 ${slug} 不存在`,
        error,
      );
    }
    throw error;
  }
  if (!data || typeof data !== "object" || !data.meta) {
    throw new StorageError(
      "corrupted",
      projectFile(slug, "project.json"),
      `项目 ${slug} 的 project.json 结构不完整`,
    );
  }
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
        } catch (error) {
          // 单个项目损坏不应拖垮首页，但要在服务端日志里留下明确线索。
          console.warn(`[projects] 跳过无法读取的项目 ${entry.name}：${errorMessage(error)}`);
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
  // plan.json 是项目目录骨架：缺失或损坏都不能用空大纲代替，否则会误导后续写入。
  const plan = await readJsonStrict<ProjectPlan>(projectFile(slug, "plan.json"));
  const characters = await readJson<Character[]>(projectFile(slug, "characters.json"), []);
  const state = await readState(slug);
  const canon = await readCanon(slug);
  // 只读派生旧项目的台账，不在普通读请求里写文件；正式迁移发生在发布任务开始时。
  const publishLedger = await loadPublishLedger(slug, false);
  const bible = await readText(projectFile(slug, "world.md"));
  const outlineMd = await readText(projectFile(slug, "outline.md"));
  const rawPlanLedger = await readJsonOptional<unknown>(planLedgerFile(slug), null);
  const planLedger = rawPlanLedger
    ? normalizePlanLedger(rawPlanLedger, file.meta.updatedAt)
    : derivePlanLedger(plan, outlineMd, file.meta.updatedAt);
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
    planLedger,
    publish: file.publish,
    publishLedger,
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
  assertValidChapterPlans(plan.chapters, {
    targetChapters: file.meta.targetChapters,
    requireContiguous: true,
    allowEmpty: true,
  });
  const sortedPlan: ProjectPlan = {
    ...plan,
    chapters: [...plan.chapters].sort((a, b) => a.index - b.index),
  };
  const syncedOutline = ensurePlanOutlineSync(outlineMd, sortedPlan.chapters);
  const nextFile: ProjectFile = {
    ...file,
    meta: { ...file.meta, updatedAt: nowIso() },
  };

  await commitProjectWrites(slug, [
    {
      filePath: projectFile(slug, "plan.json"),
      content: jsonText(sortedPlan),
      backupName: "plan.json",
    },
    {
      filePath: projectFile(slug, "world.md"),
      content: textWithNewline(bible),
      backupName: "world.md",
    },
    {
      filePath: projectFile(slug, "outline.md"),
      content: textWithNewline(syncedOutline),
      backupName: "outline.md",
    },
    {
      filePath: projectFile(slug, "project.json"),
      content: jsonText(nextFile),
      backupName: "project.json",
    },
  ]);
}

export async function appendChapters(
  slug: string,
  chapters: ChapterPlan[],
  planLedger?: PlanLedger,
): Promise<ProjectPlan> {
  const file = await getProjectFile(slug);
  // 必须读到真实大纲再合并；损坏时直接抛错，避免用“仅新增章节”覆盖原有目录。
  const plan = await readJsonStrict<ProjectPlan>(projectFile(slug, "plan.json"));
  if (!chapters.length) return plan;

  const maxExisting = plan.chapters.length
    ? Math.max(...plan.chapters.map((chapter) => chapter.index))
    : 0;
  const startIndex = maxExisting + 1;
  assertValidChapterPlans(chapters, {
    expectedCount: chapters.length,
    startIndex,
    requireContiguous: true,
  });

  const existing = new Set(plan.chapters.map((chapter) => chapter.index));
  for (const chapter of chapters) {
    if (existing.has(chapter.index)) {
      throw new Error(`第 ${chapter.index} 章已存在于大纲中，不能重复追加`);
    }
    if (chapter.index < startIndex) {
      throw new Error(
        `第 ${chapter.index} 章序号小于现有最大章节号，不能追加`,
      );
    }
  }

  const nextPlan: ProjectPlan = {
    ...plan,
    chapters: [...plan.chapters, ...chapters].sort((a, b) => a.index - b.index),
  };
  assertValidChapterPlans(nextPlan.chapters, { allowEmpty: false });

  const outlinePath = projectFile(slug, "outline.md");
  const currentOutline = await readText(outlinePath);
  const syncedOutline = ensurePlanOutlineSync(currentOutline, chapters);
  const nextFile: ProjectFile = {
    ...file,
    meta: {
      ...file.meta,
      targetChapters: nextPlan.chapters.length,
      updatedAt: nowIso(),
    },
  };
  let mergedLedger: PlanLedger;
  if (planLedger) {
    mergedLedger = normalizePlanLedger(planLedger);
  } else {
    // 未传计划台账时至少把新增章节登记为 planned，避免大纲与台账脱节。
    const current = await getPlanLedger(slug);
    mergedLedger = mergePlanLedgers(current, {
      ...emptyPlanLedger(file.meta.updatedAt),
      events: planEntriesForChapters(chapters, file.meta.updatedAt),
    });
  }
  assertValidPlanLedger(mergedLedger, nextPlan);

  const writes: PendingWrite[] = [
    {
      filePath: projectFile(slug, "plan.json"),
      content: jsonText(nextPlan),
      backupName: "plan.json",
    },
    {
      filePath: outlinePath,
      content: textWithNewline(syncedOutline),
      backupName: "outline.md",
    },
    {
      filePath: projectFile(slug, "project.json"),
      content: jsonText(nextFile),
      backupName: "project.json",
    },
  ];
  if (mergedLedger) {
    writes.push({
      filePath: planLedgerFile(slug),
      content: jsonText(mergedLedger),
      backupName: "plan-ledger.json",
    });
  }
  await commitProjectWrites(slug, writes);

  return nextPlan;
}

// 兼容旧调用：只同步主线大纲，不改动 plan.json。
export async function appendOutlineSection(
  slug: string,
  chapters: ChapterPlan[],
): Promise<void> {
  if (!chapters.length) return;
  const file = await getProjectFile(slug);
  const outlinePath = projectFile(slug, "outline.md");
  const current = await readText(outlinePath);
  const synced = ensurePlanOutlineSync(current, chapters);
  if (synced === current) return;

  const nextFile: ProjectFile = {
    ...file,
    meta: { ...file.meta, updatedAt: nowIso() },
  };
  await commitProjectWrites(slug, [
    {
      filePath: outlinePath,
      content: textWithNewline(synced),
      backupName: "outline.md",
    },
    {
      filePath: projectFile(slug, "project.json"),
      content: jsonText(nextFile),
      backupName: "project.json",
    },
  ]);
}

export function mergeGeneratedCharacters(
  existing: Character[],
  generated: Character[],
): { characters: Character[]; preserved: number; updated: number } {
  const byName = new Map<string, Character>();
  for (const character of existing) {
    const name = character.name.trim();
    if (name && !byName.has(name)) byName.set(name, character);
  }

  const used = new Set<string>();
  const characters: Character[] = [];
  let preserved = 0;
  let updated = 0;

  for (const candidate of generated) {
    const name = candidate.name.trim();
    const previous = byName.get(name);
    // 旧版角色没有 source，无法确定是否被用户改过，按保守策略保留。
    if (previous && (previous.source === "user" || previous.source === undefined)) {
      characters.push(previous);
      used.add(name);
      preserved += 1;
    } else {
      characters.push({ ...candidate, name, source: "ai", updatedAt: nowIso() });
      used.add(name);
      updated += 1;
    }
  }

  for (const previous of existing) {
    const name = previous.name.trim();
    if (!name || used.has(name)) continue;
    if (previous.source === "user" || previous.source === undefined) {
      characters.push(previous);
      used.add(name);
      preserved += 1;
    }
  }

  return { characters, preserved, updated };
}

export interface CommitArchitectureResult {
  plan: ProjectPlan;
  characters: Character[];
  preservedCharacters: number;
  updatedCharacters: number;
  seededCanon: boolean;
}

// 大纲、世界观、主线大纲和人物卡全部生成并通过校验后，再一次性提交。
export async function commitArchitecture(
  slug: string,
  generated: {
    plan: ProjectPlan;
    bible: string;
    outlineMd: string;
    planLedger?: PlanLedger;
    facts?: CanonFact[];
    keyItems?: PlanItem[];
  },
  characters: Character[],
  options: { seedCanon?: boolean } = {},
): Promise<CommitArchitectureResult> {
  const file = await getProjectFile(slug);
  const sortedPlan: ProjectPlan = {
    ...generated.plan,
    chapters: [...generated.plan.chapters].sort((a, b) => a.index - b.index),
  };

  assertValidChapterPlans(sortedPlan.chapters, {
    expectedCount: file.meta.targetChapters,
    startIndex: 1,
    requireContiguous: true,
  });
  if (!generated.bible.trim()) throw new Error("世界观内容为空，架构未写入");
  if (!generated.outlineMd.trim()) throw new Error("主线大纲为空，架构未写入");

  const normalized = characters
    .map(normalizeCharacter)
    .filter((character) => character.name.trim().length > 0);
  if (!normalized.length) {
    throw new Error("角色生成结果为空，架构未写入");
  }
  const names = new Set<string>();
  for (const character of normalized) {
    const name = character.name.trim();
    if (names.has(name)) throw new Error(`角色生成结果存在重复姓名：${name}`);
    names.add(name);
  }

  const existing = await readJson<Character[]>(
    projectFile(slug, "characters.json"),
    [],
  );
  const merged = mergeGeneratedCharacters(existing, normalized);
  const syncedOutline = ensurePlanOutlineSync(
    generated.outlineMd,
    sortedPlan.chapters,
  );
  // 计划台账与架构一起校验、一起提交；缺失时按大纲派生 planned 记录。
  const planLedger = generated.planLedger
    ? normalizePlanLedger(generated.planLedger)
    : derivePlanLedger(sortedPlan, syncedOutline);
  assertValidPlanLedger(planLedger, sortedPlan, merged.characters);
  const nextFile: ProjectFile = {
    ...file,
    meta: {
      ...file.meta,
      targetChapters: sortedPlan.chapters.length,
      updatedAt: nowIso(),
    },
  };
  const initialCanon =
    options.seedCanon === true && isCanonEmpty(await readCanon(slug))
      ? buildInitialCanon(merged.characters, {
          facts: generated.facts ?? [],
          items: (generated.keyItems ?? []).map((item) => ({
            name: item.name,
            aliases: [...item.aliases],
            holder: item.holder,
            location: item.location,
            state: item.state,
            note: item.note,
            chapter: item.introducedChapter || 0,
          })),
        })
      : null;

  const writes = [
    {
      filePath: projectFile(slug, "plan.json"),
      content: jsonText(sortedPlan),
      backupName: "plan.json",
    },
    {
      filePath: projectFile(slug, "world.md"),
      content: textWithNewline(generated.bible),
      backupName: "world.md",
    },
    {
      filePath: projectFile(slug, "outline.md"),
      content: textWithNewline(syncedOutline),
      backupName: "outline.md",
    },
    {
      filePath: projectFile(slug, "characters.json"),
      content: jsonText(merged.characters),
      backupName: "characters.json",
    },
    {
      filePath: planLedgerFile(slug),
      content: jsonText(planLedger),
      backupName: "plan-ledger.json",
    },
    {
      filePath: projectFile(slug, "project.json"),
      content: jsonText(nextFile),
      backupName: "project.json",
    },
  ];
  if (initialCanon) {
    writes.push({
      filePath: projectFile(slug, "canon.json"),
      content: jsonText(initialCanon),
      backupName: "canon.json",
    });
  }

  await commitProjectWrites(slug, writes);

  return {
    plan: sortedPlan,
    characters: merged.characters,
    preservedCharacters: merged.preserved,
    updatedCharacters: merged.updated,
    seededCanon: Boolean(initialCanon),
  };
}

export interface SaveCharactersOptions {
  source?: CharacterSource;
  // 用户手动保存：只把新增或字段有变化的角色标记为 user，未改动的保留原来源。
  markChangedAsUser?: boolean;
}

export async function saveCharacters(
  slug: string,
  characters: Character[],
  options: SaveCharactersOptions = {},
): Promise<Character[]> {
  const file = await getProjectFile(slug);
  const normalized = characters
    .map(normalizeCharacter)
    .filter((character) => character.name.trim().length > 0);

  const names = new Set<string>();
  for (const character of normalized) {
    const name = character.name.trim();
    if (names.has(name)) throw new Error(`角色姓名重复：${name}`);
    names.add(name);
  }

  let next = normalized;
  if (options.markChangedAsUser) {
    const existing = await readJson<Character[]>(
      projectFile(slug, "characters.json"),
      [],
    );
    const existingByName = new Map(
      existing.map((character) => [character.name.trim(), character]),
    );
    const stamp = nowIso();
    next = normalized.map((character) => {
      const previous = existingByName.get(character.name.trim());
      if (
        !previous ||
        characterFingerprint(previous) !== characterFingerprint(character)
      ) {
        return { ...character, source: "user" as const, updatedAt: stamp };
      }
      return {
        ...character,
        source: previous.source,
        updatedAt: previous.updatedAt,
      };
    });
  } else {
    const source = options.source ?? "system";
    const stamp = nowIso();
    next = normalized.map((character) => ({
      ...character,
      source,
      updatedAt: character.updatedAt ?? stamp,
    }));
  }

  const nextFile: ProjectFile = {
    ...file,
    meta: { ...file.meta, updatedAt: nowIso() },
  };
  await commitProjectWrites(slug, [
    {
      filePath: projectFile(slug, "characters.json"),
      content: jsonText(next),
      backupName: "characters.json",
    },
    {
      filePath: projectFile(slug, "project.json"),
      content: jsonText(nextFile),
      backupName: "project.json",
    },
  ]);
  return next;
}

export async function updateProject(slug: string, patch: UpdateProjectPatch): Promise<ProjectMeta> {
  const file = await getProjectFile(slug);

  if (patch.meta) {
    const meta = patch.meta;
    const previousTitle = file.meta.title;
    if (typeof meta.title === "string" && meta.title.trim()) {
      file.meta.title = meta.title.trim();
      // 发布按番茄书名定位作品；书名原本跟随项目标题时同步更新，避免改名后发布仍在找旧名。
      const bookName = file.publish.fanqie.bookName.trim();
      if (
        !patch.publish?.fanqie?.bookName &&
        (!bookName || bookName === previousTitle)
      ) {
        file.publish.fanqie.bookName = file.meta.title;
      }
    }
    if (typeof meta.genre === "string" && meta.genre.trim()) file.meta.genre = meta.genre.trim();
    if (typeof meta.tone === "string" && meta.tone.trim()) file.meta.tone = meta.tone.trim();
    if (typeof meta.idea === "string") file.meta.idea = meta.idea;
    if (typeof meta.author === "string") file.meta.author = meta.author;
    if (typeof meta.language === "string" && meta.language.trim()) file.meta.language = meta.language.trim();
    if (meta.targetChapters !== undefined) {
      const nextTarget = clampInt(
        meta.targetChapters,
        file.meta.targetChapters,
        1,
        200,
      );
      const plan = await readJsonStrict<ProjectPlan>(
        projectFile(slug, "plan.json"),
      );
      if (nextTarget < plan.chapters.length) {
        throw new Error(
          `目标章节数不能小于现有大纲章节数（当前 ${plan.chapters.length} 章）`,
        );
      }
      file.meta.targetChapters = nextTarget;
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
  await writeJson(
    projectFile(slug, "project.json"),
    file,
    projectBackup(slug, "project.json"),
  );
  return file.meta;
}

export const CHAPTER_VERSION_SOURCES: ChapterVersionSource[] = [
  "ai-write",
  "ai-rewrite",
  "ai-repair",
  "ai-polish",
  "user",
  "restore",
  "system",
];

export function versionDir(slug: string, index: number): string {
  return projectFile(slug, "versions", String(index));
}

export function normalizeChapterVersion(
  input: unknown,
  index: number,
  filePath: string,
): ChapterVersion {
  const record = (input ?? {}) as Record<string, unknown>;
  const version = Number(record.version);
  const source = record.source as ChapterVersionSource;
  if (
    !Number.isInteger(version) ||
    version < 1 ||
    !CHAPTER_VERSION_SOURCES.includes(source) ||
    typeof record.content !== "string" ||
    typeof record.previousContent !== "string"
  ) {
    throw new StorageError(
      "corrupted",
      filePath,
      `章节版本文件结构不完整：${filePath}`,
    );
  }
  const recordIndex = Number(record.index);
  if (recordIndex !== index) {
    throw new StorageError(
      "corrupted",
      filePath,
      `章节版本文件与章节目录不匹配：${filePath}`,
    );
  }
  return {
    index,
    version,
    createdAt:
      typeof record.createdAt === "string" && record.createdAt
        ? record.createdAt
        : nowIso(),
    source,
    title: typeof record.title === "string" ? record.title : "",
    summary: typeof record.summary === "string" ? record.summary : "",
    content: record.content,
    previousContent: record.previousContent,
    note: typeof record.note === "string" ? record.note : undefined,
  };
}

export async function readChapterVersionRecords(
  slug: string,
  index: number,
): Promise<ChapterVersion[]> {
  const dir = versionDir(slug, index);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const records: ChapterVersion[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const filePath = path.join(dir, entry);
    const raw = await readJsonStrict<unknown>(filePath);
    records.push(normalizeChapterVersion(raw, index, filePath));
  }
  return records.sort(
    (a, b) => a.version - b.version || a.createdAt.localeCompare(b.createdAt),
  );
}

export async function createChapterVersion(
  slug: string,
  index: number,
  input: {
    source: ChapterVersionSource;
    title: string;
    summary: string;
    content: string;
    previousContent: string;
    note?: string;
  },
): Promise<ChapterVersion> {
  const records = await readChapterVersionRecords(slug, index);
  const version = records.length
    ? Math.max(...records.map((record) => record.version)) + 1
    : 1;
  const record: ChapterVersion = {
    index,
    version,
    createdAt: nowIso(),
    source: input.source,
    title: input.title,
    summary: input.summary,
    content: input.content,
    previousContent: input.previousContent,
    note: input.note,
  };
  const dir = versionDir(slug, index);
  await fs.mkdir(dir, { recursive: true });
  const stamp = record.createdAt.replace(/[:.]/g, "-");
  const target = path.join(
    dir,
    `${String(version).padStart(6, "0")}-${stamp}-${randomUUID().slice(0, 8)}.json`,
  );
  await writeJsonSafe(target, record);
  return record;
}

export async function ensureLegacyChapterVersions(
  slug: string,
  index: number,
): Promise<void> {
  const existing = await readChapterVersionRecords(slug, index);
  if (existing.length) return;

  const plan = await readJsonStrict<ProjectPlan>(
    projectFile(slug, "plan.json"),
  );
  const chapter = plan.chapters.find((item) => item.index === index);
  const current = await readTextOptional(
    projectFile(slug, "chapters", `${index}.md`),
  );

  const draftsDir = projectFile(slug, "drafts");
  let entries: string[] = [];
  try {
    entries = await fs.readdir(draftsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const prefix = `${index}-before-repair-`;
  const repairDrafts = entries
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith(".md"))
    .sort();

  let previous = "";
  for (const entry of repairDrafts) {
    const content = await readText(path.join(draftsDir, entry));
    if (!content.trim() || content === previous) continue;
    await createChapterVersion(slug, index, {
      source: "ai-repair",
      title: chapter?.title ?? "",
      summary: "",
      content,
      previousContent: previous,
      note: "从旧的定点修复草稿导入",
    });
    previous = content;
  }

  if (current.trim() && current !== previous) {
    await createChapterVersion(slug, index, {
      source: "system",
      title: chapter?.title ?? "",
      summary: chapter?.summary ?? "",
      content: current,
      previousContent: previous,
      note: "创建版本记录时的当前正文",
    });
  }
}

export interface WriteChapterOptions {
  source?: ChapterVersionSource;
  title?: string;
  summary?: string;
  note?: string;
}

export async function writeChapterFile(
  slug: string,
  index: number,
  content: string,
  options: WriteChapterOptions = {},
): Promise<ChapterVersion | null> {
  if (!Number.isInteger(index) || index < 1) throw new Error("章节序号不合法");
  const normalized = content.endsWith("\n") ? content : `${content}\n`;
  const chapterPath = projectFile(slug, "chapters", `${index}.md`);
  const previous = await readTextOptional(chapterPath);
  // 正文没有变化时不再制造空版本，避免历史列表被无意义记录淹没。
  if (previous === normalized) return null;

  let title = options.title?.trim() ?? "";
  let summary = options.summary?.trim() ?? "";
  if (!title) {
    const plan = await readJsonStrict<ProjectPlan>(
      projectFile(slug, "plan.json"),
    );
    const chapter = plan.chapters.find((item) => item.index === index);
    title = chapter?.title ?? "";
    if (!summary) summary = chapter?.summary ?? "";
  }

  // 旧项目可能已有正文但还没有任何版本记录；先为原文建基线，否则第一次
  // 覆盖后原文只存在于 previousContent 里，无法通过“恢复版本”找回。
  if (previous.trim()) {
    const existing = await readChapterVersionRecords(slug, index);
    if (!existing.length) {
      await createChapterVersion(slug, index, {
        source: "system",
        title,
        summary,
        content: previous,
        previousContent: "",
        note: "首次修改前的正文",
      });
    }
  }

  const version = await createChapterVersion(slug, index, {
    source: options.source ?? "system",
    title,
    summary,
    content: normalized,
    previousContent: previous,
    note: options.note,
  });

  // 版本写成功后才覆盖正文；版本记录失败时旧稿保持不变。
  await writeText(
    chapterPath,
    normalized,
    projectBackup(slug, `chapters/${index}.md`),
  );
  return version;
}

export async function listChapterVersions(
  slug: string,
  index: number,
  options: { importLegacy?: boolean } = {},
): Promise<ChapterVersionMeta[]> {
  if (!Number.isInteger(index) || index < 1) throw new Error("章节序号不合法");
  await getProjectFile(slug);
  if (options.importLegacy !== false) {
    await ensureLegacyChapterVersions(slug, index);
  }
  const records = await readChapterVersionRecords(slug, index);
  return records.map((record) => ({
    index: record.index,
    version: record.version,
    createdAt: record.createdAt,
    source: record.source,
    title: record.title,
    summary: record.summary,
    words: countWords(record.content),
    note: record.note,
  }));
}

export async function getChapterVersion(
  slug: string,
  index: number,
  version: number,
  options: { importLegacy?: boolean } = {},
): Promise<ChapterVersion> {
  if (!Number.isInteger(index) || index < 1) throw new Error("章节序号不合法");
  if (!Number.isInteger(version) || version < 1) throw new Error("版本号不合法");
  await getProjectFile(slug);
  if (options.importLegacy !== false) {
    await ensureLegacyChapterVersions(slug, index);
  }
  const records = await readChapterVersionRecords(slug, index);
  const found = records.find((record) => record.version === version);
  if (!found) {
    throw new StorageError(
      "not_found",
      versionDir(slug, index),
      `第 ${index} 章不存在版本 ${version}`,
    );
  }
  return found;
}

export interface RestoreChapterVersionResult {
  restored: ChapterVersion;
  created: ChapterVersion | null;
}

// 恢复旧版本会新建一条 restore 版本，不销毁任何历史记录。
export async function restoreChapterVersion(
  slug: string,
  index: number,
  version: number,
): Promise<RestoreChapterVersionResult> {
  const target = await getChapterVersion(slug, index, version);
  const file = await getProjectFile(slug);
  const plan = await readJsonStrict<ProjectPlan>(
    projectFile(slug, "plan.json"),
  );
  const chapter = plan.chapters.find((item) => item.index === index);
  if (!chapter) throw new Error(`第 ${index} 章不在当前大纲中`);

  const created = await writeChapterFile(slug, index, target.content, {
    source: "restore",
    title: chapter.title,
    summary: target.summary || chapter.summary,
    note: `恢复到第 ${target.version} 版`,
  });
  if (!created) return { restored: target, created: null };

  const state = await readState(slug);
  if (!state.written.includes(index)) {
    state.written = [...state.written, index].sort((a, b) => a - b);
  }
  state.summaries[String(index)] =
    target.summary.trim() || state.summaries[String(index)] || chapter.summary;
  // 旧审校和修复记录对应的是被覆盖的正文，恢复后不再适用。
  delete state.reviews[String(index)];
  delete state.repairs[String(index)];
  delete state.rejectedDrafts[String(index)];
  state.updatedAt = nowIso();
  await writeJson(
    projectFile(slug, "state.json"),
    state,
    projectBackup(slug, "state.json"),
  );

  const nextFile: ProjectFile = {
    ...file,
    meta: { ...file.meta, updatedAt: nowIso() },
  };
  await writeJson(
    projectFile(slug, "project.json"),
    nextFile,
    projectBackup(slug, "project.json"),
  );

  return { restored: target, created };
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
  await writeJson(
    projectFile(slug, "state.json"),
    state,
    projectBackup(slug, "state.json"),
  );
  return record;
}

export async function getRejectedDraftContent(
  slug: string,
  index: number,
): Promise<{ draft: RejectedDraft; content: string } | null> {
  if (!Number.isInteger(index) || index < 1) throw new Error("章节序号不合法");
  const state = await readState(slug);
  const draft = state.rejectedDrafts[String(index)];
  if (!draft) return null;
  const fileName = path.basename(draft.path);
  if (!/^[^/\\]+\.md$/i.test(fileName)) throw new Error("草稿路径不合法");
  let content: string;
  try {
    content = await readTextStrict(projectFile(slug, "drafts", fileName));
  } catch {
    throw new Error(`第 ${index} 章草稿文件缺失或无法读取`);
  }
  if (!content.trim()) throw new Error(`第 ${index} 章草稿内容为空`);
  return { draft, content };
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
  await writeJson(
    projectFile(slug, "state.json"),
    state,
    projectBackup(slug, "state.json"),
  );
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
  await writeJson(
    projectFile(slug, "state.json"),
    state,
    projectBackup(slug, "state.json"),
  );

  const file = await getProjectFile(slug);
  file.meta.updatedAt = nowIso();
  await writeJson(
    projectFile(slug, "project.json"),
    file,
    projectBackup(slug, "project.json"),
  );
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
  await writeJson(
    projectFile(slug, "state.json"),
    state,
    projectBackup(slug, "state.json"),
  );
}

export async function saveChapter(
  slug: string,
  index: number,
  content: string,
  title?: string,
  options: { source?: "user" | "ai-polish"; note?: string } = {},
): Promise<ChapterContent> {
  if (!Number.isInteger(index) || index < 1) throw new Error("章节序号不合法");

  // 必须读到真实大纲再保存；损坏时抛错，避免把章节写到错误骨架下。
  const plan = await readJsonStrict<ProjectPlan>(projectFile(slug, "plan.json"));
  const chapter = plan.chapters.find((item) => item.index === index);
  if (!chapter) throw new Error(`第 ${index} 章不在当前大纲中`);

  // 先写正文版本，再改 plan.json 标题；版本写入失败时标题也不会先变。
  const nextTitle =
    title && title.trim() ? title.trim() : chapter.title;
  await writeChapterFile(slug, index, content, {
    source: options.source ?? "user",
    title: nextTitle,
    summary: chapter.summary,
    note: options.note ?? "手动保存",
  });
  if (nextTitle !== chapter.title) {
    chapter.title = nextTitle;
    await writeJson(
      projectFile(slug, "plan.json"),
      plan,
      projectBackup(slug, "plan.json"),
    );
  }

  const state = await readState(slug);
  if (content.trim() && !state.written.includes(index)) {
    state.written = [...state.written, index].sort((a, b) => a - b);
  }
  if (content.trim()) delete state.rejectedDrafts[String(index)];
  state.summaries[String(index)] = state.summaries[String(index)] ?? chapter.summary;
  state.updatedAt = nowIso();
  await writeJson(
    projectFile(slug, "state.json"),
    state,
    projectBackup(slug, "state.json"),
  );

  const file = await getProjectFile(slug);
  file.meta.updatedAt = nowIso();
  await writeJson(
    projectFile(slug, "project.json"),
    file,
    projectBackup(slug, "project.json"),
  );

  return {
    index,
    title: chapter.title,
    content,
    words: countWords(content),
    written: true,
  };
}

export interface DeleteChapterResult {
  deleted: number;
  remainingChapters: number;
}

// 只允许删除最后一章：它不参与后续章节编号，删除后不需要迁移其他章节的正文和台账。
export async function deleteChapter(
  slug: string,
  index: number,
): Promise<DeleteChapterResult> {
  if (!Number.isInteger(index) || index < 1) throw new Error("章节序号不合法");
  const file = await getProjectFile(slug);
  const plan = await readJsonStrict<ProjectPlan>(projectFile(slug, "plan.json"));
  assertDeletableChapter(plan, index);

  // 已提交到番茄的章节删除后，平台上的正文仍然存在；同号重写也可能被当成重复发布。
  const ledger = await getPublishLedger(slug);
  const published = Object.values(ledger.records).filter(
    (entry) => entry.platform === "fanqie" && entry.chapter === index,
  );
  if (published.length) {
    const status = published.some((entry) => entry.status === "published")
      ? "已发布"
      : "待人工确认";
    throw new Error(
      `第 ${index} 章存在番茄发布记录（${status}），请先在「发布」页处理后再删除`,
    );
  }

  const state = await readState(slug);
  const rawCanon = await readJsonOptional<unknown>(
    projectFile(slug, "canon.json"),
    null,
  );
  const canon = rawCanon === null ? emptyCanon() : normalizeCanon(rawCanon);
  const rawMemory = await readJsonOptional<unknown>(memoryFile(slug), null);
  const memory = rawMemory === null ? null : normalizeMemory(rawMemory);
  const rawStory = await readJsonOptional<unknown>(storyFile(slug), null);
  const story = rawStory === null ? null : normalizeStory(rawStory);
  const rawPlanLedger = await readJsonOptional<unknown>(planLedgerFile(slug), null);
  const planLedger =
    rawPlanLedger === null
      ? null
      : normalizePlanLedger(rawPlanLedger, file.meta.updatedAt);
  const outlineMd = await readText(projectFile(slug, "outline.md"));

  const at = nowIso();
  const result = buildChapterDeletion({
    plan,
    state,
    canon,
    memory,
    story,
    planLedger,
    outlineMd,
    index,
    updatedAt: at,
  });
  const nextFile: ProjectFile = {
    ...file,
    meta: {
      ...file.meta,
      targetChapters: result.plan.chapters.length,
      updatedAt: at,
    },
  };

  const writes: PendingWrite[] = [
    {
      filePath: projectFile(slug, "plan.json"),
      content: jsonText(result.plan),
      backupName: "plan.json",
    },
    {
      filePath: projectFile(slug, "outline.md"),
      content: textWithNewline(result.outlineMd),
      backupName: "outline.md",
    },
    {
      filePath: projectFile(slug, "state.json"),
      content: jsonText(result.state),
      backupName: "state.json",
    },
    {
      filePath: projectFile(slug, "project.json"),
      content: jsonText(nextFile),
      backupName: "project.json",
    },
  ];
  if (rawCanon !== null || !isCanonEmpty(result.canon)) {
    writes.push({
      filePath: projectFile(slug, "canon.json"),
      content: jsonText(result.canon),
      backupName: "canon.json",
    });
  }
  if (result.memory) {
    writes.push({
      filePath: memoryFile(slug),
      content: jsonText(result.memory),
      backupName: "memory.json",
    });
  }
  if (result.story) {
    writes.push({
      filePath: storyFile(slug),
      content: jsonText(result.story),
      backupName: "story.json",
    });
  }
  if (result.planLedger) {
    writes.push({
      filePath: planLedgerFile(slug),
      content: jsonText(result.planLedger),
      backupName: "plan-ledger.json",
    });
  }

  // 正文先复制到 backups/，再统一提交 JSON；提交失败时 chapters/ 里的原文不受影响。
  const chapterFile = projectFile(slug, "chapters", `${index}.md`);
  await backupFile(chapterFile, projectBackup(slug, `chapters/${index}.md`));
  await removeRepairDecisionsForChapter(slug, index);
  await commitProjectWrites(slug, writes);

  await fs.rm(chapterFile, { force: true });
  await fs.rm(versionDir(slug, index), { recursive: true, force: true });
  await removeChapterDraftFiles(slug, index);

  return { deleted: index, remainingChapters: result.plan.chapters.length };
}

async function removeChapterDraftFiles(
  slug: string,
  index: number,
): Promise<void> {
  const dir = projectFile(slug, "drafts");
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return;
  }
  const prefix = `${index}-`;
  await Promise.all(
    entries
      .filter((entry) => entry.startsWith(prefix) && entry.endsWith(".md"))
      .map((entry) => fs.rm(path.join(dir, entry), { force: true })),
  );
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
  await writeText(
    target,
    content.endsWith("\n") ? content : `${content}\n`,
    projectBackup(slug, "audit.md"),
  );
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
      readTextStrict(target),
      fs.stat(target),
    ]);
    return { content, updatedAt: stat.mtime.toISOString() };
  } catch (error) {
    // 只有“报告尚未生成”可以返回空；权限/IO 错误必须暴露，否则会被误判为没有审校记录。
    if (error instanceof StorageError && error.code === "not_found") {
      return { content: "", updatedAt: null };
    }
    throw error;
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

// 发布日志只用于展示，允许按上限裁剪；真正的去重依据是 publish-ledger.json。
export async function appendPublishRecord(slug: string, record: PublishRecord): Promise<void> {
  const state = await readState(slug);
  state.publishHistory = [...state.publishHistory, record].slice(-100);
  state.updatedAt = nowIso();
  await writeJson(
    projectFile(slug, "state.json"),
    state,
    projectBackup(slug, "state.json"),
  );
}

// 清空日志不会影响永久去重台账。
export async function clearPublishHistory(slug: string): Promise<void> {
  const state = await readState(slug);
  state.publishHistory = [];
  state.updatedAt = nowIso();
  await writeJson(
    projectFile(slug, "state.json"),
    state,
    projectBackup(slug, "state.json"),
  );
}

async function loadPublishLedger(
  slug: string,
  migrate: boolean,
): Promise<PublishLedger> {
  const ledgerPath = projectFile(slug, "publish-ledger.json");
  const file = await getProjectFile(slug);
  const raw = await readJsonOptional<unknown>(ledgerPath, null);
  if (raw) return normalizePublishLedger(raw);

  // 没有台账的旧项目：从日志里恢复“成功且正式发布”的章节。
  const state = await readState(slug);
  const derived = derivePublishLedger(
    state.publishHistory ?? [],
    file.publish.fanqie.bookId,
    file.publish.fanqie.bookName,
  );
  if (migrate && Object.keys(derived.records).length) {
    await writeJson(
      ledgerPath,
      derived,
      projectBackup(slug, "publish-ledger.json"),
    );
  }
  return derived;
}

export async function getPublishLedger(slug: string): Promise<PublishLedger> {
  return loadPublishLedger(slug, true);
}

export async function recordPublishOutcome(
  slug: string,
  input: {
    bookId: string;
    bookName: string;
    chapter: number;
    status: PublishLedgerStatus;
    jobId?: string;
    message?: string;
  },
): Promise<void> {
  const ledger = await getPublishLedger(slug);
  const next = upsertPublishEntry(ledger, {
    platform: "fanqie",
    bookId: input.bookId.trim(),
    bookName: input.bookName.trim(),
    chapter: input.chapter,
    status: input.status,
    at: nowIso(),
    jobId: input.jobId,
    message: input.message,
  });
  await writeJson(
    projectFile(slug, "publish-ledger.json"),
    next,
    projectBackup(slug, "publish-ledger.json"),
  );
}

// 人工确认“状态不明”的章节：确认成功则永久去重，确认未成功则删除记录以便重发。
export async function resolvePublishOutcome(
  slug: string,
  input: { bookId: string; bookName: string; chapter: number; published: boolean },
): Promise<PublishLedger> {
  return resolvePublishOutcomes(slug, { ...input, chapters: [input.chapter] });
}

// 批量版：几十章一起标记时只读一次、写一次台账。
export async function resolvePublishOutcomes(
  slug: string,
  input: { bookId: string; bookName: string; chapters: number[]; published: boolean },
): Promise<PublishLedger> {
  const ledger = await getPublishLedger(slug);
  const next = applyPublishStates(ledger, input);
  await writeJson(
    projectFile(slug, "publish-ledger.json"),
    next,
    projectBackup(slug, "publish-ledger.json"),
  );
  return next;
}

export type IntegritySeverity = "critical" | "warning";

export interface IntegrityIssue {
  severity: IntegritySeverity;
  code: string;
  message: string;
}

export interface IntegrityReport {
  slug: string;
  ok: boolean;
  issues: IntegrityIssue[];
  chaptersOnDisk: number[];
}

export async function checkProjectIntegrity(slug: string): Promise<IntegrityReport> {
  let file: ProjectFile;
  let plan: ProjectPlan;
  let state: ProjectState;
  let canon: CanonFacts;
  try {
    file = await getProjectFile(slug);
    plan = await readJsonStrict<ProjectPlan>(projectFile(slug, "plan.json"));
    state = await readState(slug);
    canon = await readCanon(slug);
  } catch (error) {
    // 核心文件无法读取时，完整性报告本身应返回 critical，而不是直接抛错。
    if (error instanceof StorageError) {
      return {
        slug,
        ok: false,
        issues: [
          {
            severity: "critical",
            code: `storage-${error.code}`,
            message: error.message,
          },
        ],
        chaptersOnDisk: [],
      };
    }
    throw error;
  }
  const issues: IntegrityIssue[] = [];
  const add = (severity: IntegritySeverity, code: string, message: string) => {
    issues.push({ severity, code, message });
  };

  const indexSet = new Set<number>();
  const chapterByIndex = new Map<number, ChapterPlan>();
  for (const chapter of plan.chapters) {
    if (!Number.isInteger(chapter.index) || chapter.index < 1) {
      add("critical", "invalid-index", `章节序号不合法：${String(chapter.index)}`);
      continue;
    }
    if (indexSet.has(chapter.index)) {
      add("critical", "duplicate-index", `章节序号重复：第 ${chapter.index} 章`);
      continue;
    }
    indexSet.add(chapter.index);
    chapterByIndex.set(chapter.index, chapter);
    if (!chapter.title?.trim()) {
      add("critical", "empty-title", `第 ${chapter.index} 章标题为空`);
    }
    if (!chapter.summary?.trim()) {
      add("warning", "empty-summary", `第 ${chapter.index} 章摘要为空`);
    }
    if (!Array.isArray(chapter.keyBeats)) {
      add("warning", "invalid-key-beats", `第 ${chapter.index} 章 keyBeats 不是数组`);
    }
  }

  const sortedIndices = [...indexSet].sort((a, b) => a - b);
  sortedIndices.forEach((value, offset) => {
    if (value !== offset + 1) {
      add(
        "warning",
        "non-contiguous-index",
        `章节序号不连续：期望第 ${offset + 1} 章，实际为第 ${value} 章`,
      );
    }
  });

  for (const index of state.written) {
    if (!indexSet.has(index)) {
      add("critical", "written-not-in-plan", `state 标记已写第 ${index} 章，但大纲中不存在`);
    }
  }

  const chaptersDir = projectFile(slug, "chapters");
  let entries: string[] = [];
  try {
    entries = await fs.readdir(chaptersDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      add("critical", "missing-chapters-dir", "chapters 目录不存在");
    } else {
      throw error;
    }
  }

  const chaptersOnDisk = entries
    .map((entry) => /^(\d+)\.md$/.exec(entry))
    .filter((match): match is RegExpExecArray => Boolean(match))
    .map((match) => Number(match[1]))
    .filter((index) => Number.isInteger(index) && index > 0)
    .sort((a, b) => a - b);
  const diskSet = new Set(chaptersOnDisk);

  for (const index of chaptersOnDisk) {
    if (!indexSet.has(index)) {
      add("warning", "orphan-chapter-file", `第 ${index} 章正文存在，但大纲中没有该章节`);
    }
  }

  for (const index of indexSet) {
    const written = state.written.includes(index);
    const exists = diskSet.has(index);
    if (written && !exists) {
      add("critical", "missing-chapter-file", `第 ${index} 章标记为已写，但正文文件缺失`);
      continue;
    }
    if (!written && exists) {
      const content = await readTextOptional(projectFile(slug, "chapters", `${index}.md`));
      if (content.trim()) {
        add("warning", "unmarked-chapter-file", `第 ${index} 章有正文，但未标记为已写`);
      }
    }
  }

  const checkStateKeys = (label: string, keys: string[]) => {
    for (const key of keys) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 1 || !indexSet.has(index)) {
        add("warning", "invalid-state-key", `${label} 中存在无效章节键：${key}`);
      }
    }
  };
  checkStateKeys("摘要", Object.keys(state.summaries));
  checkStateKeys("审校记录", Object.keys(state.reviews));
  checkStateKeys("修复记录", Object.keys(state.repairs));
  checkStateKeys("未通过草稿", Object.keys(state.rejectedDrafts));

  if (file.meta.slug !== slug) {
    add("warning", "slug-mismatch", `project.json 中的 slug（${file.meta.slug}）与目录名不一致`);
  }

  // 大纲与主线大纲的同步检查；无法确认时只提示，不擅自删除用户内容。
  let outlineMd = "";
  let outlineReadable = true;
  try {
    outlineMd = await readTextOptional(projectFile(slug, "outline.md"));
  } catch (error) {
    outlineReadable = false;
    add(
      "critical",
      "outline-read-failed",
      `读取 outline.md 失败：${errorMessage(error)}`,
    );
  }
  if (outlineReadable) {
    for (const issue of checkPlanOutlineConsistency(plan, outlineMd, file.meta)) {
      add(issue.severity, issue.code, issue.message);
    }
  }

  const writtenIndices = state.written.filter((index) => indexSet.has(index));
  const latestWritten = writtenIndices.length ? Math.max(...writtenIndices) : 0;
  if (canon.lastChapter < latestWritten) {
    add(
      "warning",
      "canon-lagging",
      `事实台账只覆盖到第 ${canon.lastChapter} 章，正文已写到第 ${latestWritten} 章，需要重建台账`,
    );
  }
  if (canon.lastChapter > latestWritten) {
    add(
      "critical",
      "canon-ahead",
      `事实台账覆盖到第 ${canon.lastChapter} 章，但正文只写到第 ${latestWritten} 章`,
    );
  }

  return {
    slug,
    ok: !issues.some((issue) => issue.severity === "critical"),
    issues,
    chaptersOnDisk,
  };
}

export interface FixPlanConsistencyResult {
  fixedChapters: number[];
  report: IntegrityReport;
}

// 只做可以确定的安全修复：把大纲中缺失的章节细纲追加到 outline.md。
// 标题不一致、孤儿章节等无法确定谁对谁错，交给用户人工处理。
export async function fixPlanOutlineConsistency(
  slug: string,
): Promise<FixPlanConsistencyResult> {
  const file = await getProjectFile(slug);
  const plan = await readJsonStrict<ProjectPlan>(
    projectFile(slug, "plan.json"),
  );
  const outlinePath = projectFile(slug, "outline.md");
  const current = await readText(outlinePath);
  const missing = missingOutlineChapters(plan, current).sort(
    (a, b) => a.index - b.index,
  );

  if (missing.length) {
    const nextOutline = appendChapterOutline(current, missing);
    const nextFile: ProjectFile = {
      ...file,
      meta: { ...file.meta, updatedAt: nowIso() },
    };
    await commitProjectWrites(slug, [
      {
        filePath: outlinePath,
        content: textWithNewline(nextOutline),
        backupName: "outline.md",
      },
      {
        filePath: projectFile(slug, "project.json"),
        content: jsonText(nextFile),
        backupName: "project.json",
      },
    ]);
  }

  return {
    fixedChapters: missing.map((chapter) => chapter.index),
    report: await checkProjectIntegrity(slug),
  };
}
