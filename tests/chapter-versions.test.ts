import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "@/lib/types";

const agentState = vi.hoisted(() => ({ rewriteText: "" }));

vi.mock("../lib/agents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/agents")>();
  return {
    ...actual,
    writeChapter: async (...args: Parameters<typeof actual.writeChapter>) => {
      const options = args[6];
      if (options?.mode === "rewrite" && agentState.rewriteText) {
        return agentState.rewriteText;
      }
      return actual.writeChapter(...args);
    },
  };
});

let dataDir: string;
let store: typeof import("@/lib/store");
let pipeline: typeof import("@/lib/pipeline");
let jobs: typeof import("@/lib/jobs");

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "quillmate-versions-"));
  process.env.QUILLMATE_DATA_DIR = dataDir;
  agentState.rewriteText = "";
  vi.resetModules();
  store = await import("@/lib/store");
  pipeline = await import("@/lib/pipeline");
  jobs = await import("@/lib/jobs");
  jobs.__reloadJobStoreForTests();
});

afterEach(async () => {
  vi.resetModules();
  delete process.env.QUILLMATE_DATA_DIR;
  await rm(dataDir, { recursive: true, force: true });
});

async function waitForJob(id: string): Promise<Job> {
  const deadline = Date.now() + 20000;
  for (;;) {
    const job = jobs.getJob(id);
    if (job && ["done", "error", "paused", "cancelled"].includes(job.status)) return job;
    if (Date.now() > deadline) throw new Error(`等待任务 ${id} 超时`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function projectPath(slug: string): string {
  return path.join(dataDir, "projects", slug);
}

async function projectWithPlan(title: string, chapters = 1): Promise<string> {
  const slug = (await store.createProject({ title, targetChapters: chapters })).meta.slug;
  const planJob = await pipeline.startJob(slug, "plan");
  expect((await waitForJob(planJob.id)).status, "生成架构失败").toBe("done");
  return slug;
}

describe("章节版本管理", () => {
  it("手动保存生成版本，重复保存相同正文不会制造空版本", async () => {
    const slug = await projectWithPlan("手动版本");
    await store.saveChapter(slug, 1, "第一版正文", "新标题");
    await store.saveChapter(slug, 1, "第二版正文", "新标题");
    await store.saveChapter(slug, 1, "第二版正文", "新标题");

    const versions = await store.listChapterVersions(slug, 1);
    expect(versions.map((item) => item.version)).toEqual([1, 2]);
    expect(versions.every((item) => item.source === "user")).toBe(true);

    const second = await store.getChapterVersion(slug, 1, 2);
    expect(second.content).toContain("第二版正文");
    expect(second.previousContent).toContain("第一版正文");
  });

  it("AI 重写保留旧版本，恢复会新建 restore 版本且不影响其他章节", async () => {
    const slug = await projectWithPlan("版本恢复", 2);

    const writeJob = await pipeline.startJob(slug, "write", { count: 2 });
    expect((await waitForJob(writeJob.id)).status).toBe("done");
    const before = await store.getProjectDetail(slug);
    const originalChapter1 = before.chapters.find((item) => item.index === 1)?.content ?? "";
    const originalChapter2 = before.chapters.find((item) => item.index === 2)?.content ?? "";

    agentState.rewriteText = "重写后的第一章正文。\n\n这是新的冲突。";
    const rewriteJob = await pipeline.startJob(slug, "rewrite", { indices: [1] });
    const rewriteDone = await waitForJob(rewriteJob.id);
    expect(rewriteDone.status, rewriteDone.error).toBe("done");

    let versions = await store.listChapterVersions(slug, 1);
    expect(versions.map((item) => item.source)).toEqual(["ai-write", "ai-rewrite"]);
    const firstVersion = await store.getChapterVersion(slug, 1, 1);
    expect(firstVersion.content).toBe(originalChapter1);

    const restored = await store.restoreChapterVersion(slug, 1, 1);
    expect(restored.created?.source).toBe("restore");

    const after = await store.getProjectDetail(slug);
    expect(after.chapters.find((item) => item.index === 1)?.content).toBe(
      originalChapter1,
    );
    expect(after.chapters.find((item) => item.index === 2)?.content).toBe(
      originalChapter2,
    );
    expect(after.state.reviews["1"]).toBeUndefined();

    versions = await store.listChapterVersions(slug, 1);
    expect(versions.map((item) => item.version)).toContain(3);
    expect(versions.find((item) => item.version === 3)?.source).toBe("restore");
  });

  it("已有正文但没有版本记录时，第一次覆盖前先建立原文基线", async () => {
    const slug = await projectWithPlan("基线版本");
    await store.saveChapter(slug, 1, "原始正文");
    await fs.rm(path.join(projectPath(slug), "versions"), {
      recursive: true,
      force: true,
    });

    await store.saveChapter(slug, 1, "修改正文");
    const versions = await store.listChapterVersions(slug, 1);
    expect(versions.map((item) => item.source)).toEqual(["system", "user"]);

    const baseline = await store.getChapterVersion(slug, 1, 1);
    expect(baseline.content).toContain("原始正文");

    await store.restoreChapterVersion(slug, 1, 1);
    const detail = await store.getProjectDetail(slug);
    expect(detail.chapters[0].content).toContain("原始正文");
  });

  it("版本记录写入失败时不会覆盖旧正文", async () => {
    const slug = (await store.createProject({ title: "版本失败" })).meta.slug;
    await store.savePlan(
      slug,
      {
        logline: "",
        tags: [],
        chapters: [{ index: 1, title: "开端", summary: "摘要", keyBeats: [] }],
      },
      "# 世界观",
      "# 大纲",
    );
    const chapterPath = path.join(projectPath(slug), "chapters", "1.md");
    await fs.writeFile(chapterPath, "旧正文\n", "utf8");
    // 把 versions 变成普通文件，制造版本目录创建失败。
    await fs.writeFile(path.join(projectPath(slug), "versions"), "not-a-dir", "utf8");

    await expect(store.saveChapter(slug, 1, "新正文")).rejects.toThrow();
    expect(await fs.readFile(chapterPath, "utf8")).toBe("旧正文\n");
  });

  it("旧项目的修复草稿会作为历史版本导入", async () => {
    const slug = (await store.createProject({ title: "旧版本导入" })).meta.slug;
    await store.savePlan(
      slug,
      {
        logline: "",
        tags: [],
        chapters: [{ index: 1, title: "开端", summary: "摘要", keyBeats: [] }],
      },
      "# 世界观",
      "# 大纲",
    );
    await fs.writeFile(
      path.join(projectPath(slug), "chapters", "1.md"),
      "当前正文\n",
      "utf8",
    );
    await fs.mkdir(path.join(projectPath(slug), "drafts"), { recursive: true });
    await fs.writeFile(
      path.join(projectPath(slug), "drafts", "1-before-repair-2026-01-01T00-00-00-000Z.md"),
      "修复前正文\n",
      "utf8",
    );

    const versions = await store.listChapterVersions(slug, 1);
    expect(versions.map((item) => item.source)).toEqual(["ai-repair", "system"]);
    const repaired = await store.getChapterVersion(slug, 1, 1);
    expect(repaired.content).toContain("修复前正文");
    expect(repaired.note).toContain("定点修复草稿");
    const current = await store.getChapterVersion(slug, 1, 2);
    expect(current.content).toContain("当前正文");
  });
});
