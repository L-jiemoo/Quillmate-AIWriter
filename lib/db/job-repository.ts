import type { Job, JobLog, JobParams, JobStatus } from "../types";
import { getDatabase, withTransaction } from "./connection";

interface JobRow {
  id: string;
  slug: string;
  job_type: string;
  status: string;
  params_json: string;
  pause_requested: number;
  cancel_requested: number;
  cancel_reason: string | null;
  result: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  updated_at: string;
}

function parseParams(value: string): JobParams {
  try {
    const raw = JSON.parse(value) as Record<string, unknown>;
    const params: JobParams = {};
    if (raw.count !== undefined) {
      const count = Number(raw.count);
      if (Number.isFinite(count)) params.count = Math.max(1, Math.round(count));
    }
    if (Array.isArray(raw.indices)) {
      params.indices = [
        ...new Set(
          raw.indices
            .map(Number)
            .filter((index) => Number.isInteger(index) && index > 0),
        ),
      ].slice(0, 200);
    }
    if (typeof raw.instruction === "string") params.instruction = raw.instruction.slice(0, 500);
    if (typeof raw.useReview === "boolean") params.useReview = raw.useReview;
    if (raw.source === "review" || raw.source === "audit") params.source = raw.source;
    return params;
  } catch {
    return {};
  }
}

function readLogs(jobId: string): JobLog[] {
  const rows = getDatabase()
    .prepare("SELECT time, message FROM job_logs WHERE job_id = ? ORDER BY seq")
    .all(jobId) as unknown as Array<{ time: string; message: string }>;
  return rows.slice(-400).map((row) => ({ time: row.time, message: row.message }));
}

function rowToJob(row: JobRow): Job {
  return {
    id: row.id,
    slug: row.slug,
    type: row.job_type as Job["type"],
    status: row.status as JobStatus,
    params: parseParams(row.params_json),
    pauseRequested: row.pause_requested !== 0,
    cancelRequested: row.cancel_requested !== 0,
    cancelReason:
      row.cancel_reason === "user" || row.cancel_reason === "timeout"
        ? row.cancel_reason
        : undefined,
    logs: readLogs(row.id),
    result: row.result ?? undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    endedAt: row.ended_at ?? undefined,
    updatedAt: row.updated_at,
  };
}

export function readJob(id: string): Job | null {
  const row = getDatabase()
    .prepare("SELECT * FROM jobs WHERE id = ?")
    .get(id) as JobRow | undefined;
  return row ? rowToJob(row) : null;
}

export function readAllJobs(): Job[] {
  const rows = getDatabase()
    .prepare("SELECT * FROM jobs ORDER BY updated_at DESC")
    .all() as unknown as JobRow[];
  return rows.map(rowToJob);
}

export function writeJob(job: Job): void {
  withTransaction((db) => {
    db.prepare(
      `INSERT INTO jobs (
        id, slug, job_type, status, params_json, pause_requested, cancel_requested,
        cancel_reason, result, error, created_at, started_at, ended_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        slug = excluded.slug, job_type = excluded.job_type, status = excluded.status,
        params_json = excluded.params_json, pause_requested = excluded.pause_requested,
        cancel_requested = excluded.cancel_requested, cancel_reason = excluded.cancel_reason,
        result = excluded.result, error = excluded.error, created_at = excluded.created_at,
        started_at = excluded.started_at, ended_at = excluded.ended_at,
        updated_at = excluded.updated_at`,
    ).run(
      job.id,
      job.slug,
      job.type,
      job.status,
      JSON.stringify(job.params ?? {}),
      job.pauseRequested ? 1 : 0,
      job.cancelRequested ? 1 : 0,
      job.cancelReason ?? null,
      job.result ?? null,
      job.error ?? null,
      job.createdAt,
      job.startedAt ?? null,
      job.endedAt ?? null,
      job.updatedAt,
    );
    db.prepare("DELETE FROM job_logs WHERE job_id = ?").run(job.id);
    const insert = db.prepare(
      "INSERT INTO job_logs (job_id, seq, time, message) VALUES (?, ?, ?, ?)",
    );
    const logs = job.logs.slice(-400);
    logs.forEach((log, index) => insert.run(job.id, index, log.time, log.message));
  });
}

export function listJobIds(): string[] {
  const rows = getDatabase()
    .prepare("SELECT id FROM jobs ORDER BY updated_at DESC")
    .all() as unknown as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

export function countJobs(): number {
  const row = getDatabase()
    .prepare("SELECT COUNT(*) AS count FROM jobs")
    .get() as { count: number } | undefined;
  return Number(row?.count ?? 0);
}
