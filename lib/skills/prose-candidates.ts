import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { writeJsonSafe } from "../storage";
import { nowIso } from "../utils";
import { skillProjectDir } from "./config";
import { SkillError, type ProseCandidateRecord } from "./types";

const CANDIDATE_ID = /^c\d+-[a-z0-9]+-[a-z0-9]+$/u;
const KEEP_PER_CHAPTER = 10;

export function proseCandidatesDir(slug: string): string {
  return path.join(skillProjectDir(slug), "polish");
}

export function newProseCandidateId(index: number): string {
  return `c${index}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

function candidatePath(slug: string, id: string): string {
  if (!CANDIDATE_ID.test(id)) {
    throw new SkillError("SKILL_INPUT_INVALID", "润色候选编号不合法");
  }
  return path.join(proseCandidatesDir(slug), `${id}.json`);
}

export async function saveProseCandidate(
  slug: string,
  candidate: ProseCandidateRecord,
): Promise<void> {
  if (!CANDIDATE_ID.test(candidate.id)) {
    throw new SkillError("SKILL_INPUT_INVALID", "润色候选编号不合法");
  }
  await writeJsonSafe(candidatePath(slug, candidate.id), candidate);
  await pruneCandidates(slug, candidate.index);
}

async function pruneCandidates(slug: string, index: number): Promise<void> {
  const dir = proseCandidatesDir(slug);
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
  const prefix = `c${index}-`;
  const files = entries
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith(".json"))
    .sort();
  for (const file of files.slice(0, Math.max(0, files.length - KEEP_PER_CHAPTER))) {
    await fs.rm(path.join(dir, file), { force: true });
  }
}

export async function loadProseCandidate(
  slug: string,
  id: string,
): Promise<ProseCandidateRecord> {
  const filePath = candidatePath(slug, id);
  let raw = "";
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      throw new SkillError(
        "SKILL_INPUT_INVALID",
        "润色候选不存在或已过期，请重新润色",
      );
    }
    throw new SkillError(
      "SKILL_LOAD_FAILED",
      `润色候选读取失败：${String(error)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new SkillError(
      "SKILL_LOAD_FAILED",
      `润色候选 JSON 已损坏：${String(error)}`,
    );
  }
  const record = (parsed ?? {}) as Partial<ProseCandidateRecord>;
  if (
    record.version !== 1 ||
    record.id !== id ||
    !Number.isInteger(record.index) ||
    typeof record.original !== "string" ||
    typeof record.optimized !== "string"
  ) {
    throw new SkillError("SKILL_LOAD_FAILED", "润色候选结构不完整");
  }
  return {
    ...(record as ProseCandidateRecord),
    status:
      record.status === "applied" || record.status === "rejected"
        ? record.status
        : "pending",
    createdAt: record.createdAt ?? nowIso(),
  };
}

export async function markProseCandidateStatus(
  slug: string,
  candidate: ProseCandidateRecord,
  status: "applied" | "rejected",
): Promise<ProseCandidateRecord> {
  const next: ProseCandidateRecord = {
    ...candidate,
    status,
    ...(status === "applied" ? { appliedAt: nowIso() } : {}),
  };
  await writeJsonSafe(candidatePath(slug, candidate.id), next);
  return next;
}
