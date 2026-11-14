"use client";

import { useEffect, useState } from "react";
import type { ProjectDetail } from "@/lib/types";
import { errorMessage } from "@/lib/utils";

export function ChaptersTab({
  detail,
  onRefresh,
  onWrite,
  disabled,
}: {
  detail: ProjectDetail;
  onRefresh: () => Promise<void>;
  onWrite: (count: number) => void;
  disabled: boolean;
}) {
  const chapters = detail.chapters;
  const [selected, setSelected] = useState<number>(
    () => chapters.find((chapter) => !chapter.written)?.index ?? chapters[0]?.index ?? 1,
  );
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const [savedAt, setSavedAt] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    // 切换章节或后台任务完成刷新 detail 时，以服务端最新内容同步编辑器。
    // 注意：这里会覆盖当前未保存的编辑，所以保存按钮是显式操作，不做自动保存。
    const chapter = detail.chapters.find((item) => item.index === selected);
    setTitle(chapter?.title ?? "");
    setContent(chapter?.content ?? "");
    setError("");
  }, [selected, detail.chapters]);

  if (!chapters.length) {
    return (
      <section className="panel">
        <div className="panel-body empty-inline">
          尚无章节细纲。先在右侧点击「生成架构与角色」。
        </div>
      </section>
    );
  }

  async function save() {
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/projects/${detail.meta.slug}/chapters/${selected}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, content }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "保存失败");
      setSavedAt(new Date().toLocaleTimeString("zh-CN", { hour12: false }));
      await onRefresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="chapter-layout">
      <aside className="panel chapter-list-panel">
        <div className="panel-head">
          <h2 className="panel-title">章节</h2>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => onWrite(1)}
            disabled={disabled || detail.pendingChapters === 0}
          >
            写下一章
          </button>
        </div>
        <div className="chapter-list">
          {chapters.map((chapter) => (
            <button
              key={chapter.index}
              type="button"
              className={`chapter-item ${chapter.index === selected ? "active" : ""}`}
              onClick={() => {
                setSelected(chapter.index);
                setSavedAt("");
              }}
            >
              <span className="chapter-index">{String(chapter.index).padStart(2, "0")}</span>
              <span className="chapter-name">{chapter.title}</span>
              <span className={`dot ${chapter.written ? "dot-done" : "dot-pending"}`} />
            </button>
          ))}
        </div>
      </aside>

      <section className="panel editor-panel">
        <div className="panel-head editor-head">
          <input
            className="editor-title-input"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="章节标题"
          />
          <span className="muted small">{content.replace(/\s+/g, "").length.toLocaleString("zh-CN")} 字</span>
        </div>
        <div className="panel-body editor-body">
          <textarea
            className="editor-textarea"
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder="在这里编辑章节正文，或让 AI 自动生成……"
          />
          {error ? <p className="form-error">{error}</p> : null}
          <div className="editor-actions">
            <span className="muted small">
              {savedAt ? `已保存 ${savedAt}` : "保存后本章会标记为已写"}
            </span>
            <button className="btn btn-primary" onClick={save} disabled={saving}>
              {saving ? "保存中…" : "保存章节"}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
