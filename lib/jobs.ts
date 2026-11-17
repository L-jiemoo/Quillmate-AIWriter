import { randomUUID } from "crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import path from "path";
import { JOBS_DIR } from "./config";
import * as sqliteJobRepo from "./db/job-repository";
import { shouldUseSqlite } from "./storage-mode";
import { assertSafeSlug, isSafeJobId, isSafeSlug, nowIso } from "./utils";
import type { Job, JobLog, JobParams, JobStatus } from "./types";

const JOB_TYPES = [
  "plan",
  "extend",
  "write",
  "rewrite",
  "repair",
  "recanon",
  "memory",
  "audit",
  "export",
  "fanqie-login",
  "fanqie-publish",
] as const satisfies readonly Job["type"][];

const JOB_STATUSES = [
  "queued",
  "running",
  "paused",
  "done",
  "error",
  "cancelled",
  "interrupted",
] as const satisfies readonly JobStatus[];

const LOCKS_DIR = path.join(JOBS_DIR, "locks");
const CONTROL_DIR = path.join(JOBS_DIR, "control");
const LOCK_STALE_MS = 10 * 60 * 1000;

// 锁文件心跳：长时间模型调用期间也要证明进程仍存活。
export const JOB_HEARTBEAT_MS = 15000;

interface JobStore {
  jobs: Map<string, Job>;
  locks: Map<string, string>;
  hydrated: boolean;
}

// Next.js 开发模式会把页面和 API 放在不同进程/工作线程里，
// 因此项目锁、任务状态和暂停/取消信号都必须落盘，不能只放内存。
const globalStore = globalThis as unknown as { __quillmateJobStore?: JobStore };
const store: JobStore =
  globalStore.__quillmateJobStore ?? {
    jobs: new Map<string, Job>(),
    locks: new Map<string, string>(),
    hydrated: false,
  };
globalStore.__quillmateJobStore = store;
const jobs = store.jobs;

const writeQueues = new Map<string, Promise<void>>();
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();

function isJobType(value: unknown): value is Job["type"] {
  return typeof value === "string" && JOB_TYPES.includes(value as Job["type"]);
}

function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === "string" && JOB_STATUSES.includes(value as JobStatus);
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function normalizeParams(input: unknown): JobParams {
  const record = (input ?? {}) as Record<string, unknown>;
  const params: JobParams = {};
  if (record.count !== undefined) {
    const count = Number(record.count);
    if (Number.isFinite(count)) params.count = Math.max(1, Math.round(count));
  }
  if (Array.isArray(record.indices)) {
    params.indices = [
      ...new Set(
        record.indices
          .map(Number)
          .filter((index) => Number.isInteger(index) && index > 0),
      ),
    ].slice(0, 200);
  }
  if (typeof record.instruction === "string") {
    params.instruction = record.instruction.slice(0, 500);
  }
  if (typeof record.useReview === "boolean") params.useReview = record.useReview;
  if (record.source === "review" || record.source === "audit") {
    params.source = record.source;
  }
  if (record.confirmPublish === true) params.confirmPublish = true;
  return params;
}

function normalizeLogs(input: unknown): JobLog[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => {
      const record = (item ?? {}) as Record<string, unknown>;
      const message = text(record.message).trim();
      if (!message) return null;
      return { time: text(record.time, nowIso()), message };
    })
    .filter((item): item is JobLog => Boolean(item))
    .slice(-400);
}

function normalizeJob(raw: unknown): Job | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = text(record.id).trim();
  const slug = text(record.slug).trim();
  if (
    !id ||
    !slug ||
    !isJobType(record.type) ||
    !isSafeJobId(id) ||
    !isSafeSlug(slug)
  ) {
    return null;
  }

  const createdAt = text(record.createdAt, nowIso());
  return {
    id,
    slug,
    type: record.type,
    status: isJobStatus(record.status) ? record.status : "error",
    params: normalizeParams(record.params),
    pauseRequested: record.pauseRequested === true,
    cancelRequested: record.cancelRequested === true,
    cancelReason:
      record.cancelReason === "user" || record.cancelReason === "timeout"
        ? record.cancelReason
        : undefined,
    logs: normalizeLogs(record.logs),
    result: typeof record.result === "string" ? record.result : undefined,
    error: typeof record.error === "string" ? record.error : undefined,
    createdAt,
    startedAt: typeof record.startedAt === "string" ? record.startedAt : undefined,
    endedAt: typeof record.endedAt === "string" ? record.endedAt : undefined,
    updatedAt: text(record.updatedAt, createdAt),
  };
}

function ensureDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

function writeJsonAtomicSync(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    renameSync(tmp, filePath);
  } catch {
    // Windows 上目标被占用时 rename 可能失败，退化为先删后改名。
    rmSync(filePath, { force: true });
    try {
      renameSync(tmp, filePath);
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
  }
}

function readJsonSync<T>(filePath: string): T | null {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function assertSafeJobId(id: string): void {
  if (!isSafeJobId(id)) throw new Error("任务 ID 不合法");
}

function jobPath(id: string): string {
  assertSafeJobId(id);
  return path.join(JOBS_DIR, `${id}.json`);
}

function lockPath(slug: string): string {
  assertSafeSlug(slug);
  return path.join(LOCKS_DIR, `${slug}.lock`);
}

function controlPath(id: string): string {
  assertSafeJobId(id);
  return path.join(CONTROL_DIR, `${id}.json`);
}

interface LockInfo {
  jobId: string;
  pid: number;
  at: string;
}

interface ControlInfo {
  pauseRequested?: boolean;
  cancelRequested?: boolean;
  cancelReason?: "user" | "timeout";
}

function readLock(slug: string): LockInfo | null {
  const raw = readJsonSync<Record<string, unknown>>(lockPath(slug));
  if (!raw) return null;
  const jobId = text(raw.jobId).trim();
  const pid = Number(raw.pid);
  const at = text(raw.at).trim();
  if (!jobId || !Number.isInteger(pid) || !at) return null;
  return { jobId, pid, at };
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM 表示进程存在但无权限发信号，仍算存活。
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function lockIsLive(lock: LockInfo | null): boolean {
  if (!lock) return false;
  const at = Date.parse(lock.at);
  if (!Number.isFinite(at)) return false;
  return isPidAlive(lock.pid) && Date.now() - at < LOCK_STALE_MS;
}

function tryCreateLock(slug: string, jobId: string): boolean {
  ensureDir(LOCKS_DIR);
  try {
    const fd = openSync(lockPath(slug), "wx");
    try {
      writeFileSync(fd, JSON.stringify({ jobId, pid: process.pid, at: nowIso() }));
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

function clearStaleLock(slug: string): boolean {
  const lock = readLock(slug);
  if (!lock) {
    rmSync(lockPath(slug), { force: true });
    return true;
  }
  if (lockIsLive(lock)) return false;
  rmSync(lockPath(slug), { force: true });
  return true;
}

export function touchProjectLock(slug: string, id: string): void {
  const lock = readLock(slug);
  if (!lock || lock.jobId !== id) return;
  writeJsonAtomicSync(lockPath(slug), { ...lock, pid: process.pid, at: nowIso() });
}

function releaseLockFile(slug: string, id: string): void {
  const lock = readLock(slug);
  if (lock?.jobId !== id) return;
  rmSync(lockPath(slug), { force: true });
}

function readControl(id: string): ControlInfo | null {
  return readJsonSync<ControlInfo>(controlPath(id));
}

function writeControl(id: string, patch: ControlInfo): void {
  const current = readControl(id) ?? {};
  writeJsonAtomicSync(controlPath(id), { ...current, ...patch });
}

function clearControl(id: string): void {
  rmSync(controlPath(id), { force: true });
}

export function clearJobControl(id: string): void {
  clearControl(id);
}

// 停/取消信号由任意进程写入控制文件，任务执行进程在每个检查点读取。
function applyControl(job: Job): void {
  const control = readControl(job.id);
  if (!control) return;
  if (control.cancelRequested) {
    job.cancelRequested = true;
    job.cancelReason = control.cancelReason === "timeout" ? "timeout" : "user";
  }
  if (control.pauseRequested) job.pauseRequested = true;
}

function readJobFile(id: string): Job | null {
  return normalizeJob(readJsonSync(jobPath(id)));
}

function writeJobFileSync(job: Job): void {
  writeJsonAtomicSync(jobPath(job.id), job);
}

function listJobFileNames(): string[] {
  try {
    return readdirSync(JOBS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

interface JobPersistence {
  readAll(): Job[];
  read(id: string): Job | null;
  write(job: Job): void;
  listIds(): string[];
}

const filePersistence: JobPersistence = {
  readAll() {
    const result: Job[] = [];
    for (const fileName of listJobFileNames()) {
      try {
        const job = normalizeJob(
          JSON.parse(readFileSync(path.join(JOBS_DIR, fileName), "utf8")),
        );
        if (job) result.push(job);
      } catch (error) {
        console.warn(
          `[jobs] 跳过损坏的任务文件 ${fileName}：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return result;
  },
  read: (id) => readJobFile(id),
  write: (job) => writeJobFileSync(job),
  listIds: () => listJobFileNames().map((name) => name.replace(/\.json$/, "")),
};

const sqlitePersistence: JobPersistence = {
  readAll: () => sqliteJobRepo.readAllJobs(),
  read: (id) => sqliteJobRepo.readJob(id),
  write: (job) => sqliteJobRepo.writeJob(job),
  listIds: () => sqliteJobRepo.listJobIds(),
};

function persistence(): JobPersistence {
  return shouldUseSqlite() ? sqlitePersistence : filePersistence;
}

function hydrate(): void {
  if (store.hydrated) return;
  store.hydrated = true;

  let interrupted = 0;
  for (const job of persistence().readAll()) {
    if (job.status === "queued" || job.status === "running") {
      const lock = readLock(job.slug);
      const live = Boolean(lock && lock.jobId === job.id && lockIsLive(lock));
      // 只有“没有存活锁”的运行中任务才是上次进程遗留的；
      // 另一个进程正在执行时不能误标为中断。
      if (!live) {
        job.status = "interrupted";
        job.error = "服务重启导致任务中断，可重试";
        job.endedAt = job.endedAt ?? nowIso();
        job.updatedAt = nowIso();
        job.pauseRequested = false;
        job.cancelRequested = false;
        persistence().write(job);
        interrupted += 1;
      }
    } else {
      clearControl(job.id);
    }
    jobs.set(job.id, job);
  }

  if (interrupted) {
    console.warn(`[jobs] ${interrupted} 个未完成任务已标记为中断，可在任务台重试`);
  }
}

hydrate();

function activeStatus(status: JobStatus): boolean {
  return status === "queued" || status === "running";
}

// 同一任务的异步写入串行化，避免旧快照晚于新快照落盘。
export function persistJob(job: Job): Promise<void> {
  const previous = writeQueues.get(job.id) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => {
      persistence().write(job);
    })
    .catch((error) => {
      console.warn(
        `[jobs] 任务 ${job.id} 持久化失败：${error instanceof Error ? error.message : String(error)}`,
      );
    });
  writeQueues.set(job.id, next);
  void next.finally(() => {
    if (writeQueues.get(job.id) === next) writeQueues.delete(job.id);
  });
  return next;
}

function schedulePersist(job: Job): void {
  if (persistTimers.has(job.id)) return;
  const timer = setTimeout(() => {
    persistTimers.delete(job.id);
    void persistJob(job);
  }, 250);
  (timer as unknown as { unref?: () => void }).unref?.();
  persistTimers.set(job.id, timer);
}

function cancelScheduledPersist(id: string): void {
  const timer = persistTimers.get(id);
  if (!timer) return;
  clearTimeout(timer);
  persistTimers.delete(id);
}

export async function flushJob(job: Job): Promise<void> {
  cancelScheduledPersist(job.id);
  await persistJob(job);
}

function createJobRecord(
  slug: string,
  type: Job["type"],
  params: JobParams,
  id: string,
): Job {
  const now = nowIso();
  const job: Job = {
    id,
    slug,
    type,
    status: "queued",
    params: normalizeParams(params),
    logs: [],
    createdAt: now,
    updatedAt: now,
  };
  jobs.set(job.id, job);
  try {
    persistence().write(job);
  } catch (error) {
    jobs.delete(job.id);
    throw error;
  }
  return job;
}

export function createJob(slug: string, type: Job["type"], params: JobParams = {}): Job {
  return createJobRecord(slug, type, params, randomUUID());
}

export class JobConflictError extends Error {
  readonly job?: Job;

  constructor(message: string, job?: Job) {
    super(message);
    this.name = "JobConflictError";
    this.job = job;
  }
}

export function acquireProjectSlot(
  slug: string,
  type: Job["type"],
  params: JobParams = {},
): Job {
  assertSafeSlug(slug);
  const existing = getActiveJob(slug);
  if (existing) {
    throw new JobConflictError(`项目已有任务正在运行：${existing.type}`, existing);
  }

  const jobId = randomUUID();
  if (!tryCreateLock(slug, jobId)) {
    if (!clearStaleLock(slug)) {
      const lock = readLock(slug);
      const active = lock ? getJob(lock.jobId) : undefined;
      throw new JobConflictError(
        `项目已有任务正在运行${active ? `：${active.type}` : ""}`,
        active,
      );
    }
    if (!tryCreateLock(slug, jobId)) {
      const lock = readLock(slug);
      throw new JobConflictError(
        `项目已有任务正在运行${lock ? `：${getJob(lock.jobId)?.type ?? ""}` : ""}`,
        lock ? getJob(lock.jobId) : undefined,
      );
    }
  }

  try {
    const job = createJobRecord(slug, type, params, jobId);
    store.locks.set(slug, jobId);
    return job;
  } catch (error) {
    releaseLockFile(slug, jobId);
    throw error;
  }
}

export function releaseProjectSlot(slug: string, id: string): void {
  if (store.locks.get(slug) === id) store.locks.delete(slug);
  releaseLockFile(slug, id);
}

export function getJob(id: string): Job | undefined {
  if (!isSafeJobId(id)) return undefined;
  const memory = jobs.get(id);
  const disk = persistence().read(id);
  if (!disk) return memory;
  if (memory && memory.updatedAt > disk.updatedAt) return memory;
  jobs.set(id, disk);
  return disk;
}

export function getActiveJob(slug: string): Job | undefined {
  const lock = readLock(slug);
  if (!lock) return undefined;
  if (!lockIsLive(lock)) {
    rmSync(lockPath(slug), { force: true });
    return undefined;
  }
  // 只信“锁 + 任务文件”这一对；不能回退到本进程内存，
  // 否则另一个进程完成后，这里残留的 running 快照会永远阻塞新任务。
  const job = getJob(lock.jobId);
  return job && activeStatus(job.status) ? job : undefined;
}

export function getInterruptedJobs(slug: string): Job[] {
  return persistence()
    .readAll()
    .filter((job) => job.slug === slug && job.status === "interrupted")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function requestPause(id: string, slug: string): Job | undefined {
  const job = getJob(id);
  if (!job || job.slug !== slug) return undefined;
  if (job.status !== "queued" && job.status !== "running") return job;

  // 暂停由执行进程在检查点读取；这里只写信号，不直接改任务状态。
  writeControl(id, { pauseRequested: true });
  job.pauseRequested = true;
  return job;
}

export function requestCancel(id: string, slug: string): Job | undefined {
  const job = getJob(id);
  if (!job || job.slug !== slug) return undefined;

  if (job.status === "paused") {
    job.status = "cancelled";
    job.error = "任务已取消";
    job.pauseRequested = false;
    job.endedAt = nowIso();
    job.updatedAt = job.endedAt;
    job.logs.push({ time: job.updatedAt, message: "任务已取消" });
    if (job.logs.length > 400) job.logs.splice(0, job.logs.length - 400);
    persistence().write(job);
    releaseProjectSlot(slug, id);
    clearControl(id);
    return job;
  }

  if (
    job.status === "done" ||
    job.status === "error" ||
    job.status === "cancelled" ||
    job.status === "interrupted"
  ) {
    return job;
  }

  writeControl(id, { cancelRequested: true, cancelReason: "user" });
  job.cancelRequested = true;
  job.cancelReason = "user";
  return job;
}

export class JobCancelledError extends Error {
  readonly reason: "user" | "timeout";

  constructor(reason: "user" | "timeout") {
    super(reason === "timeout" ? "任务超时" : "任务已取消");
    this.name = "JobCancelledError";
    this.reason = reason;
  }
}

export function throwIfCancelled(job: Job): void {
  applyControl(job);
  if (job.cancelRequested) {
    throw new JobCancelledError(job.cancelReason ?? "user");
  }
}

export function isPauseRequested(job: Job): boolean {
  applyControl(job);
  return job.pauseRequested === true;
}

function parseTimeout(): number {
  const raw = Number(process.env.QUILLMATE_JOB_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw > 0) {
    return Math.min(Math.round(raw), 24 * 60 * 60 * 1000);
  }
  return 30 * 60 * 1000;
}

export const JOB_TIMEOUT_MS = parseTimeout();

export function logJob(job: Job, message: string): void {
  job.logs.push({ time: nowIso(), message });
  // 长任务会持续输出日志；只保留最近 400 条，避免内存和轮询响应无限增长。
  if (job.logs.length > 400) job.logs.splice(0, job.logs.length - 400);
  job.updatedAt = nowIso();
  console.log(`[${job.type}] ${message}`);
  schedulePersist(job);
}

// 测试辅助：清空内存任务与锁，并从当前 JOBS_DIR 重新恢复。
export function __reloadJobStoreForTests(): void {
  for (const timer of persistTimers.values()) clearTimeout(timer);
  persistTimers.clear();
  writeQueues.clear();
  jobs.clear();
  store.locks.clear();
  store.hydrated = false;
  hydrate();
}
