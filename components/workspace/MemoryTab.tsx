"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  BookMemory,
  ChapterMemory,
  MemoryRetrievalResult,
  MemoryStatsView,
  ProjectDetail,
  ProjectMemory,
  StartJobFn,
  VolumeMemory,
} from "@/lib/types";
import { errorMessage } from "@/lib/utils";

type MemoryView = "book" | "volumes" | "chapters" | "retrieval";

const VIEWS: { key: MemoryView; label: string }[] = [
  { key: "book", label: "全书记忆" },
  { key: "volumes", label: "分卷记忆" },
  { key: "chapters", label: "章节记忆" },
  { key: "retrieval", label: "检索预览" },
];

const SOURCE_LABEL: Record<ChapterMemory["source"], string> = {
  ai: "AI 抽取",
  summary: "基础摘要",
  manual: "人工修正",
};

function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function joinLines(values: string[]): string {
  return values.join("\n");
}

function cloneBook(book: BookMemory): BookMemory {
  return {
    ...book,
    tags: [...book.tags],
    coreCharacters: [...book.coreCharacters],
    coreRules: [...book.coreRules],
    keyConflicts: [...book.keyConflicts],
  };
}

function cloneVolume(volume: VolumeMemory): VolumeMemory {
  return {
    ...volume,
    events: [...volume.events],
    characterChanges: [...volume.characterChanges],
    conflicts: [...volume.conflicts],
    foreshadows: [...volume.foreshadows],
  };
}

function cloneChapter(chapter: ChapterMemory): ChapterMemory {
  return {
    ...chapter,
    events: [...chapter.events],
    characters: [...chapter.characters],
    actions: [...chapter.actions],
    newSettings: [...chapter.newSettings],
    foreshadowsPlanted: [...chapter.foreshadowsPlanted],
    foreshadowsResolved: [...chapter.foreshadowsResolved],
  };
}

function LinesField({
  label,
  value,
  onChange,
  rows = 4,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <textarea
        className="input"
        rows={rows}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

export function MemoryTab({
  detail,
  onStartJob,
  onRefresh,
  disabled,
}: {
  detail: ProjectDetail;
  onStartJob: StartJobFn;
  onRefresh: () => Promise<void> | void;
  disabled: boolean;
}) {
  const slug = detail.meta.slug;
  const [view, setView] = useState<MemoryView>("book");
  const [memory, setMemory] = useState<ProjectMemory | null>(null);
  const [stats, setStats] = useState<MemoryStatsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [bookDraft, setBookDraft] = useState<BookMemory | null>(null);
  const [selectedVolumeId, setSelectedVolumeId] = useState("");
  const [volumeDraft, setVolumeDraft] = useState<VolumeMemory | null>(null);
  const [selectedChapter, setSelectedChapter] = useState<number>(0);
  const [chapterDraft, setChapterDraft] = useState<ChapterMemory | null>(null);
  const [retrievalChapter, setRetrievalChapter] = useState<number>(0);
  const [retrieval, setRetrieval] = useState<MemoryRetrievalResult | null>(null);
  const [retrieving, setRetrieving] = useState(false);

  const writtenChapters = useMemo(
    () => detail.chapters.filter((chapter) => chapter.written).map((chapter) => chapter.index),
    [detail.chapters],
  );

  const loadMemory = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/projects/${slug}/memory`, { cache: "no-store" });
      const data = (await response.json()) as {
        memory?: ProjectMemory;
        stats?: MemoryStatsView;
        error?: string;
      };
      if (!response.ok || !data.memory) throw new Error(data.error ?? "读取长期记忆失败");
      setMemory(data.memory);
      setStats(data.stats ?? null);
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    void loadMemory();
  }, [loadMemory, detail]);

  useEffect(() => {
    if (!memory) return;
    setBookDraft(cloneBook(memory.book));
    if (!memory.volumes.length) {
      setSelectedVolumeId("");
      setVolumeDraft(null);
    } else if (!memory.volumes.some((item) => item.id === selectedVolumeId)) {
      setSelectedVolumeId(memory.volumes[0].id);
    }
    const chapterIndexes = Object.keys(memory.chapters)
      .map(Number)
      .sort((a, b) => a - b);
    if (chapterIndexes.length && !memory.chapters[String(selectedChapter)]) {
      setSelectedChapter(chapterIndexes[0]);
    }
    const nextPending =
      detail.chapters.find((chapter) => !chapter.written)?.index ??
      detail.chapters[detail.chapters.length - 1]?.index ??
      1;
    if (!retrievalChapter) setRetrievalChapter(nextPending);
  }, [memory, selectedVolumeId, selectedChapter, retrievalChapter, detail.chapters]);

  useEffect(() => {
    if (!memory) return;
    const volume = memory.volumes.find((item) => item.id === selectedVolumeId);
    setVolumeDraft(volume ? cloneVolume(volume) : null);
  }, [memory, selectedVolumeId]);

  useEffect(() => {
    if (!memory) return;
    const chapter = memory.chapters[String(selectedChapter)];
    setChapterDraft(chapter ? cloneChapter(chapter) : null);
  }, [memory, selectedChapter]);

  async function savePatch(body: unknown) {
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/projects/${slug}/memory`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await response.json()) as {
        memory?: ProjectMemory;
        stats?: MemoryStatsView;
        error?: string;
      };
      if (!response.ok || !data.memory) throw new Error(data.error ?? "保存记忆失败");
      setMemory(data.memory);
      setStats(data.stats ?? null);
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setSaving(false);
    }
  }

  async function seed() {
    if (
      !window.confirm(
        "将用现有章节摘要、事实台账和大纲离线生成基础记忆，不调用模型。已有手工记忆不会被覆盖。继续？",
      )
    ) {
      return;
    }
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/projects/${slug}/memory/seed`, {
        method: "POST",
      });
      const data = (await response.json()) as {
        memory?: ProjectMemory;
        stats?: MemoryStatsView;
        error?: string;
      };
      if (!response.ok || !data.memory) throw new Error(data.error ?? "生成基础记忆失败");
      setMemory(data.memory);
      setStats(data.stats ?? null);
      await onRefresh();
    } catch (seedError) {
      setError(errorMessage(seedError));
    } finally {
      setSaving(false);
    }
  }

  function rebuild() {
    if (
      !window.confirm(
        `将逐章调用模型生成长期记忆，共 ${writtenChapters.length} 章；全部成功后才提交，失败时已有记忆不变。手工记忆会被保留。继续？`,
      )
    ) {
      return;
    }
    void onStartJob("memory");
  }

  async function previewRetrieval() {
    setRetrieving(true);
    setError("");
    try {
      const response = await fetch(
        `/api/projects/${slug}/memory/retrieve?chapter=${retrievalChapter}`,
        { cache: "no-store" },
      );
      const data = (await response.json()) as {
        retrieval?: MemoryRetrievalResult;
        error?: string;
      };
      if (!response.ok || !data.retrieval) {
        throw new Error(data.error ?? "检索预览失败");
      }
      setRetrieval(data.retrieval);
    } catch (retrievalError) {
      setError(errorMessage(retrievalError));
    } finally {
      setRetrieving(false);
    }
  }

  if (loading) {
    return <div className="panel"><div className="panel-body muted">正在读取长期记忆…</div></div>;
  }

  return (
    <div className="overview">
      <div className="segmented overview-tabs" role="tablist" aria-label="记忆视图">
        {VIEWS.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={view === item.key}
            className={`segmented-item ${view === item.key ? "active" : ""}`}
            onClick={() => setView(item.key)}
          >
            {item.label}
            {item.key === "chapters" && stats ? (
              <span className="segmented-count">{stats.effectiveChapters} 章</span>
            ) : null}
            {item.key === "volumes" && stats ? (
              <span className="segmented-count">{stats.volumes} 卷</span>
            ) : null}
          </button>
        ))}
      </div>

      {error ? <div className="notice notice-error">{error}</div> : null}

      <div className="memory-toolbar panel">
        <div className="panel-body">
          <p className="muted small">
            {stats
              ? `有效记忆 ${stats.effectiveChapters} 章（AI ${stats.aiChapters} / 基础 ${stats.seedChapters} / 人工 ${stats.manualChapters}） · ${stats.volumes} 卷 · 未回收伏笔 ${stats.openForeshadows}`
              : "尚未读取到记忆统计"}
          </p>
          <div className="memory-actions">
            <button className="btn" type="button" onClick={() => void loadMemory()} disabled={saving}>
              刷新
            </button>
            <button className="btn" type="button" onClick={() => void seed()} disabled={saving || disabled}>
              生成基础记忆
            </button>
            <button
              className="btn btn-primary"
              type="button"
              onClick={rebuild}
              disabled={disabled || saving || !writtenChapters.length}
            >
              重建完整记忆（AI）
            </button>
          </div>
        </div>
      </div>

      {view === "book" && bookDraft ? (
        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">全书记忆</h2>
            <span className="muted small">{bookDraft.source === "manual" ? "人工维护" : "规则聚合"}</span>
          </div>
          <div className="panel-body memory-form">
            <label className="field">
              <span className="field-label">一句话卖点</span>
              <input
                className="input"
                value={bookDraft.logline}
                onChange={(event) => setBookDraft({ ...bookDraft, logline: event.target.value })}
              />
            </label>
            <LinesField
              label="主线 / 全书摘要"
              value={bookDraft.mainline}
              onChange={(value) => setBookDraft({ ...bookDraft, mainline: value })}
              rows={6}
            />
            <LinesField
              label="核心矛盾（每行一条）"
              value={joinLines(bookDraft.keyConflicts)}
              onChange={(value) => setBookDraft({ ...bookDraft, keyConflicts: splitLines(value) })}
              rows={4}
            />
            <LinesField
              label="最终目标"
              value={bookDraft.finalGoal}
              onChange={(value) => setBookDraft({ ...bookDraft, finalGoal: value })}
              rows={3}
            />
            <LinesField
              label="核心人物（每行一条）"
              value={joinLines(bookDraft.coreCharacters)}
              onChange={(value) => setBookDraft({ ...bookDraft, coreCharacters: splitLines(value) })}
              rows={4}
            />
            <LinesField
              label="核心规则（每行一条）"
              value={joinLines(bookDraft.coreRules)}
              onChange={(value) => setBookDraft({ ...bookDraft, coreRules: splitLines(value) })}
              rows={5}
            />
            <LinesField
              label="故事梗概"
              value={bookDraft.summary}
              onChange={(value) => setBookDraft({ ...bookDraft, summary: value })}
              rows={5}
            />
            <button
              className="btn btn-primary"
              type="button"
              disabled={saving || disabled}
              onClick={() => void savePatch({ book: bookDraft })}
            >
              保存全书记忆
            </button>
          </div>
        </section>
      ) : null}

      {view === "volumes" ? (
        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">分卷记忆</h2>
            <span className="muted small">人工编辑的卷不会被自动聚合覆盖</span>
          </div>
          <div className="panel-body">
            {memory?.volumes.length ? (
              <>
                <div className="segmented" role="tablist" aria-label="选择分卷">
                  {memory.volumes.map((volume) => (
                    <button
                      key={volume.id}
                      type="button"
                      role="tab"
                      aria-selected={selectedVolumeId === volume.id}
                      className={`segmented-item ${selectedVolumeId === volume.id ? "active" : ""}`}
                      onClick={() => setSelectedVolumeId(volume.id)}
                    >
                      {volume.title}
                    </button>
                  ))}
                </div>
                {volumeDraft ? (
                  <div className="memory-form">
                    <label className="field">
                      <span className="field-label">卷标题</span>
                      <input
                        className="input"
                        value={volumeDraft.title}
                        onChange={(event) =>
                          setVolumeDraft({ ...volumeDraft, title: event.target.value })
                        }
                      />
                    </label>
                    <LinesField
                      label="卷目标"
                      value={volumeDraft.goal}
                      onChange={(value) => setVolumeDraft({ ...volumeDraft, goal: value })}
                      rows={3}
                    />
                    <LinesField
                      label="主要事件（每行一条）"
                      value={joinLines(volumeDraft.events)}
                      onChange={(value) => setVolumeDraft({ ...volumeDraft, events: splitLines(value) })}
                      rows={6}
                    />
                    <LinesField
                      label="人物阶段变化（每行一条）"
                      value={joinLines(volumeDraft.characterChanges)}
                      onChange={(value) =>
                        setVolumeDraft({ ...volumeDraft, characterChanges: splitLines(value) })
                      }
                      rows={5}
                    />
                    <LinesField
                      label="本卷冲突（每行一条）"
                      value={joinLines(volumeDraft.conflicts)}
                      onChange={(value) =>
                        setVolumeDraft({ ...volumeDraft, conflicts: splitLines(value) })
                      }
                      rows={4}
                    />
                    <LinesField
                      label="本卷伏笔（每行一条）"
                      value={joinLines(volumeDraft.foreshadows)}
                      onChange={(value) =>
                        setVolumeDraft({ ...volumeDraft, foreshadows: splitLines(value) })
                      }
                      rows={4}
                    />
                    <LinesField
                      label="卷摘要"
                      value={volumeDraft.summary}
                      onChange={(value) => setVolumeDraft({ ...volumeDraft, summary: value })}
                      rows={6}
                    />
                    <button
                      className="btn btn-primary"
                      type="button"
                      disabled={saving || disabled}
                      onClick={() => void savePatch({ volume: volumeDraft })}
                    >
                      保存分卷记忆
                    </button>
                  </div>
                ) : null}
              </>
            ) : (
              <p className="muted">还没有分卷记忆。生成基础记忆或写完章节后会自动聚合。</p>
            )}
          </div>
        </section>
      ) : null}

      {view === "chapters" ? (
        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">章节记忆</h2>
            <span className="muted small">只记录已写章节的摘要和事件，不展开正文</span>
          </div>
          <div className="panel-body">
            {memory && Object.keys(memory.chapters).length ? (
              <>
                <div className="memory-chapter-picker">
                  <span className="field-label">选择章节</span>
                  <select
                    className="input"
                    value={selectedChapter}
                    onChange={(event) => setSelectedChapter(Number(event.target.value))}
                  >
                    {Object.values(memory.chapters)
                      .sort((a, b) => a.index - b.index)
                      .map((chapter) => (
                        <option key={chapter.index} value={chapter.index}>
                          第 {chapter.index} 章 · {SOURCE_LABEL[chapter.source]}
                        </option>
                      ))}
                  </select>
                </div>
                {chapterDraft ? (
                  <div className="memory-form">
                    <LinesField
                      label="章节摘要"
                      value={chapterDraft.summary}
                      onChange={(value) => setChapterDraft({ ...chapterDraft, summary: value })}
                      rows={4}
                    />
                    <LinesField
                      label="事件（每行一条）"
                      value={joinLines(chapterDraft.events)}
                      onChange={(value) => setChapterDraft({ ...chapterDraft, events: splitLines(value) })}
                      rows={5}
                    />
                    <LinesField
                      label="出场人物（每行一条）"
                      value={joinLines(chapterDraft.characters)}
                      onChange={(value) =>
                        setChapterDraft({ ...chapterDraft, characters: splitLines(value) })
                      }
                      rows={3}
                    />
                    <LinesField
                      label="人物行动（每行一条）"
                      value={joinLines(chapterDraft.actions)}
                      onChange={(value) => setChapterDraft({ ...chapterDraft, actions: splitLines(value) })}
                      rows={4}
                    />
                    <label className="field">
                      <span className="field-label">时间</span>
                      <input
                        className="input"
                        value={chapterDraft.time}
                        onChange={(event) =>
                          setChapterDraft({ ...chapterDraft, time: event.target.value })
                        }
                      />
                    </label>
                    <label className="field">
                      <span className="field-label">地点</span>
                      <input
                        className="input"
                        value={chapterDraft.location}
                        onChange={(event) =>
                          setChapterDraft({ ...chapterDraft, location: event.target.value })
                        }
                      />
                    </label>
                    <LinesField
                      label="章末状态"
                      value={chapterDraft.endingState}
                      onChange={(value) =>
                        setChapterDraft({ ...chapterDraft, endingState: value })
                      }
                      rows={3}
                    />
                    <LinesField
                      label="新增设定（每行一条）"
                      value={joinLines(chapterDraft.newSettings)}
                      onChange={(value) =>
                        setChapterDraft({ ...chapterDraft, newSettings: splitLines(value) })
                      }
                      rows={4}
                    />
                    <LinesField
                      label="埋设伏笔（每行一条）"
                      value={joinLines(chapterDraft.foreshadowsPlanted)}
                      onChange={(value) =>
                        setChapterDraft({ ...chapterDraft, foreshadowsPlanted: splitLines(value) })
                      }
                      rows={4}
                    />
                    <LinesField
                      label="回收伏笔（每行一条）"
                      value={joinLines(chapterDraft.foreshadowsResolved)}
                      onChange={(value) =>
                        setChapterDraft({ ...chapterDraft, foreshadowsResolved: splitLines(value) })
                      }
                      rows={4}
                    />
                    <button
                      className="btn btn-primary"
                      type="button"
                      disabled={saving || disabled}
                      onClick={() => void savePatch({ chapter: chapterDraft })}
                    >
                      保存章节记忆
                    </button>
                  </div>
                ) : null}
              </>
            ) : (
              <p className="muted">还没有章节记忆。可以先生成基础记忆，或写完一章后自动生成。</p>
            )}
          </div>
        </section>
      ) : null}

      {view === "retrieval" ? (
        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">检索预览</h2>
            <span className="muted small">模拟写作前注入模型的长期记忆上下文</span>
          </div>
          <div className="panel-body">
            <div className="memory-chapter-picker">
              <span className="field-label">目标章节</span>
              <select
                className="input"
                value={retrievalChapter}
                onChange={(event) => setRetrievalChapter(Number(event.target.value))}
              >
                {detail.plan.chapters.map((chapter) => (
                  <option key={chapter.index} value={chapter.index}>
                    第 {chapter.index} 章 {chapter.title}
                  </option>
                ))}
              </select>
              <button
                className="btn"
                type="button"
                onClick={() => void previewRetrieval()}
                disabled={retrieving || !detail.plan.chapters.length}
              >
                {retrieving ? "检索中…" : "预览检索"}
              </button>
            </div>
            {retrieval ? (
              <>
                <p className="muted small">
                  第 {retrieval.chapter} 章 · 约 {retrieval.tokenEstimate} tokens
                  {retrieval.truncated ? " · 已按预算截断" : ""} · 命中章节：
                  {retrieval.chapterIndices.length ? retrieval.chapterIndices.join("、") : "无"}
                </p>
                <pre className="memory-context">{retrieval.text}</pre>
                {retrieval.sources.length ? (
                  <p className="muted small">来源：{retrieval.sources.join("；")}</p>
                ) : null}
              </>
            ) : (
              <p className="muted">选择章节后点击「预览检索」。</p>
            )}
          </div>
        </section>
      ) : null}
    </div>
  );
}
