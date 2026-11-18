import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  apiError,
  assertSameOrigin,
  readJsonBody,
  redactSecrets,
} from "@/lib/api";
import { StorageError } from "@/lib/storage";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "quillmate-api-security-"));
  process.env.QUILLMATE_DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(async () => {
  try {
    const { closeDatabase } = await import("@/lib/db/connection");
    closeDatabase();
  } catch {
    // 文件模式没有打开数据库，忽略。
  }
  vi.resetModules();
  delete process.env.QUILLMATE_DATA_DIR;
  delete process.env.QUILLMATE_STORAGE;
  await rm(dataDir, { recursive: true, force: true });
});

describe("API 安全基础能力", () => {
  it("拒绝跨站写请求，但放行同源和无 Origin 的本地请求", () => {
    const crossSite = new Request("http://localhost:3000/api/projects", {
      method: "POST",
      headers: { origin: "https://evil.example", host: "localhost:3000" },
    });
    expect(() => assertSameOrigin(crossSite)).toThrow(ApiError);

    const sameSite = new Request("http://localhost:3000/api/projects", {
      method: "POST",
      headers: { origin: "http://localhost:3000", host: "localhost:3000" },
    });
    expect(() => assertSameOrigin(sameSite)).not.toThrow();

    const localTool = new Request("http://localhost:3000/api/projects", {
      method: "POST",
      headers: { host: "localhost:3000" },
    });
    expect(() => assertSameOrigin(localTool)).not.toThrow();
  });

  it("拒绝非法 JSON 和非对象请求体", async () => {
    const malformed = new Request("http://localhost/api", {
      method: "POST",
      body: "{bad json",
    });
    await expect(readJsonBody(malformed)).rejects.toMatchObject({ status: 400 });

    const arrayBody = new Request("http://localhost/api", {
      method: "POST",
      body: "[]",
    });
    await expect(readJsonBody(arrayBody)).rejects.toMatchObject({ status: 400 });
  });

  it("脱敏 API Key、Bearer 和绝对路径", () => {
    const text = redactSecrets(
      "failed sk-abcdef123456 at C:\\Users\\me\\data\\settings.json, /home/me/private and Authorization: Bearer abc.def.ghi api_key=super-secret",
    );
    expect(text).not.toContain("sk-abcdef123456");
    expect(text).not.toContain("C:\\Users\\me");
    expect(text).not.toContain("/home/me/private");
    expect(text).not.toContain("abc.def.ghi");
    expect(text).not.toContain("super-secret");
    expect(text).toContain("[密钥已脱敏]");
  });

  it("StorageError 不把本地路径返回给前端", async () => {
    const message = "文件不存在：C:\\Users\\me\\data\\projects\\secret\\project.json";
    const response = apiError(
      new StorageError("not_found", "C:\\Users\\me\\data\\secret", message),
    );
    expect(response.status).toBe(404);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toBe("项目或文件不存在");
    expect(JSON.stringify(payload)).not.toContain("C:\\Users");
  });
});

describe("项目与任务路径穿越防护", () => {
  it("非法 slug 不会读取项目目录外的文件", async () => {
    const outside = path.join(dataDir, "secret");
    await mkdir(outside, { recursive: true });
    await writeFile(
      path.join(outside, "project.json"),
      JSON.stringify({ secret: "must-not-be-read" }),
      "utf8",
    );

    const store = await import("@/lib/store");
    await expect(store.getProjectDetail("../secret")).rejects.toThrow("slug 不合法");
    await expect(store.saveChapter("../secret", 1, "正文")).rejects.toThrow(
      "slug 不合法",
    );
  });

  it("非法任务 ID 不会拼接任务文件路径", async () => {
    const jobs = await import("@/lib/jobs");
    expect(jobs.getJob("../../settings")).toBeUndefined();
    expect(jobs.getJob("..\\..\\settings")).toBeUndefined();
    expect(() => jobs.acquireProjectSlot("../secret", "plan")).toThrow("slug 不合法");
  });

  it("SQLite 版本记录的文件路径不能跳出项目目录", async () => {
    process.env.QUILLMATE_STORAGE = "sqlite";
    vi.resetModules();
    const store = await import("@/lib/store");
    const slug = (await store.createProject({ title: "SQLite 路径校验" })).meta.slug;
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
    await store.saveChapter(slug, 1, "正文", "第一章");
    const versions = await store.listChapterVersions(slug, 1);
    const version = versions[0].version;

    const { getDatabase } = await import("@/lib/db/connection");
    getDatabase()
      .prepare(
        "UPDATE chapter_versions SET content_path = ? WHERE slug = ? AND chapter_index = ? AND version = ?",
      )
      .run("../../settings.json", slug, 1, version);

    await expect(store.getChapterVersion(slug, 1, version)).rejects.toThrow(
      "项目文件路径不合法",
    );
  });

  it("项目路由对非法 slug 返回 400，且不泄漏目录内容", async () => {
    const route = await import("@/app/api/projects/[slug]/route");
    const response = await route.GET(
      new Request("http://localhost/api/projects/..%2Fsecret"),
      { params: Promise.resolve({ slug: "../secret" }) },
    );
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).not.toContain("must-not-be-read");
    expect(text).toContain("项目标识不合法");
  });
});
