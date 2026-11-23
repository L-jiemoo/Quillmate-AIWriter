"use client";

import { useCallback, useEffect, useState } from "react";
import { Markdown } from "@/components/Markdown";
import { BusyLabel, SkeletonLines } from "@/components/ui/Loading";
import type {
  AuditChapterResult,
  AuditResult,
  CanonCharacter,
  CanonCharacterStatus,
  CanonDeadline,
  CanonFacts,
  CanonItem,
  ContinuityIssue,
  ProjectDetail,
  RejectedDraft,
  ReviewResult,
  StartJobFn,
} from "@/lib/types";
import { errorMessage } from "@/lib/utils";

type Section = "canon" | "reviews" | "leftovers" | "audit";
type CanonView = "characters" | "items" | "timeline" | "facts" | "rules";
type ReviewFilter = "all" | "flagged";

const STATUS_ORDER: { key: CanonCharacterStatus; label: string }[] = [
  { key: "dead", label: "已死亡" },
  { key: "alive", label: "存活/活跃" },
  { key: "unknown", label: "状态未知" },
];

const STATUS_LABEL: Record<CanonCharacterStatus, string> = {
  alive: "存活",
  dead: "已死亡",
  unknown: "未知",
};

function splitAliases(value: string): string[] {
  return value
    .split(/[,，、;；\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function cloneCanon(canon: CanonFacts): CanonFacts {
  return JSON.parse(JSON.stringify(canon)) as CanonFacts;
}

function IssueList({ issues }: { issues: ContinuityIssue[] }) {
  if (!issues.length) return <p className="muted small">未发现明显冲突。</p>;
  return (
    <ul className="review-issue-list">
      {issues.map((issue, index) => (
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
            {issue.evidence ? <p className="review-evidence">证据：{issue.evidence}</p> : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

function CanonReadView({ canon, view }: { canon: CanonFacts; view: CanonView }) {
  if (view === "characters") {
    if (!canon.characters.length) {
      return <p className="muted small">暂无人物记录。</p>;
    }
    return (
      <div className="canon-block">
        {STATUS_ORDER.map((group) => {
          const list = canon.characters.filter(
            (character) => character.status === group.key,
          );
          if (!list.length) return null;
          return (
            <div key={group.key} className="canon-status-group">
              <p className="canon-label">{group.label}</p>
              <ul className="canon-list">
                {list.map((character) => (
                  <li key={character.name}>
                    <span className="canon-name">{character.name}</span>
                    {character.aliases.length ? (
                      <span className="canon-meta">
                        {" "}
                        · 别名：{character.aliases.join("、")}
                      </span>
                    ) : null}
                    {character.status === "dead" ? (
                      <span className="canon-meta">
                        {" "}
                        · 第 {character.statusChapter} 章死亡
                      </span>
                    ) : character.location ? (
                      <span className="canon-meta"> · {character.location}</span>
                    ) : null}
                    {character.note ? (
                      <span className="canon-meta"> · {character.note}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    );
  }

  if (view === "items") {
    if (!canon.items.length) return <p className="muted small">暂无关键物品记录。</p>;
    return (
      <div className="canon-block">
        <ul className="canon-list">
          {canon.items.map((item) => (
            <li key={item.name}>
              <span className="canon-name">{item.name}</span>
              {item.aliases.length ? (
                <span className="canon-meta"> · 别名：{item.aliases.join("、")}</span>
              ) : null}
              {item.holder ? (
                <span className="canon-meta"> · 持有人：{item.holder}</span>
              ) : null}
              {item.location ? (
                <span className="canon-meta"> · 位置：{item.location}</span>
              ) : null}
              {item.state ? <span className="canon-meta"> · {item.state}</span> : null}
              {item.note ? <span className="canon-meta"> · {item.note}</span> : null}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (view === "timeline") {
    return (
      <div className="canon-block">
        <p className="canon-line">当前时间：{canon.timeline.currentDay || "未记录"}</p>
        {canon.timeline.deadlines.length ? (
          <ul className="canon-list">
            {canon.timeline.deadlines.map((deadline) => (
              <li key={deadline.name}>
                <span className="canon-name">{deadline.name}</span>
                {deadline.due ? (
                  <span className="canon-meta"> · 期限：{deadline.due}</span>
                ) : null}
                {deadline.note ? (
                  <span className="canon-meta"> · {deadline.note}</span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">暂无期限记录。</p>
        )}
      </div>
    );
  }

  if (view === "facts") {
    const facts = canon.facts ?? [];
    if (!facts.length) return <p className="muted small">暂无架构既定事实。</p>;
    return (
      <div className="canon-block">
        <ul className="canon-list">
          {facts.map((fact) => (
            <li key={fact.id}>
              <span className="canon-name">[{fact.kind}]</span>
              <span className="canon-meta"> · {fact.content}</span>
              <span className="canon-meta">
                {" "}
                · 首次确立：
                {fact.establishedAt === "architecture"
                  ? "架构设定"
                  : fact.establishedAt === "character"
                    ? "角色设定"
                    : `第 ${fact.chapter} 章`}
                {fact.immutable ? " · 不可变" : ""}
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (!canon.rules.length) return <p className="muted small">暂无硬性规则记录。</p>;
  return (
    <div className="canon-block">
      <ul className="canon-list">
        {canon.rules.map((rule, index) => (
          <li key={`${index}-${rule}`}>{rule}</li>
        ))}
      </ul>
    </div>
  );
}

export function ContinuityTab({
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
  const [section, setSection] = useState<Section>("canon");
  const [view, setView] = useState<CanonView>("characters");
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>("all");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<CanonFacts | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [auditContent, setAuditContent] = useState("");
  const [auditResult, setAuditResult] = useState<AuditResult | null>(null);
  const [auditUpdatedAt, setAuditUpdatedAt] = useState<string | null>(null);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState("");
  const [auditFilter, setAuditFilter] = useState<"all" | "critical" | "ignore">("all");
  const [autoContinueRepair, setAutoContinueRepair] = useState(true);

  const loadAudit = useCallback(async () => {
    setAuditLoading(true);
    setAuditError("");
    try {
      const response = await fetch(`/api/projects/${detail.meta.slug}/audit`, {
        cache: "no-store",
      });
      const data = (await response.json()) as {
        content?: string;
        result?: AuditResult | null;
        updatedAt?: string | null;
        error?: string;
      };
      if (!response.ok) throw new Error(data.error ?? "读取总体审校报告失败");
      setAuditContent(data.content ?? "");
      setAuditResult(data.result ?? null);
      setAuditUpdatedAt(data.updatedAt ?? null);
    } catch (error) {
      setAuditError(errorMessage(error));
    } finally {
      setAuditLoading(false);
    }
  }, [detail.meta.slug]);

  useEffect(() => {
    // 报告是只读文件，后台任务运行期间也要能查看；audit.md 只在总体审校结束时整份写入。
    // 依赖 disabled 是为了在任务开始/结束时各刷新一次。
    if (section === "audit") void loadAudit();
    // 批量修复进行中切到审校/遗留页时，同步一次章节审校记录。
    if (disabled && (section === "audit" || section === "leftovers")) {
      void onRefresh();
    }
  }, [section, disabled, loadAudit, onRefresh]);

  useEffect(() => {
    setAuditContent("");
    setAuditResult(null);
    setAuditUpdatedAt(null);
    setAuditError("");
    setAuditFilter("all");
  }, [detail.meta.slug]);

  const written = detail.chapters.filter(
    (chapter) => chapter.written && chapter.content.trim(),
  );
  const checked = written.filter((chapter) => detail.state.reviews[String(chapter.index)]);
  const flagged = checked.filter(
    (chapter) => detail.state.reviews[String(chapter.index)]?.continuityOk === false,
  );
  const rejectedDrafts = Object.values(detail.state.rejectedDrafts ?? {}).sort(
    (a, b) => a.index - b.index,
  );
  // 定点修复后仍未解决的严重问题，按章节汇总；同章的建议/可忽略也一并展示。
  const leftoverChapters = written
    .filter((chapter) => {
      if (!detail.state.repairs?.[String(chapter.index)]) return false;
      const review = detail.state.reviews[String(chapter.index)];
      return Boolean(
        review?.issues.some((issue) => issue.severity === "critical"),
      );
    })
    .sort((a, b) => a.index - b.index);
  const criticalCount = checked.reduce((sum, chapter) => {
    const review = detail.state.reviews[String(chapter.index)];
    return (
      sum +
      (review?.issues.filter((issue) => issue.severity === "critical").length ?? 0)
    );
  }, 0);

  const auditChapters = auditResult?.chapters ?? [];
  const auditFlagged = auditChapters.filter((chapter) =>
    chapter.issues.some((issue) => issue.severity === "critical"),
  );
  const auditIgnorable = auditChapters.filter((chapter) =>
    chapter.issues.some((issue) => issue.severity === "ignore"),
  );
  const shownAudit =
    auditFilter === "critical"
      ? auditFlagged
      : auditFilter === "ignore"
        ? auditIgnorable
        : auditChapters;
  const auditCritical = auditResult?.critical ?? 0;
  const auditWarnings = auditResult?.warnings ?? 0;
  const auditIgnored = auditResult?.ignored ?? 0;
  const auditTime = auditUpdatedAt ? new Date(auditUpdatedAt).getTime() : 0;

  function wasRepairedSinceAudit(index: number): boolean {
    const at = detail.state.repairs?.[String(index)];
    return Boolean(at) && new Date(at).getTime() > auditTime;
  }

  // 顶部统计随当前子页切换：看总体审校时展示它的结果，避免仍显示 0 个严重问题。
  const viewingAudit = section === "audit" && Boolean(auditResult);
  const statsChecked = viewingAudit && auditResult ? auditResult.chapters.length : checked.length;
  const statsWritten = viewingAudit && auditResult ? auditResult.chapters.length : written.length;
  const statsFlagged = viewingAudit ? auditFlagged.length : flagged.length;
  const statsCritical = viewingAudit ? auditCritical : criticalCount;

  const canon = detail.canon;
  const hasCanon =
    canon.characters.length > 0 ||
    canon.items.length > 0 ||
    Boolean(canon.timeline.currentDay) ||
    canon.timeline.deadlines.length > 0 ||
    (canon.facts?.length ?? 0) > 0 ||
    canon.rules.length > 0;
  const latestWritten = written.length
    ? Math.max(...written.map((chapter) => chapter.index))
    : 0;
  const canonBehind = latestWritten > canon.lastChapter;

  const reviewed = reviewFilter === "flagged" ? flagged : checked;
  const shownCanon = editing && draft ? draft : canon;

  function repairFromAudit(chapter: AuditChapterResult) {
    if (disabled || !chapter.issues.length) return;
    const fixable = chapter.issues.filter((issue) => issue.severity !== "ignore");
    if (!fixable.length) return;
    const critical = fixable.filter((issue) => issue.severity === "critical").length;
    const warnings = fixable.length - critical;
    const ignored = chapter.issues.length - fixable.length;

    // 自动续修跟随当前筛选：筛选“严重”时只续修有严重问题的章节。
    // 同时跳过没有可修复问题和本轮审校后已经改过的章节。
    const queue = (
      autoContinueRepair
        ? shownAudit.filter(
            (item) =>
              item.index >= chapter.index &&
              item.issues.some((issue) => issue.severity !== "ignore") &&
              !wasRepairedSinceAudit(item.index),
          )
        : [chapter]
    ).sort((a, b) => a.index - b.index);
    if (!queue.length) return;

    const follow = queue.slice(1).map((item) => item.index);
    const followNote = follow.length
      ? `\n\n完成后自动继续修复后续 ${follow.length} 章（第 ${follow
          .slice(0, 8)
          .join("、")}${follow.length > 8 ? "…" : ""} 章）。`
      : "";
    const ignoredNote = ignored ? `，${ignored} 条可忽略不修` : "";
    if (
      !window.confirm(
        `将根据总体审校记录定点修复第 ${chapter.index} 章《${chapter.title}》（${critical} 严重 / ${warnings} 建议${ignoredNote}）。${followNote}\n\n修复会直接改写正文，原稿先备份到 drafts/；每章都会重新抽取事实并做连续性检查，遗留问题会记入章节审校。继续？`,
      )
    ) {
      return;
    }
    void onStartJob("repair", { indices: queue.map((item) => item.index) });
  }

  function repairDraft(draft: RejectedDraft) {
    if (disabled) return;
    const critical = draft.review.issues.filter(
      (issue) => issue.severity === "critical",
    ).length;
    if (
      !window.confirm(
        `将让修复 Agent 按当前审校问题处理第 ${draft.index} 章未采用草稿（${critical} 个严重问题）。\n\n修复会先重新抽取事实并审校，最多自动修 3 轮。通过后自动写入正文；重写稿会先备份原正文。仍未通过则更新草稿，原正文保持不变。继续？`,
      )
    ) {
      return;
    }
    void onStartJob("repair", { indices: [draft.index], source: "draft" });
  }

  function repairFromReview(index: number, review: ReviewResult) {
    if (disabled) return;
    const fixable = review.issues.filter((issue) => issue.severity !== "ignore");
    if (!fixable.length) return;
    const critical = fixable.filter((issue) => issue.severity === "critical").length;
    const warnings = fixable.length - critical;
    const ignored = review.issues.length - fixable.length;
    const ignoredNote = ignored ? `，${ignored} 条可忽略不修` : "";
    if (
      !window.confirm(
        `将根据第 ${index} 章的章节审校记录定点修复正文（${critical} 严重 / ${warnings} 建议${ignoredNote}）。\n\n修复会直接改写正文，原稿先备份到 drafts/；修复后重新检查，遗留问题会更新到章节审校。继续？`,
      )
    ) {
      return;
    }
    void onStartJob("repair", { indices: [index], source: "review" });
  }

  function rebuild() {
    if (!written.length || disabled || editing) return;
    if (
      !window.confirm(
        `将逐章调用模型重新抽取 ${written.length} 章正文中的事实，并更新章节摘要。\n\n这个任务耗时较长，不会修改正文，但会覆盖当前手工编辑过的台账。继续？`,
      )
    ) {
      return;
    }
    void onStartJob("recanon");
  }

  function startEdit() {
    if (disabled) return;
    setDraft(cloneCanon(canon));
    setSaveError("");
    setEditing(true);
  }

  function cancelEdit() {
    setDraft(null);
    setSaveError("");
    setEditing(false);
  }

  function patchCharacter(index: number, patch: Partial<CanonCharacter>) {
    setDraft((current) =>
      current
        ? {
            ...current,
            characters: current.characters.map((character, i) =>
              i === index ? { ...character, ...patch } : character,
            ),
          }
        : current,
    );
  }

  function patchItem(index: number, patch: Partial<CanonItem>) {
    setDraft((current) =>
      current
        ? {
            ...current,
            items: current.items.map((item, i) => (i === index ? { ...item, ...patch } : item)),
          }
        : current,
    );
  }

  function patchDeadline(index: number, patch: Partial<CanonDeadline>) {
    setDraft((current) =>
      current
        ? {
            ...current,
            timeline: {
              ...current.timeline,
              deadlines: current.timeline.deadlines.map((deadline, i) =>
                i === index ? { ...deadline, ...patch } : deadline,
              ),
            },
          }
        : current,
    );
  }

  async function save() {
    if (!draft || saving || disabled) return;
    setSaving(true);
    setSaveError("");
    try {
      const payload: CanonFacts = {
        ...draft,
        characters: draft.characters.filter((character) => character.name.trim()),
        items: draft.items.filter((item) => item.name.trim()),
        timeline: {
          currentDay: draft.timeline.currentDay.trim(),
          deadlines: draft.timeline.deadlines
            .filter((deadline) => deadline.name.trim())
            .map((deadline) => ({ ...deadline, name: deadline.name.trim() })),
        },
        rules: draft.rules.map((rule) => rule.trim()).filter(Boolean),
      };
      const response = await fetch(`/api/projects/${detail.meta.slug}/canon`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ canon: payload }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "保存事实台账失败");
      await onRefresh();
      setDraft(null);
      setEditing(false);
    } catch (error) {
      setSaveError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="overview continuity">
      <div className="stats-grid">
        <div className="stat">
          <span className="stat-value">
            {statsChecked}/{statsWritten || 0}
          </span>
          <span className="stat-label">已检查章节</span>
        </div>
        <div className="stat">
          <span className="stat-value">{statsFlagged}</span>
          <span className="stat-label">需复查章节</span>
        </div>
        <div className="stat">
          <span className="stat-value">{statsCritical}</span>
          <span className="stat-label">严重问题</span>
        </div>
        <div className="stat">
          <span className="stat-value">{canon.characters.length}</span>
          <span className="stat-label">台账人物</span>
        </div>
      </div>

      <div className="segmented continuity-section-tabs" role="tablist" aria-label="连续性视图">
        <button
          type="button"
          role="tab"
          aria-selected={section === "canon"}
          className={`segmented-item ${section === "canon" ? "active" : ""}`}
          onClick={() => setSection("canon")}
        >
          事实台账
          <span className="segmented-count">
            {canon.characters.length} 人 · {canon.items.length} 物
          </span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={section === "reviews"}
          className={`segmented-item ${section === "reviews" ? "active" : ""}`}
          onClick={() => setSection("reviews")}
        >
          章节审校
          <span className="segmented-count">
            {flagged.length ? `${flagged.length} 章需复查` : `${checked.length} 章`}
            {rejectedDrafts.length ? ` · ${rejectedDrafts.length} 份未采用` : ""}
          </span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={section === "leftovers"}
          className={`segmented-item ${section === "leftovers" ? "active" : ""}`}
          onClick={() => setSection("leftovers")}
        >
          遗留修复
          <span className="segmented-count">{leftoverChapters.length}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={section === "audit"}
          className={`segmented-item ${section === "audit" ? "active" : ""}`}
          onClick={() => setSection("audit")}
        >
          总体审校
          <span className="segmented-count">
            {auditLoading && !auditResult
              ? "读取中"
              : auditResult?.chapters.length
                ? `${auditResult.chapters.length} 章`
                : "报告"}
          </span>
        </button>
      </div>

      {section === "canon" ? (
        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">事实台账</h2>
            <div className="panel-head-tools">
              <span className="muted small">
                {canon.lastChapter
                  ? `已覆盖到第 ${canon.lastChapter} 章`
                  : hasCanon
                    ? "架构初始台账"
                    : "尚未建立"}
              </span>
              {editing ? (
                <>
                  <button className="btn btn-sm" onClick={cancelEdit} disabled={saving}>
                    取消
                  </button>
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={() => void save()}
                    disabled={saving || disabled}
                  >
                    {saving ? "保存中…" : "保存"}
                  </button>
                </>
              ) : (
                <button className="btn btn-sm" onClick={startEdit} disabled={disabled}>
                  编辑台账
                </button>
              )}
            </div>
          </div>
          <div className="panel-body">
            <div className="continuity-toolbar">
              <div className="segmented segmented-sm" role="tablist" aria-label="台账分类">
                {(
                  [
                    ["characters", "人物"],
                    ["items", "物品"],
                    ["timeline", "时间线"],
                    ["facts", "设定"],
                    ["rules", "规则"],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    aria-selected={view === key}
                    className={`segmented-item ${view === key ? "active" : ""}`}
                    onClick={() => setView(key)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <button
                className="btn btn-sm"
                onClick={rebuild}
                disabled={disabled || editing || !written.length}
              >
                {disabled ? "任务进行中…" : "重建事实台账"}
              </button>
            </div>

            {canonBehind ? (
              <p className="form-error">
                已有第 {latestWritten} 章正文，但台账只覆盖到第 {canon.lastChapter || 0}{" "}
                章。自动写作/重写会先要求重建台账，避免脱离事实约束。
              </p>
            ) : null}

            {saveError ? <p className="form-error">{saveError}</p> : null}

            {editing ? (
              <p className="hint continuity-edit-hint">
                手工修改只影响后续写作的事实约束，不会改动正文。保存后，后续写/重写的章节会按新台账检查。
              </p>
            ) : null}

            {!hasCanon && !editing ? (
              <p className="empty-inline">
                还没有事实台账。新章节会自动积累；已写章节可点「重建事实台账」初始化，也可以直接手工编辑。
              </p>
            ) : editing && draft ? (
              <div className="canon-scroll">
                {view === "characters" ? (
                  <div className="canon-edit-list">
                    {draft.characters.map((character, index) => (
                      <div key={index} className="canon-edit-row">
                        <div className="canon-edit-head">
                          <span className="canon-edit-index">人物 {index + 1}</span>
                          <button
                            className="btn btn-sm btn-ghost danger-text"
                            onClick={() =>
                              setDraft((current) =>
                                current
                                  ? {
                                      ...current,
                                      characters: current.characters.filter(
                                        (_, i) => i !== index,
                                      ),
                                    }
                                  : current,
                              )
                            }
                          >
                            删除
                          </button>
                        </div>
                        <div className="field-row-2">
                          <label className="field">
                            <span>姓名</span>
                            <input
                              className="input input-sm"
                              value={character.name}
                              onChange={(event) =>
                                patchCharacter(index, { name: event.target.value })
                              }
                            />
                          </label>
                          <label className="field">
                            <span>别名（逗号分隔）</span>
                            <input
                              className="input input-sm"
                              value={character.aliases.join("，")}
                              onChange={(event) =>
                                patchCharacter(index, {
                                  aliases: splitAliases(event.target.value),
                                })
                              }
                            />
                          </label>
                        </div>
                        <div className="field-row-3">
                          <label className="field">
                            <span>状态</span>
                            <select
                              className="input input-sm"
                              value={character.status}
                              onChange={(event) =>
                                patchCharacter(index, {
                                  status: event.target.value as CanonCharacterStatus,
                                })
                              }
                            >
                              {(["alive", "dead", "unknown"] as const).map((status) => (
                                <option key={status} value={status}>
                                  {STATUS_LABEL[status]}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="field">
                            <span>状态章节</span>
                            <input
                              className="input input-sm"
                              type="number"
                              min={0}
                              value={character.statusChapter || 0}
                              onChange={(event) =>
                                patchCharacter(index, {
                                  statusChapter: Number(event.target.value) || 0,
                                })
                              }
                            />
                          </label>
                          <label className="field">
                            <span>位置</span>
                            <input
                              className="input input-sm"
                              value={character.location}
                              onChange={(event) =>
                                patchCharacter(index, { location: event.target.value })
                              }
                            />
                          </label>
                        </div>
                        <label className="field">
                          <span>备注</span>
                          <input
                            className="input input-sm"
                            value={character.note}
                            onChange={(event) =>
                              patchCharacter(index, { note: event.target.value })
                            }
                          />
                        </label>
                      </div>
                    ))}
                    <div className="canon-edit-actions">
                      <button
                        className="btn btn-sm"
                        onClick={() =>
                          setDraft((current) =>
                            current
                              ? {
                                  ...current,
                                  characters: [
                                    ...current.characters,
                                    {
                                      name: "",
                                      aliases: [],
                                      status: "unknown",
                                      location: "",
                                      note: "",
                                      statusChapter: current.lastChapter,
                                      chapter: current.lastChapter,
                                    },
                                  ],
                                }
                              : current,
                          )
                        }
                        disabled={draft.characters.length >= 400}
                      >
                        + 添加人物
                      </button>
                    </div>
                  </div>
                ) : null}

                {view === "items" ? (
                  <div className="canon-edit-list">
                    {draft.items.map((item, index) => (
                      <div key={index} className="canon-edit-row">
                        <div className="canon-edit-head">
                          <span className="canon-edit-index">物品 {index + 1}</span>
                          <button
                            className="btn btn-sm btn-ghost danger-text"
                            onClick={() =>
                              setDraft((current) =>
                                current
                                  ? {
                                      ...current,
                                      items: current.items.filter((_, i) => i !== index),
                                    }
                                  : current,
                              )
                            }
                          >
                            删除
                          </button>
                        </div>
                        <div className="field-row-2">
                          <label className="field">
                            <span>名称</span>
                            <input
                              className="input input-sm"
                              value={item.name}
                              onChange={(event) =>
                                patchItem(index, { name: event.target.value })
                              }
                            />
                          </label>
                          <label className="field">
                            <span>别名（逗号分隔）</span>
                            <input
                              className="input input-sm"
                              value={item.aliases.join("，")}
                              onChange={(event) =>
                                patchItem(index, { aliases: splitAliases(event.target.value) })
                              }
                            />
                          </label>
                        </div>
                        <div className="field-row-2">
                          <label className="field">
                            <span>持有人</span>
                            <input
                              className="input input-sm"
                              value={item.holder}
                              onChange={(event) =>
                                patchItem(index, { holder: event.target.value })
                              }
                            />
                          </label>
                          <label className="field">
                            <span>状态</span>
                            <input
                              className="input input-sm"
                              value={item.state}
                              onChange={(event) =>
                                patchItem(index, { state: event.target.value })
                              }
                            />
                          </label>
                        </div>
                        <label className="field">
                          <span>备注</span>
                          <input
                            className="input input-sm"
                            value={item.note}
                            onChange={(event) =>
                              patchItem(index, { note: event.target.value })
                            }
                          />
                        </label>
                      </div>
                    ))}
                    <div className="canon-edit-actions">
                      <button
                        className="btn btn-sm"
                        onClick={() =>
                          setDraft((current) =>
                            current
                              ? {
                                  ...current,
                                  items: [
                                    ...current.items,
                                    {
                                      name: "",
                                      aliases: [],
                                      holder: "",
                                      state: "",
                                      note: "",
                                      chapter: current.lastChapter,
                                    },
                                  ],
                                }
                              : current,
                          )
                        }
                        disabled={draft.items.length >= 400}
                      >
                        + 添加物品
                      </button>
                    </div>
                  </div>
                ) : null}

                {view === "timeline" ? (
                  <div className="canon-edit-list">
                    <div className="canon-edit-row">
                      <label className="field">
                        <span>当前时间</span>
                        <input
                          className="input input-sm"
                          value={draft.timeline.currentDay}
                          onChange={(event) =>
                            setDraft((current) =>
                              current
                                ? {
                                    ...current,
                                    timeline: {
                                      ...current.timeline,
                                      currentDay: event.target.value,
                                    },
                                  }
                                : current,
                            )
                          }
                        />
                      </label>
                    </div>
                    {draft.timeline.deadlines.map((deadline, index) => (
                      <div key={index} className="canon-edit-row">
                        <div className="canon-edit-head">
                          <span className="canon-edit-index">期限 {index + 1}</span>
                          <button
                            className="btn btn-sm btn-ghost danger-text"
                            onClick={() =>
                              setDraft((current) =>
                                current
                                  ? {
                                      ...current,
                                      timeline: {
                                        ...current.timeline,
                                        deadlines: current.timeline.deadlines.filter(
                                          (_, i) => i !== index,
                                        ),
                                      },
                                    }
                                  : current,
                              )
                            }
                          >
                            删除
                          </button>
                        </div>
                        <div className="field-row-3">
                          <label className="field">
                            <span>事项</span>
                            <input
                              className="input input-sm"
                              value={deadline.name}
                              onChange={(event) =>
                                patchDeadline(index, { name: event.target.value })
                              }
                            />
                          </label>
                          <label className="field">
                            <span>期限</span>
                            <input
                              className="input input-sm"
                              value={deadline.due}
                              onChange={(event) =>
                                patchDeadline(index, { due: event.target.value })
                              }
                            />
                          </label>
                          <label className="field">
                            <span>备注</span>
                            <input
                              className="input input-sm"
                              value={deadline.note}
                              onChange={(event) =>
                                patchDeadline(index, { note: event.target.value })
                              }
                            />
                          </label>
                        </div>
                      </div>
                    ))}
                    <div className="canon-edit-actions">
                      <button
                        className="btn btn-sm"
                        onClick={() =>
                          setDraft((current) =>
                            current
                              ? {
                                  ...current,
                                  timeline: {
                                    ...current.timeline,
                                    deadlines: [
                                      ...current.timeline.deadlines,
                                      {
                                        name: "",
                                        due: "",
                                        note: "",
                                        chapter: current.lastChapter,
                                      },
                                    ],
                                  },
                                }
                              : current,
                          )
                        }
                        disabled={draft.timeline.deadlines.length >= 200}
                      >
                        + 添加期限
                      </button>
                    </div>
                  </div>
                ) : null}

                {view === "rules" ? (
                  <div className="canon-edit-list">
                    {draft.rules.map((rule, index) => (
                      <div key={index} className="canon-edit-row">
                        <div className="canon-edit-head">
                          <span className="canon-edit-index">规则 {index + 1}</span>
                          <button
                            className="btn btn-sm btn-ghost danger-text"
                            onClick={() =>
                              setDraft((current) =>
                                current
                                  ? {
                                      ...current,
                                      rules: current.rules.filter((_, i) => i !== index),
                                    }
                                  : current,
                              )
                            }
                          >
                            删除
                          </button>
                        </div>
                        <label className="field">
                          <span>内容</span>
                          <textarea
                            className="input input-sm textarea-sm"
                            value={rule}
                            onChange={(event) =>
                              setDraft((current) =>
                                current
                                  ? {
                                      ...current,
                                      rules: current.rules.map((item, i) =>
                                        i === index ? event.target.value : item,
                                      ),
                                    }
                                  : current,
                              )
                            }
                          />
                        </label>
                      </div>
                    ))}
                    <div className="canon-edit-actions">
                      <button
                        className="btn btn-sm"
                        onClick={() =>
                          setDraft((current) =>
                            current ? { ...current, rules: [...current.rules, ""] } : current,
                          )
                        }
                        disabled={draft.rules.length >= 200}
                      >
                        + 添加规则
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : hasCanon ? (
              <div className="canon-scroll">
                <CanonReadView canon={shownCanon} view={view} />
              </div>
            ) : null}
          </div>
        </section>
      ) : section === "reviews" ? (
        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">章节审校记录</h2>
            <div className="panel-head-tools">
              <div className="segmented segmented-sm" role="tablist" aria-label="审校记录筛选">
                <button
                  type="button"
                  role="tab"
                  aria-selected={reviewFilter === "all"}
                  className={`segmented-item ${reviewFilter === "all" ? "active" : ""}`}
                  onClick={() => setReviewFilter("all")}
                >
                  全部
                  <span className="segmented-count">{checked.length}</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={reviewFilter === "flagged"}
                  className={`segmented-item ${reviewFilter === "flagged" ? "active" : ""}`}
                  onClick={() => setReviewFilter("flagged")}
                >
                  需复查
                  <span className="segmented-count">{flagged.length}</span>
                </button>
              </div>
            </div>
          </div>
          <div className="panel-body">
            {rejectedDrafts.length ? (
              <div className="rejected-drafts">
                <p className="canon-label">未采用草稿（未写入正文，原章节保留）</p>
                <div className="continuity-list">
                  {rejectedDrafts.map((draft) => {
                    const critical = draft.review.issues.filter(
                      (issue) => issue.severity === "critical",
                    ).length;
                    const extractionFailed = draft.review.extractionOk === false;
                    return (
                      <article key={draft.index} className="continuity-chapter bad">
                        <div className="continuity-chapter-head">
                          <div>
                            <span className="plan-index">
                              {String(draft.index).padStart(2, "0")}
                            </span>{" "}
                            <span className="canon-name">
                              {draft.mode === "rewrite" ? "重写稿" : "新写稿"}
                            </span>
                          </div>
                          <div className="panel-head-tools">
                            <span className="muted small">
                              {new Date(draft.at).toLocaleString("zh-CN", { hour12: false })}
                            </span>
                            <span className="review-badge bad">
                              {extractionFailed ? "事实抽取失败" : `${critical} 个严重问题`}
                            </span>
                            <button
                              className="btn btn-sm"
                              onClick={() => repairDraft(draft)}
                              disabled={disabled}
                            >
                              交给修复 Agent
                            </button>
                          </div>
                        </div>
                        <p className="muted small rejected-draft-path">草稿：{draft.path}</p>
                        <IssueList issues={draft.review.issues} />
                      </article>
                    );
                  })}
                </div>
                <p className="hint">
                  这些稿子没有覆盖正文。可以按问题修改后手动保存章节，或点「交给修复 Agent」自动修复并重新审校；通过后才会写入正文。
                </p>
              </div>
            ) : null}
            {!checked.length ? (
              rejectedDrafts.length ? null : (
                <p className="empty-inline">
                  还没有审校记录。自动写作或重写章节后，这里会显示连续性检查结果。
                </p>
              )
            ) : !reviewed.length ? (
              <p className="empty-inline">没有需要复查的章节。</p>
            ) : (
              <div className="review-scroll">
                <div className="continuity-list">
                  {reviewed.map((chapter) => {
                    const review = detail.state.reviews[String(chapter.index)];
                    return (
                      <article
                        key={chapter.index}
                        className={`continuity-chapter ${review.continuityOk ? "" : "bad"}`}
                      >
                        <div className="continuity-chapter-head">
                          <div>
                            <span className="plan-index">
                              {String(chapter.index).padStart(2, "0")}
                            </span>{" "}
                            <span className="canon-name">{chapter.title}</span>
                          </div>
                          <div className="panel-head-tools">
                            {review.repaired ? (
                              <span className="muted small">
                                自动修复 {review.repairAttempts ?? 0} 轮
                              </span>
                            ) : null}
                            <span
                              className={`review-badge ${review.continuityOk ? "ok" : "bad"}`}
                            >
                              {review.continuityOk ? "通过" : "需复查"}
                            </span>
                          </div>
                        </div>
                        <IssueList issues={review.issues} />
                      </article>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </section>
      ) : section === "leftovers" ? (
        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">遗留修复项</h2>
            <div className="panel-head-tools">
              <span className="muted small">
                {leftoverChapters.length
                  ? `${leftoverChapters.length} 章仍有严重问题`
                  : "无待处理项"}
              </span>
            </div>
          </div>
          <div className="panel-body">
            <p className="hint">
              这里按章节汇总定点修复后仍未解决的严重问题，并附带同章的建议和可忽略项。定点修复只处理严重和建议；修复会直接改写正文，原稿先备份到 drafts/，完成后重新检查并更新本章审校记录。
            </p>
            {!leftoverChapters.length ? (
              <p className="empty-inline">没有遗留修复项。</p>
            ) : (
              <div className="review-scroll">
                <div className="continuity-list">
                  {leftoverChapters.map((chapter) => {
                    const review = detail.state.reviews[String(chapter.index)];
                    if (!review) return null;
                    const critical = review.issues.filter(
                      (issue) => issue.severity === "critical",
                    ).length;
                    const warnings = review.issues.filter(
                      (issue) => issue.severity === "warning",
                    ).length;
                    const ignored = review.issues.filter(
                      (issue) => issue.severity === "ignore",
                    ).length;
                    const repairedAt = detail.state.repairs?.[String(chapter.index)];
                    return (
                      <article
                        key={chapter.index}
                        className={`continuity-chapter ${critical ? "bad" : ""}`}
                      >
                        <div className="continuity-chapter-head">
                          <div>
                            <span className="plan-index">
                              {String(chapter.index).padStart(2, "0")}
                            </span>{" "}
                            <span className="canon-name">{chapter.title}</span>
                          </div>
                          <div className="panel-head-tools">
                            {critical ? (
                              <span className="review-badge bad">{critical} 严重</span>
                            ) : null}
                            {warnings ? (
                              <span className="muted small">{warnings} 条建议</span>
                            ) : null}
                            {ignored ? (
                              <span className="muted small">{ignored} 条可忽略</span>
                            ) : null}
                            <button
                              className="btn btn-sm"
                              onClick={() => repairFromReview(chapter.index, review)}
                              disabled={disabled}
                            >
                              定点修复
                            </button>
                          </div>
                        </div>
                        {repairedAt ? (
                          <p className="muted small">
                            上次修复：
                            {new Date(repairedAt).toLocaleString("zh-CN", {
                              hour12: false,
                            })}
                          </p>
                        ) : null}
                        <IssueList issues={review.issues} />
                      </article>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </section>
      ) : (
        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">总体审校记录</h2>
            <div className="panel-head-tools">
              <button
                className="btn btn-sm"
                onClick={() => void loadAudit()}
                disabled={auditLoading}
              >
                {auditLoading ? <BusyLabel>读取中…</BusyLabel> : "刷新"}
              </button>
            </div>
          </div>
          <div className="panel-body">
            {auditResult?.chapters.length || auditUpdatedAt ? (
              <div className="continuity-toolbar">
                <span className="muted small">
                  {auditResult?.chapters.length
                    ? `${auditResult.chapters.length} 章 · ${auditCritical} 严重 · ${auditWarnings} 建议${
                        auditIgnored ? ` · ${auditIgnored} 可忽略` : ""
                      }`
                    : ""}
                  {auditResult?.chapters.length && auditUpdatedAt ? " · " : ""}
                  {auditUpdatedAt
                    ? `生成于 ${new Date(auditUpdatedAt).toLocaleString("zh-CN", {
                        hour12: false,
                      })}`
                    : ""}
                </span>
                {auditResult?.chapters.length ? (
                  <div className="segmented segmented-sm" role="tablist" aria-label="总体审校筛选">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={auditFilter === "all"}
                      className={`segmented-item ${auditFilter === "all" ? "active" : ""}`}
                      onClick={() => setAuditFilter("all")}
                    >
                      全部
                      <span className="segmented-count">{auditChapters.length}</span>
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={auditFilter === "critical"}
                      className={`segmented-item ${auditFilter === "critical" ? "active" : ""}`}
                      onClick={() => setAuditFilter("critical")}
                    >
                      严重
                      <span className="segmented-count">{auditFlagged.length}</span>
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={auditFilter === "ignore"}
                      className={`segmented-item ${auditFilter === "ignore" ? "active" : ""}`}
                      onClick={() => setAuditFilter("ignore")}
                    >
                      可忽略
                      <span className="segmented-count">{auditIgnorable.length}</span>
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
            {auditResult?.chapters.length ? (
              <>
                <p className="hint">
                  总体审校是生成时的快照；定点修复会直接改写该章正文，整份报告需重新运行总体审校才会更新。
                </p>
                <label className="checkbox-row audit-auto-continue">
                  <input
                    className="switch"
                    type="checkbox"
                    checked={autoContinueRepair}
                    onChange={(event) => setAutoContinueRepair(event.target.checked)}
                    disabled={disabled}
                  />
                  <span>修复后自动继续下一章（跳过无问题和已修复的章节）</span>
                </label>
              </>
            ) : null}
            {auditError ? <p className="form-error">{auditError}</p> : null}
            {auditLoading && !auditResult && !auditContent ? (
              <div className="skeleton-panel" aria-busy="true">
                <p className="skeleton-label">正在读取总体审校记录…</p>
                <SkeletonLines lines={5} />
              </div>
            ) : auditChapters.length ? (
              !shownAudit.length ? (
                <p className="empty-inline">
                  {auditFilter === "critical"
                    ? "没有严重问题。"
                    : auditFilter === "ignore"
                      ? "没有可忽略问题。"
                      : "没有审校记录。"}
                </p>
              ) : (
                <div className="review-scroll">
                  <div className="continuity-list">
                    {shownAudit.map((chapter) => {
                      const critical = chapter.issues.filter(
                        (issue) => issue.severity === "critical",
                      ).length;
                      const warnings = chapter.issues.filter(
                        (issue) => issue.severity === "warning",
                      ).length;
                      const ignored = chapter.issues.filter(
                        (issue) => issue.severity === "ignore",
                      ).length;
                      const repairedSinceAudit = wasRepairedSinceAudit(chapter.index);
                      return (
                        <article
                          key={chapter.index}
                          className={`continuity-chapter ${
                            critical && !repairedSinceAudit ? "bad" : ""
                          }`}
                        >
                          <div className="continuity-chapter-head">
                            <div>
                              <span className="plan-index">
                                {String(chapter.index).padStart(2, "0")}
                              </span>{" "}
                              <span className="canon-name">{chapter.title}</span>
                            </div>
                            <div className="panel-head-tools">
                              {critical ? (
                                <span className="review-badge bad">{critical} 严重</span>
                              ) : null}
                              {warnings ? (
                                <span className="muted small">{warnings} 条建议</span>
                              ) : null}
                              {ignored ? (
                                <span className="muted small">{ignored} 条可忽略</span>
                              ) : null}
                              {!chapter.issues.length ? (
                                <span className="review-badge ok">无问题</span>
                              ) : null}
                              {repairedSinceAudit ? (
                                <span className="review-badge ok">已修复，待重审</span>
                              ) : null}
                              {(critical || warnings) && !repairedSinceAudit ? (
                                <button
                                  className="btn btn-sm"
                                  onClick={() => repairFromAudit(chapter)}
                                  disabled={disabled}
                                >
                                  定点修复正文
                                </button>
                              ) : null}
                            </div>
                          </div>
                          {repairedSinceAudit ? (
                            <p className="hint">
                              该章已按总体审校记录定点修复并写回正文，以下为修复前的问题；重新运行总体审校可更新。
                            </p>
                          ) : null}
                          {chapter.issues.length ? (
                            <IssueList issues={chapter.issues} />
                          ) : null}
                        </article>
                      );
                    })}
                  </div>
                </div>
              )
            ) : auditContent ? (
              <div className="audit-scroll">
                <Markdown>{auditContent}</Markdown>
              </div>
            ) : (
              <p className="empty-inline">
                还没有总体审校记录。到「AI 任务台」点击「总体审校全书」，完成后会按章节显示在这里。
              </p>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
