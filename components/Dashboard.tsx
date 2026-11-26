"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { FormEvent } from "react";
import type { ProjectSummary } from "@/lib/types";
import { errorMessage } from "@/lib/utils";
import { ProjectFolder } from "./ProjectFolder";

const INITIAL_FORM = {
  title: "",
  slug: "",
  genre: "玄幻",
  tone: "热血",
  idea: "",
  author: "",
  targetChapters: "12",
  wordsPerChapter: "3000",
};

export function Dashboard({ initialProjects }: { initialProjects: ProjectSummary[] }) {
  const router = useRouter();
  const [projects, setProjects] = useState(initialProjects);
  const [form, setForm] = useState(INITIAL_FORM);
  const [error, setError] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState("");
  const [submitting, setSubmitting] = useState(false);

  function update(key: keyof typeof form, value: string) {
    setForm((previous) => ({ ...previous, [key]: value }));
  }

  async function handleDelete(project: ProjectSummary) {
    const confirmed = window.confirm(
      `确定删除《${project.title}》吗？\n\n设定、章节和导出文件都会从本地磁盘永久删除，无法恢复。`,
    );
    if (!confirmed) return;

    setDeleting(project.slug);
    setDeleteError("");
    try {
      const response = await fetch(`/api/projects/${project.slug}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmSlug: project.slug }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "删除失败");
      setProjects((previous) => previous.filter((item) => item.slug !== project.slug));
    } catch (err) {
      setDeleteError(errorMessage(err));
    } finally {
      setDeleting("");
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          targetChapters: Number(form.targetChapters),
          wordsPerChapter: Number(form.wordsPerChapter),
        }),
      });
      const data = (await response.json()) as { slug?: string; error?: string };
      if (!response.ok || !data.slug) throw new Error(data.error ?? "创建失败");
      router.push(`/projects/${data.slug}`);
    } catch (err) {
      setError(errorMessage(err));
      setSubmitting(false);
    }
  }

  return (
    <main className="shell">
      <section className="hero">
        <div className="hero-copy">
          <div className="hero-eyebrow">本地稿房，长篇连载</div>
          <h1 className="hero-title">
            把一句创意，
            <br />
            写成一部连载。
          </h1>
          <p className="hero-sub">
            架构、人物、章节、审校、发布——一条本地流水线完成。所有文稿以 Markdown 保存在你的磁盘上。
          </p>
        </div>
        {/* 工序笺：编号表示真实写作顺序，桌面端作为首屏的视觉落点。 */}
        <aside className="hero-aside" aria-label="写作流程">
          <span className="hero-seal" aria-hidden="true">
            稿
          </span>
          <div>
            <p className="hero-aside-title">一张桌面，四道工序</p>
            <ol className="hero-flow">
              <li>
                <span>01</span>架构与人物
              </li>
              <li>
                <span>02</span>章节与审校
              </li>
              <li>
                <span>03</span>导出与备份
              </li>
              <li>
                <span>04</span>发布到平台
              </li>
            </ol>
          </div>
        </aside>
      </section>

      <div className="dashboard-grid">
        <section>
          <div className="section-head">
            <h2 className="section-title">我的作品</h2>
            <span className="muted small">{projects.length} 部作品</span>
          </div>

          {deleteError ? <p className="form-error">{deleteError}</p> : null}

          {projects.length ? (
            <div className="project-grid">
              {projects.map((project) => {
                const progress = project.planned
                  ? Math.round((project.written / project.planned) * 100)
                  : 0;
                return (
                  <article key={project.slug} className="project-card">
                    <div className="project-row">
                      <ProjectFolder
                        uid={project.slug}
                        label={`打开作品《${project.title}》工作台`}
                        href={`/projects/${project.slug}`}
                      />
                      <Link href={`/projects/${project.slug}`} className="project-card-link">
                        <div className="project-top">
                          <h3 className="project-title">{project.title}</h3>
                          <span className="chip">{project.genre}</span>
                        </div>
                        <p className="project-meta muted small">
                          {project.tone} · {project.written}/{project.planned || "?"} 章 ·{" "}
                          {project.words.toLocaleString("zh-CN")} 字
                        </p>
                        <div className="progress">
                          <span style={{ width: `${progress}%` }} />
                        </div>
                        <div className="project-foot">
                          <span className="muted small">
                            更新于{" "}
                            {new Date(project.updatedAt).toLocaleString("zh-CN", { hour12: false })}
                          </span>
                          <span className="project-open">打开工作台</span>
                        </div>
                      </Link>
                    </div>
                    <div className="project-tools">
                      <button
                        type="button"
                        className="project-delete"
                        onClick={() => handleDelete(project)}
                        disabled={deleting === project.slug}
                        aria-label={`删除作品《${project.title}》`}
                      >
                        {deleting === project.slug ? "删除中…" : "删除作品"}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="panel empty-state">
              <p className="empty-mark">稿</p>
              <h3>还没有作品</h3>
              <p className="muted">
                在新建作品表单里填一句创意，创建第一部小说。未配置模型时会用 mock 示例数据跑通全流程。
              </p>
            </div>
          )}
        </section>

        <section className="panel create-panel">
          <div className="panel-head">
            <h2 className="panel-title">新建作品</h2>
            <span className="muted small">本地项目</span>
          </div>
          <form className="panel-body form" onSubmit={handleSubmit}>
            <label className="field">
              <span>书名 *</span>
              <input
                className="input"
                value={form.title}
                onChange={(event) => update("title", event.target.value)}
                placeholder="例如：长夜灯行"
                required
              />
            </label>
            <div className="field-row-2">
              <label className="field">
                <span>类型</span>
                <input
                  className="input"
                  value={form.genre}
                  onChange={(event) => update("genre", event.target.value)}
                />
              </label>
              <label className="field">
                <span>基调</span>
                <input
                  className="input"
                  value={form.tone}
                  onChange={(event) => update("tone", event.target.value)}
                />
              </label>
            </div>
            <label className="field">
              <span>一句话创意</span>
              <textarea
                className="input textarea-sm"
                rows={3}
                value={form.idea}
                onChange={(event) => update("idea", event.target.value)}
                placeholder="提灯人能以灯续命，每点一盏灯就忘掉一段记忆。"
              />
            </label>
            <div className="field-row-2">
              <label className="field">
                <span>规划章节数</span>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={200}
                  value={form.targetChapters}
                  onChange={(event) => update("targetChapters", event.target.value)}
                />
              </label>
              <label className="field">
                <span>单章字数</span>
                <input
                  className="input"
                  type="number"
                  min={500}
                  max={10000}
                  step={500}
                  value={form.wordsPerChapter}
                  onChange={(event) => update("wordsPerChapter", event.target.value)}
                />
              </label>
            </div>
            <div className="field-row-2">
              <label className="field">
                <span>作者</span>
                <input
                  className="input"
                  value={form.author}
                  onChange={(event) => update("author", event.target.value)}
                  placeholder="可选"
                />
              </label>
              <label className="field">
                <span>网址标识 slug</span>
                <input
                  className="input"
                  value={form.slug}
                  onChange={(event) => update("slug", event.target.value)}
                  placeholder="留空自动生成"
                />
              </label>
            </div>
            {error ? <p className="form-error">{error}</p> : null}
            <button className="btn btn-primary btn-block" type="submit" disabled={submitting}>
              {submitting ? "创建中…" : "创建工作台"}
            </button>
            <p className="hint">创建后进入工作台，先点「生成架构」，再点「自动写作」。</p>
          </form>
        </section>
      </div>
    </main>
  );
}
