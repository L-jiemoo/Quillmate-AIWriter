import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job, JobParams } from "@/lib/types";

const startJobMock = vi.hoisted(() =>
  vi.fn(
    async (slug: string, type: Job["type"], params: JobParams = {}): Promise<Job> => {
      const now = new Date().toISOString();
      return {
        id: "00000000-0000-4000-8000-000000000001",
        slug,
        type,
        status: "queued",
        params,
        logs: [],
        createdAt: now,
        updatedAt: now,
      };
    },
  ),
);

vi.mock("@/lib/pipeline", () => ({
  startJob: startJobMock,
}));

let dataDir: string;
let store: typeof import("@/lib/store");

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "quillmate-api-routes-"));
  process.env.QUILLMATE_DATA_DIR = dataDir;
  vi.clearAllMocks();
  vi.resetModules();
  store = await import("@/lib/store");
  const jobs = await import("@/lib/jobs");
  jobs.__reloadJobStoreForTests();
});

afterEach(async () => {
  vi.resetModules();
  delete process.env.QUILLMATE_DATA_DIR;
  await rm(dataDir, { recursive: true, force: true });
});

function jsonRequest(
  url: string,
  method: string,
  body?: unknown,
): Request {
  return new Request(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("项目与发布路由确认", () => {
  it("删除项目必须携带 confirmSlug", async () => {
    const slug = (await store.createProject({ title: "删除确认" })).meta.slug;
    const route = await import("@/app/api/projects/[slug]/route");

    const without = await route.DELETE(
      jsonRequest(`http://localhost/api/projects/${slug}`, "DELETE"),
      { params: Promise.resolve({ slug }) },
    );
    expect(without.status).toBe(400);
    await expect(store.getProjectDetail(slug)).resolves.toBeTruthy();

    const withConfirm = await route.DELETE(
      jsonRequest(`http://localhost/api/projects/${slug}`, "DELETE", {
        confirmSlug: slug,
      }),
      { params: Promise.resolve({ slug }) },
    );
    expect(withConfirm.status).toBe(200);
    await expect(store.getProjectDetail(slug)).rejects.toBeTruthy();
  });

  it("跨源写请求在确认之前就被拒绝", async () => {
    const slug = (await store.createProject({ title: "跨源拒绝" })).meta.slug;
    const route = await import("@/app/api/projects/[slug]/route");
    const response = await route.DELETE(
      new Request(`http://localhost/api/projects/${slug}`, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          origin: "https://evil.example",
          host: "localhost",
        },
        body: JSON.stringify({ confirmSlug: slug }),
      }),
      { params: Promise.resolve({ slug }) },
    );
    expect(response.status).toBe(403);
    await expect(store.getProjectDetail(slug)).resolves.toBeTruthy();
  });

  it("清空发布日志必须携带固定确认令牌", async () => {
    const slug = (await store.createProject({ title: "清空日志确认" })).meta.slug;
    const route = await import("@/app/api/projects/[slug]/publish/route");

    const without = await route.DELETE(
      jsonRequest(`http://localhost/api/projects/${slug}/publish`, "DELETE"),
      { params: Promise.resolve({ slug }) },
    );
    expect(without.status).toBe(400);

    const withConfirm = await route.DELETE(
      jsonRequest(`http://localhost/api/projects/${slug}/publish`, "DELETE", {
        confirm: "clear-publish-history",
      }),
      { params: Promise.resolve({ slug }) },
    );
    expect(withConfirm.status).toBe(200);
  });

  it("发布任务缺少 confirmPublish 时不会启动任务", async () => {
    const slug = (await store.createProject({ title: "发布确认" })).meta.slug;
    const route = await import("@/app/api/projects/[slug]/jobs/route");

    const without = await route.POST(
      jsonRequest(`http://localhost/api/projects/${slug}/jobs`, "POST", {
        type: "fanqie-publish",
      }),
      { params: Promise.resolve({ slug }) },
    );
    expect(without.status).toBe(400);
    expect(startJobMock).not.toHaveBeenCalled();

    const withConfirm = await route.POST(
      jsonRequest(`http://localhost/api/projects/${slug}/jobs`, "POST", {
        type: "fanqie-publish",
        confirmPublish: true,
      }),
      { params: Promise.resolve({ slug }) },
    );
    expect(withConfirm.status).toBe(202);
    expect(startJobMock).toHaveBeenCalledWith(
      slug,
      "fanqie-publish",
      expect.objectContaining({ confirmPublish: true }),
    );
  });

  it("草稿修复任务必须指定草稿并保留 draft 来源", async () => {
    const slug = (await store.createProject({ title: "草稿修复" })).meta.slug;
    const route = await import("@/app/api/projects/[slug]/jobs/route");

    const without = await route.POST(
      jsonRequest(`http://localhost/api/projects/${slug}/jobs`, "POST", {
        type: "repair",
        source: "draft",
      }),
      { params: Promise.resolve({ slug }) },
    );
    expect(without.status).toBe(400);
    expect(startJobMock).not.toHaveBeenCalled();

    const withDraft = await route.POST(
      jsonRequest(`http://localhost/api/projects/${slug}/jobs`, "POST", {
        type: "repair",
        source: "draft",
        indices: [2],
      }),
      { params: Promise.resolve({ slug }) },
    );
    expect(withDraft.status).toBe(202);
    expect(startJobMock).toHaveBeenCalledWith(
      slug,
      "repair",
      expect.objectContaining({ indices: [2], source: "draft" }),
    );
  });

  it("人工修改发布状态必须二次确认", async () => {
    const slug = (await store.createProject({ title: "发布状态确认" })).meta.slug;
    const route = await import("@/app/api/projects/[slug]/publish/records/route");

    const without = await route.POST(
      jsonRequest(`http://localhost/api/projects/${slug}/publish/records`, "POST", {
        chapter: 1,
        published: true,
      }),
      { params: Promise.resolve({ slug }) },
    );
    expect(without.status).toBe(400);
  });

  it("从未发布过的章节也能手动标记为已发布并释放", async () => {
    const slug = (await store.createProject({ title: "手动标记发布" })).meta.slug;
    const route = await import("@/app/api/projects/[slug]/publish/records/route");

    // 新建项目默认用书名做番茄书名；清空后应该拒绝标记，
    // 否则台账会落到空书名下，发布去重无法匹配。
    await store.updateProject(slug, { publish: { fanqie: { bookName: "" } } });
    const noBook = await route.POST(
      jsonRequest(`http://localhost/api/projects/${slug}/publish/records`, "POST", {
        chapter: 1,
        published: true,
        confirm: true,
      }),
      { params: Promise.resolve({ slug }) },
    );
    expect(noBook.status).toBe(400);

    await store.updateProject(slug, {
      publish: { fanqie: { bookName: "手动标记之书", bookId: "book-manual" } },
    });

    const marked = await route.POST(
      jsonRequest(`http://localhost/api/projects/${slug}/publish/records`, "POST", {
        chapter: 1,
        published: true,
        confirm: true,
      }),
      { params: Promise.resolve({ slug }) },
    );
    expect(marked.status).toBe(200);
    const ledger = await store.getPublishLedger(slug);
    const entry = Object.values(ledger.records).find((item) => item.chapter === 1);
    expect(entry?.status).toBe("published");
    expect(entry?.bookName).toBe("手动标记之书");

    const released = await route.POST(
      jsonRequest(`http://localhost/api/projects/${slug}/publish/records`, "POST", {
        chapter: 1,
        published: false,
        confirm: true,
      }),
      { params: Promise.resolve({ slug }) },
    );
    expect(released.status).toBe(200);
    const after = await store.getPublishLedger(slug);
    expect(
      Object.values(after.records).some((item) => item.chapter === 1),
    ).toBe(false);
  });

  it("发布状态支持一次批量标记已发布与未发布", async () => {
    const slug = (await store.createProject({ title: "批量标记发布" })).meta.slug;
    await store.updateProject(slug, {
      publish: { fanqie: { bookName: "批量标记之书", bookId: "book-batch" } },
    });
    const route = await import("@/app/api/projects/[slug]/publish/records/route");

    const marked = await route.POST(
      jsonRequest(`http://localhost/api/projects/${slug}/publish/records`, "POST", {
        chapters: [1, 2, 3, 2, 0, "x"],
        published: true,
        confirm: true,
      }),
      { params: Promise.resolve({ slug }) },
    );
    expect(marked.status).toBe(200);
    let ledger = await store.getPublishLedger(slug);
    expect(
      Object.values(ledger.records)
        .filter((item) => item.status === "published")
        .map((item) => item.chapter)
        .sort((a, b) => a - b),
    ).toEqual([1, 2, 3]);

    // 批量释放：一次请求清掉整批，避免逐章写台账。
    const released = await route.POST(
      jsonRequest(`http://localhost/api/projects/${slug}/publish/records`, "POST", {
        chapters: [1, 2, 3],
        published: false,
        confirm: true,
      }),
      { params: Promise.resolve({ slug }) },
    );
    expect(released.status).toBe(200);
    ledger = await store.getPublishLedger(slug);
    expect(Object.values(ledger.records)).toHaveLength(0);

    const empty = await route.POST(
      jsonRequest(`http://localhost/api/projects/${slug}/publish/records`, "POST", {
        chapters: [],
        published: true,
        confirm: true,
      }),
      { params: Promise.resolve({ slug }) },
    );
    expect(empty.status).toBe(400);
  });

  it("剧情台账支持批量标记伏笔已回收与已废弃", async () => {
    const slug = (await store.createProject({ title: "批量伏笔", targetChapters: 3 })).meta.slug;
    const { normalizeStory } = await import("@/lib/story");
    await store.saveStory(
      slug,
      normalizeStory({
        foreshadows: [
          {
            id: "fs-a",
            text: "测试伏笔甲",
            plantedChapter: 1,
            status: "developing",
            source: "manual",
          },
          {
            id: "fs-b",
            text: "测试伏笔乙",
            plantedChapter: 1,
            status: "pending",
            source: "manual",
          },
          {
            id: "fs-c",
            text: "账房先生的旧账",
            plantedChapter: 1,
            status: "pending",
            source: "manual",
          },
        ],
      }),
    );

    const route = await import("@/app/api/projects/[slug]/story/route");
    const marked = await route.PATCH(
      jsonRequest(`http://localhost/api/projects/${slug}/story`, "PATCH", {
        foreshadows: { ids: ["fs-a", "fs-b"], status: "resolved", resolvedChapter: 3 },
        confirm: true,
      }),
      { params: Promise.resolve({ slug }) },
    );
    expect(marked.status).toBe(200);
    let story = await store.getStory(slug);
    const resolved = story.foreshadows.find((item) => item.id === "fs-a");
    expect(resolved?.status).toBe("resolved");
    expect(resolved?.resolvedChapter).toBe(3);
    expect(story.foreshadows.find((item) => item.id === "fs-b")?.status).toBe("resolved");
    expect(story.foreshadows.find((item) => item.id === "fs-c")?.status).toBe("pending");

    const abandoned = await route.PATCH(
      jsonRequest(`http://localhost/api/projects/${slug}/story`, "PATCH", {
        foreshadows: { ids: ["fs-c"], status: "abandoned" },
        confirm: true,
      }),
      { params: Promise.resolve({ slug }) },
    );
    expect(abandoned.status).toBe(200);
    story = await store.getStory(slug);
    expect(story.foreshadows.find((item) => item.id === "fs-c")?.status).toBe("abandoned");

    // 批量修改同样需要二次确认。
    const noConfirm = await route.PATCH(
      jsonRequest(`http://localhost/api/projects/${slug}/story`, "PATCH", {
        foreshadows: { ids: ["fs-a"], status: "pending" },
      }),
      { params: Promise.resolve({ slug }) },
    );
    expect(noConfirm.status).toBe(400);
  });

  it("恢复章节版本必须二次确认", async () => {
    const slug = (await store.createProject({ title: "版本恢复确认" })).meta.slug;
    await store.savePlan(
      slug,
      {
        logline: "",
        tags: [],
        chapters: [
          { index: 1, title: "第一章", summary: "开场", keyBeats: ["开场"] },
        ],
      },
      "",
      "",
    );
    await store.saveChapter(slug, 1, "第一版正文", "第一章");
    await store.saveChapter(slug, 1, "第二版正文", "第一章");
    const versions = await store.listChapterVersions(slug, 1);
    const target = versions[versions.length - 1].version;
    const route = await import(
      "@/app/api/projects/[slug]/chapters/[index]/versions/[version]/route"
    );

    const without = await route.POST(
      jsonRequest(`http://localhost/api/projects/${slug}/chapters/1/versions/${target}`, "POST", {
        action: "restore",
      }),
      { params: Promise.resolve({ slug, index: "1", version: String(target) }) },
    );
    expect(without.status).toBe(400);

    const withConfirm = await route.POST(
      jsonRequest(`http://localhost/api/projects/${slug}/chapters/1/versions/${target}`, "POST", {
        action: "restore",
        confirm: true,
      }),
      { params: Promise.resolve({ slug, index: "1", version: String(target) }) },
    );
    expect(withConfirm.status).toBe(200);
  });
});

describe("计划台账路由", () => {
  async function projectWithChapters(title: string, count: number): Promise<string> {
    const slug = (await store.createProject({ title })).meta.slug;
    const { emptyPlanLedger } = await import("@/lib/plan-ledger");
    await store.appendChapters(
      slug,
      Array.from({ length: count }, (_, offset) => ({
        index: offset + 1,
        title: `章节${offset + 1}`,
        summary: `第 ${offset + 1} 章梗概`,
        keyBeats: [],
      })),
      emptyPlanLedger(),
    );
    return slug;
  }

  it("可以删除单条计划伏笔", async () => {
    const slug = (await store.createProject({ title: "删计划" })).meta.slug;
    const { normalizePlanLedger } = await import("@/lib/plan-ledger");
    await store.savePlanLedger(
      slug,
      normalizePlanLedger({
        foreshadows: [
          { id: "fs-1", text: "测试伏笔甲", plantChapter: 1, resolveChapter: 2 },
          { id: "fs-2", text: "测试伏笔乙", plantChapter: 1, resolveChapter: 0 },
        ],
      }),
    );
    const route = await import("@/app/api/projects/[slug]/plan-ledger/route");

    const response = await route.PATCH(
      jsonRequest(`http://localhost/api/projects/${slug}/plan-ledger`, "PATCH", {
        remove: { kind: "foreshadow", id: "fs-1" },
      }),
      { params: Promise.resolve({ slug }) },
    );
    expect(response.status).toBe(200);

    const detail = await store.getProjectDetail(slug);
    expect(detail.planLedger?.foreshadows.map((item) => item.id)).toEqual(["fs-2"]);
  });

  it("可以从末尾删除后补的章节大纲", async () => {
    const slug = await projectWithChapters("删后补大纲", 3);
    const route = await import("@/app/api/projects/[slug]/plan-ledger/route");

    const withoutConfirm = await route.DELETE(
      jsonRequest(`http://localhost/api/projects/${slug}/plan-ledger`, "DELETE", {
        fromChapter: 2,
      }),
      { params: Promise.resolve({ slug }) },
    );
    expect(withoutConfirm.status).toBe(400);

    const response = await route.DELETE(
      jsonRequest(`http://localhost/api/projects/${slug}/plan-ledger`, "DELETE", {
        fromChapter: 2,
        confirm: true,
      }),
      { params: Promise.resolve({ slug }) },
    );
    expect(response.status).toBe(200);

    const detail = await store.getProjectDetail(slug);
    expect(detail.plan.chapters.map((chapter) => chapter.index)).toEqual([1]);
  });

  it("已有正文的章节拒绝直接删大纲", async () => {
    const slug = await projectWithChapters("正文保护", 2);
    await store.saveChapter(slug, 2, "第二章正文。", "章节2");
    const route = await import("@/app/api/projects/[slug]/plan-ledger/route");

    const response = await route.DELETE(
      jsonRequest(`http://localhost/api/projects/${slug}/plan-ledger`, "DELETE", {
        fromChapter: 2,
        confirm: true,
      }),
      { params: Promise.resolve({ slug }) },
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("已有正文");

    const detail = await store.getProjectDetail(slug);
    expect(detail.plan.chapters).toHaveLength(2);
  });
});

describe("设置与参数校验路由", () => {
  it("设置响应不泄漏完整 API Key，并禁止缓存", async () => {
    const route = await import("@/app/api/settings/route");
    const key = "sk-test-1234567890";
    const put = await route.PUT(
      jsonRequest("http://localhost/api/settings", "PUT", {
        provider: "openai-compatible",
        baseUrl: "https://example.com/v1",
        model: "test-model",
        apiKey: key,
        temperature: 0.5,
        maxTokens: 4096,
      }),
    );
    expect(put.status).toBe(200);
    const putText = await put.text();
    expect(putText).not.toContain(key);
    expect(putText).toContain("apiKeyPreview");

    const get = await route.GET();
    expect(get.status).toBe(200);
    expect(get.headers.get("cache-control")).toContain("no-store");
    expect(await get.text()).not.toContain(key);
  });

  it("设置接口拒绝非 http(s) 地址", async () => {
    const route = await import("@/app/api/settings/route");
    const response = await route.PUT(
      jsonRequest("http://localhost/api/settings", "PUT", {
        baseUrl: "file:///etc/passwd",
        model: "test",
      }),
    );
    expect(response.status).toBe(400);
  });

  it("未知任务类型、未知提示词 Agent 和未知完整性操作返回 400", async () => {
    const slug = (await store.createProject({ title: "参数校验" })).meta.slug;
    const jobsRoute = await import("@/app/api/projects/[slug]/jobs/route");
    const jobsResponse = await jobsRoute.POST(
      jsonRequest(`http://localhost/api/projects/${slug}/jobs`, "POST", {
        type: "not-a-job",
      }),
      { params: Promise.resolve({ slug }) },
    );
    expect(jobsResponse.status).toBe(400);

    const promptsRoute = await import("@/app/api/prompts/route");
    const promptResponse = await promptsRoute.POST(
      jsonRequest("http://localhost/api/prompts", "POST", {
        agent: "not-an-agent",
        mode: "system",
        instructions: "规则",
      }),
    );
    expect(promptResponse.status).toBe(400);

    const integrityRoute = await import("@/app/api/projects/[slug]/integrity/route");
    const integrityResponse = await integrityRoute.POST(
      jsonRequest(`http://localhost/api/projects/${slug}/integrity`, "POST", {
        action: "unknown",
      }),
      { params: Promise.resolve({ slug }) },
    );
    expect(integrityResponse.status).toBe(400);
  });
});
