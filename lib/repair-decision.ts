import { randomUUID } from "node:crypto";
import { readJsonOptional, writeJsonSafe } from "./storage";
import { projectFile } from "./store-file";
import type { ContinuityIssue, JobParams } from "./types";

export interface RepairDecisionOption {
  label: string;
  description: string;
  // 该方案需要一起修改的章节（含根因章节与目标章节）。
  affectedChapters: number[];
  // 方案明确依赖的原文锚点，用于校验根因章节的补丁落在正确位置。
  anchors: string[];
  // 该方案会新增的设定；旧决策记录可能没有该字段。
  introducedFacts?: string[];
  // 旧决策记录可能没有该字段；界面按“无推荐等价于第一项”处理。
  recommended?: boolean;
}

export interface RepairDecision {
  id: string;
  slug: string;
  chapterIndex: number;
  source: "audit" | "review" | "draft";
  params: JobParams;
  jobId: string;
  createdAt: string;
  reason: string;
  issues: ContinuityIssue[];
  options: RepairDecisionOption[];
  chosenIndex?: number;
  chosenAt?: string;
}

interface DecisionFile {
  version: number;
  decisions: RepairDecision[];
}

const FILE_VERSION = 1;
const MAX_DECISIONS = 30;

function decisionPath(slug: string): string {
  return projectFile(slug, "repair-decisions.json");
}

export async function listRepairDecisions(slug: string): Promise<RepairDecision[]> {
  const file = await readJsonOptional<DecisionFile>(decisionPath(slug), {
    version: FILE_VERSION,
    decisions: [],
  });
  return Array.isArray(file.decisions) ? file.decisions : [];
}

async function saveDecisions(slug: string, decisions: RepairDecision[]): Promise<void> {
  const trimmed = decisions
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .slice(-MAX_DECISIONS);
  await writeJsonSafe(decisionPath(slug), {
    version: FILE_VERSION,
    decisions: trimmed,
  });
}

export async function createRepairDecision(input: {
  slug: string;
  chapterIndex: number;
  source: "audit" | "review" | "draft";
  params: JobParams;
  jobId: string;
  reason: string;
  issues: ContinuityIssue[];
  options: RepairDecisionOption[];
}): Promise<RepairDecision> {
  const decisions = await listRepairDecisions(input.slug);
  // 同一章只保留最新一份待确认记录，避免作者面对过期选项。
  const filtered = decisions.filter(
    (decision) =>
      decision.chapterIndex !== input.chapterIndex || decision.chosenIndex !== undefined,
  );
  const decision: RepairDecision = {
    id: randomUUID(),
    slug: input.slug,
    chapterIndex: input.chapterIndex,
    source: input.source,
    params: { ...input.params },
    jobId: input.jobId,
    createdAt: new Date().toISOString(),
    reason: input.reason,
    issues: input.issues,
    options: input.options.map((option) => ({
      label: option.label.trim() || "未命名方案",
      description: option.description,
      affectedChapters: [
        ...new Set(
          option.affectedChapters.filter(
            (index) => Number.isInteger(index) && index > 0,
          ),
        ),
      ],
      anchors: option.anchors.map((anchor) => anchor.trim()).filter(Boolean),
      introducedFacts: (option.introducedFacts ?? [])
        .map((fact) => fact.trim())
        .filter(Boolean),
      recommended: option.recommended === true,
    })),
  };
  // 兜底：优先推荐不新增设定的方案；只有都新增时才选新增最少、改动章节最少的。
  const safe = decision.options.filter((option) => !option.introducedFacts?.length);
  const pool = safe.length ? safe : decision.options;
  const marked = pool.filter((option) => option.recommended);
  if (marked.length !== 1) {
    const pick = [...pool].sort(
      (left, right) =>
        (left.introducedFacts?.length ?? 0) - (right.introducedFacts?.length ?? 0) ||
        left.affectedChapters.length - right.affectedChapters.length,
    )[0];
    for (const option of decision.options) option.recommended = option === pick;
  }
  await saveDecisions(input.slug, [...filtered, decision]);
  return decision;
}

export async function getRepairDecision(
  slug: string,
  id: string,
): Promise<RepairDecision | undefined> {
  return (await listRepairDecisions(slug)).find((decision) => decision.id === id);
}

export async function getPendingRepairDecision(
  slug: string,
): Promise<RepairDecision | undefined> {
  const decisions = await listRepairDecisions(slug);
  return [...decisions].reverse().find((decision) => decision.chosenIndex === undefined);
}

export async function confirmRepairDecision(
  slug: string,
  id: string,
  optionIndex: number,
): Promise<RepairDecision> {
  const decisions = await listRepairDecisions(slug);
  const index = decisions.findIndex((decision) => decision.id === id);
  if (index < 0) throw new Error("修复决策不存在或已被清理");
  const decision = decisions[index];
  if (decision.chosenIndex !== undefined) {
    throw new Error("该修复决策已经确认过，不能重复确认");
  }
  if (
    !Number.isInteger(optionIndex) ||
    optionIndex < 0 ||
    optionIndex >= decision.options.length
  ) {
    throw new Error("选择的修复方案不存在");
  }
  const updated: RepairDecision = {
    ...decision,
    chosenIndex: optionIndex,
    chosenAt: new Date().toISOString(),
  };
  decisions[index] = updated;
  await saveDecisions(slug, decisions);
  return updated;
}
