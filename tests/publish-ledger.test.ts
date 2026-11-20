import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  derivePublishLedger,
  emptyPublishLedger,
  findPublishEntry,
  publishLedgerKey,
  removePublishEntry,
  upsertPublishEntry,
} from "@/lib/publish-ledger";
import type { Job, PublishRecord } from "@/lib/types";

const publishState = vi.hoisted(() => ({
  mode: "success" as "success" | "uncertain" | "fail",
  calls: 0,
}));

vi.mock("../lib/publishers/fanqie", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/publishers/fanqie")>();
  return {
    ...actual,
    publishFanqie: async (
      options: Parameters<typeof actual.publishFanqie>[0],
    ): Promise<void> => {
      publishState.calls += 1;
      for (const chapter of options.chapters) {
        if (publishState.mode === "success") {
          await options.onChapterPublished?.(chapter.index);
        } else if (publishState.mode === "uncertain") {
          const message = "模拟提交结果不明";
          await options.onChapterUncertain?.(chapter.index, message);
          throw new actual.PublishUncertainError(message);
        } else {
          throw new Error("模拟登录失效");
        }
      }
    },
  };
});

let dataDir: string;
let store: typeof import("@/lib/store");
let pipeline: typeof import("@/lib/pipeline");
let jobs: typeof import("@/lib/jobs");

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "quillmate-publish-"));
  process.env.QUILLMATE_DATA_DIR = dataDir;
  publishState.mode = "success";
  publishState.calls = 0;
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

async function projectWithWrittenChapters(title: string): Promise<string> {
  const slug = (await store.createProject({ title })).meta.slug;
  const planJob = await pipeline.startJob(slug, "plan");
  expect((await waitForJob(planJob.id)).status).toBe("done");
  const writeJob = await pipeline.startJob(slug, "write", { count: 1 });
  expect((await waitForJob(writeJob.id)).status).toBe("done");
  await store.updateProject(slug, {
    publish: { fanqie: { autoSubmit: true, bookName: "测试书", bookId: "book-1" } },
  });
  return slug;
}

async function publish(slug: string): Promise<Job> {
  const job = await pipeline.startJob(slug, "fanqie-publish", {
    confirmPublish: true,
  });
  return waitForJob(job.id);
}

describe("永久发布台账", () => {
  it("成功发布写入台账，重复任务直接跳过", async () => {
    const slug = await projectWithWrittenChapters("发布成功");
    const first = await publish(slug);
    expect(first.status, first.error).toBe("done");
    expect(publishState.calls).toBe(1);

    let detail = await store.getProjectDetail(slug);
    const entry = findPublishEntry(detail.publishLedger, "book-1", "测试书", 1);
    expect(entry?.status).toBe("published");

    publishState.calls = 0;
    const second = await publish(slug);
    expect(second.status, second.error).toBe("done");
    expect(second.result).toBe("无新章节需要发布");
    expect(publishState.calls).toBe(0);

    detail = await store.getProjectDetail(slug);
    expect(detail.state.publishHistory.length).toBeGreaterThan(0);
  });

  it("清空发布日志后，永久台账仍然阻止重复发布", async () => {
    const slug = await projectWithWrittenChapters("清空日志");
    expect((await publish(slug)).status).toBe("done");

    await store.clearPublishHistory(slug);
    publishState.calls = 0;
    const again = await publish(slug);
    expect(again.status, again.error).toBe("done");
    expect(again.result).toBe("无新章节需要发布");
    expect(publishState.calls).toBe(0);

    const detail = await store.getProjectDetail(slug);
    expect(detail.state.publishHistory).toHaveLength(0);
    expect(findPublishEntry(detail.publishLedger, "book-1", "测试书", 1)?.status).toBe(
      "published",
    );
  });

  it("日志超过 100 条被裁剪后，早期章节仍不会重复发布", async () => {
    const slug = (await store.createProject({ title: "日志裁剪" })).meta.slug;
    for (let chapter = 1; chapter <= 101; chapter += 1) {
      await store.recordPublishOutcome(slug, {
        bookId: "book-1",
        bookName: "测试书",
        chapter,
        status: "published",
      });
      await store.appendPublishRecord(slug, {
        platform: "fanqie",
        at: new Date(2026, 0, 1, 0, 0, chapter % 60, chapter % 1000).toISOString(),
        chapters: [chapter],
        status: "success",
        mode: "publish",
        message: "测试",
      });
    }

    const detail = await store.getProjectDetail(slug);
    expect(detail.state.publishHistory).toHaveLength(100);
    expect(
      detail.state.publishHistory.some((record) => record.chapters.includes(1)),
    ).toBe(false);
    expect(findPublishEntry(detail.publishLedger, "book-1", "测试书", 1)?.status).toBe(
      "published",
    );
  });

  it("提交结果不明时记为待确认，不自动重发，人工确认后按结果处理", async () => {
    const slug = await projectWithWrittenChapters("待确认");
    publishState.mode = "uncertain";
    const uncertainJob = await publish(slug);
    expect(uncertainJob.status).toBe("error");

    let detail = await store.getProjectDetail(slug);
    expect(findPublishEntry(detail.publishLedger, "book-1", "测试书", 1)?.status).toBe(
      "uncertain",
    );

    publishState.mode = "success";
    publishState.calls = 0;
    const skipped = await publish(slug);
    expect(skipped.result).toBe("无新章节需要发布");
    expect(publishState.calls).toBe(0);

    await store.resolvePublishOutcome(slug, {
      bookId: "book-1",
      bookName: "测试书",
      chapter: 1,
      published: false,
    });
    publishState.calls = 0;
    const retried = await publish(slug);
    expect(retried.status, retried.error).toBe("done");
    expect(publishState.calls).toBe(1);

    detail = await store.getProjectDetail(slug);
    expect(findPublishEntry(detail.publishLedger, "book-1", "测试书", 1)?.status).toBe(
      "published",
    );
  });

  it("旧项目的成功日志会自动迁移为永久台账", async () => {
    const slug = (await store.createProject({ title: "旧项目迁移" })).meta.slug;
    await store.appendPublishRecord(slug, {
      platform: "fanqie",
      at: new Date().toISOString(),
      chapters: [1, 2],
      status: "success",
      mode: "publish",
      message: "旧记录",
    });

    const ledgerPath = path.join(dataDir, "projects", slug, "publish-ledger.json");
    const derivedView = await store.getProjectDetail(slug);
    expect(findPublishEntry(derivedView.publishLedger, "", "旧项目迁移", 1)?.status).toBe(
      "published",
    );
    await expect(readFile(ledgerPath, "utf8")).rejects.toThrow();

    const ledger = await store.getPublishLedger(slug);
    expect(findPublishEntry(ledger, "", "旧项目迁移", 2)?.status).toBe("published");
    expect(JSON.parse(await readFile(ledgerPath, "utf8"))).toBeTruthy();
  });
});

describe("台账纯函数", () => {
  it("按作品与章节匹配，补上 bookId 后不会产生重复记录", () => {
    const history: PublishRecord[] = [
      {
        platform: "fanqie",
        at: new Date().toISOString(),
        chapters: [1],
        status: "success",
        mode: "publish",
        message: "",
      },
      {
        platform: "fanqie",
        at: new Date().toISOString(),
        chapters: [2],
        status: "success",
        mode: "draft",
        message: "",
      },
      {
        platform: "fanqie",
        at: new Date().toISOString(),
        chapters: [3],
        status: "failed",
        mode: "publish",
        message: "",
      },
    ];
    let ledger = derivePublishLedger(history, "", " 测试书 ");
    expect(Object.keys(ledger.records)).toEqual([
      publishLedgerKey("", "测试书", 1),
    ]);
    expect(findPublishEntry(ledger, "book-1", "测试书", 1)?.status).toBe("published");

    ledger = upsertPublishEntry(ledger, {
      platform: "fanqie",
      bookId: "book-1",
      bookName: "测试书",
      chapter: 1,
      status: "published",
      at: new Date().toISOString(),
    });
    expect(Object.values(ledger.records)).toHaveLength(1);

    const removed = removePublishEntry(ledger, "book-1", "测试书", 1);
    expect(Object.values(removed.records)).toHaveLength(0);
    expect(emptyPublishLedger().records).toEqual({});
  });
});
