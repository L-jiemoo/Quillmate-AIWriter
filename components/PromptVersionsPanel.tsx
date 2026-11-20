"use client";

import { useCallback, useEffect, useState } from "react";
import { BusyLabel } from "@/components/ui/Loading";
import { PROMPT_AGENTS, PROMPT_CATALOG } from "@/lib/prompt-registry";
import type { PromptAgent } from "@/lib/prompt-registry";
import { errorMessage } from "@/lib/utils";

interface PromptVersionView {
  id: string;
  agent: PromptAgent;
  versionNumber: number;
  mode: "system" | "user";
  instructions: string;
  label: string;
  note: string;
  baseVersion: string;
  createdAt: string;
}

interface PromptAgentView {
  agent: PromptAgent;
  label: string;
  version: string;
  description: string;
  activeId: string | null;
  versions: PromptVersionView[];
}

interface PromptUsageView {
  time: string;
  agent: PromptAgent;
  promptVersion: string;
  baseVersion: string;
  overrideId?: string;
  promptHash: string;
  model: string;
  provider: string;
  temperature: number;
  maxTokens: number;
  chapter?: number;
  messageChars: number;
}

interface Snapshot {
  agents: PromptAgentView[];
  usage: PromptUsageView[];
  updatedAt: string;
}

type Notice = { type: "success" | "error"; text: string } | null;

const MODE_LABEL: Record<PromptVersionView["mode"], string> = {
  system: "追加到 system",
  user: "追加到 user",
};

function formatTime(value: string): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("zh-CN", { hour12: false });
}

export function PromptVersionsPanel() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [agent, setAgent] = useState<PromptAgent>("writer");
  const [mode, setMode] = useState<PromptVersionView["mode"]>("system");
  const [label, setLabel] = useState("");
  const [note, setNote] = useState("");
  const [instructions, setInstructions] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/prompts", { cache: "no-store" });
      const data = (await response.json()) as Snapshot & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "读取提示词版本失败");
      setSnapshot(data);
    } catch (error) {
      setNotice({ type: "error", text: errorMessage(error) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const current = snapshot?.agents.find((item) => item.agent === agent);
  const activeVersion = current?.versions.find((item) => item.id === current.activeId);
  const usage = (snapshot?.usage ?? [])
    .filter((item) => item.agent === agent)
    .slice()
    .reverse()
    .slice(0, 20);

  async function saveVersion() {
    const text = instructions.trim();
    if (!text) {
      setNotice({ type: "error", text: "请填写附加提示词规则" });
      return;
    }
    if (
      !window.confirm(
        `将把这段附加规则启用给「${PROMPT_CATALOG[agent].label}」Agent。它会影响之后所有项目的新任务，但不会改写已写正文。继续？`,
      )
    ) {
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/prompts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent,
          mode,
          instructions: text,
          label: label.trim(),
          note: note.trim(),
        }),
      });
      const data = (await response.json()) as Snapshot & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "保存提示词版本失败");
      setSnapshot(data);
      setInstructions("");
      setLabel("");
      setNote("");
      setNotice({ type: "success", text: "已保存并启用新的附加提示词版本。" });
    } catch (error) {
      setNotice({ type: "error", text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  async function activate(activeId: string | null) {
    const name = activeId
      ? current?.versions.find((item) => item.id === activeId)?.label ?? activeId
      : "内置提示词";
    if (
      !window.confirm(
        `将把「${PROMPT_CATALOG[agent].label}」切换到「${name}」。这只影响之后的新任务，不会改写已有正文。继续？`,
      )
    ) {
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/prompts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent, activeId }),
      });
      const data = (await response.json()) as Snapshot & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "切换提示词版本失败");
      setSnapshot(data);
      setNotice({
        type: "success",
        text: activeId ? "已启用历史版本。" : "已恢复内置提示词。",
      });
    } catch (error) {
      setNotice({ type: "error", text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel prompt-panel">
      <div className="panel-head">
        <h2 className="panel-title">提示词版本</h2>
        <span className="muted small">记录模型参数、版本与指纹</span>
      </div>
      <div className="panel-body prompt-body">
        <p className="hint">
          内置提示词由代码维护；这里保存的是每个 Agent 的「附加规则」版本。附加规则只会追加到
          system 或 user 提示词末尾，不会替换章节正文、JSON 约束和变量。创建和切换会立即影响之后的新任务。
        </p>

        <div className="prompt-agent-row">
          <label className="field">
            <span>Agent</span>
            <select
              className="input"
              value={agent}
              onChange={(event) => {
                setAgent(event.target.value as PromptAgent);
                setNotice(null);
              }}
            >
              {PROMPT_AGENTS.map((item) => (
                <option key={item} value={item}>
                  {PROMPT_CATALOG[item].label} · {item}
                </option>
              ))}
            </select>
          </label>
          <div className="prompt-status">
            <span>内置版本：{current?.version ?? PROMPT_CATALOG[agent].version}</span>
            <span>
              当前启用：{activeVersion ? activeVersion.label : "内置提示词"}
            </span>
            <span className="muted small">{current?.description}</span>
          </div>
        </div>

        <div className="prompt-editor">
          <div className="field-row-2">
            <label className="field">
              <span>追加位置</span>
              <select
                className="input"
                value={mode}
                onChange={(event) =>
                  setMode(event.target.value as PromptVersionView["mode"])
                }
              >
                <option value="system">system（规则/角色约束）</option>
                <option value="user">user（任务附加要求）</option>
              </select>
            </label>
            <label className="field">
              <span>版本标签</span>
              <input
                className="input"
                value={label}
                maxLength={80}
                placeholder="如：加强伏笔检查"
                onChange={(event) => setLabel(event.target.value)}
              />
            </label>
          </div>
          <label className="field">
            <span>附加规则（最多 8000 字）</span>
            <textarea
              className="input prompt-textarea"
              value={instructions}
              maxLength={8000}
              placeholder="例如：审校时额外检查每个出场人物是否知道自己掌握的信息，并给出原文证据。"
              onChange={(event) => setInstructions(event.target.value)}
            />
          </label>
          <label className="field">
            <span>备注（可选）</span>
            <input
              className="input"
              value={note}
              maxLength={500}
              placeholder="记录这次修改的原因，便于以后回滚"
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <div className="settings-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void saveVersion()}
              disabled={busy || loading || !instructions.trim()}
            >
              {busy ? <BusyLabel>保存中…</BusyLabel> : "保存并启用新版本"}
            </button>
          </div>
        </div>

        {notice ? (
          <p className={notice.type === "success" ? "form-note" : "form-error"}>
            {notice.text}
          </p>
        ) : null}

        <div className="prompt-section-head">
          <h3>历史版本</h3>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void activate(null)}
            disabled={busy || !current?.activeId}
          >
            恢复内置
          </button>
        </div>

        {!current?.versions.length ? (
          <p className="muted small">这个 Agent 还没有附加规则版本。</p>
        ) : (
          <div className="prompt-list">
            {current.versions.map((version) => {
              const active = current.activeId === version.id;
              return (
                <article
                  key={version.id}
                  className={`prompt-version ${active ? "active" : ""}`}
                >
                  <div className="prompt-version-head">
                    <strong>
                      v{version.versionNumber} · {version.label}
                      {active ? " · 当前启用" : ""}
                    </strong>
                    <span className="muted small">
                      {MODE_LABEL[version.mode]} · 基于 {version.baseVersion} ·{" "}
                      {formatTime(version.createdAt)}
                    </span>
                  </div>
                  {version.note ? <p className="prompt-note">{version.note}</p> : null}
                  <details>
                    <summary>查看附加规则</summary>
                    <pre className="prompt-instructions">{version.instructions}</pre>
                  </details>
                  <div className="prompt-version-actions">
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={busy || active}
                      onClick={() => void activate(version.id)}
                    >
                      {active ? "当前版本" : "启用此版本"}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}

        <div className="prompt-section-head">
          <h3>最近模型调用</h3>
          <span className="muted small">只记录元数据，不保存正文或 API Key</span>
        </div>
        {!usage.length ? (
          <p className="muted small">还没有真实模型调用记录；mock 模式不会产生记录。</p>
        ) : (
          <div className="prompt-usage">
            <div className="prompt-usage-row prompt-usage-head">
              <span>时间</span>
              <span>版本</span>
              <span>模型 / 参数</span>
              <span>章节</span>
              <span>指纹</span>
            </div>
            {usage.map((record, index) => (
              <div
                className="prompt-usage-row"
                key={`${record.time}-${record.agent}-${index}`}
              >
                <span>{formatTime(record.time)}</span>
                <span title={record.baseVersion}>{record.promptVersion}</span>
                <span>
                  {record.model} · {record.provider} · temp {record.temperature} · max{" "}
                  {record.maxTokens}
                </span>
                <span>{record.chapter ?? "—"}</span>
                <span title={record.promptHash}>{record.promptHash.slice(0, 10)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
