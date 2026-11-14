import { randomUUID } from "crypto";
import { nowIso } from "./utils";
import type { Job } from "./types";

// Next.js 开发模式会热重载服务端模块；把任务表挂到 globalThis，
// 保证热更新后前端轮询仍能查到正在跑的任务，不会突然 404。
const globalStore = globalThis as unknown as { __quillmateJobs?: Map<string, Job> };
const jobs = globalStore.__quillmateJobs ?? new Map<string, Job>();
globalStore.__quillmateJobs = jobs;

export function createJob(slug: string, type: Job["type"]): Job {
  const now = nowIso();
  const job: Job = {
    id: randomUUID(),
    slug,
    type,
    status: "queued",
    logs: [],
    createdAt: now,
    updatedAt: now,
  };
  jobs.set(job.id, job);
  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function logJob(job: Job, message: string): void {
  job.logs.push({ time: nowIso(), message });
  // 长任务会持续输出日志；只保留最近 400 条，避免内存和轮询响应无限增长。
  if (job.logs.length > 400) job.logs.splice(0, job.logs.length - 400);
  job.updatedAt = nowIso();
  console.log(`[${job.type}] ${message}`);
}
