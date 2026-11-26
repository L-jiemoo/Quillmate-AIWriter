import { nowIso } from "./utils";
import type {
  PublishLedger,
  PublishLedgerEntry,
  PublishLedgerStatus,
  PublishRecord,
} from "./types";

export const PUBLISH_LEDGER_VERSION = 1;

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function normalizeBookName(name: string): string {
  return name.trim().toLowerCase();
}

export function emptyPublishLedger(): PublishLedger {
  return { version: PUBLISH_LEDGER_VERSION, records: {}, updatedAt: nowIso() };
}

export function publishLedgerKey(
  bookId: string,
  bookName: string,
  chapter: number,
): string {
  const work = bookId.trim() || normalizeBookName(bookName) || "unknown";
  return `fanqie:${work}:${chapter}`;
}

function normalizeStatus(value: unknown): PublishLedgerStatus | null {
  return value === "published" || value === "uncertain" ? value : null;
}

function normalizeEntry(value: unknown): PublishLedgerEntry | null {
  const record = (value ?? {}) as Record<string, unknown>;
  if (record.platform !== "fanqie") return null;
  const chapter = Number(record.chapter);
  const status = normalizeStatus(record.status);
  const bookId = str(record.bookId).trim();
  const bookName = str(record.bookName).trim();
  if (!Number.isInteger(chapter) || chapter < 1 || !status) return null;
  if (!bookId && !bookName) return null;
  return {
    platform: "fanqie",
    bookId,
    bookName,
    chapter,
    status,
    at: str(record.at, nowIso()),
    jobId: str(record.jobId).trim() || undefined,
    message: str(record.message).trim() || undefined,
  };
}

export function normalizePublishLedger(input: unknown): PublishLedger {
  const record = (input ?? {}) as Record<string, unknown>;
  const records: Record<string, PublishLedgerEntry> = {};
  if (record.records && typeof record.records === "object") {
    for (const value of Object.values(record.records as Record<string, unknown>)) {
      const entry = normalizeEntry(value);
      if (!entry) continue;
      records[publishLedgerKey(entry.bookId, entry.bookName, entry.chapter)] = entry;
    }
  }
  return {
    version: PUBLISH_LEDGER_VERSION,
    records,
    updatedAt: str(record.updatedAt, nowIso()),
  };
}

// 同一作品可能先按书名记录，后来补了 bookId；命中任意一个标识都算同一本书。
export function matchesPublishWork(
  entry: PublishLedgerEntry,
  bookId: string,
  bookName: string,
): boolean {
  const targetId = bookId.trim();
  const targetName = normalizeBookName(bookName);
  if (entry.bookId && targetId) return entry.bookId === targetId;
  return Boolean(targetName) && normalizeBookName(entry.bookName) === targetName;
}

export function findPublishEntry(
  ledger: PublishLedger,
  bookId: string,
  bookName: string,
  chapter: number,
): PublishLedgerEntry | undefined {
  return Object.values(ledger.records).find(
    (entry) => entry.chapter === chapter && matchesPublishWork(entry, bookId, bookName),
  );
}

export function upsertPublishEntry(
  ledger: PublishLedger,
  entry: PublishLedgerEntry,
): PublishLedger {
  const records: Record<string, PublishLedgerEntry> = {};
  for (const [key, value] of Object.entries(ledger.records)) {
    const same =
      value.chapter === entry.chapter &&
      matchesPublishWork(value, entry.bookId, entry.bookName);
    if (!same) records[key] = value;
  }
  records[publishLedgerKey(entry.bookId, entry.bookName, entry.chapter)] = entry;
  return { version: PUBLISH_LEDGER_VERSION, records, updatedAt: nowIso() };
}

export function removePublishEntry(
  ledger: PublishLedger,
  bookId: string,
  bookName: string,
  chapter: number,
): PublishLedger {
  const records: Record<string, PublishLedgerEntry> = {};
  for (const [key, value] of Object.entries(ledger.records)) {
    const same =
      value.chapter === chapter && matchesPublishWork(value, bookId, bookName);
    if (!same) records[key] = value;
  }
  return { version: PUBLISH_LEDGER_VERSION, records, updatedAt: nowIso() };
}

// 批量人工标记：一次算完整批结果，调用方只需写一次台账，
// 避免几十章「全部标记」时反复读盘/写盘。
export function applyPublishStates(
  ledger: PublishLedger,
  input: {
    bookId: string;
    bookName: string;
    chapters: number[];
    published: boolean;
  },
): PublishLedger {
  let next = ledger;
  for (const chapter of input.chapters) {
    next = input.published
      ? upsertPublishEntry(next, {
          platform: "fanqie",
          bookId: input.bookId.trim(),
          bookName: input.bookName.trim(),
          chapter,
          status: "published",
          at: nowIso(),
          message: "人工确认已发布",
        })
      : removePublishEntry(next, input.bookId, input.bookName, chapter);
  }
  return next;
}

// 旧项目只有发布历史日志；首次读取台账时把“成功且正式发布”的记录迁移过来。
export function derivePublishLedger(
  history: PublishRecord[],
  bookId: string,
  bookName: string,
): PublishLedger {
  let ledger = emptyPublishLedger();
  for (const record of history) {
    if (
      record.platform !== "fanqie" ||
      record.status !== "success" ||
      record.mode !== "publish"
    ) {
      continue;
    }
    for (const chapter of record.chapters) {
      ledger = upsertPublishEntry(ledger, {
        platform: "fanqie",
        bookId: bookId.trim(),
        bookName: bookName.trim(),
        chapter,
        status: "published",
        at: record.at,
        message: "由历史发布记录迁移",
      });
    }
  }
  return ledger;
}
