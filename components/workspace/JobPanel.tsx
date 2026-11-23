"use client";

import { useEffect, useRef, useState } from "react";
import { buddyFor, logFace } from "@/components/ui/ai-buddy";
import { AiProgress, SkeletonLines } from "@/components/ui/Loading";
import type { Job, ProjectDetail, StartJobFn } from "@/lib/types";

const STATUS_LABEL: Record<Job["status"], string> = {
  queued: "排队中",
  running: "执行中",
  paused: "已暂停",
  done: "已完成",
  error: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
};

const RETRYABLE: Job["status"][] = ["error", "cancelled", "interrupted", "paused"];

interface RepairDecisionView {
  id: string;
  chapterIndex: number;
  reason: string;
  params: { indices?: number[]; source?: string };
  options: {
    label: string;
    description: string;
    affectedChapters: number[];
    introducedFacts?: string[];
    recommended?: boolean;
  }[];
}

const DEFAULT_RECOMMENDED_KEY = "quillmate-default-recommended";

function preferredChoice(decision: RepairDecisionView, useRecommended: boolean): number {
  if (!useRecommended) return 0;
  const index = decision.options.findIndex((option) => option.recommended);
  return index >= 0 ? index : 0;
}

const TYPE_LABEL: Record<Job["type"], string> = {
  plan: "生成架构",
  extend: "补充大纲",
  write: "自动写作",
  finale: "生成完结章",
  rewrite: "重写章节",
  repair: "定点修复",
  recanon: "重建事实台账",
  memory: "重建长期记忆与剧情台账",
  audit: "总体审校",
  export: "导出全书",
  "fanqie-login": "登录番茄",
  "fanqie-publish": "发布番茄",
};

// 支持 "3"、"3,5"、"8-10" 以及中文逗号/顿号分隔的章节选择。
function parseChapterSelection(input: string): number[] {
  const indices = new Set<number>();
  for (const token of input.split(/[\s,，、]+/).filter(Boolean)) {
    const range = token.match(/^(\d+)\s*[-~—]\s*(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start < 1 || end < start || end - start > 200) continue;
      for (let index = start; index <= end; index += 1) indices.add(index);
      continue;
    }
    const index = Number(token);
    if (Number.isInteger(index) && index > 0) indices.add(index);
  }
  return [...indices].sort((a, b) => a - b);
}

export function JobPanel({
  detail,
  job,
  onStartJob,
  onPauseJob,
  onCancelJob,
  onRetryJob,
}: {
  detail: ProjectDetail;
  job: Job | null;
  onStartJob: StartJobFn;
  onPauseJob?: () => void;
  onCancelJob?: () => void;
  onRetryJob?: () => void;
}) {
  const [count, setCount] = useState("1");
  const [extendCount, setExtendCount] = useState("10");
  const [rewriteInput, setRewriteInput] = useState("");
  const [rewriteInstruction, setRewriteInstruction] = useState("");
  const [useReview, setUseReview] = useState(false);
  const [rewriteError, setRewriteError] = useState("");
  const [decision, setDecision] = useState<RepairDecisionView | null>(null);
  const [decisionChoice, setDecisionChoice] = useState(0);
  const [decisionError, setDecisionError] = useState("");
  const [decisionDismissed, setDecisionDismissed] = useState(false);
  const [defaultRecommended, setDefaultRecommended] = useState(true);
  const defaultRecommendedRef = useRef(true);
  const decisionIdRef = useRef<string | null>(null);
  const consoleRef = useRef<HTMLDivElement>(null);
  const slug = detail.meta.slug;

  useEffect(() => {
    try {
      const saved = localStorage.getItem(DEFAULT_RECOMMENDED_KEY);
      if (saved === "0" || saved === "1") {
        const enabled = saved === "1";
        defaultRecommendedRef.current = enabled;
        // 启动时同步一次本地偏好，之后由复选框控制。
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setDefaultRecommended(enabled);
      }
    } catch {
      // 本地偏好不可用时保持默认开启。
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/projects/${slug}/repair-decisions`);
        if (!response.ok) return;
        const data = (await response.json()) as {
          decision?: RepairDecisionView | null;
        };
        if (!cancelled) {
          const next = data.decision ?? null;
          if (next?.id !== decisionIdRef.current) {
            decisionIdRef.current = next?.id ?? null;
            setDecisionDismissed(false);
            setDecisionChoice(
              next ? preferredChoice(next, defaultRecommendedRef.current) : 0,
            );
          }
          setDecision(next);
        }
      } catch {
        // 决策接口失败不影响正常任务操作。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, job?.status]);

  function toggleDefaultRecommended(enabled: boolean) {
    setDefaultRecommended(enabled);
    defaultRecommendedRef.current = enabled;
    try {
      localStorage.setItem(DEFAULT_RECOMMENDED_KEY, enabled ? "1" : "0");
    } catch {
      // 本地存储不可用时只影响本次会话。
    }
    if (enabled && decision) {
      setDecisionChoice(preferredChoice(decision, true));
    }
  }

  async function confirmDecision() {
    if (!decision) return;
    setDecisionError("");
    try {
      const response = await fetch(`/api/projects/${slug}/repair-decisions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: decision.id, optionIndex: decisionChoice }),
      });
      const data = (await response.json()) as {
        decision?: RepairDecisionView;
        error?: string;
      };
      if (!response.ok || !data.decision) {
        throw new Error(data.error ?? "确认修复方向失败");
      }
      setDecision(null);
      await onStartJob("repair", {
        indices: data.decision.params.indices ?? [data.decision.chapterIndex],
        source: data.decision.params.source,
        decisionId: data.decision.id,
      });
    } catch (error) {
      setDecisionError(error instanceof Error ? error.message : "确认修复方向失败");
    }
  }

  const running = Boolean(job && (job.status === "queued" || job.status === "running"));
  const pending = detail.chapters.filter((chapter) => !chapter.written).length;
  const hasArchitecture = detail.plan.chapters.length > 0;
  const writtenIndexes = new Set(
    detail.chapters
      .filter((chapter) => chapter.written && chapter.content.trim())
      .map((chapter) => chapter.index),
  );
  const nextIndex = detail.plan.chapters.length
    ? Math.max(...detail.plan.chapters.map((chapter) => chapter.index)) + 1
    : 1;
  const completedChapter = detail.planLedger?.completedChapter ?? 0;

  useEffect(() => {
    const node = consoleRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [job?.logs.length]);

  function startPlan() {
    if (
      detail.plan.chapters.length &&
      !window.confirm(
        "重新生成架构会覆盖现有大纲、世界观和 AI 角色卡；已写章节文件仍会保留，但可能与新大纲不一致。全部生成成功并通过校验后才会写入；手动编辑或旧版人物卡会保留。继续？",
      )
    ) {
      return;
    }
    void onStartJob("plan");
  }

  function startWrite() {
    void onStartJob("write", { count: Math.max(1, Number(count) || 1) });
  }

  function startExtend() {
    void onStartJob("extend", { count: Math.max(1, Number(extendCount) || 10) });
  }

  function startFinale() {
    if (
      !window.confirm(
        "生成完结章会按现有计划收束全书，并标记项目“已完结”，之后不能再自动写作或补充大纲。继续？",
      )
    ) {
      return;
    }
    void onStartJob("finale");
  }

  function startRewrite() {
    const indices = parseChapterSelection(rewriteInput);
    if (!indices.length) {
      setRewriteError("请输入要重写的章节，如 3、5 或 8-10");
      return;
    }

    const missing = indices.filter((index) => !writtenIndexes.has(index));
    if (missing.length) {
      setRewriteError(`第 ${missing.join("、")} 章还没有正文，无法重写`);
      return;
    }

    const published = new Set(
      Object.values(detail.publishLedger.records)
        .filter((entry) => entry.status === "published")
        .map((entry) => entry.chapter),
    );
    const publishedTargets = indices.filter((index) => published.has(index));
    const warning = publishedTargets.length
      ? `\n\n第 ${publishedTargets.join("、")} 章已发布到番茄；重写只改本地稿，不会自动发布，之后请自行到番茄后台更新。`
      : "";
    const reviewTargets = indices.filter((index) =>
      (detail.state.reviews[String(index)]?.issues ?? []).some(
        (issue) => issue.severity === "critical",
      ),
    );
    const reviewNote = useReview
      ? reviewTargets.length
        ? `\n\n将参考第 ${reviewTargets.join("、")} 章的上一版严重审校问题。`
        : "\n\n所选章节没有严重审校记录，勾选项不会生效。"
      : "";

    if (
      !window.confirm(
        `将用 AI 重写第 ${indices.join("、")} 章；通过连续性检查后才会覆盖原稿，未通过则保留原稿，不会触发发布。${warning}${reviewNote}\n\n继续？`,
      )
    ) {
      return;
    }

    setRewriteError("");
    void onStartJob("rewrite", {
      indices,
      instruction: rewriteInstruction.trim(),
      useReview,
    });
  }

  function startAudit() {
    const total = writtenIndexes.size;
    if (!total) return;
    if (
      !window.confirm(
        `将逐章抽取事实并审校全书 ${total} 章，每章约 2 次模型调用，耗时和费用会随章节数增加。\n\n审校只读，不会修改正文、台账或审校记录。继续？`,
      )
    ) {
      return;
    }
    void onStartJob("audit");
  }

  const statusText = job
    ? running
      ? `${TYPE_LABEL[job.type]} · ${STATUS_LABEL[job.status]}`
      : STATUS_LABEL[job.status]
    : "待命";
  const buddy = buddyFor(job);
  const logs = job?.logs ?? [];

  return (
    <div className="job-panel panel" aria-busy={running}>
      <div className="panel-head">
        <h2 className="panel-title">AI 任务台</h2>
        <span
          className={`status-pill ${
            running
              ? "running"
              : job &&
                  (job.status === "error" ||
                    job.status === "cancelled" ||
                    job.status === "interrupted")
                ? "bad"
                : "ok"
          }`}
        >
          <span className={`status-dot ${running ? "running" : ""}`} aria-hidden="true" />
          {statusText}
        </span>
      </div>
      <div className="panel-body">
        {running && job ? (
          <AiProgress
            label={`${TYPE_LABEL[job.type]}进行中`}
            detail={job.status === "queued" ? "排队中" : "模型正在生成"}
          />
        ) : null}
        {decision && decisionDismissed ? (
          <button
            className="btn btn-block"
            onClick={() => setDecisionDismissed(false)}
          >
            有待确认的修复方向（第 {decision.chapterIndex} 章），点此查看
          </button>
        ) : null}
        <div className={`job-output ${running ? "running" : ""}`}>
          <div className="job-output-head">
            <span
              key={buddy.emoji}
              className="job-output-face"
              aria-hidden="true"
            >
              {buddy.emoji}
            </span>
            <span className="job-output-copy">
              <strong>AI 输出</strong>
              <span>
                {running
                  ? "正在一条条发送…"
                  : job
                    ? "最近一次任务记录"
                    : "待命中"}
              </span>
            </span>
          </div>
          <div
            className={`job-log ${running ? "running" : ""}`}
            ref={consoleRef}
            role="log"
            aria-live="polite"
            aria-relevant="additions"
          >
            {logs.length ? (
              logs.map((line, index) => {
                // 最近几条依次入场；更早的历史记录直接呈现，避免刷屏等待。
                const delay =
                  Math.min(Math.max(0, index - (logs.length - 6)), 5) * 55;
                return (
                  <div
                    className="job-log-line"
                    key={`${line.time}-${index}`}
                    style={{ animationDelay: `${delay}ms` }}
                  >
                    <span className="job-log-face" aria-hidden="true">
                      {logFace(line.message)}
                    </span>
                    <span className="job-bubble">
                      <span className="job-bubble-text">{line.message}</span>
                      <span className="job-time">
                        {new Date(line.time).toLocaleTimeString("zh-CN", {
                          hour12: false,
                        })}
                      </span>
                    </span>
                  </div>
                );
              })
            ) : running ? (
              <SkeletonLines lines={4} />
            ) : (
              <p className="job-log-empty">任务日志会在这里一条条出现。</p>
            )}
            {running && logs.length ? (
              <div className="job-log-line job-log-typing" aria-hidden="true">
                <span className="job-log-face">{buddy.emoji}</span>
                <span className="job-bubble job-bubble-typing">
                  <i />
                  <i />
                  <i />
                </span>
              </div>
            ) : null}
          </div>
          {job?.error ? <p className="form-error">{job.error}</p> : null}
        </div>

        <div className="job-actions">
          {running && job?.type === "repair" ? (
            <button
              className="btn btn-block"
              onClick={onPauseJob}
              disabled={job.pauseRequested}
            >
              {job.pauseRequested ? "正在暂停…（当前章节完成后停止）" : "暂停定点修复"}
            </button>
          ) : null}

          {running ? (
            <button
              className="btn btn-block"
              onClick={() => {
                if (
                  window.confirm(
                    "将取消当前任务；已完成的章节会保留，正在生成的内容可能被丢弃。继续？",
                  )
                ) {
                  onCancelJob?.();
                }
              }}
              disabled={job?.cancelRequested}
            >
              {job?.cancelRequested
                ? job.type === "fanqie-publish"
                  ? "正在取消…（当前浏览器步骤结束后停止）"
                  : "正在取消…（当前模型调用结束后停止）"
                : "取消任务"}
            </button>
          ) : job && RETRYABLE.includes(job.status) ? (
            <button className="btn btn-block" onClick={onRetryJob}>
              重试任务（{TYPE_LABEL[job.type]}）
            </button>
          ) : null}

          <p className="job-section-label">写作</p>
          {!hasArchitecture ? (
            <button
              className="btn btn-primary btn-block"
              onClick={startPlan}
              disabled={running}
            >
              生成架构与角色
            </button>
          ) : null}
          <div className="job-input-row">
            <input
              className="input"
              type="number"
              min={1}
              max={50}
              value={count}
              onChange={(event) => setCount(event.target.value)}
              aria-label="自动写作章节数"
            />
            <button
              className={`btn btn-block ${hasArchitecture && pending > 0 ? "btn-primary" : ""}`}
              onClick={startWrite}
              disabled={running || pending === 0 || Boolean(completedChapter)}
            >
              自动写 {count} 章
            </button>
          </div>
          <p className="hint">
            {pending > 0
              ? `还有 ${pending} 章待写。`
              : detail.chapters.length
                ? "大纲章节已全部写完。"
                : "先生成架构与角色。"}
          </p>
          {hasArchitecture ? (
            <button className="btn btn-block" onClick={startPlan} disabled={running}>
              重新生成架构与角色
            </button>
          ) : null}

          <div className="job-divider" />
          <p className="job-section-label">续排</p>

          <p className="hint">
            {detail.plan.chapters.length
              ? `章节不够？从第 ${nextIndex} 章起补充大纲，已写正文不受影响。`
              : "生成架构后，可以按需补充更多章节。"}
          </p>
          <div className="job-input-row">
            <input
              className="input"
              type="number"
              min={1}
              max={50}
              value={extendCount}
              onChange={(event) => setExtendCount(event.target.value)}
              aria-label="补充章节数"
            />
            <button
              className="btn btn-block"
              onClick={startExtend}
              disabled={running || !detail.plan.chapters.length || Boolean(completedChapter)}
            >
              补充 {extendCount} 章大纲
            </button>
          </div>

          <div className="job-divider" />
          <p className="job-section-label">完结</p>
          <p className="hint">
            {completedChapter
              ? `全书已完结：第 ${completedChapter} 章。不能再自动写作或补充大纲。`
              : "按现有计划收束全书，生成完结章后项目标记为已完结。"}
          </p>
          <button
            className="btn btn-block"
            onClick={startFinale}
            disabled={running || !detail.plan.chapters.length || Boolean(completedChapter)}
          >
            生成完结章
          </button>

          <div className="job-divider" />
          <p className="job-section-label">改稿</p>

          <p className="hint">
            重写只修改本地正文，不会自动发布；支持单个、多个或范围，如 3、5、8-10。
          </p>
          <div className="job-rewrite-row">
            <input
              className="input"
              value={rewriteInput}
              onChange={(event) => {
                setRewriteInput(event.target.value);
                setRewriteError("");
              }}
              placeholder="章节号：3,5,8-10"
              aria-label="要重写的章节号"
            />
            <button
              className="btn"
              onClick={startRewrite}
              disabled={running || !writtenIndexes.size}
            >
              重写
            </button>
          </div>
          <input
            className="input"
            value={rewriteInstruction}
            onChange={(event) => setRewriteInstruction(event.target.value)}
            placeholder="可选：重写要求，如加强打斗、删掉回忆"
            maxLength={300}
            aria-label="重写要求"
          />
          <label className="checkbox-row job-review-toggle">
            <input
              className="switch"
              type="checkbox"
              checked={useReview}
              onChange={(event) => setUseReview(event.target.checked)}
              disabled={running}
            />
            <span>按照章节审校重写（只带入该章上一版的严重问题）</span>
          </label>
          {rewriteError ? <p className="form-error">{rewriteError}</p> : null}

          <div className="job-divider" />
          <p className="job-section-label">审校</p>

          <p className="hint">
            总体审校会逐章抽取事实并以“截至上一章”的台账检查全书，只读不改稿；章节越多耗时越长。
          </p>
          <button
            className="btn btn-block"
            onClick={startAudit}
            disabled={running || !writtenIndexes.size}
          >
            总体审校全书（{writtenIndexes.size} 章）
          </button>
        </div>

      </div>

      {decision && !decisionDismissed ? (
        <div className="repair-decision-mask" role="presentation">
          <div
            className="repair-decision-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="repair-decision-title"
          >
            <h3 id="repair-decision-title">
              第 {decision.chapterIndex} 章需要你确认修复方向
            </h3>
            <p className="repair-decision-reason">{decision.reason}</p>
            <label className="repair-decision-default">
              <input
                type="checkbox"
                checked={defaultRecommended}
                onChange={(event) => toggleDefaultRecommended(event.target.checked)}
              />{" "}
              默认选择推荐项
            </label>
            {decision.options.map((option, index) => (
              <label
                key={`${decision.id}-${index}`}
                className={`repair-decision-option ${
                  decisionChoice === index ? "selected" : ""
                } ${option.recommended ? "recommended" : ""}`}
              >
                <input
                  type="radio"
                  name="repair-decision"
                  checked={decisionChoice === index}
                  onChange={() => setDecisionChoice(index)}
                  disabled={running}
                />{" "}
                <strong>{option.label}</strong>
                {option.recommended ? (
                  <span className="repair-decision-recommend">推荐</span>
                ) : null}
                <span>{option.description}</span>
                {option.affectedChapters.length ? (
                  <span className="repair-decision-chapters">
                    涉及修改：第 {option.affectedChapters.join("、")} 章
                  </span>
                ) : null}
                {option.introducedFacts?.length ? (
                  <span className="repair-decision-new">
                    新增设定：{option.introducedFacts.join("；")}
                  </span>
                ) : null}
              </label>
            ))}
            {decisionError ? (
              <p className="repair-decision-error">{decisionError}</p>
            ) : null}
            <div className="repair-decision-actions">
              <button
                className="btn"
                onClick={() => setDecisionDismissed(true)}
              >
                稍后处理
              </button>
              <button
                className="btn btn-primary"
                onClick={() => void confirmDecision()}
                disabled={running}
              >
                确认并继续修复
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
