"use client";

import { useEffect, useState } from "react";
import type { Character, ProjectDetail } from "@/lib/types";
import { errorMessage } from "@/lib/utils";

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
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
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
