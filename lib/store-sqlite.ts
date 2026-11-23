import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { buildInitialCanon, isCanonEmpty } from "./canon";
import { normalizeMemory } from "./memory";
import {
  assertValidPlanLedger,
  derivePlanLedger,
  emptyPlanLedger,
  mergePlanLedgers,
  normalizePlanLedger,
  planEntriesForChapters,
} from "./plan-ledger";
import { normalizeStory } from "./story";
import { derivePublishLedger, removePublishEntry, upsertPublishEntry } from "./publish-ledger";
import {
  appendChapterOutline,
  checkPlanOutlineConsistency,
  ensurePlanOutlineSync,
  missingOutlineChapters,
} from "./plan-consistency";
import { assertValidChapterPlans } from "./plan-validation";
import {
  readJsonStrict,
  readTextOptional,
  readTextStrict,
  StorageError,
  writeJsonSafe,
} from "./storage";
import {
  CHAPTER_VERSION_SOURCES,
  characterFingerprint,
  commitProjectWrites,
  defaultProjectFile,
  mergeGeneratedCharacters,
  normalizeCharacter,
  projectBackup,
  projectDir,
  projectFile,
  readText,
  textWithNewline,
  versionDir,
  writeText,
} from "./store-file";
import {
  clampInt,
  countWords,
  errorMessage,
  isSafeSlug,
  nowIso,
  slugify,
} from "./utils";
import * as repo from "./db/project-repository";
import type {
  AuditReport,
  CommitArchitectureResult,
  CreateProjectInput,
  FixPlanConsistencyResult,
  IntegrityIssue,
  IntegrityReport,
  IntegritySeverity,
  SaveCharactersOptions,
  UpdateProjectPatch,
  WriteChapterOptions,
} from "./store-file";
import type {
  CanonFact,
  CanonFacts,
  ChapterContent,
  ChapterPlan,
  ChapterVersion,
  ChapterVersionMeta,
  ChapterVersionSource,
  Character,
  FanqieConfig,
  ProjectDetail,
  ProjectFile,
  PlanLedger,
  ProjectMemory,
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

export { DEFAULT_FANQIE, DEFAULT_PLAN, normalizeCharacter } from "./store-file";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function relativePath(slug: string, filePath: string): string {
  return path.relative(projectDir(slug), filePath).split(path.sep).join("/");
}

function resolveProjectPath(slug: string, relative: string): string {
  const root = path.resolve(projectDir(slug));
  const full = path.resolve(root, relative);
  if (full !== root && !full.startsWith(`${root}${path.sep}`)) {
    throw new Error("项目文件路径不合法");
  }
  return full;
}

function normalizeContent(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

async function chapterPath(slug: string, index: number): Promise<string> {
  return projectFile(slug, "chapters", `${index}.md`);
}

// 旧项目或迁移前项目没有计划台账行：只读派生 planned 记录，不写库。
function resolvePlanLedger(
  slug: string,
  plan: ProjectPlan,
  outlineMd: string,
  updatedAt: string,
): PlanLedger {
  return repo.getPlanLedger(slug) ?? derivePlanLedger(plan, outlineMd, updatedAt);
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
  const file = defaultProjectFile(meta);
  file.publish.fanqie.bookName = title;

  await fs.mkdir(projectFile(slug, "chapters"), { recursive: true });
  try {
    repo.insertProject(file);
    repo.replacePlanLedger(slug, emptyPlanLedger(now));
    await writeText(
      projectFile(slug, "world.md"),
      `# ${title} · 世界观圣经\n\n> 在「总览」中点击「生成架构」后，这里会自动填充。\n\n## 核心创意\n\n${meta.idea || "（尚未填写）"}\n`,
    );
    await writeText(
      projectFile(slug, "outline.md"),
      `# ${title} · 主线大纲\n\n> 在「总览」中点击「生成架构」后，这里会自动填充。\n`,
    );
  } catch (error) {
    try {
      repo.deleteProjectRow(slug);
    } catch {
      // 数据库插入失败时目录清理失败也不能覆盖原始错误。
    }
    await fs.rm(projectDir(slug), { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  return getProjectDetail(slug);
}

export async function deleteProject(slug: string): Promise<void> {
  if (!isSafeSlug(slug)) throw new Error("slug 不合法");
  repo.getProjectFile(slug);
  const trash = `${projectDir(slug)}.deleting-${randomUUID().slice(0, 8)}`;
  await fs.rename(projectDir(slug), trash);
  try {
    repo.deleteProjectRow(slug);
  } catch (error) {
    await fs.rename(trash, projectDir(slug)).catch(() => undefined);
    throw error;
  }
  await fs.rm(trash, { recursive: true, force: true });
}

export async function getProjectFile(slug: string): Promise<ProjectFile> {
  return repo.getProjectFile(slug);
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const files = repo.listProjectFiles();
  const summaries: ProjectSummary[] = [];
  for (const file of files) {
    try {
      const slug = file.meta.slug;
      const plan = repo.getPlan(slug);
      const state = repo.getState(slug);
      let words = 0;
      for (const index of state.written) {
        words += countWords(await readText(await chapterPath(slug, index)));
      }
      summaries.push({
        slug,
        title: file.meta.title,
        genre: file.meta.genre,
        tone: file.meta.tone,
        written: state.written.length,
        planned: plan.chapters.length,
        words,
        updatedAt: file.meta.updatedAt,
      });
    } catch (error) {
      console.warn(
        `[projects] 跳过无法读取的项目 ${file.meta.slug}：${errorMessage(error)}`,
      );
    }
  }
  return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getProjectDetail(slug: string): Promise<ProjectDetail> {
  const file = repo.getProjectFile(slug);
  const plan = repo.getPlan(slug);
  const characters = repo.getCharacters(slug);
  const state = repo.getState(slug);
  const canon = repo.getCanon(slug);
  // 普通读取不写库；只有显式调用 getPublishLedger 时才把旧日志派生结果落盘。
  let publishLedger = repo.getPublishLedger(slug);
  if (!Object.keys(publishLedger.records).length) {
    publishLedger = derivePublishLedger(
      state.publishHistory ?? [],
      file.publish.fanqie.bookId,
      file.publish.fanqie.bookName,
    );
  }
  const bible = await readText(projectFile(slug, "world.md"));
  const outlineMd = await readText(projectFile(slug, "outline.md"));
  const planLedger = resolvePlanLedger(slug, plan, outlineMd, file.meta.updatedAt);
  const chapterStates = repo.getChapterStates(slug);
  const writtenSet = new Set(state.written);

  const chapters: ChapterContent[] = [];
  const staleChapters: number[] = [];
  for (const chapter of plan.chapters) {
    const content = await readText(await chapterPath(slug, chapter.index));
    const stateRow = chapterStates.get(chapter.index);
    const written = writtenSet.has(chapter.index) || Boolean(stateRow?.written);
    if (written && stateRow?.contentHash && sha256(content) !== stateRow.contentHash) {
      staleChapters.push(chapter.index);
    }
    chapters.push({
      index: chapter.index,
      title: chapter.title,
      content,
      words: countWords(content),
      written,
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
    staleChapters,
  };
}

function previousPlanForRollback(slug: string): {
  plan: ProjectPlan;
  file: ProjectFile;
} {
  return { plan: repo.getPlan(slug), file: repo.getProjectFile(slug) };
}

export async function savePlan(
  slug: string,
  plan: ProjectPlan,
  bible: string,
  outlineMd: string,
): Promise<void> {
  const file = repo.getProjectFile(slug);
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
  const previous = previousPlanForRollback(slug);

  repo.replacePlan(slug, sortedPlan, nextFile);
  try {
    await commitProjectWrites(slug, [
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
    ]);
  } catch (error) {
    repo.replacePlan(slug, previous.plan, previous.file);
    throw error;
  }
}

export async function appendChapters(
  slug: string,
  chapters: ChapterPlan[],
  planLedger?: PlanLedger,
): Promise<ProjectPlan> {
  const file = repo.getProjectFile(slug);
  const plan = repo.getPlan(slug);
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
      throw new Error(`第 ${chapter.index} 章序号小于现有最大章节号，不能追加`);
    }
  }

  const nextPlan: ProjectPlan = {
    ...plan,
    chapters: [...plan.chapters, ...chapters].sort((a, b) => a.index - b.index),
  };
  assertValidChapterPlans(nextPlan.chapters, { allowEmpty: false });

  const currentOutline = await readText(projectFile(slug, "outline.md"));
  const syncedOutline = ensurePlanOutlineSync(currentOutline, chapters);
  const nextFile: ProjectFile = {
    ...file,
    meta: {
      ...file.meta,
      targetChapters: nextPlan.chapters.length,
      updatedAt: nowIso(),
    },
  };
  const previous = previousPlanForRollback(slug);

  let nextLedger: PlanLedger;
  if (planLedger) {
    nextLedger = normalizePlanLedger(planLedger);
  } else {
    const current =
      repo.getPlanLedger(slug) ?? derivePlanLedger(plan, await readText(projectFile(slug, "outline.md")), file.meta.updatedAt);
    nextLedger = mergePlanLedgers(current, {
      ...emptyPlanLedger(file.meta.updatedAt),
      events: planEntriesForChapters(chapters, file.meta.updatedAt),
    });
  }
  assertValidPlanLedger(nextLedger, nextPlan);
  repo.appendPlanChapters(slug, chapters, nextFile, nextLedger);
  try {
    await commitProjectWrites(slug, [
      {
        filePath: projectFile(slug, "outline.md"),
        content: textWithNewline(syncedOutline),
        backupName: "outline.md",
      },
    ]);
  } catch (error) {
    repo.replacePlan(slug, previous.plan, previous.file);
    throw error;
  }
  return nextPlan;
}

export async function appendOutlineSection(
  slug: string,
  chapters: ChapterPlan[],
): Promise<void> {
  if (!chapters.length) return;
  const file = repo.getProjectFile(slug);
  const outlinePath = projectFile(slug, "outline.md");
  const current = await readText(outlinePath);
  const synced = ensurePlanOutlineSync(current, chapters);
  if (synced === current) return;

  await commitProjectWrites(slug, [
    {
      filePath: outlinePath,
      content: textWithNewline(synced),
      backupName: "outline.md",
    },
  ]);
  repo.updateProjectFile({ ...file, meta: { ...file.meta, updatedAt: nowIso() } });
}

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
  const file = repo.getProjectFile(slug);
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
  if (!normalized.length) throw new Error("角色生成结果为空，架构未写入");
  const names = new Set<string>();
  for (const character of normalized) {
    const name = character.name.trim();
    if (names.has(name)) throw new Error(`角色生成结果存在重复姓名：${name}`);
    names.add(name);
  }

  const existing = repo.getCharacters(slug);
  const merged = mergeGeneratedCharacters(existing, normalized);
  const syncedOutline = ensurePlanOutlineSync(generated.outlineMd, sortedPlan.chapters);
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
  const previous = previousPlanForRollback(slug);
  const previousCharacters = repo.getCharacters(slug);
  const previousCanon = repo.getCanon(slug);
  const previousPlanLedger = repo.getPlanLedger(slug) ?? emptyPlanLedger();
  const initialCanon =
    options.seedCanon === true && isCanonEmpty(previousCanon)
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
      : undefined;

  repo.commitArchitecture(
    slug,
    sortedPlan,
    merged.characters,
    nextFile,
    initialCanon,
    planLedger,
  );
  try {
    await commitProjectWrites(slug, [
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
    ]);
  } catch (error) {
    repo.commitArchitecture(
      slug,
      previous.plan,
      previousCharacters,
      previous.file,
      previousCanon,
      previousPlanLedger,
    );
    throw error;
  }

  return {
    plan: sortedPlan,
    characters: merged.characters,
    preservedCharacters: merged.preserved,
    updatedCharacters: merged.updated,
    seededCanon: Boolean(initialCanon),
  };
}

export async function saveCharacters(
  slug: string,
  characters: Character[],
  options: SaveCharactersOptions = {},
): Promise<Character[]> {
  const file = repo.getProjectFile(slug);
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
    const existing = repo.getCharacters(slug);
    const existingByName = new Map(
      existing.map((character) => [character.name.trim(), character]),
    );
    const stamp = nowIso();
    next = normalized.map((character) => {
      const previous = existingByName.get(character.name.trim());
      if (!previous || characterFingerprint(previous) !== characterFingerprint(character)) {
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

  repo.replaceCharacters(slug, next);
  repo.updateProjectFile({ ...file, meta: { ...file.meta, updatedAt: nowIso() } });
  return next;
}

export async function updateProject(
  slug: string,
  patch: UpdateProjectPatch,
): Promise<ProjectMeta> {
  const file = repo.getProjectFile(slug);

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
      const nextTarget = clampInt(meta.targetChapters, file.meta.targetChapters, 1, 200);
      const plan = repo.getPlan(slug);
      if (nextTarget < plan.chapters.length) {
        throw new Error(
          `目标章节数不能小于现有大纲章节数（当前 ${plan.chapters.length} 章）`,
        );
      }
      file.meta.targetChapters = nextTarget;
    }
    if (meta.wordsPerChapter !== undefined) {
      file.meta.wordsPerChapter = clampInt(
        meta.wordsPerChapter,
        file.meta.wordsPerChapter,
        500,
        10000,
      );
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
  repo.updateProjectFile(file);
  return file.meta;
}

export async function saveCanon(slug: string, canon: CanonFacts): Promise<void> {
  const file = repo.getProjectFile(slug);
  repo.replaceCanon(slug, canon);
  repo.updateProjectFile({ ...file, meta: { ...file.meta, updatedAt: nowIso() } });
}

export async function getCanon(slug: string): Promise<CanonFacts> {
  repo.getProjectFile(slug);
  return repo.getCanon(slug);
}

export async function getMemory(slug: string): Promise<ProjectMemory> {
  repo.getProjectFile(slug);
  return normalizeMemory(repo.getMemory(slug));
}

export async function saveMemory(slug: string, memory: ProjectMemory): Promise<void> {
  repo.getProjectFile(slug);
  repo.replaceMemory(slug, normalizeMemory(memory));
}

export async function getStory(slug: string): Promise<StoryLedger> {
  repo.getProjectFile(slug);
  return normalizeStory(repo.getStory(slug));
}

export async function saveStory(slug: string, story: StoryLedger): Promise<void> {
  repo.getProjectFile(slug);
  repo.replaceStory(slug, normalizeStory(story));
}

export async function getPlanLedger(slug: string): Promise<PlanLedger> {
  const file = repo.getProjectFile(slug);
  const plan = repo.getPlan(slug);
  const outlineMd = await readText(projectFile(slug, "outline.md"));
  return resolvePlanLedger(slug, plan, outlineMd, file.meta.updatedAt);
}

export async function savePlanLedger(slug: string, ledger: PlanLedger): Promise<void> {
  const file = repo.getProjectFile(slug);
  repo.replacePlanLedger(slug, normalizePlanLedger(ledger));
  repo.updateProjectFile({ ...file, meta: { ...file.meta, updatedAt: nowIso() } });
}

export async function commitCanonRebuild(
  slug: string,
  canon: CanonFacts,
  summaries: Record<string, string>,
): Promise<void> {
  const file = repo.getProjectFile(slug);
  repo.commitCanonRebuild(slug, canon, summaries);
  repo.updateProjectFile({ ...file, meta: { ...file.meta, updatedAt: nowIso() } });
}

async function createSqliteChapterVersion(
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
  const version = repo.nextChapterVersionNumber(slug, index);
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
  try {
    repo.insertChapterVersion(slug, index, {
      version,
      createdAt: record.createdAt,
      source: record.source,
      title: record.title,
      summary: record.summary,
      note: record.note,
      contentPath: relativePath(slug, target),
      contentHash: sha256(record.content),
      previousHash: record.previousContent ? sha256(record.previousContent) : null,
      words: countWords(record.content),
    });
  } catch (error) {
    await fs.rm(target, { force: true }).catch(() => undefined);
    throw error;
  }
  return record;
}

async function ensureLegacyChapterVersions(slug: string, index: number): Promise<void> {
  if (repo.listChapterVersions(slug, index).length) return;

  const plan = repo.getPlan(slug);
  const chapter = plan.chapters.find((item) => item.index === index);
  const current = await readTextOptional(await chapterPath(slug, index));

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
    await createSqliteChapterVersion(slug, index, {
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
    await createSqliteChapterVersion(slug, index, {
      source: "system",
      title: chapter?.title ?? "",
      summary: chapter?.summary ?? "",
      content: current,
      previousContent: previous,
      note: "创建版本记录时的当前正文",
    });
  }
}

export async function writeChapterFile(
  slug: string,
  index: number,
  content: string,
  options: WriteChapterOptions = {},
): Promise<ChapterVersion | null> {
  if (!Number.isInteger(index) || index < 1) throw new Error("章节序号不合法");
  const normalized = normalizeContent(content);
  const target = await chapterPath(slug, index);
  const previous = await readTextOptional(target);
  if (previous === normalized) return null;

  let title = options.title?.trim() ?? "";
  let summary = options.summary?.trim() ?? "";
  if (!title) {
    const plan = repo.getPlan(slug);
    const chapter = plan.chapters.find((item) => item.index === index);
    title = chapter?.title ?? "";
    if (!summary) summary = chapter?.summary ?? "";
  }

  // 旧项目可能已有正文但还没有任何版本记录；先为原文建基线，否则第一次
  // 覆盖后原文只存在于 previousContent 里，无法通过“恢复版本”找回。
  if (previous.trim() && repo.listChapterVersions(slug, index).length === 0) {
    await createSqliteChapterVersion(slug, index, {
      source: "system",
      title,
      summary,
      content: previous,
      previousContent: "",
      note: "首次修改前的正文",
    });
  }

  const version = await createSqliteChapterVersion(slug, index, {
    source: options.source ?? "system",
    title,
    summary,
    content: normalized,
    previousContent: previous,
    note: options.note,
  });

  await writeText(target, normalized, projectBackup(slug, `chapters/${index}.md`));
  repo.updateChapterContentMeta(
    slug,
    index,
    `chapters/${index}.md`,
    sha256(normalized),
    countWords(normalized),
    nowIso(),
  );
  return version;
}

export async function listChapterVersions(
  slug: string,
  index: number,
  options: { importLegacy?: boolean } = {},
): Promise<ChapterVersionMeta[]> {
  if (!Number.isInteger(index) || index < 1) throw new Error("章节序号不合法");
  repo.getProjectFile(slug);
  if (options.importLegacy !== false) await ensureLegacyChapterVersions(slug, index);
  return repo.listChapterVersions(slug, index);
}

function normalizeVersionRecord(
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
    throw new StorageError("corrupted", filePath, `章节版本文件结构不完整：${filePath}`);
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

export async function getChapterVersion(
  slug: string,
  index: number,
  version: number,
  options: { importLegacy?: boolean } = {},
): Promise<ChapterVersion> {
  if (!Number.isInteger(index) || index < 1) throw new Error("章节序号不合法");
  if (!Number.isInteger(version) || version < 1) throw new Error("版本号不合法");
  repo.getProjectFile(slug);
  if (options.importLegacy !== false) await ensureLegacyChapterVersions(slug, index);
  const stored = repo.getChapterVersionMeta(slug, index, version);
  if (!stored) {
    throw new StorageError(
      "not_found",
      versionDir(slug, index),
      `第 ${index} 章不存在版本 ${version}`,
    );
  }
  const fullPath = resolveProjectPath(slug, stored.contentPath);
  const raw = await readJsonStrict<unknown>(fullPath);
  return normalizeVersionRecord(raw, index, fullPath);
}

export interface RestoreChapterVersionResult {
  restored: ChapterVersion;
  created: ChapterVersion | null;
}

export async function restoreChapterVersion(
  slug: string,
  index: number,
  version: number,
): Promise<RestoreChapterVersionResult> {
  const target = await getChapterVersion(slug, index, version);
  const file = repo.getProjectFile(slug);
  const plan = repo.getPlan(slug);
  const chapter = plan.chapters.find((item) => item.index === index);
  if (!chapter) throw new Error(`第 ${index} 章不在当前大纲中`);

  const created = await writeChapterFile(slug, index, target.content, {
    source: "restore",
    title: chapter.title,
    summary: target.summary || chapter.summary,
    note: `恢复到第 ${target.version} 版`,
  });
  if (!created) return { restored: target, created: null };

  const state = repo.getState(slug);
  const summary = target.summary.trim() || state.summaries[String(index)] || chapter.summary;
  const at = nowIso();
  repo.setChapterWrittenState(slug, index, summary, at);
  repo.clearChapterAnnotations(slug, index, at);
  repo.updateProjectFile({ ...file, meta: { ...file.meta, updatedAt: at } });
  return { restored: target, created };
}

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
  await writeText(target, normalizeContent(input.content));
  const record: RejectedDraft = {
    index: input.index,
    at: nowIso(),
    path: path.relative(process.cwd(), target).split(path.sep).join("/"),
    mode: input.mode,
    reason: input.reason,
    review: input.review,
  };
  repo.saveRejectedDraft(slug, record, record.at);
  return record;
}

export async function getRejectedDraftContent(
  slug: string,
  index: number,
): Promise<{ draft: RejectedDraft; content: string } | null> {
  if (!Number.isInteger(index) || index < 1) throw new Error("章节序号不合法");
  const draft = repo.getState(slug).rejectedDrafts[String(index)];
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

export async function saveRepairBackup(
  slug: string,
  index: number,
  content: string,
): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = projectFile(slug, "drafts", `${index}-before-repair-${stamp}.md`);
  await writeText(target, normalizeContent(content));
  return path.relative(process.cwd(), target).split(path.sep).join("/");
}

export async function markChapterRepaired(slug: string, index: number): Promise<void> {
  repo.markChapterRepaired(slug, index, nowIso());
}

export async function markChapterWritten(
  slug: string,
  index: number,
  summary: string,
  review: ReviewResult,
): Promise<void> {
  repo.markChapterWritten(slug, index, summary, review, nowIso());
}

export async function updateChapterSummary(
  slug: string,
  index: number,
  summary: string,
): Promise<void> {
  const trimmed = summary.trim();
  if (!trimmed) return;
  repo.updateChapterSummary(slug, index, trimmed, nowIso());
}

export async function saveChapter(
  slug: string,
  index: number,
  content: string,
  title?: string,
): Promise<ChapterContent> {
  if (!Number.isInteger(index) || index < 1) throw new Error("章节序号不合法");

  const plan = repo.getPlan(slug);
  const chapter = plan.chapters.find((item) => item.index === index);
  if (!chapter) throw new Error(`第 ${index} 章不在当前大纲中`);

  const nextTitle = title && title.trim() ? title.trim() : chapter.title;
  await writeChapterFile(slug, index, content, {
    source: "user",
    title: nextTitle,
    summary: chapter.summary,
    note: "手动保存",
  });
  if (nextTitle !== chapter.title) {
    repo.updateChapterTitle(slug, index, nextTitle);
  }

  const state = repo.getState(slug);
  const summary = state.summaries[String(index)] ?? chapter.summary;
  if (content.trim()) {
    repo.setChapterWrittenState(slug, index, summary, nowIso());
  } else {
    repo.updateChapterSummary(slug, index, summary, nowIso());
  }

  const file = repo.getProjectFile(slug);
  const at = nowIso();
  repo.updateProjectFile({ ...file, meta: { ...file.meta, updatedAt: at } });

  return {
    index,
    title: nextTitle,
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
  repo.getProjectFile(slug);
  const target = projectFile(slug, "audit.md");
  await writeText(
    target,
    normalizeContent(content),
    projectBackup(slug, "audit.md"),
  );
  return path.relative(process.cwd(), target).split(path.sep).join("/");
}

export async function getAuditReport(slug: string): Promise<AuditReport> {
  repo.getProjectFile(slug);
  const target = projectFile(slug, "audit.md");
  try {
    const [content, stat] = await Promise.all([readTextStrict(target), fs.stat(target)]);
    return { content, updatedAt: stat.mtime.toISOString() };
  } catch (error) {
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

export async function appendPublishRecord(
  slug: string,
  record: PublishRecord,
): Promise<void> {
  repo.appendPublishRecord(slug, record, nowIso());
}

export async function clearPublishHistory(slug: string): Promise<void> {
  repo.clearPublishHistory(slug, nowIso());
}

export async function getPublishLedger(slug: string): Promise<PublishLedger> {
  repo.getProjectFile(slug);
  let ledger = repo.getPublishLedger(slug);
  if (!Object.keys(ledger.records).length) {
    const state = repo.getState(slug);
    const file = repo.getProjectFile(slug);
    const derived = derivePublishLedger(
      state.publishHistory ?? [],
      file.publish.fanqie.bookId,
      file.publish.fanqie.bookName,
    );
    if (Object.keys(derived.records).length) {
      repo.replacePublishLedger(slug, derived);
      ledger = derived;
    }
  }
  return ledger;
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
  repo.replacePublishLedger(slug, next);
}

export async function resolvePublishOutcome(
  slug: string,
  input: { bookId: string; bookName: string; chapter: number; published: boolean },
): Promise<PublishLedger> {
  const ledger = await getPublishLedger(slug);
  const next = input.published
    ? upsertPublishEntry(ledger, {
        platform: "fanqie",
        bookId: input.bookId.trim(),
        bookName: input.bookName.trim(),
        chapter: input.chapter,
        status: "published",
        at: nowIso(),
        message: "人工确认已发布",
      })
    : removePublishEntry(ledger, input.bookId, input.bookName, input.chapter);
  repo.replacePublishLedger(slug, next);
  return next;
}

export async function checkProjectIntegrity(slug: string): Promise<IntegrityReport> {
  let file: ProjectFile;
  let plan: ProjectPlan;
  let state: ProjectState;
  let canon: CanonFacts;
  try {
    file = repo.getProjectFile(slug);
    plan = repo.getPlan(slug);
    state = repo.getState(slug);
    canon = repo.getCanon(slug);
  } catch (error) {
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
    if (!chapter.title?.trim()) add("critical", "empty-title", `第 ${chapter.index} 章标题为空`);
    if (!chapter.summary?.trim()) add("warning", "empty-summary", `第 ${chapter.index} 章摘要为空`);
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
      const content = await readTextOptional(await chapterPath(slug, index));
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

export async function fixPlanOutlineConsistency(
  slug: string,
): Promise<FixPlanConsistencyResult> {
  const file = repo.getProjectFile(slug);
  const plan = repo.getPlan(slug);
  const outlinePath = projectFile(slug, "outline.md");
  const current = await readText(outlinePath);
  const missing = missingOutlineChapters(plan, current).sort(
    (a, b) => a.index - b.index,
  );

  if (missing.length) {
    const nextOutline = appendChapterOutline(current, missing);
    await commitProjectWrites(slug, [
      {
        filePath: outlinePath,
        content: textWithNewline(nextOutline),
        backupName: "outline.md",
      },
    ]);
    repo.updateProjectFile({ ...file, meta: { ...file.meta, updatedAt: nowIso() } });
  }

  return {
    fixedChapters: missing.map((chapter) => chapter.index),
    report: await checkProjectIntegrity(slug),
  };
}

export type {
  AuditReport,
  CommitArchitectureResult,
  CreateProjectInput,
  FanqieConfig,
  FixPlanConsistencyResult,
  IntegrityIssue,
  IntegrityReport,
  IntegritySeverity,
  ProjectDetail,
  SaveCharactersOptions,
  UpdateProjectPatch,
  WriteChapterOptions,
};
