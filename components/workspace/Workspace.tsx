"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Job, ProjectDetail, StartJobFn } from "@/lib/types";
import { errorMessage } from "@/lib/utils";
import { ChaptersTab } from "./ChaptersTab";
import { CharactersTab } from "./CharactersTab";
import { ContinuityTab } from "./ContinuityTab";
import { JobPanel } from "./JobPanel";
import { OverviewTab } from "./OverviewTab";
import { PublishTab } from "./PublishTab";

type TabKey = "overview" | "characters" | "chapters" | "continuity" | "publish";

const TABS: { key: TabKey; label: string }[] = [
  { key: "overview", label: "总览" },
  { key: "characters", label: "角色设定" },
  { key: "chapters", label: "章节" },
  { key: "continuity", label: "连续性" },
  { key: "publish", label: "发布" },
];

export function Workspace({ initialDetail }: { initialDetail: ProjectDetail }) {
  const [detail, setDetail] = useState(initialDetail);
  const [tab, setTab] = useState<TabKey>("overview");
  const [job, setJob] = useState<Job | null>(null);
  const [jobError, setJobError] = useState("");
  const completedJobRef = useRef<string | null>(null);
  const slug = detail.meta.slug;

  const refresh = useCallback(async () => {
    const response = await fetch(`/api/projects/${slug}`, { cache: "no-store" });
    if (response.ok) setDetail((await response.json()) as ProjectDetail);
  }, [slug]);

  // 任务在服务端后台运行；从作品库重新进入时要接回来，否则看起来像中断了。
  useEffect(() => {
    let cancelled = false;
    completedJobRef.current = null;
    setJob(null);
    void (async () => {
      try {
        const response = await fetch(`/api/projects/${slug}/jobs`, {
          cache: "no-store",
        });
        if (!response.ok) return;
        const data = (await response.json()) as { job?: Job | null };
        if (cancelled || !data.job) return;
        if (data.job.status === "queued" || data.job.status === "running") {
          setJob(data.job);
        }
      } catch {
        // 接不回任务时按普通工作台状态处理。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  // 任务结束后重新拉取项目详情，章节、发布记录和统计会一起同步。
  useEffect(() => {
    if (
      !job ||
      job.status === "done" ||
      job.status === "error" ||
      job.status === "paused"
    ) {
      return;
    }
    const timer = setInterval(async () => {
      try {
        const response = await fetch(`/api/jobs/${job.id}`, { cache: "no-store" });
        if (!response.ok) return;
        const next = (await response.json()) as Job;
        setJob(next);
        if (
          (next.status === "done" ||
            next.status === "error" ||
            next.status === "paused") &&
          completedJobRef.current !== next.id
        ) {
          completedJobRef.current = next.id;
          await refresh();
        }
      } catch {
        return;
      }
    }, 1200);
    return () => clearInterval(timer);
  }, [job, refresh]);

  const startJob: StartJobFn = async (type, payload = {}) => {
    const running = Boolean(job && (job.status === "queued" || job.status === "running"));
    if (running) return;
    setJobError("");
    try {
      const response = await fetch(`/api/projects/${slug}/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, ...payload }),
      });
      const data = (await response.json()) as Job & { error?: string; job?: Job };
      if (!response.ok) {
        // 服务端发现已有任务时，直接把那个任务接回界面继续显示日志。
        if (data.job) {
          completedJobRef.current = null;
          setJob(data.job);
          return;
        }
        throw new Error(data.error ?? "启动任务失败");
      }
      completedJobRef.current = null;
      setJob(data);
    } catch (error) {
      setJobError(errorMessage(error));
    }
  };

  const running = Boolean(job && (job.status === "queued" || job.status === "running"));

  async function pauseJob() {
    if (!job) return;
    setJobError("");
    try {
      const response = await fetch(`/api/projects/${slug}/jobs/${job.id}/pause`, {
        method: "POST",
      });
      const data = (await response.json()) as Job & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "暂停任务失败");
      setJob(data);
    } catch (error) {
      setJobError(errorMessage(error));
    }
  }

  return (
    <main className="shell workspace">
      <section className="workspace-head">
        <div className="workspace-title-row">
          <div>
            <h1 className="workspace-title">{detail.meta.title}</h1>
            <div className="meta-chips">
              <span className="chip">{detail.meta.genre}</span>
              <span className="chip">{detail.meta.tone}</span>
              <span className="chip">{detail.meta.author || "未署名"}</span>
              <span className="chip">
                {detail.state.written.length}/{detail.chapters.length || "?"} 章
              </span>
            </div>
          </div>
          <div className="workspace-side-note">
            <span className="live-dot" />
            {detail.pendingChapters > 0
              ? `还有 ${detail.pendingChapters} 章待写`
              : detail.chapters.length
                ? "大纲章节已写完"
                : "等待生成架构"}
          </div>
        </div>
      </section>

      {jobError ? <div className="notice notice-error">{jobError}</div> : null}

      {/* 三栏布局：目录和任务台吸顶，中间正文独立滚动阅读。 */}
      <div className="workspace-layout">
        <nav className="workspace-nav" aria-label="稿房目录">
          <Link href="/" className="workspace-nav-back">
            <span aria-hidden="true">←</span>
            <span>返回作品库</span>
          </Link>
          <span className="workspace-nav-label">稿房目录</span>
          {TABS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`workspace-nav-item ${tab === item.key ? "active" : ""}`}
              aria-current={tab === item.key ? "page" : undefined}
              onClick={() => setTab(item.key)}
            >
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        <section className="main-column">
          {tab === "overview" ? <OverviewTab detail={detail} /> : null}
          {tab === "characters" ? <CharactersTab detail={detail} onRefresh={refresh} /> : null}
          {tab === "chapters" ? (
            <ChaptersTab
              detail={detail}
              onRefresh={refresh}
              onWrite={(count) => startJob("write", { count })}
              onRewrite={(indices, instruction) => {
                void startJob("rewrite", { indices, instruction });
              }}
              disabled={running}
            />
          ) : null}
          {tab === "continuity" ? (
            <ContinuityTab
              detail={detail}
              onStartJob={startJob}
              onRefresh={refresh}
              disabled={running}
            />
          ) : null}
          {tab === "publish" ? (
            <PublishTab
              detail={detail}
              onStartJob={startJob}
              onRefresh={refresh}
              disabled={running}
            />
          ) : null}
        </section>

        <aside className="side-column">
          <JobPanel
            detail={detail}
            job={job}
            onStartJob={startJob}
            onPauseJob={() => void pauseJob()}
          />
        </aside>
      </div>
    </main>
  );
}
