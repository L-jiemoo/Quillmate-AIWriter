"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  CharacterRelation,
  CharacterState,
  ForeshadowRecord,
  ForeshadowStatus,
  PlotEvent,
  ProjectDetail,
  StartJobFn,
  StoryCheckIssue,
  StoryLedger,
  StoryStatsView,
} from "@/lib/types";
import { errorMessage } from "@/lib/utils";

type StoryView = "states" | "relations" | "events" | "foreshadows";

const VIEWS: { key: StoryView; label: string }[] = [
  { key: "states", label: "人物状态" },
  { key: "relations", label: "人物关系" },
  { key: "events", label: "剧情事件" },
  { key: "foreshadows", label: "伏笔" },
];

const FORESHADOW_LABEL: Record<ForeshadowStatus, string> = {
  planted: "已埋设",
  developing: "发展中",
  pending: "待回收",
  resolved: "已回收",
  abandoned: "已废弃",
};

interface StoryViewData {
  chapter: number;
  states: CharacterState[];
  relations: CharacterRelation[];
  events: PlotEvent[];
  foreshadows: ForeshadowRecord[];
  character?: string;
  characterHistory?: CharacterState[];
  characterEvents?: PlotEvent[];
}

interface StoryResponse {
  story?: StoryLedger;
  stats?: StoryStatsView;
  checks?: StoryCheckIssue[];
  view?: StoryViewData;
  error?: string;
}

function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function joinLines(values: string[]): string {
  return values.join("\n");
}

function newState(chapter: number): CharacterState {
  return {
    id: "",
    name: "",
    chapter,
    identity: "",
    age: "",
    location: "",
    bodyState: "",
    lifeStatus: "unknown",
    abilities: [],
    goals: [],
    knowledge: [],
    faction: "",
    experience: "",
    eventIds: [],
    source: "manual",
    updatedAt: "",
  };
}

function newRelation(chapter: number): CharacterRelation {
  return {
    id: "",
    from: "",
    to: "",
    type: "",
    status: "",
    chapter,
    eventIds: [],
    source: "manual",
    updatedAt: "",
  };
}

function newEvent(chapter: number): PlotEvent {
  return {
    id: "",
    name: "",
    chapter,
    time: "",
    location: "",
    participants: [],
    cause: "",
    process: "",
    result: "",
    impact: "",
    relatedEventIds: [],
    foreshadowIds: [],
    source: "manual",
    updatedAt: "",
  };
}

function newForeshadow(chapter: number): ForeshadowRecord {
  return {
    id: "",
    text: "",
    plantedChapter: chapter,
    relatedCharacters: [],
    expectedStartChapter: chapter,
    expectedEndChapter: 0,
    status: "planted",
    eventIds: [],
    resolution: "",
    resolvedChapter: 0,
    resolutionCandidate: "",
    source: "manual",
    updatedAt: "",
  };
}

function cloneState(state: CharacterState): CharacterState {
  return { ...state, abilities: [...state.abilities], goals: [...state.goals], knowledge: [...state.knowledge], eventIds: [...state.eventIds] };
}

function cloneRelation(relation: CharacterRelation): CharacterRelation {
  return { ...relation, eventIds: [...relation.eventIds] };
}

function cloneEvent(event: PlotEvent): PlotEvent {
  return {
    ...event,
    participants: [...event.participants],
    relatedEventIds: [...event.relatedEventIds],
    foreshadowIds: [...event.foreshadowIds],
  };
}

function cloneForeshadow(record: ForeshadowRecord): ForeshadowRecord {
  return { ...record, relatedCharacters: [...record.relatedCharacters], eventIds: [...record.eventIds] };
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

function TextField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        className="input"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

export function StoryTab({
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
  const maxChapter = detail.plan.chapters.reduce(
    (max, chapter) => Math.max(max, chapter.index),
    0,
  );
  const latestWritten = detail.state.written.length
    ? Math.max(...detail.state.written)
    : maxChapter || 1;
  const [view, setView] = useState<StoryView>("states");
  const [chapter, setChapter] = useState(latestWritten);
  const [character, setCharacter] = useState("");
  const [story, setStory] = useState<StoryLedger | null>(null);
  const [stats, setStats] = useState<StoryStatsView | null>(null);
  const [checks, setChecks] = useState<StoryCheckIssue[]>([]);
  const [data, setData] = useState<StoryViewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [stateDraft, setStateDraft] = useState<CharacterState | null>(null);
  const [relationDraft, setRelationDraft] = useState<CharacterRelation | null>(null);
  const [eventDraft, setEventDraft] = useState<PlotEvent | null>(null);
  const [foreshadowDraft, setForeshadowDraft] = useState<ForeshadowRecord | null>(null);

  const writtenChapters = useMemo(
    () => detail.chapters.filter((item) => item.written).map((item) => item.index),
    [detail.chapters],
  );

  const knownCharacters = useMemo(() => {
    const names = new Set<string>(detail.characters.map((item) => item.name));
    for (const state of story?.states ?? []) names.add(state.name);
    return [...names].filter(Boolean).sort((a, b) => a.localeCompare(b, "zh-CN"));
  }, [detail.characters, story]);

  const loadStory = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ chapter: String(chapter) });
      if (character) params.set("character", character);
      const response = await fetch(`/api/projects/${slug}/story?${params.toString()}`, {
        cache: "no-store",
      });
      const payload = (await response.json()) as StoryResponse;
      if (!response.ok || !payload.story) throw new Error(payload.error ?? "读取剧情台账失败");
      setStory(payload.story);
      setStats(payload.stats ?? null);
      setChecks(payload.checks ?? []);
      setData(payload.view ?? null);
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, [slug, chapter, character]);

  useEffect(() => {
    void loadStory();
  }, [loadStory, detail]);

  useEffect(() => {
    if (chapter > (maxChapter || 1)) setChapter(maxChapter || 1);
  }, [chapter, maxChapter]);

  useEffect(() => {
    if (!data) return;
    if (data.states.length) setStateDraft(cloneState(data.states[0]));
    else setStateDraft(null);
    if (data.relations.length) setRelationDraft(cloneRelation(data.relations[0]));
    else setRelationDraft(null);
    if (data.events.length) setEventDraft(cloneEvent(data.events[data.events.length - 1]));
    else setEventDraft(null);
    if (data.foreshadows.length) setForeshadowDraft(cloneForeshadow(data.foreshadows[0]));
    else setForeshadowDraft(null);
  }, [data]);

  async function savePatch(body: unknown) {
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/projects/${slug}/story`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as StoryResponse;
      if (!response.ok || !payload.story) throw new Error(payload.error ?? "保存剧情台账失败");
      setStory(payload.story);
      setStats(payload.stats ?? null);
      setChecks(payload.checks ?? []);
      await loadStory();
      await onRefresh();
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setSaving(false);
    }
  }

  async function seed() {
    if (
      !window.confirm(
        "将用现有章节记忆、事实台账和大纲离线生成剧情台账，不调用模型。已有手工记录不会被覆盖。继续？",
      )
    ) {
      return;
    }
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/projects/${slug}/story/seed`, { method: "POST" });
      const payload = (await response.json()) as StoryResponse;
      if (!response.ok || !payload.story) throw new Error(payload.error ?? "生成基础剧情台账失败");
      setStory(payload.story);
      setStats(payload.stats ?? null);
      setChecks(payload.checks ?? []);
      await loadStory();
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
        `将通过「重建长期记忆与剧情台账」逐章调用模型，共 ${writtenChapters.length} 章；全部成功后才提交，失败时已有记忆和台账不变。继续？`,
      )
    ) {
      return;
    }
    void onStartJob("memory");
  }

  async function remove(kind: "state" | "relation" | "event" | "foreshadow", id: string) {
    if (!id) return;
    if (!window.confirm("删除后不可自动恢复，确定删除这条手工维护的剧情台账记录？")) return;
    await savePatch({ delete: { kind, id }, confirm: true });
  }

  if (loading && !story) {
    return <div className="panel"><div className="panel-body muted">正在读取剧情台账…</div></div>;
  }

  return (
    <div className="overview">
      <div className="segmented overview-tabs" role="tablist" aria-label="剧情台账视图">
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
            {item.key === "states" && stats ? (
              <span className="segmented-count">{stats.states}</span>
            ) : null}
            {item.key === "relations" && stats ? (
              <span className="segmented-count">{stats.relations}</span>
            ) : null}
            {item.key === "events" && stats ? (
              <span className="segmented-count">{stats.events}</span>
            ) : null}
            {item.key === "foreshadows" && stats ? (
              <span className="segmented-count">{stats.openForeshadows}</span>
            ) : null}
          </button>
        ))}
      </div>

      {error ? <div className="notice notice-error">{error}</div> : null}

      <div className="memory-toolbar panel">
        <div className="panel-body">
          <p className="muted small">
            {stats
              ? `人物状态 ${stats.states} · 关系 ${stats.relations} · 事件 ${stats.events} · 伏笔 ${stats.foreshadows}（未回收 ${stats.openForeshadows} / 超期 ${stats.overdueForeshadows}）`
              : "尚未读取到剧情台账统计"}
          </p>
          <div className="memory-actions">
            <label className="field story-inline-field">
              <span className="field-label">时间点</span>
              <select
                className="input"
                value={chapter}
                onChange={(event) => setChapter(Number(event.target.value))}
              >
                {detail.plan.chapters.map((item) => (
                  <option key={item.index} value={item.index}>
                    第 {item.index} 章 {item.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="field story-inline-field">
              <span className="field-label">人物</span>
              <select
                className="input"
                value={character}
                onChange={(event) => setCharacter(event.target.value)}
              >
                <option value="">全部人物</option>
                {knownCharacters.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            </label>
            <button className="btn" type="button" onClick={() => void loadStory()} disabled={saving}>
              刷新
            </button>
            <button className="btn" type="button" onClick={() => void seed()} disabled={saving || disabled}>
              生成基础台账
            </button>
            <button
              className="btn btn-primary"
              type="button"
              onClick={rebuild}
              disabled={disabled || saving || !writtenChapters.length}
            >
              重建记忆与台账（AI）
            </button>
          </div>
          {checks.length ? (
            <div className="story-checks">
              <span className="muted small">待核对 {checks.length} 条</span>
              {checks.slice(0, 5).map((issue, index) => (
                <div key={`${issue.code}-${issue.chapter}-${index}`} className="story-check">
                  <span className={`story-severity ${issue.severity}`}>
                    {issue.severity === "critical" ? "严重" : "提示"}
                  </span>
                  <span>第 {issue.chapter} 章：{issue.message}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {view === "states" ? (
        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">人物动态状态</h2>
            <div className="memory-actions">
              <span className="muted small">截至第 {chapter} 章</span>
              <button
                className="btn"
                type="button"
                onClick={() => setStateDraft(newState(chapter))}
              >
                新增状态
              </button>
            </div>
          </div>
          <div className="panel-body story-split">
            <div className="story-list">
              {data?.states.length ? (
                data.states.map((state) => (
                  <button
                    key={state.id}
                    type="button"
                    className={`story-card ${stateDraft?.id === state.id ? "active" : ""}`}
                    onClick={() => setStateDraft(cloneState(state))}
                  >
                    <strong>{state.name}</strong>
                    <span className="muted small">
                      第 {state.chapter} 章 · {state.lifeStatus === "dead" ? "死亡" : state.lifeStatus === "alive" ? "存活" : "状态未知"}
                    </span>
                    <span className="muted small">
                      {[state.location, state.identity, state.faction].filter(Boolean).join(" · ") || "暂无位置/身份"}
                    </span>
                  </button>
                ))
              ) : (
                <p className="muted">还没有人物状态。生成基础台账，或运行 AI 重建。</p>
              )}
              {data?.characterHistory?.length ? (
                <div className="story-history">
                  <span className="field-label">人物历史</span>
                  {data.characterHistory.map((state) => (
                    <div key={state.id} className="muted small">
                      第 {state.chapter} 章：{[state.location, state.bodyState, state.lifeStatus]
                        .filter(Boolean)
                        .join(" / ") || "无变化记录"}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
            {stateDraft ? (
              <div className="memory-form">
                <TextField
                  label="人物名"
                  value={stateDraft.name}
                  onChange={(value) => setStateDraft({ ...stateDraft, name: value })}
                />
                <label className="field">
                  <span className="field-label">章节</span>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={maxChapter || undefined}
                    value={stateDraft.chapter}
                    onChange={(event) =>
                      setStateDraft({ ...stateDraft, chapter: Number(event.target.value) })
                    }
                  />
                </label>
                <label className="field">
                  <span className="field-label">生死状态</span>
                  <select
                    className="input"
                    value={stateDraft.lifeStatus}
                    onChange={(event) =>
                      setStateDraft({
                        ...stateDraft,
                        lifeStatus: event.target.value as CharacterState["lifeStatus"],
                      })
                    }
                  >
                    <option value="alive">存活</option>
                    <option value="dead">死亡</option>
                    <option value="unknown">未知</option>
                  </select>
                </label>
                <TextField
                  label="当前身份"
                  value={stateDraft.identity}
                  onChange={(value) => setStateDraft({ ...stateDraft, identity: value })}
                />
                <TextField
                  label="年龄"
                  value={stateDraft.age}
                  onChange={(value) => setStateDraft({ ...stateDraft, age: value })}
                />
                <TextField
                  label="当前所在位置"
                  value={stateDraft.location}
                  onChange={(value) => setStateDraft({ ...stateDraft, location: value })}
                />
                <TextField
                  label="身体状态"
                  value={stateDraft.bodyState}
                  onChange={(value) => setStateDraft({ ...stateDraft, bodyState: value })}
                />
                <TextField
                  label="所属阵营"
                  value={stateDraft.faction}
                  onChange={(value) => setStateDraft({ ...stateDraft, faction: value })}
                />
                <LinesField
                  label="能力变化（每行一条）"
                  value={joinLines(stateDraft.abilities)}
                  onChange={(value) => setStateDraft({ ...stateDraft, abilities: splitLines(value) })}
                  rows={3}
                />
                <LinesField
                  label="当前目标（每行一条）"
                  value={joinLines(stateDraft.goals)}
                  onChange={(value) => setStateDraft({ ...stateDraft, goals: splitLines(value) })}
                  rows={3}
                />
                <LinesField
                  label="当前掌握的信息（每行一条）"
                  value={joinLines(stateDraft.knowledge)}
                  onChange={(value) => setStateDraft({ ...stateDraft, knowledge: splitLines(value) })}
                  rows={3}
                />
                <LinesField
                  label="重要经历"
                  value={stateDraft.experience}
                  onChange={(value) => setStateDraft({ ...stateDraft, experience: value })}
                  rows={3}
                />
                <div className="memory-actions">
                  <button
                    className="btn btn-primary"
                    type="button"
                    disabled={saving || disabled}
                    onClick={() => void savePatch({ state: stateDraft })}
                  >
                    保存人物状态
                  </button>
                  {stateDraft.id ? (
                    <button
                      className="btn"
                      type="button"
                      disabled={saving || disabled}
                      onClick={() => void remove("state", stateDraft.id)}
                    >
                      删除
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {view === "relations" ? (
        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">人物关系</h2>
            <div className="memory-actions">
              <span className="muted small">截至第 {chapter} 章</span>
              <button
                className="btn"
                type="button"
                onClick={() => setRelationDraft(newRelation(chapter))}
              >
                新增关系
              </button>
            </div>
          </div>
          <div className="panel-body story-split">
            <div className="story-list">
              {data?.relations.length ? (
                data.relations.map((relation) => (
                  <button
                    key={relation.id}
                    type="button"
                    className={`story-card ${relationDraft?.id === relation.id ? "active" : ""}`}
                    onClick={() => setRelationDraft(cloneRelation(relation))}
                  >
                    <strong>{relation.from} ↔ {relation.to}</strong>
                    <span className="muted small">第 {relation.chapter} 章 · {relation.type || "未分类"}</span>
                    <span className="muted small">{relation.status || "暂无关系状态"}</span>
                  </button>
                ))
              ) : (
                <p className="muted">还没有人物关系。可手工新增，或在 AI 重建后由正文抽取。</p>
              )}
            </div>
            {relationDraft ? (
              <div className="memory-form">
                <TextField
                  label="人物 A"
                  value={relationDraft.from}
                  onChange={(value) => setRelationDraft({ ...relationDraft, from: value })}
                />
                <TextField
                  label="人物 B"
                  value={relationDraft.to}
                  onChange={(value) => setRelationDraft({ ...relationDraft, to: value })}
                />
                <label className="field">
                  <span className="field-label">章节</span>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={maxChapter || undefined}
                    value={relationDraft.chapter}
                    onChange={(event) =>
                      setRelationDraft({ ...relationDraft, chapter: Number(event.target.value) })
                    }
                  />
                </label>
                <TextField
                  label="关系类型"
                  value={relationDraft.type}
                  onChange={(value) => setRelationDraft({ ...relationDraft, type: value })}
                  placeholder="师徒 / 父子 / 敌对 / 盟友"
                />
                <LinesField
                  label="当前状态 / 本章变化"
                  value={relationDraft.status}
                  onChange={(value) => setRelationDraft({ ...relationDraft, status: value })}
                  rows={3}
                />
                <div className="memory-actions">
                  <button
                    className="btn btn-primary"
                    type="button"
                    disabled={saving || disabled}
                    onClick={() => void savePatch({ relation: relationDraft })}
                  >
                    保存关系
                  </button>
                  {relationDraft.id ? (
                    <button
                      className="btn"
                      type="button"
                      disabled={saving || disabled}
                      onClick={() => void remove("relation", relationDraft.id)}
                    >
                      删除
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {view === "events" ? (
        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">剧情事件时间线</h2>
            <div className="memory-actions">
              <span className="muted small">截至第 {chapter} 章</span>
              <button className="btn" type="button" onClick={() => setEventDraft(newEvent(chapter))}>
                新增事件
              </button>
            </div>
          </div>
          <div className="panel-body story-split">
            <div className="story-list">
              {data?.events.length ? (
                data.events.map((event) => (
                  <button
                    key={event.id}
                    type="button"
                    className={`story-card ${eventDraft?.id === event.id ? "active" : ""}`}
                    onClick={() => setEventDraft(cloneEvent(event))}
                  >
                    <strong>第 {event.chapter} 章 · {event.name}</strong>
                    <span className="muted small">
                      {[event.time, event.location, event.participants.join("、")]
                        .filter(Boolean)
                        .join(" · ") || "暂无时间地点"}
                    </span>
                    <span className="muted small">
                      {[event.result, event.impact].filter(Boolean).join(" / ") || "暂无结果/影响"}
                    </span>
                  </button>
                ))
              ) : (
                <p className="muted">还没有剧情事件。生成基础台账，或运行 AI 重建。</p>
              )}
              {data?.characterEvents?.length ? (
                <div className="story-history">
                  <span className="field-label">{data.character} 的事件历史</span>
                  {data.characterEvents.map((event) => (
                    <div key={event.id} className="muted small">
                      第 {event.chapter} 章：{event.name}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
            {eventDraft ? (
              <div className="memory-form">
                <TextField
                  label="事件名称"
                  value={eventDraft.name}
                  onChange={(value) => setEventDraft({ ...eventDraft, name: value })}
                />
                <label className="field">
                  <span className="field-label">章节</span>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={maxChapter || undefined}
                    value={eventDraft.chapter}
                    onChange={(event) =>
                      setEventDraft({ ...eventDraft, chapter: Number(event.target.value) })
                    }
                  />
                </label>
                <TextField
                  label="发生时间"
                  value={eventDraft.time}
                  onChange={(value) => setEventDraft({ ...eventDraft, time: value })}
                />
                <TextField
                  label="发生地点"
                  value={eventDraft.location}
                  onChange={(value) => setEventDraft({ ...eventDraft, location: value })}
                />
                <LinesField
                  label="参与人物（每行一条）"
                  value={joinLines(eventDraft.participants)}
                  onChange={(value) => setEventDraft({ ...eventDraft, participants: splitLines(value) })}
                  rows={3}
                />
                <LinesField
                  label="事件起因"
                  value={eventDraft.cause}
                  onChange={(value) => setEventDraft({ ...eventDraft, cause: value })}
                  rows={3}
                />
                <LinesField
                  label="事件过程"
                  value={eventDraft.process}
                  onChange={(value) => setEventDraft({ ...eventDraft, process: value })}
                  rows={4}
                />
                <LinesField
                  label="事件结果"
                  value={eventDraft.result}
                  onChange={(value) => setEventDraft({ ...eventDraft, result: value })}
                  rows={3}
                />
                <LinesField
                  label="对后续剧情的影响"
                  value={eventDraft.impact}
                  onChange={(value) => setEventDraft({ ...eventDraft, impact: value })}
                  rows={3}
                />
                <LinesField
                  label="关联事件 ID（每行一条）"
                  value={joinLines(eventDraft.relatedEventIds)}
                  onChange={(value) => setEventDraft({ ...eventDraft, relatedEventIds: splitLines(value) })}
                  rows={2}
                />
                <LinesField
                  label="关联伏笔 ID（每行一条）"
                  value={joinLines(eventDraft.foreshadowIds)}
                  onChange={(value) => setEventDraft({ ...eventDraft, foreshadowIds: splitLines(value) })}
                  rows={2}
                />
                <div className="memory-actions">
                  <button
                    className="btn btn-primary"
                    type="button"
                    disabled={saving || disabled}
                    onClick={() => void savePatch({ event: eventDraft })}
                  >
                    保存事件
                  </button>
                  {eventDraft.id ? (
                    <button
                      className="btn"
                      type="button"
                      disabled={saving || disabled}
                      onClick={() => void remove("event", eventDraft.id)}
                    >
                      删除
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {view === "foreshadows" ? (
        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">伏笔生命周期</h2>
            <div className="memory-actions">
              <span className="muted small">AI 只能给出回收候选，确认回收由作者操作</span>
              <button
                className="btn"
                type="button"
                onClick={() => setForeshadowDraft(newForeshadow(chapter))}
              >
                新增伏笔
              </button>
            </div>
          </div>
          <div className="panel-body story-split">
            <div className="story-list">
              {data?.foreshadows.length ? (
                data.foreshadows.map((record) => (
                  <button
                    key={record.id}
                    type="button"
                    className={`story-card ${foreshadowDraft?.id === record.id ? "active" : ""}`}
                    onClick={() => setForeshadowDraft(cloneForeshadow(record))}
                  >
                    <strong>{record.text}</strong>
                    <span className="muted small">
                      第 {record.plantedChapter} 章埋 · {FORESHADOW_LABEL[record.status]}
                      {record.expectedEndChapter ? ` · 预计第 ${record.expectedEndChapter} 章前回收` : ""}
                    </span>
                    {record.resolutionCandidate ? (
                      <span className="story-candidate">{record.resolutionCandidate}</span>
                    ) : null}
                  </button>
                ))
              ) : (
                <p className="muted">还没有伏笔记录。生成基础台账，或在 AI 重建后从正文抽取。</p>
              )}
            </div>
            {foreshadowDraft ? (
              <div className="memory-form">
                <LinesField
                  label="伏笔内容"
                  value={foreshadowDraft.text}
                  onChange={(value) => setForeshadowDraft({ ...foreshadowDraft, text: value })}
                  rows={4}
                />
                <label className="field">
                  <span className="field-label">埋设章节</span>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={maxChapter || undefined}
                    value={foreshadowDraft.plantedChapter}
                    onChange={(event) =>
                      setForeshadowDraft({
                        ...foreshadowDraft,
                        plantedChapter: Number(event.target.value),
                      })
                    }
                  />
                </label>
                <TextField
                  label="相关人物（用顿号分隔）"
                  value={foreshadowDraft.relatedCharacters.join("、")}
                  onChange={(value) =>
                    setForeshadowDraft({
                      ...foreshadowDraft,
                      relatedCharacters: value
                        .split(/[、,，]/u)
                        .map((item) => item.trim())
                        .filter(Boolean),
                    })
                  }
                />
                <label className="field">
                  <span className="field-label">预计回收起始章</span>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    value={foreshadowDraft.expectedStartChapter}
                    onChange={(event) =>
                      setForeshadowDraft({
                        ...foreshadowDraft,
                        expectedStartChapter: Number(event.target.value),
                      })
                    }
                  />
                </label>
                <label className="field">
                  <span className="field-label">预计回收结束章</span>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    value={foreshadowDraft.expectedEndChapter}
                    onChange={(event) =>
                      setForeshadowDraft({
                        ...foreshadowDraft,
                        expectedEndChapter: Number(event.target.value),
                      })
                    }
                  />
                </label>
                <label className="field">
                  <span className="field-label">状态</span>
                  <select
                    className="input"
                    value={foreshadowDraft.status}
                    onChange={(event) =>
                      setForeshadowDraft({
                        ...foreshadowDraft,
                        status: event.target.value as ForeshadowStatus,
                      })
                    }
                  >
                    {Object.entries(FORESHADOW_LABEL).map(([key, label]) => (
                      <option key={key} value={key}>{label}</option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span className="field-label">回收章节</span>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    value={foreshadowDraft.resolvedChapter}
                    onChange={(event) =>
                      setForeshadowDraft({
                        ...foreshadowDraft,
                        resolvedChapter: Number(event.target.value),
                      })
                    }
                  />
                </label>
                <LinesField
                  label="回收说明"
                  value={foreshadowDraft.resolution}
                  onChange={(value) => setForeshadowDraft({ ...foreshadowDraft, resolution: value })}
                  rows={3}
                />
                {foreshadowDraft.resolutionCandidate ? (
                  <p className="muted small">AI 回收候选：{foreshadowDraft.resolutionCandidate}</p>
                ) : null}
                <div className="memory-actions">
                  <button
                    className="btn btn-primary"
                    type="button"
                    disabled={saving || disabled}
                    onClick={() => void savePatch({ foreshadow: foreshadowDraft })}
                  >
                    保存伏笔
                  </button>
                  {foreshadowDraft.status !== "resolved" ? (
                    <button
                      className="btn"
                      type="button"
                      disabled={saving || disabled}
                      onClick={() =>
                        void savePatch({
                          foreshadow: {
                            ...foreshadowDraft,
                            status: "resolved",
                            resolvedChapter: foreshadowDraft.resolvedChapter || chapter,
                            resolution:
                              foreshadowDraft.resolution || "作者在剧情台账中确认回收",
                          },
                        })
                      }
                    >
                      确认回收
                    </button>
                  ) : null}
                  {foreshadowDraft.id ? (
                    <button
                      className="btn"
                      type="button"
                      disabled={saving || disabled}
                      onClick={() => void remove("foreshadow", foreshadowDraft.id)}
                    >
                      删除
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}
