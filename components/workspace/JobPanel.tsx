"use client";

import { useEffect, useRef, useState } from "react";
import type { Job, ProjectDetail, StartJobFn } from "@/lib/types";

const STATUS_LABEL: Record<Job["status"], string> = {
  queued: "排队中",
  running: "执行中",
  done: "已完成",
  error: "失败",
};

const TYPE_LABEL: Record<Job["type"], string> = {
  plan: "生成架构",
  extend: "补充大纲",
  write: "自动写作",
  export: "导出全书",
  "fanqie-login": "登录番茄",
  "fanqie-publish": "发布番茄",
};

export function JobPanel({
  detail,
  job,
  onStartJob,
}: {
  detail: ProjectDetail;
  job: Job | null;
  onStartJob: StartJobFn;
}) {
  const [count, setCount] = useState("1");
  const [extendCount, setExtendCount] = useState("10");
  const consoleRef = useRef<HTMLDivElement>(null);
  const running = Boolean(job && (job.status === "queued" || job.status === "running"));
  const pending = detail.chapters.filter((chapter) => !chapter.written).length;
  const nextIndex = detail.plan.chapters.length
    ? Math.max(...detail.plan.chapters.map((chapter) => chapter.index)) + 1
    : 1;

  useEffect(() => {
    const node = consoleRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [job?.logs.length]);

  function startPlan() {
    if (
      detail.plan.chapters.length &&
      !window.confirm(
        "重新生成架构会覆盖现有大纲；已写章节文件仍会保留，但可能与新大纲不一致。继续？",
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

  const statusText = job
    ? running
      ? `${TYPE_LABEL[job.type]} · ${STATUS_LABEL[job.status]}`
      : STATUS_LABEL[job.status]
    : "待命";

  return (
    <div className="job-panel panel">
      <div className="panel-head">
        <h2 className="panel-title">AI 任务台</h2>
        <span
          className={`status-pill ${
            running ? "running" : job?.status === "error" ? "bad" : "ok"
          }`}
        >
          {statusText}
        </span>
      </div>
      <div className="panel-body">
        <div className="job-actions">
          <button className="btn btn-primary btn-block" onClick={startPlan} disabled={running}>
            生成架构与角色
          </button>
          <div className="job-input-row">
            <input
              className="input"
              type="number"
              min={1}
              max={50}
              value={count}
              onChange={(event) => setCount(event.target.value)}
            />
            <button
              className="btn btn-block"
              onClick={startWrite}
              disabled={running || pending === 0}
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

          <div className="job-divider" />

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
              disabled={running || !detail.plan.chapters.length}
            >
              补充 {extendCount} 章大纲
            </button>
          </div>
        </div>

        <div className="job-log" ref={consoleRef}>
          {job?.logs.length ? (
            job.logs.map((line, index) => (
              <div key={`${line.time}-${index}`} className="job-log-line">
                <span className="job-time">
                  {new Date(line.time).toLocaleTimeString("zh-CN", { hour12: false })}
                </span>
                <span>{line.message}</span>
              </div>
            ))
          ) : (
            <p className="job-log-empty">任务日志会显示在这里。</p>
          )}
        </div>
        {job?.error ? <p className="form-error">{job.error}</p> : null}
      </div>
    </div>
  );
}
