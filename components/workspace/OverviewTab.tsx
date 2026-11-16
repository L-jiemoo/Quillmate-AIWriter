"use client";

import { useState } from "react";
import type { ProjectDetail } from "@/lib/types";
import { Markdown } from "@/components/Markdown";

type OverviewView = "summary" | "canon" | "world" | "outline" | "chapters";

const VIEWS: { key: OverviewView; label: string }[] = [
  { key: "summary", label: "概览" },
  { key: "canon", label: "事实台账" },
  { key: "world", label: "世界观" },
  { key: "outline", label: "主线大纲" },
  { key: "chapters", label: "章节细纲" },
];

export function OverviewTab({ detail }: { detail: ProjectDetail }) {
  const [view, setView] = useState<OverviewView>("summary");
  const written = detail.state.written.length;
  const totalWords = detail.chapters.reduce(
    (sum, chapter) => sum + (chapter.written ? chapter.words : 0),
    0,
  );
  const canon = detail.canon;
  const alive = canon.characters.filter((character) => character.status === "alive");
  const dead = canon.characters.filter((character) => character.status === "dead");
  const unknown = canon.characters.filter((character) => character.status === "unknown");
  const hasCanon = Boolean(
    canon.characters.length ||
      canon.items.length ||
      canon.timeline.currentDay ||
      canon.timeline.deadlines.length ||
      canon.rules.length,
  );
  const namePreview = (list: { name: string }[], limit = 8): string => {
    const names = list.slice(0, limit).map((item) => item.name).join("、");
    return list.length > limit ? `${names} 等 ${list.length} 人` : names;
  };

  return (
    <div className="overview">
      <div className="segmented overview-tabs" role="tablist" aria-label="总览视图">
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
            {item.key === "canon" ? (
              <span className="segmented-count">
                {canon.characters.length} 人 · {canon.items.length} 物
              </span>
            ) : null}
            {item.key === "chapters" ? (
              <span className="segmented-count">{detail.plan.chapters.length} 章</span>
            ) : null}
          </button>
        ))}
      </div>

      {view === "summary" ? (
        <>
          <div className="stats-grid">
            <div className="stat">
              <span className="stat-value">
                {written}/{detail.chapters.length}
              </span>
              <span className="stat-label">已写章节</span>
            </div>
            <div className="stat">
              <span className="stat-value">{totalWords.toLocaleString("zh-CN")}</span>
              <span className="stat-label">累计字数</span>
            </div>
            <div className="stat">
              <span className="stat-value">{detail.characters.length}</span>
              <span className="stat-label">核心角色</span>
            </div>
            <div className="stat">
              <span className="stat-value">{detail.plan.tags.length}</span>
              <span className="stat-label">作品标签</span>
            </div>
          </div>

          {hasCanon ? (
            <p className="canon-line overview-canon-line">
              台账截至第 {canon.lastChapter || 0} 章 · 当前时间：
              {canon.timeline.currentDay || "未记录"} · 存活 {alive.length} / 死亡{" "}
              {dead.length} / 待核实 {unknown.length} · 物品 {canon.items.length}
            </p>
          ) : null}

          <section className="panel">
            <div className="panel-head">
              <h2 className="panel-title">故事内核</h2>
              <span className="muted small">梗概</span>
            </div>
            <div className="panel-body">
              {detail.plan.logline ? (
                <blockquote className="logline">{detail.plan.logline}</blockquote>
              ) : (
                <p className="muted">还没有架构。点击右侧「生成架构与角色」开始。</p>
              )}
              {detail.plan.tags.length ? (
                <div className="tag-list">
                  {detail.plan.tags.map((tag) => (
                    <span key={tag} className="tag">
                      {tag}
                    </span>
                  ))}
                </div>
              ) : null}
              <dl className="meta-list">
                <div>
                  <dt>核心创意</dt>
                  <dd>{detail.meta.idea || "未填写"}</dd>
                </div>
                <div>
                  <dt>目标规模</dt>
                  <dd>
                    {detail.meta.targetChapters} 章 · 每章约 {detail.meta.wordsPerChapter} 字
                  </dd>
                </div>
                <div>
                  <dt>更新时间</dt>
                  <dd>
                    {new Date(detail.meta.updatedAt).toLocaleString("zh-CN", {
                      hour12: false,
                    })}
                  </dd>
                </div>
              </dl>
            </div>
          </section>
        </>
      ) : null}

      {view === "canon" ? (
        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">事实台账摘要</h2>
            <span className="muted small">
              {canon.lastChapter ? `截至第 ${canon.lastChapter} 章` : "尚未建立"}
            </span>
          </div>
          <div className="panel-body">
            {!hasCanon ? (
              <p className="muted small">
                还没有事实台账。写作新章节或点「重建事实台账」后会自动积累。
              </p>
            ) : (
              <>
                <p className="canon-line">
                  当前时间：{canon.timeline.currentDay || "未记录"} · 角色{" "}
                  {alive.length} 存活 / {dead.length} 死亡 / {unknown.length} 待核实 · 物品{" "}
                  {canon.items.length} · 死线 {canon.timeline.deadlines.length}
                </p>
                <div className="canon-grid">
                  <div className="canon-block">
                    <p className="canon-label">存活角色</p>
                    {alive.length ? (
                      <p className="canon-line">{namePreview(alive)}</p>
                    ) : (
                      <p className="muted small">暂无</p>
                    )}
                    <p className="canon-label">已死亡</p>
                    {dead.length ? (
                      <ul className="canon-list">
                        {dead.slice(0, 8).map((character) => (
                          <li key={`${character.name}-${character.statusChapter}`}>
                            <span className="canon-name">{character.name}</span>
                            <span className="canon-meta">
                              {" "}
                              · 第 {character.statusChapter} 章死亡
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="muted small">暂无</p>
                    )}
                    {unknown.length ? (
                      <>
                        <p className="canon-label">状态待核实</p>
                        <p className="canon-line">{namePreview(unknown)}</p>
                      </>
                    ) : null}
                  </div>
                  <div className="canon-block">
                    <p className="canon-label">关键物品</p>
                    {canon.items.length ? (
                      <ul className="canon-list">
                        {canon.items.slice(0, 8).map((item) => (
                          <li key={`${item.name}-${item.chapter}`}>
                            <span className="canon-name">{item.name}</span>
                            {item.holder ? (
                              <span className="canon-meta"> · 持有人：{item.holder}</span>
                            ) : null}
                            {item.state ? (
                              <span className="canon-meta"> · {item.state}</span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="muted small">暂无</p>
                    )}
                    <p className="canon-label">时间与死线</p>
                    {canon.timeline.deadlines.length ? (
                      <ul className="canon-list">
                        {canon.timeline.deadlines.slice(0, 6).map((deadline) => (
                          <li key={`${deadline.name}-${deadline.chapter}`}>
                            <span className="canon-name">{deadline.name}</span>
                            {deadline.due ? (
                              <span className="canon-meta"> · 期限：{deadline.due}</span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="muted small">暂无</p>
                    )}
                    <p className="canon-label">硬性规则</p>
                    {canon.rules.length ? (
                      <ul className="canon-list">
                        {canon.rules.slice(0, 5).map((rule, index) => (
                          <li key={`${index}-${rule}`}>{rule}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="muted small">暂无</p>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        </section>
      ) : null}

      {view === "world" ? (
        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">世界观圣经</h2>
            <span className="muted small">世界设定</span>
          </div>
          <div className="panel-body">
            <Markdown>{detail.bible}</Markdown>
          </div>
        </section>
      ) : null}

      {view === "outline" ? (
        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">主线大纲</h2>
            <span className="muted small">主线</span>
          </div>
          <div className="panel-body">
            <Markdown>{detail.outlineMd}</Markdown>
          </div>
        </section>
      ) : null}

      {view === "chapters" ? (
        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">章节细纲</h2>
            <span className="muted small">细纲</span>
          </div>
          <div className="panel-body">
            {detail.plan.chapters.length ? (
              <ol className="plan-list">
                {detail.plan.chapters.map((chapter) => (
                  <li key={chapter.index}>
                    <div className="plan-title">
                      <span className="plan-index">
                        {String(chapter.index).padStart(2, "0")}
                      </span>
                      <span>{chapter.title}</span>
                      <span
                        className={`dot ${
                          detail.state.written.includes(chapter.index)
                            ? "dot-done"
                            : "dot-pending"
                        }`}
                      />
                    </div>
                    <p>{chapter.summary}</p>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="muted">还没有章节细纲，请先生成架构与角色。</p>
            )}
          </div>
        </section>
      ) : null}
    </div>
  );
}
