"use client";

import { useCallback, useEffect, useState } from "react";
import type { ProjectDetail } from "@/lib/types";
import {
  NAMING_STYLES,
  PROSE_PACE_LABELS,
  PROSE_RATIO_LABELS,
  PROSE_SENTENCE_LABELS,
  PROSE_STYLES,
  SKILL_IDS,
  type CharacterDesignRecord,
  type NamingStyle,
  type ProsePace,
  type ProseRatio,
  type ProseSentenceLength,
  type ProseStyle,
  type ProjectSkillConfig,
  type SkillCatalogItem,
  type SkillId,
  type SkillUsageRecord,
} from "@/lib/skills/types";
import { errorMessage } from "@/lib/utils";

interface SkillPayload {
  config: ProjectSkillConfig;
  skills: SkillCatalogItem[];
  designs: Record<string, CharacterDesignRecord>;
  logs: SkillUsageRecord[];
}

const SKILL_LABELS: Record<SkillId, string> = {
  "character-naming": "人物命名专家",
  "character-design": "人物塑造专家",
  "prose-style": "文风优化专家",
};

const SKILL_HINTS: Record<SkillId, string> = {
  "character-naming": "新建人物或改名时生成候选，检查重名、近音与形近。",
  "character-design": "补全人物欲望、恐惧、弱点、习惯与成长弧线，不写入事实台账。",
  "prose-style": "章节写完后按项目文风做表达层润色，保留原文并需作者确认。",
};

function linesToArray(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/\r?\n|[,，]/u)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ].slice(0, 200);
}

function arrayToLines(value: string[]): string {
  return value.join("\n");
}

export function SkillsTab({ detail }: { detail: ProjectDetail }) {
  const slug = detail.meta.slug;
  const [payload, setPayload] = useState<SkillPayload | null>(null);
  const [draft, setDraft] = useState<ProjectSkillConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [savedAt, setSavedAt] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/projects/${slug}/skills`, {
        cache: "no-store",
      });
      const data = (await response.json()) as SkillPayload & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "读取技能配置失败");
      setPayload(data);
      setDraft(data.config);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  function patchConfig(update: (current: ProjectSkillConfig) => ProjectSkillConfig) {
    if (!draft) return;
    setDraft(update(draft));
    setSavedAt("");
    setError("");
  }

  async function save() {
    if (!draft) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/projects/${slug}/skills`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const data = (await response.json()) as SkillPayload & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "保存技能配置失败");
      setPayload(data);
      setDraft(data.config);
      setSavedAt(new Date().toLocaleTimeString());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  if (!draft) {
    return (
      <div className="skills">
        <div className="section-head">
          <div>
            <h2 className="section-title">技能</h2>
            <p className="muted small">正在读取项目级技能配置…</p>
          </div>
        </div>
        {error ? <p className="form-error">{error}</p> : null}
        {loading ? <p className="hint">加载中…</p> : null}
      </div>
    );
  }

  return (
    <div className="skills">
      <div className="section-head">
        <div>
          <h2 className="section-title">
            技能
            <span className="char-count">{SKILL_IDS.length} 项</span>
          </h2>
          <p className="muted small">
            技能只增强创作流程，不会直接改写事实台账或计划台账。关闭后，写作时不再注入对应上下文。
          </p>
        </div>
        <div className="char-toolbar">
          {savedAt ? <span className="hint">已保存 {savedAt}</span> : null}
          <button className="btn btn-ghost btn-sm" onClick={() => void load()} disabled={loading}>
            {loading ? "刷新中…" : "刷新"}
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => void save()} disabled={saving}>
            {saving ? "保存中…" : "保存技能设置"}
          </button>
        </div>
      </div>

      {error ? <p className="form-error">{error}</p> : null}

      <section className="panel">
        <div className="panel-head">
          <h3>启用与禁用</h3>
          <p className="muted small">禁用后 API 会拒绝调用；写作任务也不会注入该技能的上下文。</p>
        </div>
        <div className="panel-body skill-switch-list">
          {SKILL_IDS.map((id) => {
            const catalog = payload?.skills.find((item) => item.id === id);
            return (
              <label className="skill-switch" key={id}>
                <input
                  type="checkbox"
                  checked={draft.enabled[id]}
                  onChange={(event) =>
                    patchConfig((current) => ({
                      ...current,
                      enabled: { ...current.enabled, [id]: event.target.checked },
                    }))
                  }
                />
                <span>
                  <strong>{SKILL_LABELS[id]}</strong>
                  <span className="muted small"> {SKILL_HINTS[id]}</span>
                  <span className="skill-version">
                    {catalog?.available
                      ? `v${catalog.version}`
                      : `不可用：${catalog?.error ?? "未加载"}`}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </section>

      <div className="skill-grid">
        <section className="panel">
          <div className="panel-head">
            <h3>人物命名</h3>
            <p className="muted small">项目级默认风格与禁用项；角色页仍可单次覆盖。</p>
          </div>
          <div className="panel-body">
            <div className="field-row-2">
              <label className="field">
                <span>默认命名风格</span>
                <select
                  className="input"
                  value={draft.naming.style}
                  onChange={(event) =>
                    patchConfig((current) => ({
                      ...current,
                      naming: {
                        ...current.naming,
                        style: event.target.value as NamingStyle,
                      },
                    }))
                  }
                >
                  {NAMING_STYLES.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>自定义命名风格</span>
                <input
                  className="input"
                  value={draft.naming.customStyle}
                  placeholder="例如：旧上海报馆文人气质"
                  onChange={(event) =>
                    patchConfig((current) => ({
                      ...current,
                      naming: { ...current.naming, customStyle: event.target.value },
                    }))
                  }
                />
              </label>
            </div>
            <div className="field-row-2">
              <label className="field">
                <span>禁用名字（每行一个）</span>
                <textarea
                  className="input textarea-sm"
                  rows={4}
                  value={arrayToLines(draft.naming.forbiddenNames)}
                  onChange={(event) =>
                    patchConfig((current) => ({
                      ...current,
                      naming: {
                        ...current.naming,
                        forbiddenNames: linesToArray(event.target.value),
                      },
                    }))
                  }
                />
              </label>
              <label className="field">
                <span>禁用风格（每行一个）</span>
                <textarea
                  className="input textarea-sm"
                  rows={4}
                  value={arrayToLines(draft.naming.forbiddenStyles)}
                  onChange={(event) =>
                    patchConfig((current) => ({
                      ...current,
                      naming: {
                        ...current.naming,
                        forbiddenStyles: linesToArray(event.target.value),
                      },
                    }))
                  }
                />
              </label>
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h3>默认文风</h3>
            <p className="muted small">章节写作和润色共用；只影响表达，不改变剧情事实。</p>
          </div>
          <div className="panel-body">
            <div className="field-row-2">
              <label className="field">
                <span>整体文风</span>
                <select
                  className="input"
                  value={draft.prose.style}
                  onChange={(event) =>
                    patchConfig((current) => ({
                      ...current,
                      prose: {
                        ...current.prose,
                        style: event.target.value as ProseStyle,
                      },
                    }))
                  }
                >
                  {PROSE_STYLES.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>自定义文风</span>
                <input
                  className="input"
                  value={draft.prose.customStyle}
                  placeholder="例如：克制、短句、少形容词"
                  onChange={(event) =>
                    patchConfig((current) => ({
                      ...current,
                      prose: { ...current.prose, customStyle: event.target.value },
                    }))
                  }
                />
              </label>
            </div>
            <div className="field-row-2">
              <label className="field">
                <span>句子长短</span>
                <select
                  className="input"
                  value={draft.prose.sentenceLength}
                  onChange={(event) =>
                    patchConfig((current) => ({
                      ...current,
                      prose: {
                        ...current.prose,
                        sentenceLength: event.target.value as ProseSentenceLength,
                      },
                    }))
                  }
                >
                  {Object.entries(PROSE_SENTENCE_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>叙事节奏</span>
                <select
                  className="input"
                  value={draft.prose.pace}
                  onChange={(event) =>
                    patchConfig((current) => ({
                      ...current,
                      prose: { ...current.prose, pace: event.target.value as ProsePace },
                    }))
                  }
                >
                  {Object.entries(PROSE_PACE_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="skill-ratio-grid">
              {(
                [
                  ["descriptionDensity", "描写密度"],
                  ["dialogueRatio", "对话比例"],
                  ["psychologyRatio", "心理描写"],
                  ["environmentRatio", "环境描写"],
                ] as const
              ).map(([key, label]) => (
                <label className="field" key={key}>
                  <span>{label}</span>
                  <select
                    className="input"
                    value={draft.prose[key]}
                    onChange={(event) =>
                      patchConfig((current) => ({
                        ...current,
                        prose: {
                          ...current.prose,
                          [key]: event.target.value as ProseRatio,
                        },
                      }))
                    }
                  >
                    {Object.entries(PROSE_RATIO_LABELS).map(([value, text]) => (
                      <option key={value} value={value}>
                        {text}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            <div className="field-row-2">
              <label className="field">
                <span>禁用表达（每行一个）</span>
                <textarea
                  className="input textarea-sm"
                  rows={3}
                  value={arrayToLines(draft.prose.bannedExpressions)}
                  onChange={(event) =>
                    patchConfig((current) => ({
                      ...current,
                      prose: {
                        ...current.prose,
                        bannedExpressions: linesToArray(event.target.value),
                      },
                    }))
                  }
                />
              </label>
              <label className="field">
                <span>偏好表达（每行一个）</span>
                <textarea
                  className="input textarea-sm"
                  rows={3}
                  value={arrayToLines(draft.prose.preferredExpressions)}
                  onChange={(event) =>
                    patchConfig((current) => ({
                      ...current,
                      prose: {
                        ...current.prose,
                        preferredExpressions: linesToArray(event.target.value),
                      },
                    }))
                  }
                />
              </label>
            </div>
            <label className="skill-inline-check">
              <input
                type="checkbox"
                checked={draft.prose.autoSuggestAfterWrite}
                onChange={(event) =>
                  patchConfig((current) => ({
                    ...current,
                    prose: {
                      ...current.prose,
                      autoSuggestAfterWrite: event.target.checked,
                    },
                  }))
                }
              />
              章节写完后在任务日志里提示可以润色（不会自动覆盖正文）
            </label>
          </div>
        </section>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h3>技能清单</h3>
          <p className="muted small">
            每次执行都会记录 Skill ID、版本、任务、状态和耗时；模型 Tokens 由现有 LLM 封装统一控制。
          </p>
        </div>
        <div className="panel-body skill-catalog">
          {(payload?.skills ?? []).map((skill) => (
            <article className="skill-catalog-item" key={skill.id}>
              <header>
                <strong>{skill.name}</strong>
                <span className={`chip ${skill.available ? "" : "chip-danger"}`}>
                  {skill.available ? `v${skill.version}` : "不可用"}
                </span>
              </header>
              <p className="muted small">{skill.description || skill.error}</p>
              {skill.available ? (
                <p className="hint">
                  任务：{skill.tasks.join(" / ")}；触发：{skill.triggers.join("、")}
                </p>
              ) : null}
            </article>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>最近执行记录</h3>
          <p className="muted small">最多显示最近 20 条，不包含正文和人物档案内容。</p>
        </div>
        <div className="panel-body">
          {payload?.logs.length ? (
            <div className="skill-log-list">
              {[...payload.logs].reverse().map((log, index) => (
                <div className="skill-log-row" key={`${log.time}-${index}`}>
                  <span className={`skill-log-status status-${log.status}`}>
                    {log.status === "success" ? "成功" : log.status === "cancelled" ? "取消" : "失败"}
                  </span>
                  <span className="skill-log-main">
                    {log.skillId} v{log.skillVersion} · {log.task} · {log.mode}
                  </span>
                  <span className="muted small">
                    {log.durationMs}ms
                    {log.errorCode ? ` · ${log.errorCode}` : ""}
                    {log.message ? ` · ${log.message}` : ""}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="hint">还没有技能执行记录。</p>
          )}
        </div>
      </section>
    </div>
  );
}
