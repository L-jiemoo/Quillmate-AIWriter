import { DEFAULT_FANQIE } from "../store-file";
import { emptyCanon, normalizeCanonFacts, normalizeReviewResult } from "../canon";
import {
  emptyMemory,
  normalizeChapterMemory,
  normalizeMemory,
  normalizeVolumeMemory,
} from "../memory";
import { emptyPlanLedger, normalizePlanLedger } from "../plan-ledger";
import { emptyStory, normalizeStory } from "../story";
import { PUBLISH_LEDGER_VERSION, publishLedgerKey } from "../publish-ledger";
import { StorageError } from "../storage";
import { DB_FILE } from "../storage-mode";
import { nowIso } from "../utils";
import type {
  CanonFacts,
  ChapterPlan,
  ChapterVersionMeta,
  ChapterVersionSource,
  Character,
  CharacterSource,
  PlanLedger,
  PublishLedger,
  PublishLedgerEntry,
  PublishLedgerStatus,
  PublishRecord,
  ProjectFile,
  ProjectMemory,
  ProjectPlan,
  ProjectState,
  RejectedDraft,
  ReviewResult,
  StoryLedger,
} from "../types";
import { getDatabase, withTransaction } from "./connection";

interface ProjectRow {
  slug: string;
  title: string;
  genre: string;
  tone: string;
  idea: string;
  author: string;
  language: string;
  target_chapters: number;
  words_per_chapter: number;
  logline: string;
  tags_json: string;
  fanqie_enabled: number;
  fanqie_book_id: string;
  fanqie_book_name: string;
  fanqie_auto_submit: number;
  fanqie_headless: number;
  fanqie_selectors_json: string;
  state_updated_at: string;
  created_at: string;
  updated_at: string;
}

interface ChapterRow {
  chapter_index: number;
  title: string;
  summary: string;
  key_beats_json: string;
}

interface ChapterStateRow {
  chapter_index: number;
  written: number;
  written_summary: string;
  content_path: string;
  content_hash: string | null;
  word_count: number;
  written_at: string | null;
  updated_at: string;
}

interface CharacterRow {
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
  speech_style: string;
  source: string | null;
  updated_at: string | null;
}

interface ReviewRow {
  id: number;
  chapter_index: number;
  summary: string;
  continuity_ok: number;
  repaired: number | null;
  repair_attempts: number | null;
  extraction_ok: number | null;
  extraction_error: string | null;
  extraction_attempts: number | null;
  updated_at: string;
}

interface IssueRow {
  review_id: number;
  severity: string;
  issue_type: string;
  evidence: string;
  detail: string;
}

interface VersionRow {
  chapter_index: number;
  version: number;
  created_at: string;
  source: string;
  title: string;
  summary: string;
  note: string | null;
  content_path: string;
  content_hash: string;
  word_count: number;
}

export interface ChapterStateRecord {
  index: number;
  written: boolean;
  summary: string;
  contentPath: string;
  contentHash: string | null;
  words: number;
  writtenAt: string | null;
  updatedAt: string;
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function rowToProjectFile(row: ProjectRow): ProjectFile {
  const selectors = parseJson<Record<string, string[]>>(row.fanqie_selectors_json, {});
  return {
    meta: {
      slug: row.slug,
      title: row.title,
      genre: row.genre,
      tone: row.tone,
      idea: row.idea,
      author: row.author,
      language: row.language,
      targetChapters: Number(row.target_chapters),
      wordsPerChapter: Number(row.words_per_chapter),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
    publish: {
      fanqie: {
        ...DEFAULT_FANQIE,
        enabled: row.fanqie_enabled !== 0,
        bookId: row.fanqie_book_id,
        bookName: row.fanqie_book_name,
        autoSubmit: row.fanqie_auto_submit !== 0,
        headless: row.fanqie_headless !== 0,
        selectors,
      },
    },
  };
}

function insertProjectRow(db = getDatabase(), file: ProjectFile): void {
  const { meta, publish } = file;
  db.prepare(
    `INSERT INTO projects (
      slug, title, genre, tone, idea, author, language, target_chapters, words_per_chapter,
      logline, tags_json, fanqie_enabled, fanqie_book_id, fanqie_book_name,
      fanqie_auto_submit, fanqie_headless, fanqie_selectors_json,
      state_updated_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    meta.slug,
    meta.title,
    meta.genre,
    meta.tone,
    meta.idea,
    meta.author,
    meta.language,
    meta.targetChapters,
    meta.wordsPerChapter,
    publish.fanqie.enabled ? 1 : 0,
    publish.fanqie.bookId,
    publish.fanqie.bookName,
    publish.fanqie.autoSubmit ? 1 : 0,
    publish.fanqie.headless ? 1 : 0,
    JSON.stringify(publish.fanqie.selectors ?? {}),
    meta.updatedAt,
    meta.createdAt,
    meta.updatedAt,
  );
}

export function updateProjectFile(file: ProjectFile): void {
  const db = getDatabase();
  const { meta, publish } = file;
  const result = db.prepare(
    `UPDATE projects SET
      title = ?, genre = ?, tone = ?, idea = ?, author = ?, language = ?,
      target_chapters = ?, words_per_chapter = ?, fanqie_enabled = ?,
      fanqie_book_id = ?, fanqie_book_name = ?, fanqie_auto_submit = ?,
      fanqie_headless = ?, fanqie_selectors_json = ?, updated_at = ?
    WHERE slug = ?`,
  ).run(
    meta.title,
    meta.genre,
    meta.tone,
    meta.idea,
    meta.author,
    meta.language,
    meta.targetChapters,
    meta.wordsPerChapter,
    publish.fanqie.enabled ? 1 : 0,
    publish.fanqie.bookId,
    publish.fanqie.bookName,
    publish.fanqie.autoSubmit ? 1 : 0,
    publish.fanqie.headless ? 1 : 0,
    JSON.stringify(publish.fanqie.selectors ?? {}),
    meta.updatedAt,
    meta.slug,
  );
  if (result.changes === 0) {
    throw new StorageError("not_found", DB_FILE, `项目 ${meta.slug} 不存在`);
  }
}

export function getProjectFile(slug: string): ProjectFile {
  const row = getDatabase()
    .prepare("SELECT * FROM projects WHERE slug = ?")
    .get(slug) as ProjectRow | undefined;
  if (!row) {
    throw new StorageError("not_found", DB_FILE, `项目 ${slug} 不存在`);
  }
  return rowToProjectFile(row);
}

export function listProjectFiles(): ProjectFile[] {
  const rows = getDatabase()
    .prepare("SELECT * FROM projects ORDER BY updated_at DESC")
    .all() as unknown as ProjectRow[];
  return rows.map(rowToProjectFile);
}

export function insertProject(file: ProjectFile): void {
  withTransaction((db) => insertProjectRow(db, file));
}

export function deleteProjectRow(slug: string): void {
  const db = getDatabase();
  const result = db.prepare("DELETE FROM projects WHERE slug = ?").run(slug);
  if (result.changes === 0) {
    throw new StorageError("not_found", DB_FILE, `项目 ${slug} 不存在`);
  }
}

export function touchProject(slug: string, at: string): void {
  const db = getDatabase();
  db.prepare("UPDATE projects SET updated_at = ? WHERE slug = ?").run(at, slug);
}

export function getPlan(slug: string): ProjectPlan {
  const db = getDatabase();
  const project = db
    .prepare("SELECT logline, tags_json FROM projects WHERE slug = ?")
    .get(slug) as { logline: string; tags_json: string } | undefined;
  if (!project) throw new StorageError("not_found", DB_FILE, `项目 ${slug} 不存在`);
  const rows = db
    .prepare(
      "SELECT chapter_index, title, summary, key_beats_json FROM chapters WHERE slug = ? ORDER BY chapter_index",
    )
    .all(slug) as unknown as ChapterRow[];
  return {
    logline: project.logline,
    tags: parseJson<string[]>(project.tags_json, []),
    chapters: rows.map((row) => ({
      index: Number(row.chapter_index),
      title: row.title,
      summary: row.summary,
      keyBeats: parseJson<string[]>(row.key_beats_json, []),
    })),
  };
}

export function getPlanLedger(slug: string): PlanLedger | null {
  const row = getDatabase()
    .prepare("SELECT data_json FROM plan_ledgers WHERE slug = ?")
    .get(slug) as { data_json: string } | undefined;
  if (!row) return null;
  return normalizePlanLedger(parseJson<unknown>(row.data_json, emptyPlanLedger()));
}

export function replacePlanLedger(slug: string, ledger: PlanLedger): void {
  const normalized = normalizePlanLedger(ledger);
  getDatabase()
    .prepare(
      `INSERT INTO plan_ledgers (slug, version, data_json, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET version = excluded.version,
         data_json = excluded.data_json, updated_at = excluded.updated_at`,
    )
    .run(slug, normalized.version, JSON.stringify(normalized), normalized.updatedAt);
}

function replacePlanLedgerInTransaction(
  db = getDatabase(),
  slug: string,
  ledger: PlanLedger,
): void {
  const normalized = normalizePlanLedger(ledger);
  db.prepare(
    `INSERT INTO plan_ledgers (slug, version, data_json, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET version = excluded.version,
       data_json = excluded.data_json, updated_at = excluded.updated_at`,
  ).run(slug, normalized.version, JSON.stringify(normalized), normalized.updatedAt);
}

function replacePlanInTransaction(
  db = getDatabase(),
  slug: string,
  plan: ProjectPlan,
  file: ProjectFile,
): void {
  db.prepare("DELETE FROM chapters WHERE slug = ?").run(slug);
  const insert = db.prepare(
    "INSERT INTO chapters (slug, chapter_index, title, summary, key_beats_json) VALUES (?, ?, ?, ?, ?)",
  );
  for (const chapter of plan.chapters) {
    insert.run(
      slug,
      chapter.index,
      chapter.title,
      chapter.summary,
      JSON.stringify(chapter.keyBeats ?? []),
    );
  }
  db.prepare(
    "UPDATE projects SET logline = ?, tags_json = ?, target_chapters = ?, updated_at = ? WHERE slug = ?",
  ).run(
    plan.logline,
    JSON.stringify(plan.tags ?? []),
    plan.chapters.length,
    file.meta.updatedAt,
    slug,
  );
  updateProjectFile(file);
}

export function replacePlan(slug: string, plan: ProjectPlan, file: ProjectFile): void {
  withTransaction((db) => replacePlanInTransaction(db, slug, plan, file));
}

export function appendPlanChapters(
  slug: string,
  chapters: ChapterPlan[],
  file: ProjectFile,
  planLedger?: PlanLedger,
): void {
  withTransaction((db) => {
    const insert = db.prepare(
      "INSERT INTO chapters (slug, chapter_index, title, summary, key_beats_json) VALUES (?, ?, ?, ?, ?)",
    );
    for (const chapter of chapters) {
      insert.run(
        slug,
        chapter.index,
        chapter.title,
        chapter.summary,
        JSON.stringify(chapter.keyBeats ?? []),
      );
    }
    db.prepare(
      "UPDATE projects SET target_chapters = ?, updated_at = ? WHERE slug = ?",
    ).run(file.meta.targetChapters, file.meta.updatedAt, slug);
    updateProjectFile(file);
    if (planLedger) replacePlanLedgerInTransaction(db, slug, planLedger);
  });
}

export function updateChapterTitle(slug: string, index: number, title: string): void {
  getDatabase()
    .prepare("UPDATE chapters SET title = ? WHERE slug = ? AND chapter_index = ?")
    .run(title, slug, index);
}

export function getCharacters(slug: string): Character[] {
  const rows = getDatabase()
    .prepare("SELECT * FROM characters WHERE slug = ? ORDER BY id")
    .all(slug) as unknown as CharacterRow[];
  return rows.map((row) => {
    const character: Character = {
      name: row.name,
      role: row.role,
      gender: row.gender,
      age: row.age,
      appearance: row.appearance,
      personality: row.personality,
      background: row.background,
      goals: row.goals,
      arc: row.arc,
      relationships: row.relationships,
      speechStyle: row.speech_style,
    };
    if (row.source === "ai" || row.source === "user" || row.source === "system") {
      character.source = row.source as CharacterSource;
    }
    if (row.updated_at) character.updatedAt = row.updated_at;
    return character;
  });
}

function replaceCharactersInTransaction(
  db = getDatabase(),
  slug: string,
  characters: Character[],
): void {
  db.prepare("DELETE FROM characters WHERE slug = ?").run(slug);
  const insert = db.prepare(
    `INSERT INTO characters (
      slug, name, role, gender, age, appearance, personality, background,
      goals, arc, relationships, speech_style, source, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const character of characters) {
    insert.run(
      slug,
      character.name,
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
      character.source ?? null,
      character.updatedAt ?? null,
    );
  }
}

export function replaceCharacters(slug: string, characters: Character[]): void {
  withTransaction((db) => replaceCharactersInTransaction(db, slug, characters));
}

export function commitArchitecture(
  slug: string,
  plan: ProjectPlan,
  characters: Character[],
  file: ProjectFile,
  canon?: CanonFacts,
  planLedger?: PlanLedger,
): void {
  withTransaction((db) => {
    replacePlanInTransaction(db, slug, plan, file);
    replaceCharactersInTransaction(db, slug, characters);
    if (canon) replaceCanonInTransaction(db, slug, canon);
    if (planLedger) replacePlanLedgerInTransaction(db, slug, planLedger);
    updateProjectFile(file);
  });
}

export function getCanon(slug: string): CanonFacts {
  const db = getDatabase();
  const meta = db
    .prepare("SELECT * FROM canon_meta WHERE slug = ?")
    .get(slug) as
    | {
        current_day: string;
        last_chapter: number;
        updated_at: string;
        base_facts_json: string;
      }
    | undefined;
  if (!meta) return emptyCanon();

  const characters = db
    .prepare("SELECT * FROM canon_characters WHERE slug = ? ORDER BY id")
    .all(slug) as unknown as Array<{
    name: string;
    aliases_json: string;
    status: string;
    location: string;
    note: string;
    status_chapter: number;
    chapter: number;
  }>;
  const items = db
    .prepare("SELECT * FROM canon_items WHERE slug = ? ORDER BY id")
    .all(slug) as unknown as Array<{
    name: string;
    aliases_json: string;
    holder: string;
    location: string;
    state: string;
    note: string;
    chapter: number;
  }>;
  const deadlines = db
    .prepare("SELECT * FROM canon_deadlines WHERE slug = ? ORDER BY id")
    .all(slug) as unknown as Array<{
    name: string;
    due: string;
    note: string;
    chapter: number;
  }>;
  const rules = db
    .prepare("SELECT rule FROM canon_rules WHERE slug = ? ORDER BY id")
    .all(slug) as unknown as Array<{ rule: string }>;

  const facts = normalizeCanonFacts(
    parseJson<unknown[]>(meta.base_facts_json ?? "[]", []),
  );
  return {
    characters: characters.map((row) => ({
      name: row.name,
      aliases: parseJson<string[]>(row.aliases_json, []),
      status: row.status === "alive" || row.status === "dead" ? row.status : "unknown",
      location: row.location,
      note: row.note,
      statusChapter: Number(row.status_chapter),
      chapter: Number(row.chapter),
    })),
    items: items.map((row) => ({
      name: row.name,
      aliases: parseJson<string[]>(row.aliases_json, []),
      holder: row.holder,
      location: row.location,
      state: row.state,
      note: row.note,
      chapter: Number(row.chapter),
    })),
    timeline: {
      currentDay: meta.current_day,
      deadlines: deadlines.map((row) => ({
        name: row.name,
        due: row.due,
        note: row.note,
        chapter: Number(row.chapter),
      })),
    },
    rules: rules.map((row) => row.rule),
    ...(facts.length ? { facts } : {}),
    lastChapter: Number(meta.last_chapter),
    updatedAt: meta.updated_at,
  };
}

function replaceCanonInTransaction(db = getDatabase(), slug: string, canon: CanonFacts): void {
  for (const table of [
    "canon_characters",
    "canon_items",
    "canon_deadlines",
    "canon_rules",
    "canon_meta",
  ]) {
    db.prepare(`DELETE FROM ${table} WHERE slug = ?`).run(slug);
  }

  const characterInsert = db.prepare(
    `INSERT INTO canon_characters (
      slug, name, aliases_json, status, location, note, status_chapter, chapter
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const item of canon.characters) {
    characterInsert.run(
      slug,
      item.name,
      JSON.stringify(item.aliases ?? []),
      item.status,
      item.location,
      item.note,
      item.statusChapter,
      item.chapter,
    );
  }

  const itemInsert = db.prepare(
    `INSERT INTO canon_items (
      slug, name, aliases_json, holder, location, state, note, chapter
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const item of canon.items) {
    itemInsert.run(
      slug,
      item.name,
      JSON.stringify(item.aliases ?? []),
      item.holder,
      item.location ?? "",
      item.state,
      item.note,
      item.chapter,
    );
  }

  const deadlineInsert = db.prepare(
    "INSERT INTO canon_deadlines (slug, name, due, note, chapter) VALUES (?, ?, ?, ?, ?)",
  );
  for (const item of canon.timeline.deadlines) {
    deadlineInsert.run(slug, item.name, item.due, item.note, item.chapter);
  }

  const ruleInsert = db.prepare("INSERT INTO canon_rules (slug, rule) VALUES (?, ?)");
  for (const rule of canon.rules) ruleInsert.run(slug, rule);

  db.prepare(
    "INSERT INTO canon_meta (slug, current_day, last_chapter, updated_at, base_facts_json) VALUES (?, ?, ?, ?, ?)",
  ).run(
    slug,
    canon.timeline.currentDay,
    canon.lastChapter,
    canon.updatedAt,
    JSON.stringify(canon.facts ?? []),
  );
  db.prepare("UPDATE projects SET updated_at = ? WHERE slug = ?").run(
    canon.updatedAt,
    slug,
  );
}

export function replaceCanon(slug: string, canon: CanonFacts): void {
  withTransaction((db) => replaceCanonInTransaction(db, slug, canon));
}

interface MemoryJsonRow {
  data_json: string;
  updated_at: string;
}

export function getMemory(slug: string): ProjectMemory {
  const db = getDatabase();
  const bookRow = db
    .prepare("SELECT data_json, updated_at FROM book_memory WHERE slug = ?")
    .get(slug) as MemoryJsonRow | undefined;
  const volumeRows = db
    .prepare(
      "SELECT data_json, updated_at FROM volume_memories WHERE slug = ? ORDER BY start_chapter, end_chapter",
    )
    .all(slug) as unknown as MemoryJsonRow[];
  const chapterRows = db
    .prepare(
      "SELECT data_json, updated_at FROM chapter_memories WHERE slug = ? ORDER BY chapter_index",
    )
    .all(slug) as unknown as MemoryJsonRow[];

  if (!bookRow && !volumeRows.length && !chapterRows.length) {
    const project = db
      .prepare("SELECT state_updated_at FROM projects WHERE slug = ?")
      .get(slug) as { state_updated_at: string } | undefined;
    return emptyMemory(project?.state_updated_at ?? nowIso());
  }

  const chapters: Record<string, ReturnType<typeof normalizeChapterMemory>> = {};
  let latest = "";
  for (const row of chapterRows) {
    try {
      const parsed = JSON.parse(row.data_json) as unknown;
      const memory = normalizeChapterMemory(parsed);
      if (memory) chapters[String(memory.index)] = memory;
      if (row.updated_at > latest) latest = row.updated_at;
    } catch (error) {
      throw new Error(`长期记忆数据损坏（第 ${row.updated_at} 行）：${String(error)}`);
    }
  }

  const volumes = volumeRows
    .map((row) => {
      try {
        return normalizeVolumeMemory(JSON.parse(row.data_json) as unknown);
      } catch (error) {
        throw new Error(`分卷记忆数据损坏（第 ${row.updated_at} 行）：${String(error)}`);
      }
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  let book: unknown = undefined;
  if (bookRow) {
    try {
      book = JSON.parse(bookRow.data_json) as unknown;
      if (bookRow.updated_at > latest) latest = bookRow.updated_at;
    } catch (error) {
      throw new Error(`全书记忆数据损坏：${String(error)}`);
    }
  }

  return normalizeMemory({
    version: 1,
    book,
    volumes,
    chapters,
    updatedAt: latest || nowIso(),
  });
}

function replaceMemoryInTransaction(
  db = getDatabase(),
  slug: string,
  memory: ProjectMemory,
): void {
  db.prepare("DELETE FROM chapter_memories WHERE slug = ?").run(slug);
  db.prepare("DELETE FROM volume_memories WHERE slug = ?").run(slug);
  db.prepare("DELETE FROM book_memory WHERE slug = ?").run(slug);

  db.prepare(
    "INSERT INTO book_memory (slug, data_json, updated_at) VALUES (?, ?, ?)",
  ).run(slug, JSON.stringify(memory.book), memory.updatedAt);
  const volumeInsert = db.prepare(
    `INSERT INTO volume_memories (
      slug, volume_id, start_chapter, end_chapter, data_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const volume of memory.volumes) {
    volumeInsert.run(
      slug,
      volume.id,
      volume.startChapter,
      volume.endChapter,
      JSON.stringify(volume),
      volume.updatedAt,
    );
  }
  const chapterInsert = db.prepare(
    "INSERT INTO chapter_memories (slug, chapter_index, data_json, updated_at) VALUES (?, ?, ?, ?)",
  );
  for (const chapter of Object.values(memory.chapters)) {
    chapterInsert.run(
      slug,
      chapter.index,
      JSON.stringify(chapter),
      chapter.updatedAt,
    );
  }
}

export function replaceMemory(slug: string, memory: ProjectMemory): void {
  withTransaction((db) => replaceMemoryInTransaction(db, slug, memory));
}

interface StoryJsonRow {
  data_json: string;
  updated_at: string;
}

export function getStory(slug: string): StoryLedger {
  const db = getDatabase();
  const meta = db
    .prepare("SELECT updated_at, suppressed_json FROM story_meta WHERE slug = ?")
    .get(slug) as { updated_at: string; suppressed_json: string } | undefined;
  const stateRows = db
    .prepare("SELECT data_json, updated_at FROM story_character_states WHERE slug = ? ORDER BY chapter_index, character_name")
    .all(slug) as unknown as StoryJsonRow[];
  const relationRows = db
    .prepare("SELECT data_json, updated_at FROM story_relations WHERE slug = ? ORDER BY chapter_index")
    .all(slug) as unknown as StoryJsonRow[];
  const eventRows = db
    .prepare("SELECT data_json, updated_at FROM story_events WHERE slug = ? ORDER BY chapter_index")
    .all(slug) as unknown as StoryJsonRow[];
  const foreshadowRows = db
    .prepare("SELECT data_json, updated_at FROM story_foreshadows WHERE slug = ? ORDER BY planted_chapter")
    .all(slug) as unknown as StoryJsonRow[];

  if (
    !meta &&
    !stateRows.length &&
    !relationRows.length &&
    !eventRows.length &&
    !foreshadowRows.length
  ) {
    const project = db
      .prepare("SELECT state_updated_at FROM projects WHERE slug = ?")
      .get(slug) as { state_updated_at: string } | undefined;
    return emptyStory(project?.state_updated_at ?? nowIso());
  }

  const parseRows = (rows: StoryJsonRow[], label: string): unknown[] => {
    return rows.map((row) => {
      try {
        return JSON.parse(row.data_json) as unknown;
      } catch (error) {
        throw new Error(`${label}数据损坏（${row.updated_at}）：${String(error)}`);
      }
    });
  };

  return normalizeStory({
    version: 1,
    states: parseRows(stateRows, "人物状态"),
    relations: parseRows(relationRows, "人物关系"),
    events: parseRows(eventRows, "剧情事件"),
    foreshadows: parseRows(foreshadowRows, "伏笔记录"),
    suppressedIds: parseJson<string[]>(meta?.suppressed_json, []),
    updatedAt: meta?.updated_at ?? nowIso(),
  });
}

function replaceStoryInTransaction(
  db = getDatabase(),
  slug: string,
  story: StoryLedger,
): void {
  for (const table of [
    "story_character_states",
    "story_relations",
    "story_events",
    "story_foreshadows",
    "story_meta",
  ]) {
    db.prepare(`DELETE FROM ${table} WHERE slug = ?`).run(slug);
  }

  const stateInsert = db.prepare(
    `INSERT INTO story_character_states (
      slug, state_id, chapter_index, character_name, data_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const state of story.states) {
    stateInsert.run(
      slug,
      state.id,
      state.chapter,
      state.name,
      JSON.stringify(state),
      state.updatedAt,
    );
  }

  const relationInsert = db.prepare(
    `INSERT INTO story_relations (
      slug, relation_id, chapter_index, from_name, to_name, data_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const relation of story.relations) {
    relationInsert.run(
      slug,
      relation.id,
      relation.chapter,
      relation.from,
      relation.to,
      JSON.stringify(relation),
      relation.updatedAt,
    );
  }

  const eventInsert = db.prepare(
    `INSERT INTO story_events (
      slug, event_id, chapter_index, name, data_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const event of story.events) {
    eventInsert.run(
      slug,
      event.id,
      event.chapter,
      event.name,
      JSON.stringify(event),
      event.updatedAt,
    );
  }

  const foreshadowInsert = db.prepare(
    `INSERT INTO story_foreshadows (
      slug, foreshadow_id, planted_chapter, status, data_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const foreshadow of story.foreshadows) {
    foreshadowInsert.run(
      slug,
      foreshadow.id,
      foreshadow.plantedChapter,
      foreshadow.status,
      JSON.stringify(foreshadow),
      foreshadow.updatedAt,
    );
  }

  db.prepare(
    "INSERT INTO story_meta (slug, updated_at, suppressed_json) VALUES (?, ?, ?)",
  ).run(slug, story.updatedAt, JSON.stringify(story.suppressedIds ?? []));
}

export function replaceStory(slug: string, story: StoryLedger): void {
  withTransaction((db) => replaceStoryInTransaction(db, slug, story));
}

export function commitCanonRebuild(
  slug: string,
  canon: CanonFacts,
  summaries: Record<string, string>,
): void {
  withTransaction((db) => {
    const updateState = db.prepare(
      "UPDATE chapter_states SET written_summary = ?, updated_at = ? WHERE slug = ? AND chapter_index = ?",
    );
    const updateReview = db.prepare(
      "UPDATE reviews SET summary = ?, updated_at = ? WHERE slug = ? AND chapter_index = ?",
    );
    for (const [key, summary] of Object.entries(summaries)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 1 || !summary.trim()) continue;
      updateState.run(summary, nowIso(), slug, index);
      updateReview.run(summary, nowIso(), slug, index);
    }
    replaceCanonInTransaction(db, slug, canon);
  });
}

function getChapterStateRows(slug: string): ChapterStateRow[] {
  return getDatabase()
    .prepare("SELECT * FROM chapter_states WHERE slug = ? ORDER BY chapter_index")
    .all(slug) as unknown as ChapterStateRow[];
}

export function getChapterStates(slug: string): Map<number, ChapterStateRecord> {
  const result = new Map<number, ChapterStateRecord>();
  for (const row of getChapterStateRows(slug)) {
    result.set(Number(row.chapter_index), {
      index: Number(row.chapter_index),
      written: row.written !== 0,
      summary: row.written_summary,
      contentPath: row.content_path,
      contentHash: row.content_hash,
      words: Number(row.word_count),
      writtenAt: row.written_at,
      updatedAt: row.updated_at,
    });
  }
  return result;
}

export function getChapterState(
  slug: string,
  index: number,
): ChapterStateRecord | null {
  return getChapterStates(slug).get(index) ?? null;
}

function readReviews(db = getDatabase(), slug: string): Record<string, ReviewResult> {
  const rows = db
    .prepare("SELECT * FROM reviews WHERE slug = ? ORDER BY chapter_index")
    .all(slug) as unknown as ReviewRow[];
  if (!rows.length) return {};
  const issues = db
    .prepare(
      `SELECT i.review_id, i.severity, i.issue_type, i.evidence, i.detail
       FROM review_issues i
       JOIN reviews r ON r.id = i.review_id
       WHERE r.slug = ?
       ORDER BY i.review_id, i.position`,
    )
    .all(slug) as unknown as IssueRow[];
  const byReview = new Map<number, IssueRow[]>();
  for (const issue of issues) {
    const list = byReview.get(issue.review_id) ?? [];
    list.push(issue);
    byReview.set(issue.review_id, list);
  }

  const result: Record<string, ReviewResult> = {};
  for (const row of rows) {
    const review: ReviewResult = {
      summary: row.summary,
      issues: (byReview.get(row.id) ?? []).map((issue) => ({
        severity:
          issue.severity === "critical" || issue.severity === "ignore"
            ? issue.severity
            : "warning",
        type: issue.issue_type,
        evidence: issue.evidence,
        detail: issue.detail,
      })),
      continuityOk: row.continuity_ok !== 0,
    };
    if (row.repaired !== null) review.repaired = row.repaired !== 0;
    if (row.repair_attempts !== null) review.repairAttempts = Number(row.repair_attempts);
    if (row.extraction_ok !== null) review.extractionOk = row.extraction_ok !== 0;
    if (row.extraction_error) review.extractionError = row.extraction_error;
    if (row.extraction_attempts !== null) {
      review.extractionAttempts = Number(row.extraction_attempts);
    }
    result[String(row.chapter_index)] = review;
  }
  return result;
}

function readRejectedDrafts(
  db = getDatabase(),
  slug: string,
  summaries: Record<string, string>,
): Record<string, RejectedDraft> {
  const rows = db
    .prepare("SELECT * FROM rejected_drafts WHERE slug = ? ORDER BY chapter_index")
    .all(slug) as unknown as Array<{
    chapter_index: number;
    at: string;
    path: string;
    mode: string;
    reason: string;
    review_json: string;
  }>;
  const result: Record<string, RejectedDraft> = {};
  for (const row of rows) {
    const index = Number(row.chapter_index);
    const parsed = parseJson<Record<string, unknown>>(row.review_json, {});
    result[String(index)] = {
      index,
      at: row.at,
      path: row.path,
      mode: row.mode === "rewrite" ? "rewrite" : "write",
      reason: row.reason,
      review: normalizeReviewResult(parsed, summaries[String(index)] ?? ""),
    };
  }
  return result;
}

function readRepairs(db = getDatabase(), slug: string): Record<string, string> {
  const rows = db
    .prepare("SELECT chapter_index, repaired_at FROM chapter_repairs WHERE slug = ?")
    .all(slug) as unknown as Array<{ chapter_index: number; repaired_at: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) result[String(row.chapter_index)] = row.repaired_at;
  return result;
}

export function getPublishHistory(slug: string): PublishRecord[] {
  const rows = getDatabase()
    .prepare("SELECT * FROM publish_records WHERE slug = ? ORDER BY id")
    .all(slug) as unknown as Array<{
    platform: string;
    at: string;
    status: string;
    mode: string | null;
    message: string;
    chapters_json: string;
  }>;
  return rows.map((row) => ({
    platform: row.platform === "fanqie" ? "fanqie" : "export",
    at: row.at,
    chapters: parseJson<number[]>(row.chapters_json, []),
    status: row.status === "success" ? "success" : "failed",
    ...(row.mode === "publish" || row.mode === "draft" ? { mode: row.mode } : {}),
    message: row.message,
  }));
}

export function getState(slug: string): ProjectState {
  const db = getDatabase();
  const project = db
    .prepare("SELECT state_updated_at FROM projects WHERE slug = ?")
    .get(slug) as { state_updated_at: string } | undefined;
  if (!project) throw new StorageError("not_found", DB_FILE, `项目 ${slug} 不存在`);

  const states = getChapterStateRows(slug);
  const summaries: Record<string, string> = {};
  for (const row of states) {
    if (row.written_summary) summaries[String(row.chapter_index)] = row.written_summary;
  }

  return {
    written: states
      .filter((row) => row.written !== 0)
      .map((row) => Number(row.chapter_index))
      .sort((a, b) => a - b),
    summaries,
    reviews: readReviews(db, slug),
    rejectedDrafts: readRejectedDrafts(db, slug, summaries),
    repairs: readRepairs(db, slug),
    publishHistory: getPublishHistory(slug),
    updatedAt: project.state_updated_at,
  };
}

function upsertChapterStateInTransaction(
  db = getDatabase(),
  slug: string,
  index: number,
  patch: {
    written?: boolean;
    summary?: string;
    contentPath?: string;
    contentHash?: string | null;
    words?: number;
    writtenAt?: string | null;
    updatedAt: string;
  },
): void {
  const existing = db
    .prepare("SELECT * FROM chapter_states WHERE slug = ? AND chapter_index = ?")
    .get(slug, index) as ChapterStateRow | undefined;

  if (!existing) {
    db.prepare(
      `INSERT INTO chapter_states (
        slug, chapter_index, written, written_summary, content_path, content_hash,
        word_count, written_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      slug,
      index,
      patch.written ? 1 : 0,
      patch.summary ?? "",
      patch.contentPath ?? "",
      patch.contentHash ?? null,
      patch.words ?? 0,
      patch.writtenAt ?? null,
      patch.updatedAt,
    );
    return;
  }

  db.prepare(
    `UPDATE chapter_states SET
      written = ?, written_summary = ?, content_path = ?, content_hash = ?,
      word_count = ?, written_at = ?, updated_at = ?
    WHERE slug = ? AND chapter_index = ?`,
  ).run(
    patch.written === undefined ? existing.written : patch.written ? 1 : 0,
    patch.summary ?? existing.written_summary,
    patch.contentPath ?? existing.content_path,
    patch.contentHash === undefined ? existing.content_hash : patch.contentHash,
    patch.words ?? existing.word_count,
    patch.writtenAt === undefined ? existing.written_at : patch.writtenAt,
    patch.updatedAt,
    slug,
    index,
  );
}

function saveReviewInTransaction(
  db = getDatabase(),
  slug: string,
  index: number,
  review: ReviewResult,
  at: string,
): void {
  db.prepare(
    `INSERT INTO reviews (
      slug, chapter_index, summary, continuity_ok, repaired, repair_attempts,
      extraction_ok, extraction_error, extraction_attempts, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(slug, chapter_index) DO UPDATE SET
      summary = excluded.summary,
      continuity_ok = excluded.continuity_ok,
      repaired = excluded.repaired,
      repair_attempts = excluded.repair_attempts,
      extraction_ok = excluded.extraction_ok,
      extraction_error = excluded.extraction_error,
      extraction_attempts = excluded.extraction_attempts,
      updated_at = excluded.updated_at`,
  ).run(
    slug,
    index,
    review.summary,
    review.continuityOk ? 1 : 0,
    review.repaired === undefined ? null : review.repaired ? 1 : 0,
    review.repairAttempts ?? null,
    review.extractionOk === undefined ? null : review.extractionOk ? 1 : 0,
    review.extractionError ?? null,
    review.extractionAttempts ?? null,
    at,
  );

  const row = db
    .prepare("SELECT id FROM reviews WHERE slug = ? AND chapter_index = ?")
    .get(slug, index) as { id: number };
  db.prepare("DELETE FROM review_issues WHERE review_id = ?").run(row.id);
  const insert = db.prepare(
    `INSERT INTO review_issues (
      review_id, position, severity, issue_type, evidence, detail
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  review.issues.forEach((issue, position) => {
    insert.run(row.id, position, issue.severity, issue.type, issue.evidence, issue.detail);
  });
}

export function markChapterWritten(
  slug: string,
  index: number,
  summary: string,
  review: ReviewResult,
  at: string,
): void {
  withTransaction((db) => {
    upsertChapterStateInTransaction(db, slug, index, {
      written: true,
      summary,
      writtenAt: at,
      updatedAt: at,
    });
    saveReviewInTransaction(db, slug, index, review, at);
    db.prepare("DELETE FROM rejected_drafts WHERE slug = ? AND chapter_index = ?").run(
      slug,
      index,
    );
    db.prepare(
      "UPDATE projects SET state_updated_at = ?, updated_at = ? WHERE slug = ?",
    ).run(at, at, slug);
  });
}

export function updateChapterSummary(
  slug: string,
  index: number,
  summary: string,
  at: string,
): void {
  withTransaction((db) => {
    upsertChapterStateInTransaction(db, slug, index, {
      summary,
      updatedAt: at,
    });
    db.prepare(
      "UPDATE reviews SET summary = ?, updated_at = ? WHERE slug = ? AND chapter_index = ?",
    ).run(summary, at, slug, index);
    db.prepare("UPDATE projects SET state_updated_at = ? WHERE slug = ?").run(at, slug);
  });
}

export function saveRejectedDraft(slug: string, record: RejectedDraft, at: string): void {
  withTransaction((db) => {
    db.prepare(
      `INSERT INTO rejected_drafts (
        slug, chapter_index, at, path, mode, reason, review_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(slug, chapter_index) DO UPDATE SET
        at = excluded.at, path = excluded.path, mode = excluded.mode,
        reason = excluded.reason, review_json = excluded.review_json`,
    ).run(
      slug,
      record.index,
      record.at,
      record.path,
      record.mode,
      record.reason,
      JSON.stringify(record.review),
    );
    db.prepare("UPDATE projects SET state_updated_at = ? WHERE slug = ?").run(at, slug);
  });
}

export function deleteRejectedDraft(slug: string, index: number, at: string): void {
  withTransaction((db) => {
    db.prepare("DELETE FROM rejected_drafts WHERE slug = ? AND chapter_index = ?").run(
      slug,
      index,
    );
    db.prepare("UPDATE projects SET state_updated_at = ? WHERE slug = ?").run(at, slug);
  });
}

export function markChapterRepaired(slug: string, index: number, at: string): void {
  withTransaction((db) => {
    db.prepare(
      `INSERT INTO chapter_repairs (slug, chapter_index, repaired_at) VALUES (?, ?, ?)
       ON CONFLICT(slug, chapter_index) DO UPDATE SET repaired_at = excluded.repaired_at`,
    ).run(slug, index, at);
    db.prepare("UPDATE projects SET state_updated_at = ? WHERE slug = ?").run(at, slug);
  });
}

export function clearChapterAnnotations(slug: string, index: number, at: string): void {
  withTransaction((db) => {
    const review = db
      .prepare("SELECT id FROM reviews WHERE slug = ? AND chapter_index = ?")
      .get(slug, index) as { id: number } | undefined;
    if (review) db.prepare("DELETE FROM reviews WHERE id = ?").run(review.id);
    db.prepare("DELETE FROM chapter_repairs WHERE slug = ? AND chapter_index = ?").run(
      slug,
      index,
    );
    db.prepare("DELETE FROM rejected_drafts WHERE slug = ? AND chapter_index = ?").run(
      slug,
      index,
    );
    db.prepare("UPDATE projects SET state_updated_at = ? WHERE slug = ?").run(at, slug);
  });
}

export function setChapterWrittenState(
  slug: string,
  index: number,
  summary: string,
  at: string,
): void {
  withTransaction((db) => {
    upsertChapterStateInTransaction(db, slug, index, {
      written: true,
      summary,
      writtenAt: at,
      updatedAt: at,
    });
    db.prepare("DELETE FROM rejected_drafts WHERE slug = ? AND chapter_index = ?").run(
      slug,
      index,
    );
    db.prepare("UPDATE projects SET state_updated_at = ? WHERE slug = ?").run(at, slug);
  });
}

export function updateChapterContentMeta(
  slug: string,
  index: number,
  contentPath: string,
  contentHash: string,
  words: number,
  at: string,
): void {
  withTransaction((db) => {
    upsertChapterStateInTransaction(db, slug, index, {
      contentPath,
      contentHash,
      words,
      updatedAt: at,
    });
  });
}

export function listChapterVersions(
  slug: string,
  index: number,
): ChapterVersionMeta[] {
  const rows = getDatabase()
    .prepare(
      `SELECT chapter_index, version, created_at, source, title, summary, note, content_path,
        content_hash, word_count
       FROM chapter_versions WHERE slug = ? AND chapter_index = ? ORDER BY version`,
    )
    .all(slug, index) as unknown as VersionRow[];
  return rows.map((row) => ({
    index: Number(row.chapter_index),
    version: Number(row.version),
    createdAt: row.created_at,
    source: row.source as ChapterVersionSource,
    title: row.title,
    summary: row.summary,
    words: Number(row.word_count),
    ...(row.note ? { note: row.note } : {}),
  }));
}

export interface StoredChapterVersion extends ChapterVersionMeta {
  contentPath: string;
  contentHash: string;
}

export function getChapterVersionMeta(
  slug: string,
  index: number,
  version: number,
): StoredChapterVersion | null {
  const row = getDatabase()
    .prepare(
      `SELECT chapter_index, version, created_at, source, title, summary, note,
        content_path, content_hash, word_count
       FROM chapter_versions WHERE slug = ? AND chapter_index = ? AND version = ?`,
    )
    .get(slug, index, version) as VersionRow | undefined;
  if (!row) return null;
  return {
    index: Number(row.chapter_index),
    version: Number(row.version),
    createdAt: row.created_at,
    source: row.source as ChapterVersionSource,
    title: row.title,
    summary: row.summary,
    words: Number(row.word_count),
    ...(row.note ? { note: row.note } : {}),
    contentPath: row.content_path,
    contentHash: row.content_hash,
  };
}

export function nextChapterVersionNumber(slug: string, index: number): number {
  const row = getDatabase()
    .prepare(
      "SELECT MAX(version) AS version FROM chapter_versions WHERE slug = ? AND chapter_index = ?",
    )
    .get(slug, index) as { version?: number | null } | undefined;
  return Number(row?.version ?? 0) + 1;
}

export function insertChapterVersion(
  slug: string,
  index: number,
  input: {
    version: number;
    createdAt: string;
    source: ChapterVersionSource;
    title: string;
    summary: string;
    note?: string;
    contentPath: string;
    contentHash: string;
    previousHash: string | null;
    words: number;
  },
): void {
  getDatabase()
    .prepare(
      `INSERT INTO chapter_versions (
        slug, chapter_index, version, created_at, source, title, summary, note,
        content_path, content_hash, previous_hash, word_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      slug,
      index,
      input.version,
      input.createdAt,
      input.source,
      input.title,
      input.summary,
      input.note ?? null,
      input.contentPath,
      input.contentHash,
      input.previousHash,
      input.words,
    );
}

export function deleteChapterVersion(
  slug: string,
  index: number,
  version: number,
): void {
  getDatabase()
    .prepare(
      "DELETE FROM chapter_versions WHERE slug = ? AND chapter_index = ? AND version = ?",
    )
    .run(slug, index, version);
}

export function appendPublishRecord(slug: string, record: PublishRecord, at: string): void {
  withTransaction((db) => {
    db.prepare(
      `INSERT INTO publish_records (
        slug, platform, at, status, mode, message, chapters_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      slug,
      record.platform,
      record.at,
      record.status,
      record.mode ?? null,
      record.message,
      JSON.stringify(record.chapters),
    );
    db.prepare(
      `DELETE FROM publish_records WHERE slug = ? AND id NOT IN (
        SELECT id FROM publish_records WHERE slug = ? ORDER BY id DESC LIMIT 100
      )`,
    ).run(slug, slug);
    db.prepare("UPDATE projects SET state_updated_at = ? WHERE slug = ?").run(at, slug);
  });
}

export function clearPublishHistory(slug: string, at: string): void {
  withTransaction((db) => {
    db.prepare("DELETE FROM publish_records WHERE slug = ?").run(slug);
    db.prepare("UPDATE projects SET state_updated_at = ? WHERE slug = ?").run(at, slug);
  });
}

export function getPublishLedger(slug: string): PublishLedger {
  const db = getDatabase();
  const meta = db
    .prepare("SELECT updated_at FROM publish_ledger_meta WHERE slug = ?")
    .get(slug) as { updated_at: string } | undefined;
  const rows = db
    .prepare("SELECT * FROM publish_ledger WHERE slug = ? ORDER BY id")
    .all(slug) as unknown as Array<{
    platform: string;
    book_id: string;
    book_name: string;
    chapter_index: number;
    status: string;
    at: string;
    job_id: string | null;
    message: string | null;
  }>;
  const records: Record<string, PublishLedgerEntry> = {};
  for (const row of rows) {
    const entry: PublishLedgerEntry = {
      platform: "fanqie",
      bookId: row.book_id,
      bookName: row.book_name,
      chapter: Number(row.chapter_index),
      status: row.status as PublishLedgerStatus,
      at: row.at,
      ...(row.job_id ? { jobId: row.job_id } : {}),
      ...(row.message ? { message: row.message } : {}),
    };
    records[publishLedgerKey(entry.bookId, entry.bookName, entry.chapter)] = entry;
  }
  return {
    version: PUBLISH_LEDGER_VERSION,
    records,
    updatedAt: meta?.updated_at ?? nowIso(),
  };
}

export function replacePublishLedger(slug: string, ledger: PublishLedger): void {
  withTransaction((db) => {
    db.prepare("DELETE FROM publish_ledger WHERE slug = ?").run(slug);
    const insert = db.prepare(
      `INSERT INTO publish_ledger (
        slug, platform, book_id, book_name, chapter_index, status, at, job_id, message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const entry of Object.values(ledger.records)) {
      insert.run(
        slug,
        entry.platform,
        entry.bookId,
        entry.bookName,
        entry.chapter,
        entry.status,
        entry.at,
        entry.jobId ?? null,
        entry.message ?? null,
      );
    }
    db.prepare(
      `INSERT INTO publish_ledger_meta (slug, updated_at) VALUES (?, ?)
       ON CONFLICT(slug) DO UPDATE SET updated_at = excluded.updated_at`,
    ).run(slug, ledger.updatedAt);
  });
}

export interface ImportChapterState {
  index: number;
  written: boolean;
  summary: string;
  contentPath: string;
  contentHash: string;
  words: number;
  writtenAt: string | null;
  updatedAt: string;
}

export interface ImportChapterVersion {
  index: number;
  version: number;
  createdAt: string;
  source: ChapterVersionSource;
  title: string;
  summary: string;
  note?: string;
  contentPath: string;
  contentHash: string;
  previousHash: string | null;
  words: number;
}

export interface ImportProjectSnapshotInput {
  file: ProjectFile;
  plan: ProjectPlan;
  characters: Character[];
  canon: CanonFacts;
  state: ProjectState;
  chapterStates: ImportChapterState[];
  versions: ImportChapterVersion[];
  publishLedger: PublishLedger;
  memory?: ProjectMemory;
  story?: StoryLedger;
  planLedger?: PlanLedger;
}

// 迁移专用：一次性导入一个项目的结构化快照，失败时整个项目回滚。
export function importProjectSnapshot(input: ImportProjectSnapshotInput): void {
  const {
    file,
    plan,
    characters,
    canon,
    state,
    chapterStates,
    versions,
    publishLedger,
    memory,
    story,
    planLedger,
  } = input;
  const slug = file.meta.slug;

  withTransaction((db) => {
    insertProjectRow(db, file);
    db.prepare(
      "UPDATE projects SET logline = ?, tags_json = ?, state_updated_at = ? WHERE slug = ?",
    ).run(
      plan.logline,
      JSON.stringify(plan.tags ?? []),
      state.updatedAt,
      slug,
    );

    const chapterInsert = db.prepare(
      "INSERT INTO chapters (slug, chapter_index, title, summary, key_beats_json) VALUES (?, ?, ?, ?, ?)",
    );
    for (const chapter of plan.chapters) {
      chapterInsert.run(
        slug,
        chapter.index,
        chapter.title,
        chapter.summary,
        JSON.stringify(chapter.keyBeats ?? []),
      );
    }

    replaceCharactersInTransaction(db, slug, characters);
    replaceCanonInTransaction(db, slug, canon);

    const stateInsert = db.prepare(
      `INSERT INTO chapter_states (
        slug, chapter_index, written, written_summary, content_path, content_hash,
        word_count, written_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const item of chapterStates) {
      stateInsert.run(
        slug,
        item.index,
        item.written ? 1 : 0,
        item.summary,
        item.contentPath,
        item.contentHash,
        item.words,
        item.writtenAt,
        item.updatedAt,
      );
    }

    for (const [key, review] of Object.entries(state.reviews)) {
      const index = Number(key);
      if (Number.isInteger(index) && index > 0) {
        saveReviewInTransaction(db, slug, index, review, state.updatedAt);
      }
    }

    const rejectedInsert = db.prepare(
      `INSERT INTO rejected_drafts (
        slug, chapter_index, at, path, mode, reason, review_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const [key, draft] of Object.entries(state.rejectedDrafts)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 1) continue;
      rejectedInsert.run(
        slug,
        index,
        draft.at,
        draft.path,
        draft.mode,
        draft.reason,
        JSON.stringify(draft.review),
      );
    }

    const repairInsert = db.prepare(
      "INSERT INTO chapter_repairs (slug, chapter_index, repaired_at) VALUES (?, ?, ?)",
    );
    for (const [key, at] of Object.entries(state.repairs)) {
      const index = Number(key);
      if (Number.isInteger(index) && index > 0) repairInsert.run(slug, index, at);
    }

    const recordInsert = db.prepare(
      `INSERT INTO publish_records (
        slug, platform, at, status, mode, message, chapters_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const record of state.publishHistory) {
      recordInsert.run(
        slug,
        record.platform,
        record.at,
        record.status,
        record.mode ?? null,
        record.message,
        JSON.stringify(record.chapters),
      );
    }

    const ledgerInsert = db.prepare(
      `INSERT INTO publish_ledger (
        slug, platform, book_id, book_name, chapter_index, status, at, job_id, message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const entry of Object.values(publishLedger.records)) {
      ledgerInsert.run(
        slug,
        entry.platform,
        entry.bookId,
        entry.bookName,
        entry.chapter,
        entry.status,
        entry.at,
        entry.jobId ?? null,
        entry.message ?? null,
      );
    }
    db.prepare(
      "INSERT INTO publish_ledger_meta (slug, updated_at) VALUES (?, ?)",
    ).run(slug, publishLedger.updatedAt);

    const versionInsert = db.prepare(
      `INSERT INTO chapter_versions (
        slug, chapter_index, version, created_at, source, title, summary, note,
        content_path, content_hash, previous_hash, word_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const version of versions) {
      versionInsert.run(
        slug,
        version.index,
        version.version,
        version.createdAt,
        version.source,
        version.title,
        version.summary,
        version.note ?? null,
        version.contentPath,
        version.contentHash,
        version.previousHash,
        version.words,
      );
    }

    if (memory) replaceMemoryInTransaction(db, slug, memory);
    if (story) replaceStoryInTransaction(db, slug, story);
    if (planLedger) replacePlanLedgerInTransaction(db, slug, planLedger);

    db.prepare("UPDATE projects SET updated_at = ? WHERE slug = ?").run(
      file.meta.updatedAt,
      slug,
    );
  });
}
