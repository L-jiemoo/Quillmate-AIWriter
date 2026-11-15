"use client";

import { useState } from "react";
import type { ProjectDetail, StartJobFn } from "@/lib/types";
import { errorMessage } from "@/lib/utils";

export function PublishTab({
  detail,
  onStartJob,
  onRefresh,
  disabled = false,
}: {
  detail: ProjectDetail;
  onStartJob: StartJobFn;
  onRefresh: () => Promise<void>;
  disabled?: boolean;
}) {
  const fanqie = detail.publish.fanqie;
  const slug = detail.meta.slug;

  const [bookName, setBookName] = useState(fanqie.bookName);
  const [bookId, setBookId] = useState(fanqie.bookId);
  const [autoSubmit, setAutoSubmit] = useState(fanqie.autoSubmit);
  const [headless, setHeadless] = useState(fanqie.headless);
  const [selectorsText, setSelectorsText] = useState(
    JSON.stringify(fanqie.selectors ?? {}, null, 2),
  );
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [historyNotice, setHistoryNotice] = useState("");

  const history = [...(detail.state.publishHistory ?? [])].reverse();
  // “已发布”只认成功且 mode=publish 的记录；草稿记录仍算待发布，
  // 这样用户把草稿改成正式提交后，按钮不会错误地显示 0 章。
  const published = new Set(
    (detail.state.publishHistory ?? [])
      .filter(
        (record) =>
          record.platform === "fanqie" &&
          record.status === "success" &&
          record.mode === "publish",
      )
      .flatMap((record) => record.chapters),
  );
  const publishable = detail.chapters.filter(
    (chapter) =>
      chapter.written && chapter.content.trim().length > 0 && !published.has(chapter.index),
  ).length;

  async function persist(showNotice: boolean): Promise<boolean> {
    setSaving(true);
    setError("");
    try {
      let selectors: Record<string, unknown> = {};
      if (selectorsText.trim()) {
        const parsed = JSON.parse(selectorsText) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("选择器配置必须是 JSON 对象");
        }
        selectors = parsed as Record<string, unknown>;
      }

      const response = await fetch(`/api/projects/${slug}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          publish: { fanqie: { bookName, bookId, autoSubmit, headless, selectors } },
        }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "保存失败");
      if (showNotice) setNotice("发布设置已保存");
      await onRefresh();
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function handleLogin() {
    setNotice("");
    if (!(await persist(false))) return;
    await onStartJob("fanqie-login");
  }

  async function handleRefreshHistory() {
    setRefreshing(true);
    setError("");
    try {
      await onRefresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRefreshing(false);
    }
  }

  async function handleClearHistory() {
    if (!history.length || clearing || disabled) return;
    if (
      !window.confirm(
        `将清空全部 ${history.length} 条发布记录。\n\n发布记录同时用于去重：清空后系统会忘记哪些章节已成功发布，下次发布可能把已发布章节再次提交到番茄。\n\n仅建议在记录错误或确实需要重新发布时使用。继续？`,
      )
    ) {
      return;
    }
    setClearing(true);
    setHistoryError("");
    setHistoryNotice("");
    try {
      const response = await fetch(`/api/projects/${slug}/publish`, { method: "DELETE" });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "清空发布记录失败");
      await onRefresh();
      setHistoryNotice("发布记录已清空");
    } catch (err) {
      setHistoryError(errorMessage(err));
    } finally {
      setClearing(false);
    }
  }

  async function handlePublish() {
    setNotice("");
    if (!publishable) {
      setError("还没有已写章节");
      return;
    }
    const action = autoSubmit ? "直接提交发布" : "保存为草稿";
    if (
      !window.confirm(
        `将自动操作浏览器，把 ${publishable} 个未发布章节${action}到番茄小说《${bookName}》。\n\n自动化发布可能违反平台规则或触发风控，请确认已了解风险。继续？`,
      )
    ) {
      return;
    }
    if (!(await persist(false))) return;
    await onStartJob("fanqie-publish");
  }

  return (
    <div className="publish-tab">
      <div className="publish-grid">
        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">本地导出</h2>
            <span className="muted small">MD 文件</span>
          </div>
          <div className="panel-body publish-body">
            <p className="muted">把已写章节合并成一份全书 Markdown，方便备份、投稿或二次排版。</p>
            <div className="button-row">
              <button className="btn" onClick={() => onStartJob("export")}>
                导出到项目目录
              </button>
              <a className="btn btn-ghost" href={`/api/projects/${slug}/export`}>
                下载全书 .md
              </a>
            </div>
            <p className="hint">文件位置：data/projects/{slug}/exports/全书.md</p>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">番茄小说 · 自动发布</h2>
            <span className="muted small">番茄小说</span>
          </div>
          <div className="panel-body publish-body">
            <div className="field-row-2">
              <label className="field">
                <span>书名 *</span>
                <input
                  className="input"
                  value={bookName}
                  onChange={(event) => setBookName(event.target.value)}
                  placeholder="与番茄后台的作品名一致"
                />
              </label>
              <label className="field">
                <span>bookId（可选）</span>
                <input
                  className="input"
                  value={bookId}
                  onChange={(event) => setBookId(event.target.value)}
                  placeholder="留空时按书名定位作品"
                />
              </label>
            </div>

            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={autoSubmit}
                onChange={(event) => setAutoSubmit(event.target.checked)}
              />
              <span>自动完成「下一步 → 内容检测 → 确认提交」（关闭时只保存草稿）</span>
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={headless}
                onChange={(event) => setHeadless(event.target.checked)}
              />
              <span>发布时使用无头浏览器（登录过程始终可见）</span>
            </label>

            <details className="advanced">
              <summary>高级：站点选择器（平台改版时调整）</summary>
              <textarea
                className="input code-area"
                rows={9}
                value={selectorsText}
                onChange={(event) => setSelectorsText(event.target.value)}
                spellCheck={false}
              />
              <p className="hint">
                可配置键：bookEntry / createChapter / titleInput / contentEditor / saveButton /
                publishButton / confirmButton，值为 CSS 或 text= 选择器数组。bookEntry
                默认指向番茄工作台的作品卡片。
              </p>
            </details>

            {error ? <p className="form-error">{error}</p> : null}
            {notice ? <p className="form-note">{notice}</p> : null}

            <div className="button-row">
              <button className="btn" onClick={() => persist(true)} disabled={saving}>
                保存设置
              </button>
              <button className="btn btn-ghost" onClick={handleLogin} disabled={saving}>
                登录番茄
              </button>
              <button
                className="btn btn-primary"
                onClick={handlePublish}
                disabled={saving || publishable === 0}
              >
                发布 {publishable} 章
              </button>
            </div>

            <ol className="steps">
              <li>
                点「登录番茄」，窗口会自动进入登录页；扫码或验证码登录成功后窗口自动关闭，会话保存在本地。也可以手动关闭窗口。
              </li>
              <li>首次建议关闭「自动提交」，先验证存草稿流程。</li>
              <li>
                正式提交时会自动选择「仅基础检测」，并在发布设置中声明「使用
                AI：是」；已提交成功的章节在下次发布时会自动跳过。
              </li>
            </ol>
            <p className="hint">
              番茄要求每章正文不少于 1000 字，标题需要配合章节序号；字数不足时任务会在启动前提示具体章节。
            </p>
            <p className="hint warn">
              自动发布依赖平台网页结构，站点改版后可能失效；请遵守平台规则、控制频率，并对发布内容负责。
            </p>
          </div>
        </section>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">发布记录</h2>
          <div className="panel-head-tools">
            <span className="muted small">{history.length} 条记录</span>
            {/* 发布记录可能由后台任务写入，刷新会重新拉取项目详情。 */}
            <button
              className="btn btn-ghost btn-sm"
              onClick={handleRefreshHistory}
              disabled={refreshing}
            >
              {refreshing ? "刷新中…" : "刷新"}
            </button>
            <button
              className="btn btn-ghost btn-sm danger-text"
              onClick={handleClearHistory}
              disabled={clearing || disabled || !history.length}
            >
              {clearing ? "清空中…" : "清空记录"}
            </button>
          </div>
        </div>
        <div className="panel-body">
          {historyError ? <p className="form-error">{historyError}</p> : null}
          {historyNotice ? <p className="form-note">{historyNotice}</p> : null}
          {history.length ? (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>平台</th>
                    <th>章节</th>
                    <th>状态</th>
                    <th>说明</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((record, index) => (
                    <tr key={`${record.at}-${index}`}>
                      <td>{new Date(record.at).toLocaleString("zh-CN", { hour12: false })}</td>
                      <td>{record.platform === "fanqie" ? "番茄小说" : "本地导出"}</td>
                      <td>{record.chapters.length} 章</td>
                      <td>
                        <span className={`status-pill ${record.status === "success" ? "ok" : "bad"}`}>
                          {record.status === "success" ? "成功" : "失败"}
                        </span>
                      </td>
                      <td className="muted">{record.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">暂无发布记录。</p>
          )}
        </div>
      </section>
    </div>
  );
}
