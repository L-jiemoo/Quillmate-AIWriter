"use client";

import { useCallback, useEffect, useState } from "react";
import type { Character, ProjectDetail } from "@/lib/types";
import {
  CHARACTER_DESIGN_FIELDS,
  NAMING_STYLES,
  type CharacterDesignField,
  type CharacterDesignFields,
  type CharacterDesignRecord,
  type CharacterDesignResult,
  type NameCheckResult,
  type NamingBreakdown,
  type NamingCandidate,
  type NamingResult,
  type NamingStyle,
  type ProjectSkillConfig,
} from "@/lib/skills/types";
import type { RenameReport } from "@/lib/skills/rename";
import { errorMessage } from "@/lib/utils";

const DESIGN_LABELS: Record<CharacterDesignField, string> = {
  coreDesire: "核心欲望",
  fear: "最大恐惧",
  weakness: "人物弱点",
  contradiction: "内在矛盾",
  secret: "秘密",
  values: "价值观",
  habits: "行为习惯",
  speechHabits: "语言习惯",
  growthArc: "成长弧线",
  currentPsychology: "当前心理",
};

const DESIGN_SHORT_FIELDS: CharacterDesignField[] = [
  "coreDesire",
  "fear",
  "weakness",
  "habits",
  "speechHabits",
  "growthArc",
];

function breakdownText(breakdown: NamingBreakdown): string {
  return `背景 ${breakdown.background}/25 · 时代 ${breakdown.era}/20 · 辨识 ${breakdown.distinctiveness}/20 · 自然 ${breakdown.naturalness}/15 · 区分 ${breakdown.uniqueness}/10 · 风格 ${breakdown.styleFit}/10`;
}

const EMPTY_CHARACTER: Character = {
  name: "",
  role: "配角",
  gender: "",
  age: "",
  appearance: "",
  personality: "",
  background: "",
  goals: "",
  arc: "",
  relationships: "",
  speechStyle: "",
};

const READ_FIELDS: { key: keyof Character; label: string }[] = [
  { key: "personality", label: "性格" },
  { key: "goals", label: "目标" },
  { key: "relationships", label: "关系" },
  { key: "speechStyle", label: "口吻" },
];

function blankCharacter(): Character {
  return { ...EMPTY_CHARACTER };
}

export function CharactersTab({
  detail,
  onRefresh,
}: {
  detail: ProjectDetail;
  onRefresh: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<Character[]>(detail.characters);
  const [dirty, setDirty] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonText, setJsonText] = useState(() => JSON.stringify(detail.characters, null, 2));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [skillConfig, setSkillConfig] = useState<ProjectSkillConfig | null>(null);
  const [designs, setDesigns] = useState<Record<string, CharacterDesignRecord>>({});
  const [namingPanel, setNamingPanel] = useState<{
    index: number;
    loading: boolean;
    style: NamingStyle;
    candidates: NamingCandidate[];
    warnings: string[];
    error: string;
  } | null>(null);
  const [batchPanel, setBatchPanel] = useState<{
    loading: boolean;
    items: {
      index: number;
      name: string;
      candidates: NamingCandidate[];
      warnings: string[];
    }[];
    error: string;
  } | null>(null);
  const [designPanel, setDesignPanel] = useState<{
    index: number;
    loading: boolean;
    mode: "design" | "analyze";
    result: CharacterDesignResult | null;
    values: Partial<CharacterDesignFields>;
    error: string;
  } | null>(null);
  const [nameCheck, setNameCheck] = useState<NameCheckResult | null>(null);
  const [renamePanel, setRenamePanel] = useState<{
    from: string;
    to: string;
    preview: RenameReport | null;
    loading: boolean;
    error: string;
  } | null>(null);
  const [skillBusy, setSkillBusy] = useState(false);
  const [skillNotice, setSkillNotice] = useState("");
  const slug = detail.meta.slug;

  const loadSkills = useCallback(async () => {
    try {
      const response = await fetch(`/api/projects/${slug}/skills`, {
        cache: "no-store",
      });
      const data = (await response.json()) as {
        config?: ProjectSkillConfig;
        designs?: Record<string, CharacterDesignRecord>;
        error?: string;
      };
      if (!response.ok) throw new Error(data.error ?? "读取技能配置失败");
      setSkillConfig(data.config ?? null);
      setDesigns(data.designs ?? {});
    } catch (err) {
      setSkillNotice(`技能配置读取失败：${errorMessage(err)}`);
    }
  }, [slug]);

  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  function skillEnabled(id: keyof ProjectSkillConfig["enabled"]): boolean {
    return skillConfig?.enabled[id] !== false;
  }

  useEffect(() => {
    // 后台任务完成会刷新 detail；如果有未保存的本地修改，
    // 不能用服务端数据覆盖草稿，否则用户正在编辑的人物卡会丢失。
    if (!dirty) {
      setDraft(detail.characters);
      setJsonText(JSON.stringify(detail.characters, null, 2));
    }
  }, [detail.characters, dirty]);

  function updateCharacter(index: number, key: keyof Character, value: string) {
    setDraft((previous) =>
      previous.map((character, i) => (i === index ? { ...character, [key]: value } : character)),
    );
    setDirty(true);
    setError("");
  }

  function addCharacter() {
    setDraft((previous) => [...previous, blankCharacter()]);
    setEditingIndex(draft.length);
    setDirty(true);
    setError("");
  }

  function removeCharacter(index: number) {
    const name = draft[index]?.name?.trim() || "未命名角色";
    if (!window.confirm(`确定删除角色「${name}」吗？点击「保存全部」后才会真正生效。`)) return;
    setDraft((previous) => previous.filter((_, i) => i !== index));
    setEditingIndex(null);
    setDirty(true);
    setError("");
  }

  function cancelEdits() {
    setDraft(detail.characters);
    setJsonText(JSON.stringify(detail.characters, null, 2));
    setDirty(false);
    setEditingIndex(null);
    setJsonMode(false);
    setError("");
  }

  function parseJson(): Character[] | null {
    try {
      const parsed = JSON.parse(jsonText) as unknown;
      if (!Array.isArray(parsed)) throw new Error("JSON 顶层必须是数组");
      // 高级模式允许用户只粘贴部分字段；先用空模板补齐，
      // 保证后续卡片渲染和保存时所有字段都是字符串。
      return parsed.map((item) =>
        item && typeof item === "object"
          ? { ...blankCharacter(), ...(item as Partial<Character>) }
          : blankCharacter(),
      );
    } catch (err) {
      setError(`JSON 解析失败：${errorMessage(err)}`);
      return null;
    }
  }

  function toggleJsonMode() {
    if (!jsonMode) {
      setJsonText(JSON.stringify(draft, null, 2));
      setEditingIndex(null);
      setJsonMode(true);
      setError("");
      return;
    }
    const characters = parseJson();
    if (!characters) return;
    if (JSON.stringify(characters) !== JSON.stringify(draft)) {
      setDraft(characters);
      setDirty(true);
    }
    setJsonMode(false);
    setError("");
  }

  async function save() {
    let characters = draft;
    if (jsonMode) {
      const parsed = parseJson();
      if (!parsed) return;
      characters = parsed;
      setDraft(parsed);
    }

    if (characters.some((character) => !character.name.trim())) {
      setError("请为每个角色填写姓名后再保存");
      return;
    }

    setSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/projects/${detail.meta.slug}/characters`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ characters }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "保存失败");
      setDirty(false);
      setEditingIndex(null);
      setJsonMode(false);
      setJsonText(JSON.stringify(characters, null, 2));
      await onRefresh();

      // 人物卡改名只改档案，正文和台账不会自动跟着改。
      // 这里把新旧姓名配对好填进「全书改名」，避免用户以为正文已经同步。
      const renames: { from: string; to: string }[] = [];
      if (characters.length === detail.characters.length) {
        detail.characters.forEach((item, index) => {
          const oldName = item.name.trim();
          const newName = characters[index]?.name.trim() ?? "";
          if (oldName && newName && oldName !== newName) {
            renames.push({ from: oldName, to: newName });
          }
        });
      }
      if (renames.length === 1) {
        setRenamePanel({
          from: renames[0].from,
          to: renames[0].to,
          preview: null,
          loading: false,
          error: "",
        });
        setSkillNotice(
          "人物卡已保存。正文与台账里的旧姓名不会自动替换，已为你填好「全书改名」，请预览影响后确认。",
        );
      } else if (renames.length > 1) {
        setSkillNotice(
          `人物卡已保存，有 ${renames.length} 位角色改了姓名；正文不会自动改，请用「全书改名」逐个同步。`,
        );
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  function roleOf(index: number) {
    const character = draft[index];
    return {
      role: character.role,
      gender: character.gender,
      age: character.age,
      identity: character.role,
      personality: character.personality,
      background: character.background,
      type: "本名",
    };
  }

  async function generateName(
    index: number,
    style: NamingStyle,
    task: "generate" | "regenerate" = "generate",
  ) {
    setNamingPanel({
      index,
      loading: true,
      style,
      candidates: namingPanel?.index === index ? namingPanel.candidates : [],
      warnings: [],
      error: "",
    });
    setSkillNotice("");
    try {
      const response = await fetch(`/api/projects/${slug}/skills/naming`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task,
          style,
          count: 20,
          role: roleOf(index),
          lockedNames: draft
            .map((character) => character.name.trim())
            .filter(Boolean),
          avoidNames:
            task === "regenerate" && namingPanel?.index === index
              ? namingPanel.candidates.map((candidate) => candidate.name)
              : [],
        }),
      });
      const data = (await response.json()) as NamingResult & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "生成名字失败");
      setNamingPanel({
        index,
        loading: false,
        style,
        candidates: data.candidates,
        warnings: data.warnings,
        error: "",
      });
    } catch (err) {
      setNamingPanel((current) =>
        current ? { ...current, loading: false, error: errorMessage(err) } : current,
      );
    }
  }

  async function runBatchNaming() {
    const blanks = draft
      .map((character, index) => ({ character, index }))
      .filter((item) => !item.character.name.trim());
    if (!blanks.length) {
      setSkillNotice("没有空姓名的角色。请先「新增角色」并填写定位，再批量取名。");
      return;
    }
    setBatchPanel({
      loading: true,
      items: blanks.map((item) => ({
        index: item.index,
        name: item.character.role || "未命名角色",
        candidates: [],
        warnings: [],
      })),
      error: "",
    });
    try {
      const response = await fetch(`/api/projects/${slug}/skills/naming`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task: "batch",
          count: 20,
          roles: blanks.map((item) => roleOf(item.index)),
          lockedNames: draft
            .map((character) => character.name.trim())
            .filter(Boolean),
        }),
      });
      const data = (await response.json()) as {
        results?: {
          index: number;
          candidates: NamingCandidate[];
          warnings: string[];
        }[];
        error?: string;
      };
      if (!response.ok || !data.results) {
        throw new Error(data.error ?? "批量取名失败");
      }
      setBatchPanel({
        loading: false,
        items: blanks.map((item, position) => {
          const result = data.results?.find((entry) => entry.index === position);
          return {
            index: item.index,
            name: item.character.role || "未命名角色",
            candidates: result?.candidates ?? [],
            warnings: result?.warnings ?? [],
          };
        }),
        error: "",
      });
    } catch (err) {
      setBatchPanel((current) =>
        current ? { ...current, loading: false, error: errorMessage(err) } : current,
      );
    }
  }

  function applyName(index: number, name: string) {
    const current = draft[index]?.name.trim();
    if (
      current &&
      current !== name &&
      !window.confirm(
        `把「${current}」替换为「${name}」吗？只会写入当前草稿，点「保存全部」后才生效。`,
      )
    ) {
      return;
    }
    updateCharacter(index, "name", name);
    setNamingPanel(null);
    setSkillNotice(`已把「${name}」填入草稿；保存全部后才会写入项目。`);
  }

  function applyBatchName(index: number, name: string) {
    updateCharacter(index, "name", name);
    setBatchPanel((current) =>
      current
        ? { ...current, items: current.items.filter((item) => item.index !== index) }
        : current,
    );
    setSkillNotice(`已把「${name}」填入草稿；保存全部后才会写入项目。`);
  }

  async function checkBookNames() {
    setSkillBusy(true);
    setNameCheck(null);
    setSkillNotice("");
    try {
      const response = await fetch(`/api/projects/${slug}/skills/naming`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ check: true }),
      });
      const data = (await response.json()) as NameCheckResult & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "撞名检查失败");
      setNameCheck(data);
    } catch (err) {
      setSkillNotice(`撞名检查失败：${errorMessage(err)}`);
    } finally {
      setSkillBusy(false);
    }
  }

  function openRenamePanel(name = "") {
    setSkillNotice("");
    setRenamePanel({ from: name, to: "", preview: null, loading: false, error: "" });
  }

  async function previewRename() {
    if (!renamePanel) return;
    const from = renamePanel.from.trim();
    const to = renamePanel.to.trim();
    if (!from || !to) {
      setRenamePanel({ ...renamePanel, error: "请先填写旧姓名和新姓名" });
      return;
    }
    if (dirty) {
      setRenamePanel({ ...renamePanel, error: "请先保存或撤销人物卡修改，再执行全书改名" });
      return;
    }
    setRenamePanel({ ...renamePanel, loading: true, error: "", preview: null });
    try {
      const response = await fetch(`/api/projects/${slug}/skills/naming/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from, to, dryRun: true }),
      });
      const data = (await response.json()) as RenameReport & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "预览改名影响失败");
      setRenamePanel({ from, to, preview: data, loading: false, error: "" });
    } catch (err) {
      setRenamePanel((current) =>
        current
          ? { ...current, loading: false, error: errorMessage(err) }
          : current,
      );
    }
  }

  async function applyRename() {
    if (!renamePanel?.preview || renamePanel.loading) return;
    const { from, to, preview } = renamePanel;
    const confirmed = window.confirm(
      `确认把「${from}」全部改为「${to}」？\n\n会同步修改：\n· ${preview.totals.chapters} 章正文，共 ${preview.totals.occurrences} 处\n· 人物档案、事实台账、计划台账、记忆与剧情台账\n· 章节大纲、世界观与主线设定、人物内在设定\n\n每章正文修改前会保留历史版本，可在「历史版本」里恢复。继续？`,
    );
    if (!confirmed) return;

    setRenamePanel({ ...renamePanel, loading: true, error: "" });
    try {
      const response = await fetch(`/api/projects/${slug}/skills/naming/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from, to, confirm: true }),
      });
      const data = (await response.json()) as RenameReport & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "全书改名失败");
      // 先清空本地草稿状态，避免刷新后用户未保存的旧姓名覆盖服务端结果。
      setDirty(false);
      await onRefresh();
      await loadSkills();
      setRenamePanel(null);
      setSkillNotice(
        `已将「${from}」改为「${to}」，正文替换 ${data.totals.occurrences} 处。`,
      );
    } catch (err) {
      setRenamePanel((current) =>
        current
          ? { ...current, loading: false, error: errorMessage(err) }
          : current,
      );
    }
  }

  async function openDesign(index: number, mode: "design" | "analyze") {
    const character = draft[index];
    const name = character.name.trim();
    if (!name) {
      setSkillNotice("请先给角色填写姓名，再做人物塑造分析。");
      return;
    }
    setDesignPanel({
      index,
      loading: true,
      mode,
      result: null,
      values: {},
      error: "",
    });
    setSkillNotice("");
    try {
      const response = await fetch(`/api/projects/${slug}/skills/design`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ characterName: name, mode }),
      });
      const data = (await response.json()) as CharacterDesignResult & {
        error?: string;
      };
      if (!response.ok) throw new Error(data.error ?? "人物分析失败");
      setDesignPanel({
        index,
        loading: false,
        mode,
        result: data,
        values: { ...data.design },
        error: "",
      });
    } catch (err) {
      setDesignPanel((current) =>
        current ? { ...current, loading: false, error: errorMessage(err) } : current,
      );
    }
  }

  function setDesignValue(field: CharacterDesignField, value: string) {
    setDesignPanel((current) =>
      current ? { ...current, values: { ...current.values, [field]: value } } : current,
    );
  }

  async function saveDesign(manual: boolean) {
    if (!designPanel) return;
    const character = draft[designPanel.index];
    const name = character?.name.trim();
    if (!name) return;
    const fields: Partial<CharacterDesignFields> = {};
    for (const field of CHARACTER_DESIGN_FIELDS) {
      const value = designPanel.values[field];
      if (typeof value === "string" && value.trim()) fields[field] = value;
    }
    if (!Object.keys(fields).length) {
      setDesignPanel({ ...designPanel, error: "没有可保存的设定字段" });
      return;
    }
    setDesignPanel({ ...designPanel, loading: true, error: "" });
    try {
      const response = await fetch(`/api/projects/${slug}/skills/design/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          characterName: name,
          fields,
          confirm: true,
          mode: manual ? "manual" : "ai",
        }),
      });
      const data = (await response.json()) as {
        record?: CharacterDesignRecord;
        applied?: CharacterDesignField[];
        skipped?: CharacterDesignField[];
        error?: string;
      };
      if (!response.ok || !data.record) {
        throw new Error(data.error ?? "保存人物设定失败");
      }
      setDesigns((current) => ({ ...current, [name]: data.record as CharacterDesignRecord }));
      setDesignPanel((current) =>
        current ? { ...current, loading: false, error: "" } : current,
      );
      setSkillNotice(
        `人物设定已保存：写入 ${data.applied?.length ?? 0} 项${
          data.skipped?.length ? `，跳过 ${data.skipped.length} 项锁定字段` : ""
        }。`,
      );
    } catch (err) {
      setDesignPanel((current) =>
        current ? { ...current, loading: false, error: errorMessage(err) } : current,
      );
    }
  }

  async function unlockDesignField(name: string, field: CharacterDesignField) {
    try {
      const response = await fetch(`/api/projects/${slug}/skills/design/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          characterName: name,
          fields: {},
          unlockFields: [field],
          confirm: true,
          mode: "manual",
        }),
      });
      const data = (await response.json()) as {
        record?: CharacterDesignRecord;
        error?: string;
      };
      if (!response.ok || !data.record) {
        throw new Error(data.error ?? "解锁字段失败");
      }
      setDesigns((current) => ({ ...current, [name]: data.record as CharacterDesignRecord }));
    } catch (err) {
      setSkillNotice(`解锁失败：${errorMessage(err)}`);
    }
  }

  const empty = !draft.length;

  return (
    <div className="characters">
      <datalist id="character-role-options">
        {["主角", "核心配角", "反派", "导师", "配角", "群像角色"].map((role) => (
          <option key={role} value={role} />
        ))}
      </datalist>
      <datalist id="character-gender-options">
        {["男", "女", "其他", "不详"].map((gender) => (
          <option key={gender} value={gender} />
        ))}
      </datalist>

      <div className="section-head">
        <div>
          <h2 className="section-title">
            角色档案
            <span className="char-count">{draft.length} 位</span>
          </h2>
          <p className="muted small">
            点卡片右上角「编辑」修改人物卡，调整后点「保存全部」生效。人物设定会注入写作提示词。
          </p>
        </div>
        <div className="char-toolbar">
          {dirty ? <span className="dirty-badge">有未保存的修改</span> : null}
          {dirty ? (
            <button className="btn btn-ghost btn-sm" onClick={cancelEdits}>
              撤销修改
            </button>
          ) : null}
          <button className="btn btn-ghost btn-sm" onClick={toggleJsonMode}>
            {jsonMode ? "应用并返回卡片" : "高级 JSON"}
          </button>
          {skillEnabled("character-naming") ? (
            <>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => void checkBookNames()}
                disabled={skillBusy || jsonMode}
              >
                {skillBusy ? "检查中…" : "全书撞名检查"}
              </button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => openRenamePanel()}
                disabled={skillBusy || jsonMode || dirty}
                title={
                  dirty
                    ? "请先保存人物卡修改，再执行全书改名"
                    : "同步修改正文、档案与台账里的人名"
                }
              >
                全书改名
              </button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => void runBatchNaming()}
                disabled={jsonMode || batchPanel?.loading}
              >
                批量取名
              </button>
            </>
          ) : null}
          <button className="btn btn-sm" onClick={addCharacter} disabled={jsonMode}>
            新增角色
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={save}
            disabled={!dirty || saving}
          >
            {saving ? "保存中…" : "保存全部"}
          </button>
        </div>
      </div>

      {error ? <p className="form-error">{error}</p> : null}
      {skillNotice ? <p className="hint skill-notice">{skillNotice}</p> : null}

      {nameCheck ? (
        <section className="panel skill-panel">
          <div className="panel-head">
            <h3>全书人物撞名检查</h3>
            <button className="btn btn-ghost btn-sm" onClick={() => setNameCheck(null)}>
              关闭
            </button>
          </div>
          <div className="panel-body">
            <p className="muted small">
              共检查 {nameCheck.checked} 个名字；使用项目内字形、近音与同名规则，未查询外部姓名语料库。
            </p>
            {nameCheck.duplicates.map((item) => (
              <p className="form-error" key={`dup-${item.name}`}>
                完全重名：「{item.name}」（{item.sources.join("、")}）
              </p>
            ))}
            {nameCheck.similar.map((item) => (
              <p className={item.level === "high" ? "form-error" : "hint"} key={`${item.name}-${item.other}`}>
                「{item.name}」与「{item.other}」{item.reason}
              </p>
            ))}
            {!nameCheck.duplicates.length && !nameCheck.similar.length ? (
              <p className="hint">未发现重名或近音、形近风险。</p>
            ) : null}
          </div>
        </section>
      ) : null}

      {renamePanel ? (
        <section className="panel skill-panel">
          <div className="panel-head">
            <h3>全书改名</h3>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setRenamePanel(null)}
            >
              关闭
            </button>
          </div>
          <div className="panel-body">
            <p className="muted small">
              先预览影响范围，再确认执行。会同步替换章节正文、人物档案、事实台账、计划台账、记忆与人物设定；包含旧名的更长姓名（例如「李明华」）会自动跳过。
            </p>
            <div className="field-row-2">
              <label className="field">
                <span>旧姓名</span>
                <input
                  className="input"
                  list="character-rename-options"
                  value={renamePanel.from}
                  onChange={(event) =>
                    setRenamePanel((current) =>
                      current
                        ? {
                            ...current,
                            from: event.target.value,
                            preview: null,
                          }
                        : current,
                    )
                  }
                  placeholder="例如：李明"
                />
              </label>
              <label className="field">
                <span>新姓名</span>
                <input
                  className="input"
                  value={renamePanel.to}
                  onChange={(event) =>
                    setRenamePanel((current) =>
                      current
                        ? {
                            ...current,
                            to: event.target.value,
                            preview: null,
                          }
                        : current,
                    )
                  }
                  placeholder="例如：张伟"
                />
              </label>
            </div>
            <datalist id="character-rename-options">
              {[
                ...new Set([
                  ...detail.characters.map((item) => item.name),
                  ...detail.canon.characters.map((item) => item.name),
                  ...detail.canon.characters.flatMap(
                    (item) => item.aliases ?? [],
                  ),
                ]),
              ]
                .filter(Boolean)
                .map((name) => (
                  <option key={name} value={name} />
                ))}
            </datalist>
            <div className="skill-panel-actions">
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => void previewRename()}
                disabled={renamePanel.loading}
              >
                {renamePanel.loading ? "处理中…" : "预览影响"}
              </button>
              <button
                className="btn btn-primary btn-sm"
                onClick={() => void applyRename()}
                disabled={!renamePanel.preview || renamePanel.loading}
              >
                确认改名
              </button>
            </div>
            {renamePanel.error ? (
              <p className="form-error">{renamePanel.error}</p>
            ) : null}
            {renamePanel.preview ? (
              <>
                <p className="muted small">
                  正文 {renamePanel.preview.totals.chapters} 章共{" "}
                  {renamePanel.preview.totals.occurrences} 处；人物档案{" "}
                  {renamePanel.preview.totals.characters} 处、事实台账{" "}
                  {renamePanel.preview.totals.canon} 处、计划台账{" "}
                  {renamePanel.preview.totals.ledger} 处、记忆{" "}
                  {renamePanel.preview.totals.memory} 处、剧情台账{" "}
                  {renamePanel.preview.totals.story} 处、人物设定{" "}
                  {renamePanel.preview.totals.designs} 处、大纲{" "}
                  {renamePanel.preview.totals.plan} 处、世界观{" "}
                  {renamePanel.preview.totals.world} 处、主线{" "}
                  {renamePanel.preview.totals.outline} 处。
                </p>
                {renamePanel.preview.chapters.map((chapter) => (
                  <p className="hint" key={`rename-${chapter.index}`}>
                    第 {chapter.index} 章《{chapter.title}》：{chapter.occurrences}{" "}
                    处
                  </p>
                ))}
                {renamePanel.preview.warnings.map((warning) => (
                  <p className="hint" key={warning}>
                    {warning}
                  </p>
                ))}
              </>
            ) : null}
          </div>
        </section>
      ) : null}

      {batchPanel ? (
        <section className="panel skill-panel">
          <div className="panel-head">
            <h3>批量取名</h3>
            <button className="btn btn-ghost btn-sm" onClick={() => setBatchPanel(null)}>
              关闭
            </button>
          </div>
          <div className="panel-body">
            <p className="muted small">
              为当前空姓名的角色各生成一组候选。采用后只填入草稿，点「保存全部」才会写入项目。
            </p>
            {batchPanel.loading ? <p className="hint">正在生成候选…</p> : null}
            {batchPanel.error ? <p className="form-error">{batchPanel.error}</p> : null}
            {batchPanel.items.map((item) => (
              <div className="skill-batch-row" key={item.index}>
                <strong>{item.name}</strong>
                <div className="skill-batch-candidates">
                  {item.candidates.slice(0, 3).map((candidate) => (
                    <button
                      key={candidate.name}
                      className="btn btn-ghost btn-sm"
                      onClick={() => applyBatchName(item.index, candidate.name)}
                    >
                      {candidate.name} · {candidate.score}
                    </button>
                  ))}
                </div>
                {item.warnings.length ? (
                  <span className="muted small">{item.warnings[0]}</span>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {namingPanel ? (
        <section className="panel skill-panel">
          <div className="panel-head">
            <h3>
              人物取名 · {draft[namingPanel.index]?.name || draft[namingPanel.index]?.role || "新角色"}
            </h3>
            <div className="char-toolbar">
              <select
                className="input input-sm"
                value={namingPanel.style}
                onChange={(event) =>
                  void generateName(
                    namingPanel.index,
                    event.target.value as NamingStyle,
                    "generate",
                  )
                }
              >
                {NAMING_STYLES.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() =>
                  void generateName(namingPanel.index, namingPanel.style, "regenerate")
                }
                disabled={namingPanel.loading}
              >
                重新生成
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => setNamingPanel(null)}>
                关闭
              </button>
            </div>
          </div>
          <div className="panel-body">
            {namingPanel.loading ? <p className="hint">正在生成 20 个候选并筛查…</p> : null}
            {namingPanel.error ? <p className="form-error">{namingPanel.error}</p> : null}
            {namingPanel.warnings.map((warning) => (
              <p className="hint" key={warning}>
                {warning}
              </p>
            ))}
            <div className="skill-candidate-grid">
              {namingPanel.candidates.map((candidate) => (
                <article className="skill-candidate" key={candidate.name}>
                  <header>
                    <strong>{candidate.name}</strong>
                    <span className="chip">{candidate.score} 分</span>
                    <span className="muted small">
                      {candidate.style} · {candidate.type}
                    </span>
                  </header>
                  <p>{candidate.reason}</p>
                  <p className="hint">{breakdownText(candidate.breakdown)}</p>
                  <p className="hint">依据：{candidate.scoreEvidence}</p>
                  {candidate.risks.map((risk) => (
                    <p className="hint" key={risk}>
                      风险：{risk}
                    </p>
                  ))}
                  {candidate.similarityWarnings.map((warning) => (
                    <p className="form-error" key={warning}>
                      {warning}
                    </p>
                  ))}
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => applyName(namingPanel.index, candidate.name)}
                  >
                    使用此名
                  </button>
                </article>
              ))}
            </div>
          </div>
        </section>
      ) : null}

      {designPanel ? (
        <section className="panel skill-panel">
          <div className="panel-head">
            <h3>
              人物设定 ·{" "}
              {draft[designPanel.index]?.name || "未命名角色"}
              {designPanel.mode === "analyze" ? " · 一致性分析" : ""}
            </h3>
            <div className="char-toolbar">
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => void openDesign(designPanel.index, designPanel.mode)}
                disabled={designPanel.loading}
              >
                重新分析
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => setDesignPanel(null)}>
                关闭
              </button>
            </div>
          </div>
          <div className="panel-body">
            {designPanel.loading ? <p className="hint">正在读取人物档案、关系图与台账…</p> : null}
            {designPanel.error ? <p className="form-error">{designPanel.error}</p> : null}
            {designPanel.result?.warnings.map((warning) => (
              <p className="hint" key={warning}>
                {warning}
              </p>
            ))}
            {designPanel.result?.behaviorChecks.map((check, index) => (
              <div className="skill-check" key={`behavior-${index}`}>
                <strong>第 {check.chapter || "?"} 章 · 行为检查</strong>
                <p>{check.issue}</p>
                <p className="hint">依据：{check.evidence}</p>
                <p className="hint">建议：{check.suggestion}</p>
              </div>
            ))}
            {designPanel.result?.similarities.map((item, index) => (
              <div className="skill-check" key={`similar-${index}`}>
                <strong>与「{item.character}」的区分度</strong>
                <p>{item.issue}</p>
                <p className="hint">建议：{item.suggestion}</p>
              </div>
            ))}
            <div className="skill-design-grid">
              {CHARACTER_DESIGN_FIELDS.map((field) => {
                const record = designs[draft[designPanel.index]?.name?.trim() ?? ""];
                const locked = record?.lockedFields.includes(field) ?? false;
                return (
                  <label className="field" key={field}>
                    <span>
                      {DESIGN_LABELS[field]}
                      {locked ? <span className="chip">已锁定</span> : null}
                      {locked ? (
                        <button
                          type="button"
                          className="link-btn"
                          onClick={() =>
                            void unlockDesignField(
                              draft[designPanel.index]?.name?.trim() ?? "",
                              field,
                            )
                          }
                        >
                          解锁
                        </button>
                      ) : null}
                    </span>
                    <textarea
                      className="input textarea-sm"
                      rows={2}
                      value={designPanel.values[field] ?? ""}
                      onChange={(event) => setDesignValue(field, event.target.value)}
                    />
                  </label>
                );
              })}
            </div>
            <div className="skill-panel-actions">
              <button
                className="btn btn-primary btn-sm"
                onClick={() => void saveDesign(false)}
                disabled={designPanel.loading || !designPanel.result}
              >
                应用 AI 设定（跳过锁定字段）
              </button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => void saveDesign(true)}
                disabled={designPanel.loading}
              >
                保存并锁定当前字段
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {jsonMode && dirty ? (
        <p className="hint">JSON 修改尚未应用，点「应用并返回卡片」或「保存全部」后生效。</p>
      ) : null}

      {jsonMode ? (
        <section className="panel">
          <div className="panel-body">
            <p className="muted small">
              高级模式：直接编辑角色数组，适合批量粘贴或导入。字段名保持英文键名。
            </p>
            <textarea
              className="input code-area character-editor"
              value={jsonText}
              onChange={(event) => {
                setJsonText(event.target.value);
                setDirty(true);
                setError("");
              }}
              spellCheck={false}
            />
            <p className="hint">
              字段：name / role / gender / age / appearance / personality / background / goals /
              arc / relationships / speechStyle
            </p>
          </div>
        </section>
      ) : empty ? (
        <div className="panel empty-state">
          <p className="empty-mark">人</p>
          <h3>还没有角色档案</h3>
          <p className="muted">点击「新增角色」手动创建，或回任务台让架构 Agent 生成一套角色。</p>
          <button className="btn btn-primary btn-sm" onClick={addCharacter}>
            新增角色
          </button>
        </div>
      ) : (
        <div className="character-grid">
          {draft.map((character, index) => {
            const editing = editingIndex === index;
            return (
              <article
                className={`character-card ${editing ? "editing" : ""}`}
                key={index}
              >
                <header className="char-head">
                  <div className="char-identity">
                    <span className="char-avatar">{character.name.trim().slice(0, 1) || "?"}</span>
                    <div>
                      <h3 className="char-name">{character.name || "未命名角色"}</h3>
                      <span className="char-role">{character.role || "角色"}</span>
                    </div>
                  </div>
                  <div className="char-actions">
                    {editing ? (
                      <>
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => setEditingIndex(null)}
                        >
                          完成编辑
                        </button>
                        <button
                          className="btn btn-primary btn-sm"
                          onClick={save}
                          disabled={saving}
                        >
                          保存全部
                        </button>
                      </>
                    ) : (
                      <>
                        {skillEnabled("character-naming") ? (
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => {
                              setEditingIndex(index);
                              setJsonMode(false);
                              setError("");
                              void generateName(
                                index,
                                skillConfig?.naming.style ?? "natural",
                                "generate",
                              );
                            }}
                          >
                            AI 取名
                          </button>
                        ) : null}
                        {skillEnabled("character-design") ? (
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => void openDesign(index, "analyze")}
                          >
                            AI 分析
                          </button>
                        ) : null}
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => {
                            setEditingIndex(index);
                            setJsonMode(false);
                            setError("");
                          }}
                        >
                          编辑
                        </button>
                        <button
                          className="btn btn-ghost btn-sm char-delete"
                          onClick={() => removeCharacter(index)}
                        >
                          删除
                        </button>
                      </>
                    )}
                  </div>
                </header>

                {editing ? (
                  <div className="char-edit-form">
                    <div className="field-row-2">
                      <label className="field">
                        <span>姓名 *</span>
                        <input
                          className="input"
                          value={character.name}
                          onChange={(event) => updateCharacter(index, "name", event.target.value)}
                          placeholder="角色姓名"
                        />
                      </label>
                      <label className="field">
                        <span>角色定位</span>
                        <input
                          className="input"
                          list="character-role-options"
                          value={character.role}
                          onChange={(event) => updateCharacter(index, "role", event.target.value)}
                          placeholder="主角 / 反派 / 导师……"
                        />
                      </label>
                    </div>
                    <div className="char-skill-actions">
                      {skillEnabled("character-naming") ? (
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() =>
                            void generateName(
                              index,
                              skillConfig?.naming.style ?? "natural",
                              "generate",
                            )
                          }
                        >
                          AI 取名
                        </button>
                      ) : null}
                      {skillEnabled("character-design") ? (
                        <>
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => void openDesign(index, "analyze")}
                          >
                            性格分析
                          </button>
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => void openDesign(index, "design")}
                          >
                            设定优化
                          </button>
                        </>
                      ) : null}
                    </div>
                    <div className="field-row-2">
                      <label className="field">
                        <span>性别</span>
                        <input
                          className="input"
                          list="character-gender-options"
                          value={character.gender}
                          onChange={(event) => updateCharacter(index, "gender", event.target.value)}
                          placeholder="男 / 女 / 其他"
                        />
                      </label>
                      <label className="field">
                        <span>年龄</span>
                        <input
                          className="input"
                          value={character.age}
                          onChange={(event) => updateCharacter(index, "age", event.target.value)}
                          placeholder="例如：十九岁"
                        />
                      </label>
                    </div>
                    <label className="field">
                      <span>外貌特征</span>
                      <textarea
                        className="input textarea-sm"
                        rows={2}
                        value={character.appearance}
                        onChange={(event) =>
                          updateCharacter(index, "appearance", event.target.value)
                        }
                        placeholder="身形、衣着、标志性特征"
                      />
                    </label>
                    <div className="field-row-2">
                      <label className="field">
                        <span>性格（含缺陷）</span>
                        <textarea
                          className="input textarea-sm"
                          rows={3}
                          value={character.personality}
                          onChange={(event) =>
                            updateCharacter(index, "personality", event.target.value)
                          }
                          placeholder="他/她是什么样的人，有什么弱点"
                        />
                      </label>
                      <label className="field">
                        <span>目标与欲望</span>
                        <textarea
                          className="input textarea-sm"
                          rows={3}
                          value={character.goals}
                          onChange={(event) => updateCharacter(index, "goals", event.target.value)}
                          placeholder="最想得到什么，为什么要得到"
                        />
                      </label>
                    </div>
                    <label className="field">
                      <span>出身与经历</span>
                      <textarea
                        className="input textarea-sm"
                        rows={3}
                        value={character.background}
                        onChange={(event) =>
                          updateCharacter(index, "background", event.target.value)
                        }
                        placeholder="关键经历、当前处境"
                      />
                    </label>
                    <div className="field-row-2">
                      <label className="field">
                        <span>成长弧光</span>
                        <textarea
                          className="input textarea-sm"
                          rows={3}
                          value={character.arc}
                          onChange={(event) => updateCharacter(index, "arc", event.target.value)}
                          placeholder="故事结束时，他/她会变成什么样"
                        />
                      </label>
                      <label className="field">
                        <span>人物关系</span>
                        <textarea
                          className="input textarea-sm"
                          rows={3}
                          value={character.relationships}
                          onChange={(event) =>
                            updateCharacter(index, "relationships", event.target.value)
                          }
                          placeholder="与其他角色的牵绊和冲突"
                        />
                      </label>
                    </div>
                    <label className="field">
                      <span>说话风格</span>
                      <textarea
                        className="input textarea-sm"
                        rows={2}
                        value={character.speechStyle}
                        onChange={(event) =>
                          updateCharacter(index, "speechStyle", event.target.value)
                        }
                        placeholder="语速、口癖、常用表达"
                      />
                    </label>
                    <div className="char-edit-actions">
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => setEditingIndex(null)}
                      >
                        完成编辑
                      </button>
                      <button className="btn btn-primary btn-sm" onClick={save} disabled={saving}>
                        {saving ? "保存中…" : "保存全部"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="char-meta-row">
                      <span className="char-meta">性别 · {character.gender || "未填"}</span>
                      <span className="char-meta">年龄 · {character.age || "未填"}</span>
                    </div>
                    <div className="char-fields">
                      {READ_FIELDS.map((field) => (
                        <div key={field.key}>
                          <span>{field.label}</span>
                          <p>{character[field.key] || "—"}</p>
                        </div>
                      ))}
                    </div>
                    <p className="char-text">
                      <strong>外貌</strong>
                      {character.appearance || "—"}
                    </p>
                    <p className="char-text">
                      <strong>背景</strong>
                      {character.background || "—"}
                    </p>
                    <p className="char-text">
                      <strong>弧光</strong>
                      {character.arc || "—"}
                    </p>
                    {designs[character.name.trim()] ? (
                      <div className="char-design-summary">
                        <strong>内在设定</strong>
                        {DESIGN_SHORT_FIELDS.map((field) => {
                          const value = designs[character.name.trim()].fields[field];
                          if (!value) return null;
                          return (
                            <p key={field}>
                              <span>{DESIGN_LABELS[field]}</span>
                              {value}
                            </p>
                          );
                        })}
                      </div>
                    ) : null}
                  </>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
