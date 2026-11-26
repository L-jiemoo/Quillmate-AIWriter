"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { PlanLedger, ProjectDetail } from "@/lib/types";
import { errorMessage } from "@/lib/utils";

interface PlanChapter {
  index: number;
  title: string;
  written: boolean;
}

interface PlanData {
  planLedger: PlanLedger;
  chapters: PlanChapter[];
}

type EntryKind =
  | "event"
  | "character-change"
  | "foreshadow"
  | "timeline"
  | "item"
  | "relation"
  | "item-registry";

const STATUS_LABELS: Record<string, string> = {
  planned: "未执行",
  partially_realized: "部分实现",
  realized: "已确认实现",
  deviated: "已偏离",
  cancelled: "已取消",
};

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

function clip(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function PlanTab({
  detail,
  onRefresh,
  disabled,
}: {
  detail: ProjectDetail;
  onRefresh: () => Promise<void>;
  disabled?: boolean;
}) {
  const slug = detail.meta.slug;
  const [data, setData] = useState<PlanData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [fromChapter, setFromChapter] = useState(1);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/projects/${slug}/plan-ledger`, {
        cache: "no-store",
      });
      const body = (await response.json()) as PlanData & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "读取计划台账失败");
      setData({ planLedger: body.planLedger, chapters: body.chapters ?? [] });
      const last = body.chapters?.length ? body.chapters[body.chapters.length - 1].index : 1;
      setFromChapter((current) => (current > last ? last : current));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  const ledger = data?.planLedger;
  const chapters = useMemo(() => data?.chapters ?? [], [data]);
  const lastChapter = chapters.length ? chapters[chapters.length - 1].index : 0;
  const deleteTargets = useMemo(
    () => chapters.filter((chapter) => chapter.index >= fromChapter),
    [chapters, fromChapter],
  );
  const writtenTargets = deleteTargets.filter((chapter) => chapter.written);

  async function removeEntry(kind: EntryKind, id: string, label: string) {
    if (disabled) return;
    const confirmed = window.confirm(
      `确定删除这条计划吗？\n\n${label}\n\n只删除计划台账，不会改动正文和已确认的事实。`,
    );
    if (!confirmed) return;
    setBusyId(id);
    setError("");
    try {
      const response = await fetch(`/api/projects/${slug}/plan-ledger`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ remove: { kind, id } }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "删除计划失败");
      await load();
      await onRefresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyId("");
    }
  }

  async function deleteChapterRange() {
    if (disabled || !deleteTargets.length) return;
    if (writtenTargets.length) {
      setError(
        `第 ${writtenTargets
          .slice(0, 5)
          .map((chapter) => chapter.index)
          .join("、")} 章已有正文，请先在「章节」页删除对应正文。`,
      );
      return;
    }
    const confirmed = window.confirm(
      `确定删除第 ${fromChapter} 章到第 ${lastChapter} 章的 ${deleteTargets.length} 章大纲吗？\n\n` +
        "会同时清理这些章节的细纲、计划台账条目、正文和相关台账，不可撤销。",
    );
    if (!confirmed) return;
    setBusyId("chapters");
    setError("");
    try {
      const response = await fetch(`/api/projects/${slug}/plan-ledger`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromChapter, confirm: true }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "删除章节大纲失败");
      await load();
      await onRefresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyId("");
    }
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2 className="panel-title">计划台账</h2>
        <div className="panel-head-tools">
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => void load()}>
            刷新
          </button>
        </div>
      </div>
      <div className="panel-body">
        <p className="muted small">
          计划台账记录的是“将来要发生什么”，不代表已经发生。删除这里只会改计划，不会改正文和事实台账。
        </p>
        {error ? <div className="notice notice-error">{error}</div> : null}
        {loading && !data ? <p className="muted">正在读取计划台账…</p> : null}

        {data ? (
          <>
            <h3 className="field-label">章节大纲（后补的可以在这里删）</h3>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>章节</th>
                    <th>标题</th>
                    <th>正文</th>
                  </tr>
                </thead>
                <tbody>
                  {chapters.map((chapter) => (
                    <tr key={chapter.index}>
                      <td>第 {chapter.index} 章</td>
                      <td>{chapter.title}</td>
                      <td className="muted small">{chapter.written ? "已写" : "未写"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="memory-actions">
              <label className="field">
                <span className="field-label">从第几章开始删到末尾</span>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={lastChapter || undefined}
                  value={fromChapter}
                  disabled={disabled || !lastChapter}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    setFromChapter(Number.isFinite(next) ? Math.trunc(next) : 1);
                    setError("");
                  }}
                />
              </label>
              <button
                className="btn"
                type="button"
                disabled={disabled || !deleteTargets.length || busyId === "chapters"}
                onClick={() => void deleteChapterRange()}
              >
                {busyId === "chapters"
                  ? "删除中…"
                  : `删除第 ${fromChapter || "?"}–${lastChapter || "?"} 章大纲`}
              </button>
            </div>
            {writtenTargets.length ? (
              <p className="muted small">
                其中 {writtenTargets.length} 章已有正文，删除前需要先在「章节」页删掉正文。
              </p>
            ) : null}

            <h3 className="field-label">计划伏笔（{ledger?.foreshadows.length ?? 0}）</h3>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>伏笔</th>
                    <th>埋设</th>
                    <th>回收</th>
                    <th>状态</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {(ledger?.foreshadows ?? []).map((item) => (
                    <tr key={item.id}>
                      <td title={item.text}>{clip(item.text)}</td>
                      <td>{item.actualPlantChapter || item.plantChapter || "-"}</td>
                      <td>{item.actualResolveChapter || item.resolveChapter || "-"}</td>
                      <td className="muted small">{statusLabel(item.status)}</td>
                      <td>
                        <button
                          className="btn btn-ghost btn-sm"
                          type="button"
                          disabled={disabled || busyId === item.id}
                          onClick={() => void removeEntry("foreshadow", item.id, item.text)}
                        >
                          {busyId === item.id ? "删除中…" : "删除"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!ledger?.foreshadows.length ? (
              <p className="muted">计划台账里还没有伏笔。</p>
            ) : null}

            <h3 className="field-label">计划事件（{ledger?.events.length ?? 0}）</h3>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>事件</th>
                    <th>章节</th>
                    <th>状态</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {(ledger?.events ?? []).map((item) => (
                    <tr key={item.id}>
                      <td title={item.process || item.name}>{clip(item.name || item.process)}</td>
                      <td>{item.chapter}</td>
                      <td className="muted small">{statusLabel(item.status)}</td>
                      <td>
                        <button
                          className="btn btn-ghost btn-sm"
                          type="button"
                          disabled={disabled || busyId === item.id}
                          onClick={() => void removeEntry("event", item.id, item.name || item.process)}
                        >
                          {busyId === item.id ? "删除中…" : "删除"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h3 className="field-label">
              人物变化 / 时间线 / 物品（
              {(ledger?.characterChanges.length ?? 0) +
                (ledger?.timeline.length ?? 0) +
                (ledger?.items.length ?? 0)}
              ）
            </h3>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>类型</th>
                    <th>内容</th>
                    <th>章节</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {(ledger?.characterChanges ?? []).map((item) => (
                    <tr key={item.id}>
                      <td className="muted small">人物变化</td>
                      <td>{clip(`${item.character}：${item.before || "?"} → ${item.after || "?"}`)}</td>
                      <td>{item.chapter}</td>
                      <td>
                        <button
                          className="btn btn-ghost btn-sm"
                          type="button"
                          disabled={disabled || busyId === item.id}
                          onClick={() =>
                            void removeEntry(
                              "character-change",
                              item.id,
                              `${item.character}：${item.before} → ${item.after}`,
                            )
                          }
                        >
                          删除
                        </button>
                      </td>
                    </tr>
                  ))}
                  {(ledger?.timeline ?? []).map((item) => (
                    <tr key={item.id}>
                      <td className="muted small">时间线</td>
                      <td>{clip([item.time, item.sequence].filter(Boolean).join("；") || "-")}</td>
                      <td>{item.chapter}</td>
                      <td>
                        <button
                          className="btn btn-ghost btn-sm"
                          type="button"
                          disabled={disabled || busyId === item.id}
                          onClick={() => void removeEntry("timeline", item.id, item.time || item.sequence)}
                        >
                          删除
                        </button>
                      </td>
                    </tr>
                  ))}
                  {(ledger?.items ?? []).map((item) => (
                    <tr key={item.id}>
                      <td className="muted small">物品变化</td>
                      <td>{clip(`${item.item}：${item.stateChange || item.reason || item.changeType}`)}</td>
                      <td>{item.chapter}</td>
                      <td>
                        <button
                          className="btn btn-ghost btn-sm"
                          type="button"
                          disabled={disabled || busyId === item.id}
                          onClick={() => void removeEntry("item", item.id, item.item)}
                        >
                          删除
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h3 className="field-label">
              物品基线 / 关系（
              {(ledger?.itemRegistry.length ?? 0) + (ledger?.relations.length ?? 0)}
              ）
            </h3>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>类型</th>
                    <th>内容</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {(ledger?.itemRegistry ?? []).map((item) => (
                    <tr key={item.id}>
                      <td className="muted small">物品基线</td>
                      <td>{clip(`${item.name}${item.holder ? `（${item.holder}）` : ""}`)}</td>
                      <td>
                        <button
                          className="btn btn-ghost btn-sm"
                          type="button"
                          disabled={disabled || busyId === item.id}
                          onClick={() => void removeEntry("item-registry", item.id, item.name)}
                        >
                          删除
                        </button>
                      </td>
                    </tr>
                  ))}
                  {(ledger?.relations ?? []).map((item) => (
                    <tr key={item.id}>
                      <td className="muted small">关系</td>
                      <td>{clip(`${item.from} → ${item.to}（${item.type}）`)}</td>
                      <td>
                        <button
                          className="btn btn-ghost btn-sm"
                          type="button"
                          disabled={disabled || busyId === item.id}
                          onClick={() =>
                            void removeEntry("relation", item.id, `${item.from} → ${item.to}`)
                          }
                        >
                          删除
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}
