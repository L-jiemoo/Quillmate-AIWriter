import { getProjectDetail, getStory } from "../store";
import type { LLMClient } from "../llm";
import type { Character } from "../types";
import { assertSkillEnabled, readProjectSkillConfig } from "./config";
import {
  applyCharacterDesignPatch,
  loadCharacterDesigns,
} from "./designs";
import { mockCharacterDesign } from "./mock";
import { loadSkillForRun, resolveClient, withSkillLog } from "./runtime";
import {
  CHARACTER_DESIGN_FIELDS,
  SkillError,
  type CharacterDesignField,
  type CharacterDesignFields,
  type CharacterDesignRecord,
  type CharacterDesignResult,
} from "./types";

export type CharacterDesignMode = "design" | "analyze";

export interface CharacterDesignSkillInput {
  characterName: string;
  mode?: CharacterDesignMode;
  focus?: string;
}

function text(value: unknown, max = 2000): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function characterText(character: Character): string {
  const lines = [
    `姓名：${character.name}`,
    `角色定位：${character.role || "未填写"}`,
    `性别：${character.gender || "未填写"}`,
    `年龄：${character.age || "未填写"}`,
    `外貌：${character.appearance || "未填写"}`,
    `性格：${character.personality || "未填写"}`,
    `背景：${character.background || "未填写"}`,
    `目标与欲望：${character.goals || "未填写"}`,
    `成长弧光：${character.arc || "未填写"}`,
    `人物关系：${character.relationships || "未填写"}`,
    `说话风格：${character.speechStyle || "未填写"}`,
  ];
  return lines.join("\n");
}

function fieldsText(
  fields: CharacterDesignFields | undefined,
  locked: CharacterDesignField[],
): string {
  if (!fields) return "（暂无结构化内在设定）";
  return CHARACTER_DESIGN_FIELDS.map((key) => {
    const value = fields[key]?.trim();
    if (!value) return "";
    return `- ${key}${locked.includes(key) ? "（作者已锁定，不得修改）" : ""}：${value}`;
  })
    .filter(Boolean)
    .join("\n");
}

async function buildContext(
  slug: string,
  character: Character,
  mode: CharacterDesignMode,
  focus: string,
): Promise<{
  prompt: string;
  lockedFields: CharacterDesignField[];
  existing?: CharacterDesignRecord;
  otherNames: string[];
}> {
  const detail = await getProjectDetail(slug);
  const designs = await loadCharacterDesigns(slug);
  const existing = designs[character.name];
  const story = await getStory(slug);
  const canonCharacter = detail.canon.characters.find(
    (item) => item.name === character.name,
  );
  const relatedRelations = (detail.planLedger?.relations ?? [])
    .filter(
      (relation) =>
        relation.from === character.name || relation.to === character.name,
    )
    .slice(0, 12)
    .map(
      (relation) =>
        `- ${relation.from} → ${relation.to}：${relation.type || "关系"}；强度 ${relation.strength}；方向 ${relation.direction}；状态 ${relation.status}；证据 ${relation.evidence || "未注明"}`,
    )
    .join("\n");
  const storyStates = story.states
    .filter((state) => state.name === character.name)
    .slice(-3)
    .map(
      (state) =>
        `- 第 ${state.chapter} 章：${state.lifeStatus}；位置 ${state.location || "未知"}；目标 ${state.goals.join("、") || "未知"}；掌握信息 ${state.knowledge.join("、") || "未知"}`,
    )
    .join("\n");
  const storyEvents = story.events
    .filter((event) => event.participants.includes(character.name))
    .slice(-6)
    .map((event) => `- 第 ${event.chapter} 章：${event.name}；结果：${event.result || "未记录"}`)
    .join("\n");
  const recentChapters = detail.chapters
    .filter((chapter) => chapter.written)
    .slice(-5)
    .map(
      (chapter) =>
        `- 第 ${chapter.index} 章《${chapter.title}》：${detail.state.summaries[String(chapter.index)] || "无摘要"}`,
    )
    .join("\n");

  const prompt = `【项目】《${detail.meta.title}》（${detail.meta.genre} / ${detail.meta.tone}）
【任务】${mode === "analyze" ? "人物行为一致性审查与设定补全" : "人物设定补全"}${focus ? `；作者补充要求：${focus}` : ""}

【人物档案】
${characterText(character)}

【作者已确认的结构化设定】
${fieldsText(existing?.fields, existing?.lockedFields ?? [])}

【事实台账中的当前状态】
${
  canonCharacter
    ? `生死：${canonCharacter.status}；位置：${canonCharacter.location || "未知"}；最近确认章节：${canonCharacter.chapter}；状态确立章节：${canonCharacter.statusChapter}`
    : "（尚未进入事实台账）"
}

【人物关系图（计划）】
${relatedRelations || "（暂无结构化关系）"}

【剧情台账中的当前状态】
${storyStates || "（暂无已写状态）"}

【与人物相关的已发生事件】
${storyEvents || "（暂无已写事件）"}

【最近章节摘要】
${recentChapters || "（暂无已写章节）"}

【输出要求】
只输出 JSON；design 必须包含全部字段，每个字段都要具体、可执行，不得只写形容词。
无法确认的信息只能写成推断，并放入 warnings；不得把推断当成已发生事实。
作者锁定字段不得修改，只能作为约束参考。
请返回：
{
  "design": {
    "coreDesire": "",
    "fear": "",
    "weakness": "",
    "contradiction": "",
    "secret": "",
    "values": "",
    "habits": "",
    "speechHabits": "",
    "growthArc": "",
    "currentPsychology": ""
  },
  "behaviorChecks": [
    { "chapter": 0, "issue": "", "evidence": "", "suggestion": "" }
  ],
  "similarities": [
    { "character": "", "issue": "", "suggestion": "" }
  ],
  "warnings": []
}`;
  return {
    prompt,
    lockedFields: existing?.lockedFields ?? [],
    existing,
    otherNames: detail.characters
      .map((item) => item.name)
      .filter((name) => name && name !== character.name),
  };
}

function readDesign(raw: unknown): CharacterDesignFields {
  const record = (raw ?? {}) as Record<string, unknown>;
  const fields = {} as CharacterDesignFields;
  for (const key of CHARACTER_DESIGN_FIELDS) {
    const value = text(record[key]);
    if (value.length < 4) {
      throw new SkillError(
        "SKILL_OUTPUT_INVALID",
        `人物设定字段 ${key} 缺失或过于空泛，至少需要具体行为描述`,
      );
    }
    fields[key] = value;
  }
  if (fields.habits.length < 8 || fields.speechHabits.length < 8) {
    throw new SkillError(
      "SKILL_OUTPUT_INVALID",
      "人物习惯或语言习惯过于空泛，必须包含可观察的行为表现",
    );
  }
  return fields;
}

function stringList(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => text(item, 500))
    .filter(Boolean)
    .slice(0, maxItems);
}

export async function runCharacterDesignSkill(
  slug: string,
  input: CharacterDesignSkillInput,
  options: { client?: LLMClient } = {},
): Promise<CharacterDesignResult> {
  const characterName = text(input?.characterName, 80);
  if (!characterName) {
    throw new SkillError("SKILL_INPUT_INVALID", "请指定要分析的人物姓名");
  }
  const mode: CharacterDesignMode = input.mode === "analyze" ? "analyze" : "design";
  const manifest = await loadSkillForRun("character-design", mode, slug);
  const config = await readProjectSkillConfig(slug);
  assertSkillEnabled(config, "character-design");
  const detail = await getProjectDetail(slug);
  const character = detail.characters.find(
    (item) => item.name.trim() === characterName,
  );
  if (!character) {
    throw new SkillError(
      "SKILL_INPUT_INVALID",
      `人物档案中找不到「${characterName}」`,
    );
  }

  const context = await buildContext(
    slug,
    character,
    mode,
    text(input.focus, 500),
  );
  const client = resolveClient(options.client);
  const modeLabel = client.isMock ? "mock" : "llm";

  return withSkillLog(
    {
      slug,
      manifest,
      task: mode,
      mode: modeLabel,
      client,
      inputChars: context.prompt.length,
    },
    async () => {
      const mock = mockCharacterDesign(
        character.name,
        character.role,
        context.otherNames,
      );
      const data = client.isMock
        ? {
            design: mock.design,
            behaviorChecks: [],
            similarities: mock.similarities,
            warnings: ["当前为 mock 模式，设定由本地规则生成，未调用真实模型"],
          }
        : await client.json<Record<string, unknown>>(
            [
              {
                role: "system",
                content: `你是 Quillmate 的「${manifest.name}」。严格按技能说明工作，只输出 JSON。\n\n${manifest.instructions}`,
              },
              { role: "user", content: context.prompt },
            ],
            {
              agent: "character-design",
              temperature: 0.7,
              maxTokens: 4000,
            },
          );

      const record = (data ?? {}) as Record<string, unknown>;
      const design = readDesign(record.design);
      const behaviorChecks = Array.isArray(record.behaviorChecks)
        ? record.behaviorChecks
            .slice(0, 20)
            .map((item) => {
              const entry = (item ?? {}) as Record<string, unknown>;
              return {
                chapter: Number(entry.chapter) || 0,
                issue: text(entry.issue, 500),
                evidence: text(entry.evidence, 800),
                suggestion: text(entry.suggestion, 500),
              };
            })
            .filter((item) => item.issue)
        : [];
      const similarities = Array.isArray(record.similarities)
        ? record.similarities
            .slice(0, 10)
            .map((item) => {
              const entry = (item ?? {}) as Record<string, unknown>;
              return {
                character: text(entry.character, 80),
                issue: text(entry.issue, 500),
                suggestion: text(entry.suggestion, 500),
              };
            })
            .filter((item) => item.character && item.issue)
        : [];

      const locked = context.lockedFields;
      const appliedFields = CHARACTER_DESIGN_FIELDS.filter(
        (key) => !locked.includes(key),
      );
      const skippedFields = CHARACTER_DESIGN_FIELDS.filter((key) =>
        locked.includes(key),
      );

      return {
        character: character.name,
        design,
        behaviorChecks,
        similarities,
        warnings: stringList(record.warnings, 20),
        lockedFields: [...locked],
        appliedFields: [...appliedFields],
        skippedFields: [...skippedFields],
        skillVersion: manifest.version,
      };
    },
  );
}

export async function applyCharacterDesign(
  slug: string,
  characterName: string,
  fields: Partial<CharacterDesignFields>,
  options: {
    lockFields?: CharacterDesignField[];
    unlockFields?: CharacterDesignField[];
    force?: boolean;
  } = {},
): Promise<{
  record: CharacterDesignRecord;
  applied: CharacterDesignField[];
  skipped: CharacterDesignField[];
}> {
  const name = text(characterName, 80);
  if (!name) {
    throw new SkillError("SKILL_INPUT_INVALID", "人物姓名不能为空");
  }
  const detail = await getProjectDetail(slug);
  if (!detail.characters.some((item) => item.name.trim() === name)) {
    throw new SkillError(
      "SKILL_INPUT_INVALID",
      `人物档案中找不到「${name}」`,
    );
  }
  return applyCharacterDesignPatch(
    slug,
    {
      name,
      fields,
      lockFields: options.lockFields,
      unlockFields: options.unlockFields,
      source: options.force ? "user" : "ai",
      skillVersion: "1.0.0",
    },
    {
      force: options.force === true,
      lockProvided: options.force === true,
    },
  );
}
