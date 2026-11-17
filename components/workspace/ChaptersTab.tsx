"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { diffLines } from "@/lib/text-diff";
import type {
  ChapterVersion,
  ChapterVersionMeta,
  ProjectDetail,
} from "@/lib/types";
import { errorMessage } from "@/lib/utils";

const VERSION_SOURCE_LABEL: Record<ChapterVersionMeta["source"], string> = {
  "ai-write": "AI 写作",
  "ai-rewrite": "AI 重写",
  "ai-repair": "AI 修复",
  user: "手动保存",
  restore: "版本恢复",
  system: "系统/导入",
};

// textarea 没有“滚动到第 N 个字符”的能力，用同样样式的隐藏镜像算出匹配所在行高。
function scrollTextareaTo(textarea: HTMLTextAreaElement, position: number) {
  const style = window.getComputedStyle(textarea);
  const mirror = document.createElement("div");
  mirror.style.position = "absolute";
  mirror.style.top = "-9999px";
  mirror.style.left = "-9999px";
  mirror.style.visibility = "hidden";
  mirror.style.overflow = "hidden";
  mirror.style.boxSizing = "border-box";
  mirror.style.width = `${textarea.clientWidth}px`;
  mirror.style.padding = style.padding;
  mirror.style.border = "0";
  mirror.style.fontFamily = style.fontFamily;
  mirror.style.fontSize = style.fontSize;
  mirror.style.fontWeight = style.fontWeight;
  mirror.style.fontStyle = style.fontStyle;
  mirror.style.letterSpacing = style.letterSpacing;
  mirror.style.lineHeight = style.lineHeight;
  mirror.style.textIndent = style.textIndent;
  mirror.style.textTransform = style.textTransform;
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = "break-word";
  mirror.textContent = textarea.value.slice(0, position);

  const marker = document.createElement("span");
  marker.textContent = "|";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const top = marker.offsetTop;
  mirror.remove();

  textarea.scrollTop = Math.max(0, top - textarea.clientHeight / 3);
}

export function ChaptersTab({
  detail,
  onRefresh,
  onWrite,
  onRewrite,
  disabled,
}: {
  detail: ProjectDetail;
  onRefresh: () => Promise<void>;
  onWrite: (count: number) => void;
  onRewrite: (indices: number[], instruction?: string) => void;
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
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [versions, setVersions] = useState<ChapterVersionMeta[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionsError, setVersionsError] = useState("");
  const [versionDetail, setVersionDetail] = useState<ChapterVersion | null>(null);
  const [versionDiffBase, setVersionDiffBase] = useState<"previous" | "current">(
    "previous",
  );
  const [versionDetailError, setVersionDetailError] = useState("");
  const [restoringVersion, setRestoringVersion] = useState<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const findInputRef = useRef<HTMLInputElement | null>(null);

  const needle = query.trim();
  const matches = useMemo(() => {
    if (!needle) return [] as number[];
    const haystack = content.toLowerCase();
    const target = needle.toLowerCase();
    const positions: number[] = [];
    let from = 0;
    while (from <= haystack.length - target.length) {
      const at = haystack.indexOf(target, from);
      if (at === -1) break;
      positions.push(at);
      from = at + target.length;
    }
    return positions;
  }, [content, needle]);
  const activeMatch = matches.length ? Math.min(matchIndex, matches.length - 1) : -1;

  const versionDiff = useMemo(() => {
    if (!versionDetail) return [];
    if (versionDiffBase === "current") {
      return diffLines(versionDetail.content, content);
    }
    return diffLines(versionDetail.previousContent, versionDetail.content);
  }, [versionDetail, versionDiffBase, content]);

  useEffect(() => {
    if (!findOpen || !needle) return;
    const position = content.toLowerCase().indexOf(needle.toLowerCase());
    setMatchIndex(0);
    if (position >= 0) selectMatchAt(position, needle.length);
    // 只在打开查找或关键词变化时跳到首个匹配；正文编辑时不打断输入。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findOpen, needle]);

  useEffect(() => {
    function handleFindShortcut(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "f") return;
      event.preventDefault();
      setFindOpen(true);
      requestAnimationFrame(() => {
        findInputRef.current?.focus();
        findInputRef.current?.select();
      });
    }
    window.addEventListener("keydown", handleFindShortcut);
    return () => window.removeEventListener("keydown", handleFindShortcut);
  }, []);

  useEffect(() => {
    // 切换章节或后台任务完成刷新 detail 时，以服务端最新内容同步编辑器。
    // 注意：这里会覆盖当前未保存的编辑，所以保存按钮是显式操作，不做自动保存。
    const chapter = detail.chapters.find((item) => item.index === selected);
    setTitle(chapter?.title ?? "");
    setContent(chapter?.content ?? "");
    setError("");
  }, [selected, detail.chapters]);

  const selectedChapter = chapters.find((chapter) => chapter.index === selected);
  const selectedReview = detail.state.reviews[String(selected)];
  const canRewrite = Boolean(selectedChapter?.written && selectedChapter.content.trim());

  if (!chapters.length) {
    return (
      <section className="panel">
        <div className="panel-body empty-inline">
          尚无章节细纲。先在右侧点击「生成架构与角色」。
        </div>
      </section>
    );
  }

  function selectMatchAt(position: number, length: number) {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(position, position + length);
    scrollTextareaTo(textarea, position);
  }

  function moveMatch(delta: number) {
    if (!matches.length || !needle) return;
    const base = activeMatch < 0 ? 0 : activeMatch;
    const next = (base + delta + matches.length) % matches.length;
    setMatchIndex(next);
    selectMatchAt(matches[next], needle.length);
  }

  function openFind() {
    setFindOpen(true);
    requestAnimationFrame(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    });
  }

  function closeFind() {
    setFindOpen(false);
    textareaRef.current?.focus();
  }

  function rewriteSelected() {
    if (!selectedChapter || !canRewrite) return;
    if (
      !window.confirm(
        `将用 AI 重写第 ${selectedChapter.index} 章《${selectedChapter.title}》；通过连续性检查后才会覆盖原稿，未通过则保留原稿，不会自动发布。\n\n如果本章已发布到番茄，重写后请自行到番茄后台更新对应章节。继续？`,
      )
    ) {
      return;
    }
    onRewrite([selectedChapter.index]);
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
      if (versionsOpen) await loadVersions();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function loadVersions() {
    setVersionsLoading(true);
    setVersionsError("");
    try {
      const response = await fetch(
        `/api/projects/${detail.meta.slug}/chapters/${selected}/versions`,
        { cache: "no-store" },
      );
      const data = (await response.json()) as {
        versions?: ChapterVersionMeta[];
        error?: string;
      };
      if (!response.ok) throw new Error(data.error ?? "加载历史版本失败");
      setVersions(data.versions ?? []);
    } catch (err) {
      setVersionsError(errorMessage(err));
    } finally {
      setVersionsLoading(false);
    }
  }

  async function openVersions() {
    setVersionsOpen(true);
    setVersionDetail(null);
    setVersionDetailError("");
    await loadVersions();
  }

  async function viewVersion(version: number, base: "previous" | "current") {
    setVersionDetailError("");
    try {
      const response = await fetch(
        `/api/projects/${detail.meta.slug}/chapters/${selected}/versions/${version}`,
        { cache: "no-store" },
      );
      const data = (await response.json()) as {
        version?: ChapterVersion;
        error?: string;
      };
      if (!response.ok || !data.version) {
        throw new Error(data.error ?? "加载版本失败");
      }
      setVersionDetail(data.version);
      setVersionDiffBase(base);
    } catch (err) {
      setVersionDetailError(errorMessage(err));
    }
  }

  async function restoreVersion(version: number) {
    if (disabled || restoringVersion !== null) return;
    if (
      !window.confirm(
        `确定将第 ${selected} 章恢复到第 ${version} 版？\n\n当前正文会先保存为一个新的恢复前版本；事实台账和审校记录不会自动回滚，恢复后建议重新审校或重建台账。`,
      )
    ) {
      return;
    }

    setRestoringVersion(version);
    setVersionsError("");
    try {
      const response = await fetch(
        `/api/projects/${detail.meta.slug}/chapters/${selected}/versions/${version}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "restore", confirm: true }),
        },
      );
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "恢复版本失败");
      setVersionDetail(null);
      await onRefresh();
      await loadVersions();
    } catch (err) {
      setVersionsError(errorMessage(err));
    } finally {
      setRestoringVersion(null);
    }
  }

  return (
    <div className="chapters-wrap">
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
          {chapters.map((chapter) => {
            const review = detail.state.reviews[String(chapter.index)];
            const dot = chapter.written
              ? review && !review.continuityOk
                ? "dot-bad"
                : "dot-done"
              : "dot-pending";
            return (
              <button
                key={chapter.index}
                type="button"
                className={`chapter-item ${chapter.index === selected ? "active" : ""}`}
                onClick={() => {
                  setSelected(chapter.index);
                  setSavedAt("");
                  setFindOpen(false);
                  setMatchIndex(0);
                  setVersionsOpen(false);
                  setVersions([]);
                  setVersionDetail(null);
                  setVersionsError("");
                  setVersionDetailError("");
                }}
              >
                <span className="chapter-index">
                  {String(chapter.index).padStart(2, "0")}
                </span>
                <span className="chapter-name">{chapter.title}</span>
                <span className={`dot ${dot}`} />
              </button>
            );
          })}
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
          <div className="editor-head-tools">
            <span className="muted small">
              {content.replace(/\s+/g, "").length.toLocaleString("zh-CN")} 字
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={openVersions}
              title="查看、对比或恢复历史版本"
            >
              历史版本
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={findOpen ? closeFind : openFind}
              title="查找本章文字（Ctrl+F）"
            >
              {findOpen ? "关闭查找" : "查找"}
            </button>
          </div>
        </div>
        {findOpen ? (
          <div className="editor-find-bar">
            <input
              ref={findInputRef}
              className="input input-sm editor-find-input"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setMatchIndex(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  closeFind();
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  moveMatch(event.shiftKey ? -1 : 1);
                }
              }}
              placeholder="查找本章文字"
              aria-label="查找本章文字"
            />
            <span className="editor-find-count muted small">
              {needle
                ? matches.length
                  ? `${activeMatch + 1}/${matches.length}`
                  : "无匹配"
                : "输入关键词"}
            </span>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => moveMatch(-1)}
              disabled={!matches.length}
              title="上一个匹配（Shift+Enter）"
            >
              上一个
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => moveMatch(1)}
              disabled={!matches.length}
              title="下一个匹配（Enter）"
            >
              下一个
            </button>
          </div>
        ) : null}
        <div className="panel-body editor-body">
          <textarea
            ref={textareaRef}
            className="editor-textarea"
            value={content}
            onChange={(event) => setContent(event.target.value)}
            onKeyDown={(event) => {
              if (findOpen && event.key === "Escape") {
                event.preventDefault();
                closeFind();
              }
            }}
            placeholder="在这里编辑章节正文，或让 AI 自动生成……"
          />
          {error ? <p className="form-error">{error}</p> : null}
          {selectedReview ? (
            <div
              className={`chapter-review ${selectedReview.continuityOk ? "" : "bad"}`}
            >
              <div className="chapter-review-head">
                <span
                  className={`review-badge ${selectedReview.continuityOk ? "ok" : "bad"}`}
                >
                  {selectedReview.continuityOk
                    ? "连续性检查通过"
                    : "连续性检查未通过"}
                </span>
                {selectedReview.repaired ? (
                  <span className="muted small">
                    自动修复 {selectedReview.repairAttempts ?? 0} 轮
                  </span>
                ) : null}
              </div>
              {selectedReview.issues.length ? (
                <ul className="review-issue-list">
                  {selectedReview.issues.map((issue, index) => (
                    <li key={`${issue.type}-${index}`} className="review-issue">
                      <span className={`review-severity ${issue.severity}`}>
                        {issue.severity === "critical"
                          ? "严重"
                          : issue.severity === "warning"
                            ? "建议"
                            : "可忽略"}
                      </span>
                      <div>
                        <p className="review-issue-detail">
                          {issue.type}：{issue.detail}
                        </p>
                        {issue.evidence ? (
                          <p className="review-evidence">证据：{issue.evidence}</p>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted small">未发现明显冲突。</p>
              )}
              <p className="hint">
                审校记录来自最近一次 AI 生成/重写；手动修改正文后不会自动重新审校。
              </p>
            </div>
          ) : selectedChapter?.written ? (
            <p className="hint">本章还没有连续性检查记录。</p>
          ) : null}
          <div className="editor-actions">
            <span className="muted small">
              {savedAt ? `已保存 ${savedAt}` : "保存后本章会标记为已写"}
            </span>
            <div className="editor-action-buttons">
              <button
                className="btn btn-ghost"
                onClick={rewriteSelected}
                disabled={disabled || saving || !canRewrite}
              >
                AI 重写本章
              </button>
              <button className="btn btn-primary" onClick={save} disabled={saving}>
                {saving ? "保存中…" : "保存章节"}
              </button>
            </div>
          </div>
        </div>
      </section>
      </div>
      {versionsOpen ? (
        <section className="panel version-panel">
          <div className="panel-head">
            <h2 className="panel-title">第 {selected} 章 · 历史版本</h2>
            <div className="panel-head-tools">
              <span className="muted small">{versions.length} 个版本</span>
              <button
                className="btn btn-ghost btn-sm"
                onClick={loadVersions}
                disabled={versionsLoading}
              >
                {versionsLoading ? "加载中…" : "刷新"}
              </button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  setVersionsOpen(false);
                  setVersionDetail(null);
                }}
              >
                收起
              </button>
            </div>
          </div>
          <div className="panel-body">
            <p className="hint">
              每次保存、AI 重写或定点修复都会记录版本。恢复旧版本会新建一条版本，不会删除历史；事实台账与审校记录不会自动回滚。
            </p>
            {versionsError ? <p className="form-error">{versionsError}</p> : null}
            {versions.length ? (
              <ul className="version-list">
                {[...versions].reverse().map((item) => (
                  <li key={`${item.version}-${item.createdAt}`} className="version-item">
                    <div className="version-main">
                      <div className="version-line">
                        <span className="version-badge">v{item.version}</span>
                        <span className="version-source">
                          {VERSION_SOURCE_LABEL[item.source] ?? item.source}
                        </span>
                        <span className="muted small">
                          {new Date(item.createdAt).toLocaleString("zh-CN", {
                            hour12: false,
                          })}
                        </span>
                        <span className="muted small">{item.words} 字</span>
                      </div>
                      {item.note ? <p className="muted small">{item.note}</p> : null}
                    </div>
                    <div className="version-actions">
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => viewVersion(item.version, "previous")}
                      >
                        对比上一版
                      </button>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => viewVersion(item.version, "current")}
                      >
                        与当前稿对比
                      </button>
                      <button
                        className="btn btn-ghost btn-sm danger-text"
                        onClick={() => restoreVersion(item.version)}
                        disabled={disabled || restoringVersion !== null}
                      >
                        {restoringVersion === item.version ? "恢复中…" : "恢复此版本"}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : versionsLoading ? (
              <p className="muted">正在读取版本…</p>
            ) : (
              <p className="muted">还没有历史版本。之后的保存、重写或修复会自动记录。</p>
            )}
            {versionDetailError ? <p className="form-error">{versionDetailError}</p> : null}
            {versionDetail ? (
              <div className="version-diff">
                <div className="version-diff-head">
                  <div>
                    <span className="version-badge">v{versionDetail.version}</span>
                    <span className="muted small">
                      {versionDiffBase === "current"
                        ? "此版本 → 当前编辑器内容"
                        : "上一版 → 此版本"}
                    </span>
                  </div>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => setVersionDetail(null)}
                  >
                    关闭对比
                  </button>
                </div>
                <div className="version-diff-body">
                  {versionDiff.map((line, index) => (
                    <div
                      key={`${index}-${line.type}`}
                      className={`diff-line ${line.type}`}
                    >
                      <span className="diff-mark">
                        {line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}
                      </span>
                      <span>{line.text || " "}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}
