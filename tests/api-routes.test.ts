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
      { params: { slug } },
    );
    expect(without.status).toBe(400);
    await expect(store.getProjectDetail(slug)).resolves.toBeTruthy();

    const withConfirm = await route.DELETE(
      jsonRequest(`http://localhost/api/projects/${slug}`, "DELETE", {
        confirmSlug: slug,
      }),
      { params: { slug } },
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
      { params: { slug } },
    );
    expect(response.status).toBe(403);
    await expect(store.getProjectDetail(slug)).resolves.toBeTruthy();
  });

  it("清空发布日志必须携带固定确认令牌", async () => {
    const slug = (await store.createProject({ title: "清空日志确认" })).meta.slug;
    const route = await import("@/app/api/projects/[slug]/publish/route");

    const without = await route.DELETE(
      jsonRequest(`http://localhost/api/projects/${slug}/publish`, "DELETE"),
      { params: { slug } },
    );
    expect(without.status).toBe(400);

    const withConfirm = await route.DELETE(
      jsonRequest(`http://localhost/api/projects/${slug}/publish`, "DELETE", {
        confirm: "clear-publish-history",
      }),
      { params: { slug } },
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
      { params: { slug } },
    );
    expect(without.status).toBe(400);
    expect(startJobMock).not.toHaveBeenCalled();

    const withConfirm = await route.POST(
      jsonRequest(`http://localhost/api/projects/${slug}/jobs`, "POST", {
        type: "fanqie-publish",
        confirmPublish: true,
      }),
      { params: { slug } },
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
      { params: { slug } },
    );
    expect(without.status).toBe(400);
    expect(startJobMock).not.toHaveBeenCalled();

    const withDraft = await route.POST(
      jsonRequest(`http://localhost/api/projects/${slug}/jobs`, "POST", {
        type: "repair",
        source: "draft",
        indices: [2],
      }),
      { params: { slug } },
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
      { params: { slug } },
    );
    expect(without.status).toBe(400);
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
      { params: { slug, index: "1", version: String(target) } },
    );
    expect(without.status).toBe(400);

    const withConfirm = await route.POST(
      jsonRequest(`http://localhost/api/projects/${slug}/chapters/1/versions/${target}`, "POST", {
        action: "restore",
        confirm: true,
      }),
      { params: { slug, index: "1", version: String(target) } },
    );
    expect(withConfirm.status).toBe(200);
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
      { params: { slug } },
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
      { params: { slug } },
    );
    expect(integrityResponse.status).toBe(400);
  });
});
