import { getProjectDetail } from "../store";
import type { LLMClient } from "../llm";
import { NAMING_STYLES, SkillError, type BatchNamingResult, type NameCheckResult, type NamingBreakdown, type NamingCandidate, type NamingResult, type NamingRoleInput, type NamingSkillConfig, type NamingSkillInput, type NamingStyle, type NamingTask, type ProjectSkillConfig } from "./types";
import type { ProjectDetail } from "../types";
import { mockNamingCandidates } from "./mock";
import { assertSkillEnabled, readProjectSkillConfig } from "./config";
import { loadSkillForRun, resolveClient, withSkillLog } from "./runtime";

const BREAKDOWN_CAPS: Record<keyof NamingBreakdown, number> = {
  background: 25,
  era: 20,
  distinctiveness: 20,
  naturalness: 15,
  uniqueness: 10,
  styleFit: 10,
};

const HOMOPHONE_GROUPS = [
  ["明", "鸣", "铭", "茗"],
  ["伟", "玮", "炜", "苇"],
  ["丽", "莉", "俐", "俪"],
  ["雨", "宇", "羽", "禹"],
  ["涵", "寒", "函", "晗"],
  ["欣", "心", "新", "鑫", "馨"],
  ["子", "梓", "紫", "籽"],
  ["浩", "皓", "昊"],
  ["静", "靖", "婧", "净"],
  ["琳", "林", "霖", "淋"],
  ["峰", "锋", "丰", "枫"],
  ["杰", "洁", "捷"],
  ["阳", "扬", "杨", "洋"],
  ["晴", "清", "青", "轻"],
  ["言", "颜", "严", "岩"],
  ["远", "渊", "源", "园"],
  ["云", "芸", "耘", "韵"],
  ["诗", "施", "师"],
  ["梦", "孟"],
  ["婉", "宛"],
  ["佳", "嘉", "家", "加"],
  ["俊", "骏", "峻"],
  ["晨", "辰", "宸"],
  ["宁", "凝", "柠"],
  ["书", "舒", "淑"],
  ["思", "斯", "丝"],
  ["微", "薇", "威"],
  ["舟", "州", "洲", "周"],
  ["文", "雯", "闻"],
  ["玉", "钰", "雨"],
  ["子", "紫"],
  ["安", "桉"],
  ["艺", "忆", "易"],
  ["若", "弱"],
  ["亦", "奕", "逸"],
];

const HOMOPHONE_INDEX = new Map<string, string>();
for (const group of HOMOPHONE_GROUPS) {
  for (const char of group) HOMOPHONE_INDEX.set(char, group[0]);
}

function text(value: unknown, max = 200): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function stringList(value: unknown, maxItems = 20): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map((item) => text(item, 200))
        .filter(Boolean)
        .slice(0, maxItems),
    ),
  ];
}

export function normalizeNameKey(name: string): string {
  return name.replace(/[\s·・.。]/gu, "").toLowerCase();
}

function skeleton(name: string): string {
  return [...normalizeNameKey(name)]
    .map((char) => HOMOPHONE_INDEX.get(char) ?? char)
    .join("");
}

function editDistance(left: string, right: string): number {
  const a = [...left];
  const b = [...right];
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j];
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        previous + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      previous = current;
    }
  }
  return row[b.length];
}

export function similarityWarnings(
  name: string,
  others: string[],
): string[] {
  const target = normalizeNameKey(name);
  if (!target) return [];
  const warnings = new Set<string>();
  for (const other of others) {
    const key = normalizeNameKey(other);
    if (!key) continue;
    if (key === target) {
      warnings.add(`与已有角色「${other}」完全重名`);
      continue;
    }
    if (skeleton(target) === skeleton(key)) {
      warnings.add(`与「${other}」读音相近，容易混淆`);
      continue;
    }
    if (
      Math.abs([...target].length - [...key].length) <= 1 &&
      editDistance(target, key) === 1
    ) {
      warnings.add(`与「${other}」仅一字之差，字形或用字过于接近`);
      continue;
    }
    if (
      [...target].length > 2 &&
      [...key].length > 2 &&
      target.slice(1) === key.slice(1)
    ) {
      warnings.add(`与「${other}」同名不同姓，读者可能混淆`);
    }
  }
  return [...warnings];
}

export function checkNames(
  entries: { name: string; source: string }[],
): NameCheckResult {
  const byKey = new Map<string, { name: string; sources: Set<string> }>();
  for (const entry of entries) {
    const name = entry.name.trim();
    const key = normalizeNameKey(name);
    if (!key) continue;
    const current = byKey.get(key);
    if (current) {
      current.sources.add(entry.source);
    } else {
      byKey.set(key, { name, sources: new Set([entry.source]) });
    }
  }

  const uniqueNames = [...byKey.values()].map((item) => item.name);
  const similar: NameCheckResult["similar"] = [];
  const seenPairs = new Set<string>();
  for (let i = 0; i < uniqueNames.length; i += 1) {
    for (let j = i + 1; j < uniqueNames.length; j += 1) {
      const left = uniqueNames[i];
      const right = uniqueNames[j];
      const pairKey = [normalizeNameKey(left), normalizeNameKey(right)]
        .sort()
        .join("|");
      if (seenPairs.has(pairKey)) continue;
      const leftKey = normalizeNameKey(left);
      const rightKey = normalizeNameKey(right);
      let level: "high" | "medium" | null = null;
      let reason = "";
      if (skeleton(leftKey) === skeleton(rightKey)) {
        level = "high";
        reason = "读音相近";
      } else if (
        Math.abs([...leftKey].length - [...rightKey].length) <= 1 &&
        editDistance(leftKey, rightKey) === 1
      ) {
        level = "high";
        reason = "仅一字之差，字形或用字过于接近";
      } else if (
        [...leftKey].length > 2 &&
        [...rightKey].length > 2 &&
        leftKey.slice(1) === rightKey.slice(1)
      ) {
        level = "medium";
        reason = "同名不同姓";
      }
      if (!level) continue;
      seenPairs.add(pairKey);
      similar.push({ name: left, other: right, level, reason });
    }
  }

  return {
    checked: uniqueNames.length,
    duplicates: [...byKey.values()]
      .filter((item) => item.sources.size > 1)
      .map((item) => ({ name: item.name, sources: [...item.sources] })),
    similar,
  };
}

function collectEntries(detail: ProjectDetail): { name: string; source: string }[] {
  const entries: { name: string; source: string }[] = [];
  for (const character of detail.characters) {
    if (character.name.trim()) {
      entries.push({ name: character.name, source: "人物档案" });
    }
  }
  for (const character of detail.canon.characters) {
    if (character.name.trim()) {
      entries.push({ name: character.name, source: "事实台账" });
    }
    for (const alias of character.aliases ?? []) {
      if (alias.trim()) entries.push({ name: alias, source: "事实台账·别名" });
    }
  }
  return entries;
}

export async function checkProjectNames(slug: string): Promise<NameCheckResult> {
  const manifest = await loadSkillForRun("character-naming", "check", slug);
  const started = Date.now();
  try {
    const detail = await getProjectDetail(slug);
    const result = checkNames(collectEntries(detail));
    await withSkillLog(
      {
        slug,
        manifest,
        task: "check",
        mode: "local",
        inputChars: detail.characters.length,
      },
      async () => result,
    );
    return result;
  } catch (error) {
    if (error instanceof SkillError) throw error;
    throw new SkillError(
      "SKILL_LOAD_FAILED",
      `撞名检查失败（${Date.now() - started}ms）：${String(error)}`,
    );
  }
}

function sanitizeRole(raw: unknown): NamingRoleInput {
  const record = (raw ?? {}) as Record<string, unknown>;
  return {
    role: text(record.role, 60),
    gender: text(record.gender, 20),
    age: text(record.age, 40),
    identity: text(record.identity, 120),
    family: text(record.family, 200),
    socialClass: text(record.socialClass, 120),
    personality: text(record.personality, 300),
    background: text(record.background, 500),
    style: text(record.style, 40),
    type: text(record.type, 20),
  };
}

interface NormalizedNamingInput {
  task: NamingTask;
  role: NamingRoleInput;
  roles: NamingRoleInput[];
  style: NamingStyle;
  customStyle: string;
  count: number;
  forbiddenNames: string[];
  forbiddenStyles: string[];
  lockedNames: string[];
  avoidNames: string[];
}

function normalizeInput(
  raw: Partial<NamingSkillInput> | undefined,
  config: ProjectSkillConfig,
): NormalizedNamingInput {
  const record = (raw ?? {}) as Partial<NamingSkillInput>;
  const task: NamingTask =
    record.task === "batch"
      ? "batch"
      : record.task === "regenerate"
        ? "regenerate"
        : "generate";
  const style =
    NAMING_STYLES.some((item) => item.value === record.style)
      ? (record.style as NamingStyle)
      : config.naming.style;
  const requestedCount = Number(record.count);
  // Skill 要求至少 20 个候选；这里不能因为调用方传小数字而降低质量门槛。
  const count = Number.isFinite(requestedCount)
    ? Math.min(40, Math.max(20, Math.round(requestedCount)))
    : 20;
  const roles = Array.isArray(record.roles)
    ? record.roles.slice(0, 8).map(sanitizeRole)
    : [];
  return {
    task,
    role: sanitizeRole(record.role),
    roles,
    style,
    customStyle: text(record.customStyle, 500),
    count,
    forbiddenNames: [
      ...new Set([
        ...config.naming.forbiddenNames,
        ...stringList(record.forbiddenNames),
      ]),
    ],
    forbiddenStyles: [
      ...new Set([
        ...config.naming.forbiddenStyles,
        ...stringList(record.forbiddenStyles),
      ]),
    ],
    lockedNames: stringList(record.lockedNames),
    avoidNames: stringList(record.avoidNames),
  };
}

function rolePrompt(role: NamingRoleInput, index?: number): string {
  const lines: string[] = [];
  const prefix = index === undefined ? "" : `角色 ${index + 1}：`;
  const fields: [string, string][] = [
    ["角色定位", role.role ?? ""],
    ["性别", role.gender ?? ""],
    ["年龄", role.age ?? ""],
    ["身份", role.identity ?? ""],
    ["家庭", role.family ?? ""],
    ["社会阶层", role.socialClass ?? ""],
    ["性格", role.personality ?? ""],
    ["背景", role.background ?? ""],
    ["命名类型", role.type ?? ""],
  ];
  for (const [label, value] of fields) {
    if (value) lines.push(`${prefix}${label}：${value}`);
  }
  if (!lines.length) {
    lines.push(`${prefix}未提供具体背景，只能根据题材和项目基调推断，并在 risks 中注明推断。`);
  }
  return lines.join("\n");
}

function existingNamesFrom(
  detail: ProjectDetail,
  input: NormalizedNamingInput,
  config: NamingSkillConfig,
): { names: string[]; blocked: Set<string> } {
  const names = new Set<string>();
  for (const entry of collectEntries(detail)) names.add(entry.name.trim());
  for (const name of input.lockedNames) names.add(name);
  const blocked = new Set<string>();
  for (const name of names) blocked.add(normalizeNameKey(name));
  for (const name of config.forbiddenNames) blocked.add(normalizeNameKey(name));
  for (const name of input.forbiddenNames) blocked.add(normalizeNameKey(name));
  for (const name of input.avoidNames) blocked.add(normalizeNameKey(name));
  return { names: [...names].filter(Boolean).sort(), blocked };
}

function namingStyleLabel(style: NamingStyle): string {
  return NAMING_STYLES.find((item) => item.value === style)?.label ?? style;
}

function buildUserPrompt(
  detail: ProjectDetail,
  input: NormalizedNamingInput,
  config: ProjectSkillConfig,
  existing: string[],
  forbidden: string[],
): string {
  const project = `《${detail.meta.title}》 / 题材：${detail.meta.genre} / 基调：${detail.meta.tone} / 语言：${detail.meta.language}`;
  const styleLine = `命名风格：${namingStyleLabel(input.style)}${
    input.style === "custom"
      ? `；自定义说明：${input.customStyle || config.naming.customStyle || "未填写"}`
      : ""
  }`;
  const common = [
    `【项目】${project}`,
    `【${styleLine}】`,
    `【已有角色名】${existing.length ? existing.join("、") : "暂无"}`,
    `【禁用名字】${forbidden.length ? forbidden.join("、") : "无"}`,
    `【禁用风格】${input.forbiddenStyles.length ? input.forbiddenStyles.join("、") : "无"}`,
    `【锁定名字（不得建议替换）】${input.lockedNames.length ? input.lockedNames.join("、") : "无"}`,
    `【要求】生成不少于 ${input.count} 个候选；过滤已有名、禁用名和锁定名；对同音、近音、形近、同姓近似给出 similarityWarnings；每个候选必须给出六个维度的分项分数和 scoreEvidence；常见名不等于低质量，生僻字不等于高质量。`,
  ].join("\n");

  if (input.task === "batch") {
    const roles = input.roles.map((role, index) => rolePrompt(role, index)).join("\n\n");
    return `${common}

【批量任务】
${roles}

请为每个角色各生成候选，返回 JSON：
{
  "results": [
    { "index": 0, "candidates": [ ... ], "warnings": [] }
  ]
}`;
  }

  return `${common}

【人物信息】
${rolePrompt(input.role)}

请返回 JSON：
{
  "candidates": [
    {
      "name": "",
      "type": "本名 / 外号 / 代号 / 尊称",
      "style": "",
      "reason": "",
      "risks": [],
      "similarityWarnings": [],
      "breakdown": { "background": 0, "era": 0, "distinctiveness": 0, "naturalness": 0, "uniqueness": 0, "styleFit": 0 },
      "scoreEvidence": ""
    }
  ],
  "warnings": []
}`;
}

function readBreakdown(raw: unknown): NamingBreakdown {
  const record = (raw ?? {}) as Record<string, unknown>;
  const breakdown = {} as NamingBreakdown;
  for (const key of Object.keys(BREAKDOWN_CAPS) as (keyof NamingBreakdown)[]) {
    const value = Number(record[key]);
    const cap = BREAKDOWN_CAPS[key];
    if (!Number.isFinite(value) || value < 0 || value > cap) {
      throw new SkillError(
        "SKILL_OUTPUT_INVALID",
        `候选评分缺少有效分项 ${key}（0-${cap}），无法作为命名依据`,
      );
    }
    breakdown[key] = Math.round(value);
  }
  return breakdown;
}

function normalizeCandidate(
  raw: unknown,
  existing: string[],
): NamingCandidate | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const name = text(record.name, 20);
  if (!name) return null;
  const breakdown = readBreakdown(record.breakdown);
  const evidence = text(record.scoreEvidence, 1200);
  if (evidence.length < 10) {
    throw new SkillError(
      "SKILL_OUTPUT_INVALID",
      `候选「${name}」缺少具体评分依据，不能只给总分`,
    );
  }
  return {
    name,
    type: text(record.type, 20) || "本名",
    style: text(record.style, 40) || "未标注",
    score: Object.values(breakdown).reduce((sum, value) => sum + value, 0),
    breakdown,
    scoreEvidence: evidence,
    reason: text(record.reason, 400) || "未提供理由",
    risks: stringList(record.risks, 5),
    similarityWarnings: [
      ...new Set([
        ...stringList(record.similarityWarnings, 5),
        ...similarityWarnings(name, existing),
      ]),
    ],
  };
}

function finalizeCandidates(
  rawList: unknown,
  existing: string[],
  blocked: Set<string>,
  style: NamingStyle,
): { candidates: NamingCandidate[]; generatedCount: number; warnings: string[] } {
  if (!Array.isArray(rawList)) {
    throw new SkillError("SKILL_OUTPUT_INVALID", "模型输出缺少 candidates 数组");
  }
  const warnings: string[] = [];
  const byName = new Map<string, NamingCandidate>();
  for (const raw of rawList) {
    const candidate = normalizeCandidate(raw, existing);
    if (!candidate) continue;
    const key = normalizeNameKey(candidate.name);
    if (blocked.has(key)) {
      warnings.push(`候选「${candidate.name}」与已有/禁用/锁定名字冲突，已过滤`);
      continue;
    }
    const previous = byName.get(key);
    if (previous) {
      warnings.push(`候选「${candidate.name}」在模型输出中重复出现，已去重`);
      if (previous.score >= candidate.score) continue;
    }
    byName.set(key, candidate);
  }

  const candidates = [...byName.values()]
    .map((candidate) => ({
      ...candidate,
      style: candidate.style === "未标注" ? namingStyleLabel(style) : candidate.style,
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, 5);

  if (candidates.length < 5) {
    throw new SkillError(
      "SKILL_OUTPUT_INVALID",
      `有效候选只有 ${candidates.length} 个，至少需要 5 个；请重新生成或放宽禁用条件`,
    );
  }

  warnings.push("相似度检查为项目内本地启发式，未查询外部姓名语料库");
  return { candidates, generatedCount: rawList.length, warnings };
}

function mockPayload(
  input: NormalizedNamingInput,
  existing: string[],
  blocked: Set<string>,
): unknown {
  if (input.task === "batch") {
    const used = new Set(blocked);
    return {
      results: input.roles.map((role, index) => {
        const candidates = mockNamingCandidates(
          role,
          input.style,
          used,
          index * 13,
          input.count,
        );
        return { index, candidates };
      }),
    };
  }
  const used = new Set(blocked);
  return {
    candidates: mockNamingCandidates(input.role, input.style, used, 0, input.count),
  };
}

export async function runNamingSkill(
  slug: string,
  rawInput: Partial<NamingSkillInput> | undefined,
  options: { client?: LLMClient } = {},
): Promise<NamingResult | BatchNamingResult> {
  const provisionalTask =
    rawInput?.task === "batch"
      ? "batch"
      : rawInput?.task === "regenerate"
        ? "regenerate"
        : "generate";
  const manifest = await loadSkillForRun(
    "character-naming",
    provisionalTask,
    slug,
  );
  const config = await readProjectSkillConfig(slug);
  assertSkillEnabled(config, "character-naming");
  const detail = await getProjectDetail(slug);
  const input = normalizeInput(rawInput, config);
  const { names: existing, blocked } = existingNamesFrom(detail, input, config.naming);
  const client = resolveClient(options.client);
  const mode = client.isMock ? "mock" : "llm";
  const prompt = buildUserPrompt(
    detail,
    input,
    config,
    existing,
    input.forbiddenNames,
  );

  return withSkillLog(
    {
      slug,
      manifest,
      task: input.task,
      mode,
      client,
      inputChars: prompt.length,
    },
    async () => {
      const data = client.isMock
        ? mockPayload(input, existing, blocked)
        : await client.json<Record<string, unknown>>(
            [
              {
                role: "system",
                content: `你是 Quillmate 的「${manifest.name}」。严格按下面的技能说明工作，只输出 JSON。\n\n${manifest.instructions}`,
              },
              { role: "user", content: prompt },
            ],
            {
              agent: "character-naming",
              temperature: 0.9,
              maxTokens: 6000,
            },
          );

      if (input.task === "batch") {
        const record = (data ?? {}) as Record<string, unknown>;
        if (!Array.isArray(record.results)) {
          throw new SkillError(
            "SKILL_OUTPUT_INVALID",
            "批量命名输出缺少 results 数组",
          );
        }
        const used = new Set(blocked);
        const results = input.roles.map((_, index) => {
          const raw = (record.results as unknown[]).find(
            (item) =>
              item &&
              typeof item === "object" &&
              Number((item as Record<string, unknown>).index) === index,
          ) as Record<string, unknown> | undefined;
          if (!raw) {
            throw new SkillError(
              "SKILL_OUTPUT_INVALID",
              `批量命名缺少第 ${index + 1} 个角色的结果`,
            );
          }
          const finalized = finalizeCandidates(
            raw.candidates,
            existing,
            used,
            input.style,
          );
          for (const candidate of finalized.candidates) {
            used.add(normalizeNameKey(candidate.name));
          }
          return {
            index,
            candidates: finalized.candidates,
            recommendation: finalized.candidates[0].name,
            warnings: finalized.warnings,
          };
        });
        return {
          skillId: "character-naming" as const,
          skillVersion: manifest.version,
          task: "batch" as const,
          results,
          existingNames: existing,
        };
      }

      const record = (data ?? {}) as Record<string, unknown>;
      const finalized = finalizeCandidates(
        record.candidates,
        existing,
        blocked,
        input.style,
      );
      return {
        skillId: "character-naming" as const,
        skillVersion: manifest.version,
        task: input.task,
        candidates: finalized.candidates,
        recommendation: finalized.candidates[0].name,
        warnings: [
          ...stringList(record.warnings, 10),
          ...finalized.warnings,
        ],
        generatedCount: finalized.generatedCount,
        existingNames: existing,
      };
    },
  );
}
