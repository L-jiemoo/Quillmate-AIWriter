import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dataDir: string;
let store: typeof import("@/lib/store");
let storage: typeof import("@/lib/storage");

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "quillmate-store-"));
  process.env.QUILLMATE_DATA_DIR = dataDir;
  vi.resetModules();
  store = await import("@/lib/store");
  storage = await import("@/lib/storage");
});

afterEach(async () => {
  vi.resetModules();
  delete process.env.QUILLMATE_DATA_DIR;
  await rm(dataDir, { recursive: true, force: true });
});

function projectPath(slug: string): string {
  return path.join(dataDir, "projects", slug);
}

async function createProjectWithPlan(): Promise<string> {
  const detail = await store.createProject({ title: "测试书" });
  const slug = detail.meta.slug;
  await store.savePlan(
    slug,
    {
      logline: "",
      tags: [],
      chapters: [
        {
          index: 1,
          title: "开端",
          summary: "主角出发",
          keyBeats: ["出发"],
        },
      ],
    },
    "# 世界观",
    "# 大纲",
  );
  return slug;
}

describe("store 安全读取", () => {
  it("新项目初始化完整结构", async () => {
    const detail = await store.createProject({ title: "测试书" });
    expect(detail.plan.chapters).toEqual([]);
    expect(detail.state.written).toEqual([]);

    const file = await store.getProjectFile(detail.meta.slug);
    expect(file.meta.title).toBe("测试书");

    const canon = await store.getCanon(detail.meta.slug);
    expect(canon.characters).toEqual([]);
  });

  it("缺失的 canon.json 按空台账处理，不抛错", async () => {
    const detail = await store.createProject({ title: "测试书" });
    const slug = detail.meta.slug;
    await fs.rm(path.join(projectPath(slug), "canon.json"));

    const canon = await store.getCanon(slug);
    expect(canon.characters).toEqual([]);
    expect(canon.lastChapter).toBe(0);
  });

  it("缺失的 state.json 按空状态处理", async () => {
    const detail = await store.createProject({ title: "测试书" });
    const slug = detail.meta.slug;
    await fs.rm(path.join(projectPath(slug), "state.json"));

    const loaded = await store.getProjectDetail(slug);
    expect(loaded.state.written).toEqual([]);
  });

  it("损坏的 state.json 抛错且不会覆盖原文件", async () => {
    const detail = await store.createProject({ title: "测试书" });
    const slug = detail.meta.slug;
    const statePath = path.join(projectPath(slug), "state.json");
    const broken = "{ this is not json";
    await fs.writeFile(statePath, broken, "utf8");

    await expect(store.getProjectDetail(slug)).rejects.toMatchObject({
      name: "StorageError",
      code: "corrupted",
    });
    expect(await fs.readFile(statePath, "utf8")).toBe(broken);
  });

  it("损坏的 plan.json 不会被 appendChapters 用默认大纲覆盖", async () => {
    const detail = await store.createProject({ title: "测试书" });
    const slug = detail.meta.slug;
    const planPath = path.join(projectPath(slug), "plan.json");
    const broken = '{"chapters": [';
    await fs.writeFile(planPath, broken, "utf8");

    await expect(
      store.appendChapters(slug, [
        { index: 2, title: "新增", summary: "新增章节", keyBeats: [] },
      ]),
    ).rejects.toMatchObject({
      name: "StorageError",
      code: "corrupted",
    });
    expect(await fs.readFile(planPath, "utf8")).toBe(broken);
  });

  it("区分项目不存在与 project.json 损坏", async () => {
    await expect(store.getProjectFile("missing-slug")).rejects.toMatchObject({
      name: "StorageError",
      code: "not_found",
    });

    const detail = await store.createProject({ title: "测试书" });
    const slug = detail.meta.slug;
    await fs.writeFile(path.join(projectPath(slug), "project.json"), "broken", "utf8");

    await expect(store.getProjectFile(slug)).rejects.toMatchObject({
      name: "StorageError",
      code: "corrupted",
    });
  });
});

describe("store 原子写入与备份", () => {
  it("saveCanon 覆盖前生成备份，且不残留临时文件", async () => {
    const detail = await store.createProject({ title: "测试书" });
    const slug = detail.meta.slug;
    const canon = await store.getCanon(slug);

    await store.saveCanon(slug, canon);
    canon.rules = ["新的世界规则"];
    await store.saveCanon(slug, canon);

    const backupsDir = path.join(projectPath(slug), "backups");
    const backups = await fs.readdir(backupsDir);
    expect(backups.some((name) => name.startsWith("canon.json.") && name.endsWith(".bak"))).toBe(
      true,
    );

    const allFiles = await fs.readdir(projectPath(slug));
    expect(allFiles.some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("覆盖章节正文前保留上一版", async () => {
    const slug = await createProjectWithPlan();
    await store.saveChapter(slug, 1, "第一版正文");
    await store.saveChapter(slug, 1, "第二版正文");

    const backupsDir = path.join(projectPath(slug), "backups");
    const backups = (await fs.readdir(backupsDir))
      .filter((name) => name.startsWith("chapters__1.md.") && name.endsWith(".bak"))
      .sort();
    expect(backups.length).toBeGreaterThanOrEqual(1);

    const firstVersion = await fs.readFile(path.join(backupsDir, backups[0]), "utf8");
    expect(firstVersion).toContain("第一版正文");
  });
});

describe("项目完整性检查", () => {
  it("正常项目没有 critical 问题", async () => {
    const slug = await createProjectWithPlan();
    await store.saveChapter(slug, 1, "正文");

    const report = await store.checkProjectIntegrity(slug);
    expect(report.ok).toBe(true);
    expect(report.issues.some((issue) => issue.severity === "critical")).toBe(false);
    expect(report.chaptersOnDisk).toEqual([1]);
  });

  it("发现 state 标记已写但正文缺失", async () => {
    const slug = await createProjectWithPlan();
    await store.saveChapter(slug, 1, "正文");
    await fs.rm(path.join(projectPath(slug), "chapters", "1.md"));

    const report = await store.checkProjectIntegrity(slug);
    expect(report.ok).toBe(false);
    expect(report.issues.some((issue) => issue.code === "missing-chapter-file")).toBe(true);
  });

  it("发现大纲之外的孤儿章节文件", async () => {
    const slug = await createProjectWithPlan();
    await store.saveChapter(slug, 1, "正文");
    await fs.writeFile(
      path.join(projectPath(slug), "chapters", "9.md"),
      "大纲之外的内容",
      "utf8",
    );

    const report = await store.checkProjectIntegrity(slug);
    expect(report.issues.some((issue) => issue.code === "orphan-chapter-file")).toBe(true);
  });

  it("核心文件损坏时完整性报告返回 critical 而不是抛错", async () => {
    const detail = await store.createProject({ title: "测试书" });
    const slug = detail.meta.slug;
    await fs.writeFile(path.join(projectPath(slug), "plan.json"), "broken", "utf8");

    const report = await store.checkProjectIntegrity(slug);
    expect(report.ok).toBe(false);
    expect(report.issues[0].code).toBe("storage-corrupted");
  });

  it("发现重复章节号与空标题", async () => {
    const detail = await store.createProject({ title: "测试书" });
    const slug = detail.meta.slug;
    await store.savePlan(
      slug,
      {
        logline: "",
        tags: [],
        chapters: [
          { index: 1, title: "开端", summary: "摘要", keyBeats: [] },
          { index: 1, title: "", summary: "", keyBeats: [] },
        ],
      },
      "# 世界观",
      "# 大纲",
    );

    const report = await store.checkProjectIntegrity(slug);
    expect(report.ok).toBe(false);
    expect(report.issues.some((issue) => issue.code === "duplicate-index")).toBe(true);
  });
});

describe("storage 基础能力", () => {
  it("缺失文件返回 not_found，损坏 JSON 返回 corrupted", async () => {
    const missing = path.join(dataDir, "missing.json");
    await expect(storage.readJsonStrict(missing)).rejects.toMatchObject({
      name: "StorageError",
      code: "not_found",
    });

    const corrupted = path.join(dataDir, "corrupted.json");
    await fs.writeFile(corrupted, "{", "utf8");
    await expect(storage.readJsonStrict(corrupted)).rejects.toMatchObject({
      name: "StorageError",
      code: "corrupted",
    });
  });
});
