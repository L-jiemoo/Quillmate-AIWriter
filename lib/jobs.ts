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

// 页面切走后前端会丢掉任务 id；重新进入工作台时用它把正在跑的任务接回来。
export function getActiveJob(slug: string): Job | undefined {
  let latest: Job | undefined;
  for (const job of jobs.values()) {
    if (job.slug !== slug) continue;
    if (job.status !== "queued" && job.status !== "running") continue;
    if (!latest || job.createdAt > latest.createdAt) latest = job;
  }
  return latest;
}

// 长任务逐个章节推进；暂停请求在当前章节处理完后生效，已完成的章节不回滚。
export function requestPause(id: string, slug: string): Job | undefined {
  const job = jobs.get(id);
  if (!job || job.slug !== slug) return undefined;
  if (job.status === "queued") {
    job.status = "paused";
    job.pauseRequested = true;
    logJob(job, "任务开始前已暂停");
  } else if (job.status === "running") {
    job.pauseRequested = true;
    logJob(job, "已收到暂停请求，当前章节处理完后暂停");
  }
  return job;
}

export function logJob(job: Job, message: string): void {
  job.logs.push({ time: nowIso(), message });
  // 长任务会持续输出日志；只保留最近 400 条，避免内存和轮询响应无限增长。
  if (job.logs.length > 400) job.logs.splice(0, job.logs.length - 400);
  job.updatedAt = nowIso();
  console.log(`[${job.type}] ${message}`);
}
