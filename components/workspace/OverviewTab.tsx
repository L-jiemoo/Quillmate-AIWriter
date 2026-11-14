import type { ProjectDetail } from "@/lib/types";
import { Markdown } from "@/components/Markdown";

export function OverviewTab({ detail }: { detail: ProjectDetail }) {
  const written = detail.state.written.length;
  const totalWords = detail.chapters.reduce(
    (sum, chapter) => sum + (chapter.written ? chapter.words : 0),
    0,
  );

  return (
    <div className="overview">
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
              <dd>{new Date(detail.meta.updatedAt).toLocaleString("zh-CN", { hour12: false })}</dd>
            </div>
          </dl>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">世界观圣经</h2>
          <span className="muted small">世界设定</span>
        </div>
        <div className="panel-body">
          <Markdown>{detail.bible}</Markdown>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">主线大纲</h2>
          <span className="muted small">主线</span>
        </div>
        <div className="panel-body">
          <Markdown>{detail.outlineMd}</Markdown>
        </div>
      </section>

      {detail.plan.chapters.length ? (
        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">章节细纲</h2>
            <span className="muted small">细纲</span>
          </div>
          <div className="panel-body">
            <ol className="plan-list">
              {detail.plan.chapters.map((chapter) => (
                <li key={chapter.index}>
                  <div className="plan-title">
                    <span className="plan-index">{String(chapter.index).padStart(2, "0")}</span>
                    <span>{chapter.title}</span>
                    <span
                      className={`dot ${
                        detail.state.written.includes(chapter.index) ? "dot-done" : "dot-pending"
                      }`}
                    />
                  </div>
                  <p>{chapter.summary}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>
      ) : null}
    </div>
  );
}
