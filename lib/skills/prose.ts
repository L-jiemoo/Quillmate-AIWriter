import { createHash } from "node:crypto";
import { getProjectDetail, saveChapter } from "../store";
import type { LLMClient } from "../llm";
import type { ChapterContent, ProjectDetail } from "../types";
import {
  assertSkillEnabled,
  normalizeProseStyleConfig,
  readProjectSkillConfig,
} from "./config";
import { formatProseStyleForPrompt } from "./context";
import { diffParagraphs } from "./diff";
import { mockPolish } from "./mock";
import {
  loadProseCandidate,
  markProseCandidateStatus,
  newProseCandidateId,
  saveProseCandidate,
} from "./prose-candidates";
import { loadSkillForRun, resolveClient, withSkillLog } from "./runtime";
import {
  SkillError,
  type ProseCandidateRecord,
  type ProseChange,
  type ProseChangeType,
  type ProseFactCheck,
  type ProseFactIssue,
  type ProsePolishResult,
  type ProseRecommendation,
  type ProseStyleConfig,
} from "./types";

const MAX_POLISH_CHARS = 30_000;
const CHANGE_TYPES: ProseChangeType[] = [
  "repetition",
  "cliche",
  "description",
  "psychology",
  "dialogue",
  "rhythm",
  "wording",
  "other",
];

export function hashChapterText(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function text(value: unknown, max = 2000): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function stringList(value: unknown, maxItems = 20): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map((item) => text(item, 300))
        .filter(Boolean)
        .slice(0, maxItems),
    ),
  ];
}

function protectedTerms(detail: ProjectDetail): { term: string; type: ProseFactIssue["type"] }[] {
  const terms = new Map<string, ProseFactIssue["type"]>();
  for (const character of detail.characters) {
    const name = character.name.trim();
    if (name) terms.set(name, "missing-name");
  }
  for (const character of detail.canon.characters) {
    if (character.name.trim()) terms.set(character.name.trim(), "missing-name");
    for (const alias of character.aliases ?? []) {
      if (alias.trim()) terms.set(alias.trim(), "missing-name");
    }
  }
  for (const item of detail.canon.items) {
    if (item.name.trim()) terms.set(item.name.trim(), "missing-item");
  }
  for (const item of detail.planLedger?.itemRegistry ?? []) {
    if (item.name.trim()) terms.set(item.name.trim(), "missing-item");
  }
  return [...terms.entries()].map(([term, type]) => ({ term, type }));
}

function hasNumber(textValue: string, number: string): boolean {
  const escaped = number.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\d.])${escaped}(?![\\d.])`, "u").test(textValue);
}

// 事实校验是服务端硬约束，不依赖模型自报。
// 只检查“原文出现过的专名/数字是否彻底消失”，避免误伤代词替换和句子重组。
export function buildProseFactCheck(
  original: string,
  optimized: string,
  detail: ProjectDetail,
): ProseFactCheck {
  const issues: ProseFactIssue[] = [];
  for (const item of protectedTerms(detail)) {
    if (!original.includes(item.term)) continue;
    if (optimized.includes(item.term)) continue;
    issues.push({
      type: item.type,
      term: item.term,
      message: `原文中的「${item.term}」在优化稿中完全消失，可能改变了事实或人物关系`,
    });
  }
  const numbers = [...new Set(original.match(/\d+(?:\.\d+)?/gu) ?? [])];
  for (const number of numbers) {
    if (hasNumber(optimized, number)) continue;
    issues.push({
      type: "missing-number",
      term: number,
      message: `原文中的数字「${number}」在优化稿中消失，需确认不是事实变更`,
    });
  }
  return { unchanged: issues.length === 0, issues };
}

function readChanges(raw: unknown): ProseChange[] {
  if (!Array.isArray(raw)) return [];
  const changes: ProseChange[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const excerpt = text(record.excerpt, 200);
    const reason = text(record.reason, 400);
    if (!excerpt && !reason) continue;
    const type = CHANGE_TYPES.includes(record.type as ProseChangeType)
      ? (record.type as ProseChangeType)
      : "other";
    changes.push({ type, excerpt, reason });
    if (changes.length >= 200) break;
  }
  return changes;
}

function buildPrompt(
  detail: ProjectDetail,
  chapterIndex: number,
  chapterTitle: string,
  original: string,
  prose: ProseStyleConfig,
  banned: string[],
  preferred: string[],
  protectedNames: string[],
): string {
  return `【项目】《${detail.meta.title}》（${detail.meta.genre} / ${detail.meta.tone}）
【章节】第 ${chapterIndex} 章${chapterTitle ? `《${chapterTitle}》` : ""}
【文风配置】
${formatProseStyleForPrompt(prose)}
${banned.length ? `- 本次额外禁用：${banned.join("、")}` : ""}
${preferred.length ? `- 本次额外偏好：${preferred.join("、")}` : ""}

【必须保留的专名与数字】
${protectedNames.length ? protectedNames.join("、") : "（无）"}

【原文】
${original}

【任务】
只做表达层优化，不改变剧情事实、人物关系、人物认知、伏笔和剧情结果。
保留人物姓名、称呼、关键物品、地点、数字、日期和已发生的剧情结果。
优先用差异化的句子节奏、具体动作和自然对话替代套话、重复句和无效描写。
如果首段是“X 是被……的”事后总结句，或“被一阵敲门声/喊声吵醒、惊醒、惊动”式的刺激—反应开头，改写为动作中间态、声音或对话直入、环境细节切入；不得改变事件本身、时间顺序与人物动作结果。
不要为了“去 AI 味”堆砌复杂词汇，也不要抹平作者原有风格。
请输出 JSON：
{
  "optimized": "完整优化稿，保留段落",
  "changes": [
    { "type": "repetition / cliche / description / psychology / dialogue / rhythm / wording / other", "excerpt": "原文片段", "reason": "修改原因" }
  ],
  "factCheck": { "unchanged": true, "issues": [] },
  "recommendation": "accept / review / reject",
  "warnings": []
}`;
}

function normalizeRecommendation(
  raw: unknown,
  factCheck: ProseFactCheck,
): ProseRecommendation {
  if (!factCheck.unchanged) return "review";
  return raw === "accept" || raw === "reject" ? raw : "review";
}

export interface ProseSkillInput {
  index: number;
  text?: string;
  style?: Partial<ProseStyleConfig>;
  bannedExpressions?: string[];
  preferredExpressions?: string[];
}

export async function runProseSkill(
  slug: string,
  input: ProseSkillInput,
  options: { client?: LLMClient } = {},
): Promise<ProsePolishResult> {
  const index = Number(input?.index);
  if (!Number.isInteger(index) || index < 1) {
    throw new SkillError("SKILL_INPUT_INVALID", "章节序号不合法");
  }
  const manifest = await loadSkillForRun("prose-style", "polish", slug);
  const config = await readProjectSkillConfig(slug);
  assertSkillEnabled(config, "prose-style");
  const detail = await getProjectDetail(slug);
  const chapter = detail.chapters.find((item) => item.index === index);
  if (!chapter) {
    throw new SkillError("SKILL_INPUT_INVALID", `第 ${index} 章不在当前大纲中`);
  }
  const content = (input.text ?? chapter.content).trim();
  if (!content) {
    throw new SkillError(
      "SKILL_INPUT_INVALID",
      `第 ${index} 章还没有正文，无法润色`,
    );
  }
  if (content.length > MAX_POLISH_CHARS) {
    throw new SkillError(
      "SKILL_INPUT_INVALID",
      `本章超过 ${MAX_POLISH_CHARS} 字符，暂不支持一次性润色；请拆分章节后重试`,
    );
  }

  const prose = normalizeProseStyleConfig({
    ...config.prose,
    ...(input.style ?? {}),
  });
  const banned = [
    ...new Set([
      ...prose.bannedExpressions,
      ...stringList(input.bannedExpressions),
    ]),
  ];
  const preferred = [
    ...new Set([
      ...prose.preferredExpressions,
      ...stringList(input.preferredExpressions),
    ]),
  ];
  const protectedNames = protectedTerms(detail).map((item) => item.term);
  const prompt = buildPrompt(
    detail,
    index,
    chapter.title,
    content,
    prose,
    banned,
    preferred,
    protectedNames,
  );
  const client = resolveClient(options.client);
  const mode = client.isMock ? "mock" : "llm";

  return withSkillLog(
    {
      slug,
      manifest,
      task: "polish",
      mode,
      client,
      chapter: index,
      inputChars: content.length,
    },
    async () => {
      const data = client.isMock
        ? mockPolish(content)
        : await client.json<Record<string, unknown>>(
            [
              {
                role: "system",
                content: `你是 Quillmate 的「${manifest.name}」。严格按技能说明工作，只输出 JSON。\n\n${manifest.instructions}`,
              },
              { role: "user", content: prompt },
            ],
            {
              agent: "prose-style",
              chapter: index,
              temperature: 0.65,
              maxTokens: 8000,
            },
          );

      const record = (data ?? {}) as Record<string, unknown>;
      // 不能截断模型返回的正文：长度异常应明确报错，而不是静默保存半篇稿子。
      const optimized =
        typeof record.optimized === "string" ? record.optimized.trim() : "";
      if (!optimized) {
        throw new SkillError(
          "SKILL_OUTPUT_INVALID",
          "模型输出缺少 optimized 正文",
        );
      }
      if (optimized === content) {
        throw new SkillError(
          "SKILL_OUTPUT_INVALID",
          "优化稿与原文相同，未产生有效修改",
        );
      }
      const ratio = optimized.length / content.length;
      const minRatio = content.length < 500 ? 0.4 : 0.6;
      const maxRatio = content.length < 500 ? 2.2 : 1.5;
      if (ratio < minRatio || ratio > maxRatio) {
        throw new SkillError(
          "SKILL_OUTPUT_INVALID",
          `优化稿长度异常（原文 ${content.length} 字，优化稿 ${optimized.length} 字），已拒绝本次结果`,
        );
      }

      const changes = readChanges(record.changes);
      if (!changes.length) {
        throw new SkillError(
          "SKILL_OUTPUT_INVALID",
          "模型没有给出任何具体修改说明，无法判断是否只改了表达",
        );
      }

      const factCheck = buildProseFactCheck(content, optimized, detail);
      const warnings = [
        ...stringList(record.warnings, 20),
        ...(factCheck.unchanged
          ? []
          : ["优化稿存在事实项缺失，已标记为人工复核，不能直接覆盖正文"]),
      ];
      const candidateId = newProseCandidateId(index);
      const createdAt = new Date().toISOString();
      const candidate: ProseCandidateRecord = {
        version: 1,
        id: candidateId,
        index,
        chapterTitle: chapter.title,
        originalHash: hashChapterText(content),
        original: content,
        optimized,
        diff: diffParagraphs(content, optimized),
        changes,
        factCheck,
        recommendation: normalizeRecommendation(record.recommendation, factCheck),
        warnings,
        style: prose,
        skillVersion: manifest.version,
        promptVersion: "skills",
        status: "pending",
        createdAt,
      };
      await saveProseCandidate(slug, candidate);

      return {
        skillId: "prose-style" as const,
        skillVersion: manifest.version,
        index,
        candidateId,
        original: content,
        optimized,
        diff: candidate.diff,
        changes,
        factCheck,
        recommendation: candidate.recommendation,
        warnings,
        createdAt,
      };
    },
  );
}

export async function applyProseCandidate(
  slug: string,
  index: number,
  candidateId: string,
  options: { confirmFactIssues?: boolean; client?: LLMClient } = {},
): Promise<{ chapter: ChapterContent; candidate: ProseCandidateRecord }> {
  const manifest = await loadSkillForRun("prose-style", "apply", slug);
  const candidate = await loadProseCandidate(slug, candidateId);
  if (candidate.index !== index) {
    throw new SkillError(
      "SKILL_INPUT_INVALID",
      "润色候选与章节不匹配，请重新润色",
    );
  }
  if (candidate.status !== "pending") {
    throw new SkillError(
      "SKILL_INPUT_INVALID",
      candidate.status === "applied"
        ? "该润色结果已经应用过了"
        : "该润色结果已被拒绝",
    );
  }
  const detail = await getProjectDetail(slug);
  const chapter = detail.chapters.find((item) => item.index === index);
  if (!chapter) {
    throw new SkillError("SKILL_INPUT_INVALID", `第 ${index} 章不在当前大纲中`);
  }
  if (hashChapterText(chapter.content.trim()) !== candidate.originalHash) {
    throw new SkillError(
      "SKILL_INPUT_INVALID",
      "正文在润色后已发生变化，请重新润色，避免覆盖新内容",
    );
  }
  if (!candidate.factCheck.unchanged && !options.confirmFactIssues) {
    throw new SkillError(
      "SKILL_INPUT_INVALID",
      "优化稿存在事实核对问题，请先人工确认再接受",
    );
  }

  const chapterPlan = detail.plan.chapters.find((item) => item.index === index);
  return withSkillLog(
    {
      slug,
      manifest,
      task: "apply",
      mode: "local",
      chapter: index,
      inputChars: candidate.optimized.length,
    },
    async () => {
      const saved = await saveChapter(
        slug,
        index,
        candidate.optimized,
        chapterPlan?.title,
        {
          source: "ai-polish",
          note: `文风优化 ${candidate.id}`,
        },
      );
      const next = await markProseCandidateStatus(slug, candidate, "applied");
      return { chapter: saved, candidate: next };
    },
  );
}

export async function rejectProseCandidate(
  slug: string,
  candidateId: string,
): Promise<ProseCandidateRecord> {
  const manifest = await loadSkillForRun("prose-style", "reject", slug);
  const candidate = await loadProseCandidate(slug, candidateId);
  if (candidate.status !== "pending") {
    throw new SkillError("SKILL_INPUT_INVALID", "该润色结果已经处理过了");
  }
  return withSkillLog(
    {
      slug,
      manifest,
      task: "reject",
      mode: "local",
      chapter: candidate.index,
    },
    async () => markProseCandidateStatus(slug, candidate, "rejected"),
  );
}
