"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { PromptVersionsPanel } from "@/components/PromptVersionsPanel";
import type { LLMProvider } from "@/lib/config";
import { errorMessage } from "@/lib/utils";

interface SettingsView {
  provider: LLMProvider;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  apiKeySet: boolean;
  apiKeyPreview: string;
}

interface Snapshot {
  saved: SettingsView | null;
  effective: SettingsView;
  source: "settings" | "env" | "default";
  envConfigured: boolean;
}

interface Notice {
  type: "success" | "error";
  text: string;
}

const PRESETS: { label: string; baseUrl: string; model: string; note: string }[] = [
  {
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    note: "国内直连",
  },
  {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    note: "需要网络",
  },
  {
    label: "通义千问",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
    note: "阿里云百炼",
  },
  {
    label: "Ollama",
    baseUrl: "http://localhost:11434/v1",
    model: "qwen2.5:14b",
    note: "本机运行",
  },
];

const SOURCE_LABELS: Record<Snapshot["source"], string> = {
  settings: "浏览器保存的设置",
  env: ".env.local 环境变量",
  default: "默认配置（尚未接入模型）",
};

const EMPTY_FORM = {
  provider: "openai-compatible" as LLMProvider,
  baseUrl: "https://api.deepseek.com/v1",
  model: "deepseek-chat",
  apiKey: "",
  temperature: "0.85",
  maxTokens: "8192",
};

export function SettingsPanel() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/settings");
        const data = (await response.json()) as Snapshot & { error?: string };
        if (!response.ok) throw new Error(data.error ?? "读取设置失败");
        if (cancelled) return;
        applySnapshot(data);
      } catch (err) {
        if (!cancelled) setNotice({ type: "error", text: errorMessage(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function applySnapshot(data: Snapshot) {
    setSnapshot(data);
    const source = data.saved ?? data.effective;
    setForm({
      provider: data.saved?.provider ?? "openai-compatible",
      baseUrl: source.baseUrl,
      model: source.model,
      apiKey: "",
      temperature: String(source.temperature),
      maxTokens: String(source.maxTokens),
    });
  }

  function update(key: keyof typeof form, value: string) {
    setForm((previous) => ({ ...previous, [key]: value }));
    setNotice(null);
  }

  function applyPreset(preset: (typeof PRESETS)[number]) {
    setForm((previous) => ({
      ...previous,
      provider: "openai-compatible",
      baseUrl: preset.baseUrl,
      model: preset.model,
    }));
    setNotice(null);
  }

  async function save(clearApiKey = false) {
    if (clearApiKey) {
      const confirmed = window.confirm(
        "确定清除已保存的 API Key 吗？清除后会回到 mock 模式，除非 .env.local 另有配置。",
      );
      if (!confirmed) return;
    }

    setSaving(true);
    setNotice(null);
    try {
      const response = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: form.provider,
          baseUrl: form.baseUrl,
          model: form.model,
          apiKey: form.apiKey.trim() || undefined,
          temperature: Number(form.temperature),
          maxTokens: Number(form.maxTokens),
          clearApiKey,
        }),
      });
      const data = (await response.json()) as Snapshot & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "保存失败");
      applySnapshot(data);
      setNotice({
        type: "success",
        text: clearApiKey
          ? "密钥已清除，后续任务将使用 mock 模式。"
          : "已保存，新生成的任务会立即使用这套配置，无需重启服务。",
      });
    } catch (err) {
      setNotice({ type: "error", text: errorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  async function testConnection() {
    setTesting(true);
    setNotice(null);
    try {
      const response = await fetch("/api/settings/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: form.provider,
          baseUrl: form.baseUrl,
          model: form.model,
          apiKey: form.apiKey.trim() || undefined,
        }),
      });
      const data = (await response.json()) as {
        ok?: boolean;
        mock?: boolean;
        message?: string;
        reply?: string;
        model?: string;
        latencyMs?: number;
        error?: string;
      };
      if (!response.ok || !data.ok) throw new Error(data.error ?? "连接失败");
      setNotice({
        type: "success",
        text: data.mock
          ? data.message ?? "当前为 mock 模式。"
          : `连接成功：${data.model ?? form.model} 在 ${data.latencyMs ?? 0}ms 内返回「${
              data.reply || "OK"
            }」。保存后即可使用。`,
      });
    } catch (err) {
      setNotice({ type: "error", text: `连接失败：${errorMessage(err)}` });
    } finally {
      setTesting(false);
    }
  }

  const effectiveIsMock = !snapshot || snapshot.effective.provider === "mock";
  const keySaved = Boolean(snapshot?.saved?.apiKeySet);
  const keyAvailable = Boolean(snapshot?.saved?.apiKeySet || snapshot?.effective.apiKeySet);

  return (
    <main className="shell settings-page">
      <div className="settings-head">
        <div>
          <div className="hero-eyebrow">本机模型配置</div>
          <h1 className="settings-title">模型设置</h1>
          <p className="muted">
            在这里填写 API Key 并切换模型，保存后立即生效，不用重启服务。配置只保存在本机。
          </p>
        </div>
        <Link href="/" className="btn btn-ghost btn-sm">
          返回作品库
        </Link>
      </div>

      <div className="settings-grid">
        <section className="panel settings-status">
          <div className="panel-head">
            <h2 className="panel-title">当前状态</h2>
            <span className={`mode-badge ${effectiveIsMock ? "off" : "on"}`}>
              {effectiveIsMock ? "mock 离线" : "真实模型"}
            </span>
          </div>
          <div className="panel-body">
            {snapshot ? (
              <>
                <dl className="status-list">
                  <div>
                    <dt>模型</dt>
                    <dd>{effectiveIsMock ? "示例生成" : snapshot.effective.model}</dd>
                  </div>
                  <div>
                    <dt>接口</dt>
                    <dd className="status-url">{snapshot.effective.baseUrl}</dd>
                  </div>
                  <div>
                    <dt>API Key</dt>
                    <dd>
                      {snapshot.effective.apiKeySet
                        ? `已配置（${snapshot.effective.apiKeyPreview}）`
                        : "未配置"}
                    </dd>
                  </div>
                  <div>
                    <dt>配置来源</dt>
                    <dd>{SOURCE_LABELS[snapshot.source]}</dd>
                  </div>
                </dl>
                {snapshot.source === "env" && !snapshot.saved ? (
                  <p className="hint">
                    检测到 .env.local 已配置模型。在这里保存后会改为以页面设置为准。
                  </p>
                ) : null}
              </>
            ) : (
              <p className="muted">读取中…</p>
            )}
          </div>
        </section>

        <section className="panel settings-form-panel">
          <div className="panel-head">
            <h2 className="panel-title">接入模型</h2>
            <span className="muted small">保存后热切换</span>
          </div>
          <form
            className="panel-body form"
            onSubmit={(event) => {
              event.preventDefault();
              void save(false);
            }}
          >
            <div className="preset-row">
              {PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  className="preset-btn"
                  onClick={() => applyPreset(preset)}
                  title={preset.baseUrl}
                >
                  <strong>{preset.label}</strong>
                  <small>{preset.note}</small>
                </button>
              ))}
            </div>

            <label className="field">
              <span>服务类型</span>
              <select
                className="input"
                value={form.provider}
                onChange={(event) => update("provider", event.target.value)}
              >
                <option value="openai-compatible">
                  OpenAI 兼容接口（DeepSeek / OpenAI / 通义千问 / Ollama）
                </option>
                <option value="mock">离线 mock 示例（不调用模型）</option>
              </select>
            </label>

            <label className="field">
              <span>接口地址 Base URL</span>
              <input
                className="input"
                value={form.baseUrl}
                onChange={(event) => update("baseUrl", event.target.value)}
                placeholder="https://api.deepseek.com/v1"
                disabled={form.provider === "mock"}
              />
            </label>

            <div className="field-row-2">
              <label className="field">
                <span>模型名称</span>
                <input
                  className="input"
                  value={form.model}
                  onChange={(event) => update("model", event.target.value)}
                  placeholder="deepseek-chat"
                  disabled={form.provider === "mock"}
                />
              </label>
              <label className="field">
                <span>API Key</span>
                {/* 页面不回显完整密钥：输入框留空表示沿用已保存的值。 */}
                <input
                  className="input"
                  type="password"
                  value={form.apiKey}
                  onChange={(event) => update("apiKey", event.target.value)}
                  placeholder={
                    keyAvailable
                      ? `已保存（${snapshot?.effective.apiKeyPreview || "••••"}），留空不修改`
                      : "sk-…"
                  }
                  autoComplete="off"
                  disabled={form.provider === "mock"}
                />
              </label>
            </div>

            <div className="field-row-2">
              <label className="field">
                <span>温度 temperature</span>
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={2}
                  step={0.05}
                  value={form.temperature}
                  onChange={(event) => update("temperature", event.target.value)}
                />
              </label>
              <label className="field">
                <span>单次最大 tokens</span>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={32768}
                  value={form.maxTokens}
                  onChange={(event) => update("maxTokens", event.target.value)}
                />
              </label>
            </div>

            {notice ? (
              <p className={notice.type === "success" ? "form-note" : "form-error"}>
                {notice.text}
              </p>
            ) : null}

            <div className="settings-actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={testConnection}
                disabled={testing || saving}
              >
                {testing ? "测试中…" : "测试连接"}
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={saving || testing || !snapshot}
              >
                {saving ? "保存中…" : "保存并热切换"}
              </button>
            </div>

            {keySaved ? (
              <button
                type="button"
                className="link-danger"
                onClick={() => save(true)}
                disabled={saving}
              >
                清除已保存的 API Key
              </button>
            ) : null}

            <p className="hint">
              密钥写入本机 <code>data/settings.json</code>（已在 .gitignore 中），页面只回显脱敏后的尾号。使用
              Ollama 等本地服务时，Key 可任意填写非空值。
            </p>
            <p className="hint">
              推理型模型（如 deepseek-flash / deepseek-reasoner）会先消耗推理
              token，建议把「单次最大 tokens」设为 16384 以上；日常写作更推荐非推理的 deepseek-chat。
            </p>
          </form>
        </section>
      </div>

      <PromptVersionsPanel />
    </main>
  );
}
