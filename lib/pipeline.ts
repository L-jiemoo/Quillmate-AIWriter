import { extendPlan, generateCharacters, generatePlan, reviewChapter, writeChapter } from "./agents";
import { getRuntimeConfig } from "./config";
import { createJob, logJob } from "./jobs";
import { loginFanqie, publishFanqie } from "./publishers/fanqie";
import {
  appendChapters,
  appendOutlineSection,
  appendPublishRecord,
  exportBookFile,
  getProjectDetail,
  getProjectFile,
  getWrittenChapters,
  markChapterWritten,
  saveCharacters,
  savePlan,
  writeChapterFile,
} from "./store";
import { errorMessage, nowIso } from "./utils";
import type { Job } from "./types";

const JOB_LABELS: Record<Job["type"], string> = {
  plan: "生成架构与角色",
  extend: "补充章节大纲",
  write: "自动写作",
  export: "导出全书",
  "fanqie-login": "登录番茄",
  "fanqie-publish": "发布到番茄",
};

export async function startJob(
  slug: string,
  type: Job["type"],
  params: { count?: number } = {},
): Promise<Job> {
  await getProjectFile(slug);
  const job = createJob(slug, type);
  // 任务在后台自行推进，HTTP 只返回 job 快照；前端靠 /api/jobs/[id] 轮询日志。
  // 这里刻意不 await，否则长任务会一直占住请求。
  void runJob(job, params);
  return job;
}

async function runJob(job: Job, params: { count?: number }): Promise<void> {
  job.status = "running";
  job.updatedAt = nowIso();
  logJob(job, `任务开始：${JOB_LABELS[job.type]}`);

  const runtime = getRuntimeConfig();
  if (runtime.provider === "mock") {
    logJob(job, "当前为 mock 模式，将生成示例内容；可在「模型设置」页填写 API Key 接入真实模型。");
  }

  try {
    switch (job.type) {
      case "plan":
        await runPlan(job);
        break;
      case "extend":
        await runExtend(job, params.count ?? 10);
        break;
      case "write":
        await runWrite(job, params.count ?? 1);
        break;
      case "export":
        await runExport(job);
        break;
      case "fanqie-login":
        await runFanqieLogin(job);
        break;
      case "fanqie-publish":
        await runFanqiePublish(job);
        break;
    }
    job.status = "done";
    logJob(job, "任务完成");
  } catch (error) {
    // 后台任务是脱离请求执行的，异常必须先写回 job 对象；
    // 否则前端轮询只能看到任务停在 running，用户会误以为还在生成。
    job.status = "error";
    job.error = errorMessage(error);
    logJob(job, `任务失败：${job.error}`);
  } finally {
    job.updatedAt = nowIso();
  }
}

async function runPlan(job: Job): Promise<void> {
  const file = await getProjectFile(job.slug);
  logJob(job, "架构师正在构思世界观、主线与章节细纲…");
  const generated = await generatePlan(file.meta);
  await savePlan(job.slug, generated.plan, generated.bible, generated.outlineMd);
  logJob(job, `已生成 ${generated.plan.chapters.length} 章细纲`);

  logJob(job, "角色设计师正在创建人物档案…");
  const characters = await generateCharacters(file.meta, generated);
  await saveCharacters(job.slug, characters);
  logJob(job, `已生成 ${characters.length} 位角色：${characters.map((item) => item.name).join("、")}`);
}

async function runExtend(job: Job, requested: number): Promise<void> {
  const count = Math.max(1, Math.min(50, Math.round(Number(requested) || 10)));
  const detail = await getProjectDetail(job.slug);

  if (!detail.plan.chapters.length) {
    throw new Error("还没有章节大纲，请先生成架构与角色");
  }

  // 新章节从现有最大序号往后接，不复用中间空缺，避免和已发布章节撞号。
  const startIndex = Math.max(...detail.plan.chapters.map((chapter) => chapter.index)) + 1;
  // 只带最近 6 章摘要进入续排提示词，既保证连贯性，又控制上下文长度。
  const summaries = Object.keys(detail.state.summaries)
    .map(Number)
    .sort((a, b) => a - b)
    .slice(-6)
    .map((index) => `第 ${index} 章：${detail.state.summaries[String(index)]}`);

  logJob(
    job,
    `现有 ${detail.plan.chapters.length} 章大纲，正在从第 ${startIndex} 章起补充 ${count} 章…`,
  );

  const chapters = await extendPlan(
    detail.meta,
    detail.plan,
    detail.bible,
    detail.outlineMd,
    summaries,
    count,
  );
  const plan = await appendChapters(job.slug, chapters);
  await appendOutlineSection(job.slug, chapters);

  job.result = `新增 ${chapters.length} 章大纲`;
  logJob(
    job,
    `已补充 ${chapters.length} 章，当前大纲共 ${plan.chapters.length} 章，主线大纲已同步更新`,
  );
}

async function runWrite(job: Job, requested: number): Promise<void> {
  const count = Math.max(1, Math.min(50, Math.round(Number(requested) || 1)));
  const detail = await getProjectDetail(job.slug);
  const pending = detail.chapters.filter((chapter) => !chapter.written).slice(0, count);

  if (!pending.length) {
    logJob(job, "没有待写章节：请先生成架构，或调整目标章节数。");
    return;
  }

  const history = Object.keys(detail.state.summaries)
    .map(Number)
    .sort((a, b) => a - b)
    .map((index) => detail.state.summaries[String(index)])
    .filter((item): item is string => Boolean(item));

  // 逐章串行：每章写完立即落盘并更新摘要，任务中途失败时，
  // 已完成的章节仍然保留，history 也会持续传给下一章作为前情。
  for (const chapter of pending) {
    const chapterPlan = detail.plan.chapters.find((item) => item.index === chapter.index);
    if (!chapterPlan) continue;

    logJob(job, `开始写第 ${chapter.index} 章《${chapter.title}》…`);
    const text = await writeChapter(
      detail.meta,
      detail.bible,
      detail.characters,
      chapterPlan,
      history.slice(-6),
    );
    if (!text.trim()) throw new Error(`第 ${chapter.index} 章正文为空，请重试`);

    await writeChapterFile(job.slug, chapter.index, text);
    logJob(job, `正文完成，约 ${text.replace(/\s+/g, "").length} 字，开始审校…`);

    let review = {
      summary: chapterPlan.summary,
      issues: [] as string[],
      continuityOk: true,
    };
    try {
      review = await reviewChapter(detail.meta, detail.bible, chapterPlan, text);
    } catch (error) {
      // 审校只是增强步骤；模型审校失败时退回细纲梗概，
      // 正文已经写好，不能因为审校异常而丢掉这一章。
      logJob(job, `审校失败，改用章节梗概作为摘要：${errorMessage(error)}`);
    }

    await markChapterWritten(job.slug, chapter.index, review.summary, review);
    history.push(review.summary);
    logJob(
      job,
      `第 ${chapter.index} 章完成${review.issues.length ? `，审校提出 ${review.issues.length} 条建议` : ""}`,
    );
  }
}

async function runExport(job: Job): Promise<void> {
  const result = await exportBookFile(job.slug);
  job.result = result.relativePath;
  logJob(job, `已生成全书文件：${result.relativePath}（${result.chapters} 章，约 ${result.words} 字）`);
}

async function runFanqieLogin(job: Job): Promise<void> {
  logJob(job, "即将打开浏览器窗口，请在其中完成番茄作家专区的扫码或验证码登录。");
  await loginFanqie((message) => logJob(job, message));
  job.result = "登录会话已保存";
}

async function runFanqiePublish(job: Job): Promise<void> {
  const file = await getProjectFile(job.slug);
  const config = file.publish.fanqie;
  if (!config.bookName.trim()) throw new Error("请先在「发布」页填写番茄书名");

  const detail = await getProjectDetail(job.slug);
  // 发布记录就是幂等依据：只有 fanqie + success + mode=publish 才算“已发布”，
  // 草稿记录不跳过，否则用户改完草稿后无法再次提交。
  const published = new Set<number>();
  for (const record of detail.state.publishHistory ?? []) {
    if (record.platform !== "fanqie" || record.status !== "success" || record.mode !== "publish") {
      continue;
    }
    for (const index of record.chapters) published.add(index);
  }

  const written = await getWrittenChapters(job.slug);
  const chapters = written.filter((chapter) => !published.has(chapter.index));
  const skipped = written.length - chapters.length;
  if (skipped > 0) logJob(job, `已跳过 ${skipped} 个此前发布成功的章节`);

  if (!chapters.length) {
    logJob(job, "没有新的已写章节需要发布；所有已写章节都已提交过。");
    job.result = "无新章节需要发布";
    return;
  }

  logJob(
    job,
    `准备将 ${chapters.length} 章发布到番茄小说《${config.bookName}》${
      config.autoSubmit ? "（自动提交发布）" : "（仅保存草稿）"
    }…`,
  );

  const confirmed = new Set<number>();
  try {
    await publishFanqie({
      ...config,
      chapters,
      onChapterPublished: async (index) => {
        if (!config.autoSubmit) return;
        confirmed.add(index);
        await appendPublishRecord(job.slug, {
          platform: "fanqie",
          at: nowIso(),
          chapters: [index],
          status: "success",
          mode: "publish",
          message: "已自动提交发布",
        });
      },
      onLog: (message) => logJob(job, message),
    });

    if (config.autoSubmit) {
      job.result = `已提交 ${chapters.length} 章`;
      logJob(
        job,
        "流程完成；番茄后台通常需要数十分钟到 1 小时审核上线，请自行确认状态。",
      );
    } else {
      // 草稿模式没有逐章成功回调，只能在整批流程结束后记一条草稿记录；
      // 草稿不计入“已发布”，下次仍会作为待发布章节处理。
      await appendPublishRecord(job.slug, {
        platform: "fanqie",
        at: nowIso(),
        chapters: chapters.map((chapter) => chapter.index),
        status: "success",
        mode: "draft",
        message: "已保存为草稿",
      });
      job.result = "已保存草稿";
      logJob(job, "流程完成；请到番茄后台确认草稿并手动发布。");
    }
  } catch (error) {
    // 每成功一章已在 onChapterPublished 里单独记账；这里只补记“未确认”的章节，
    // 避免任务中途失败时把已经提交成功的章节误标为失败。
    const remaining = chapters.filter((chapter) => !confirmed.has(chapter.index));
    if (remaining.length) {
      await appendPublishRecord(job.slug, {
        platform: "fanqie",
        at: nowIso(),
        chapters: remaining.map((chapter) => chapter.index),
        status: "failed",
        mode: config.autoSubmit ? "publish" : "draft",
        message: errorMessage(error),
      }).catch(() => undefined);
    }
    throw error;
  }
}
