import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dataDir: string;
let store: typeof import("@/lib/store");

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "quillmate-plan-store-"));
  process.env.QUILLMATE_DATA_DIR = dataDir;
  vi.resetModules();
  store = await import("@/lib/store");
});

afterEach(async () => {
  vi.resetModules();
  delete process.env.QUILLMATE_DATA_DIR;
  await rm(dataDir, { recursive: true, force: true });
});

function projectPath(slug: string): string {
  return path.join(dataDir, "projects", slug);
}

async function projectWithPlan(count: number): Promise<string> {
  const slug = (await store.createProject({ title: "大纲测试" })).meta.slug;
  await store.savePlan(
    slug,
    {
      logline: "",
      tags: [],
      chapters: Array.from({ length: count }, (_, i) => ({
        index: i + 1,
        title: `第 ${i + 1} 章标题`,
        summary: `第 ${i + 1} 章摘要`,
        keyBeats: [],
      })),
    },
    "# 世界观",
    "# 主线大纲",
  );
  return slug;
}

describe("大纲保存与编号校验", () => {
  it("savePlan 拒绝断号且不写任何文件", async () => {
    const slug = (await store.createProject({ title: "断号" })).meta.slug;
    const planPath = path.join(projectPath(slug), "plan.json");
    const worldPath = path.join(projectPath(slug), "world.md");
    const beforePlan = await fs.readFile(planPath, "utf8");
    const beforeWorld = await fs.readFile(worldPath, "utf8");

    await expect(
      store.savePlan(
        slug,
        {
          logline: "",
          tags: [],
          chapters: [
            { index: 1, title: "开端", summary: "摘要", keyBeats: [] },
            { index: 3, title: "跳号", summary: "摘要", keyBeats: [] },
          ],
        },
        "# 新世界观",
        "# 新大纲",
      ),
    ).rejects.toThrow("章节序号不连续");

    expect(await fs.readFile(planPath, "utf8")).toBe(beforePlan);
    expect(await fs.readFile(worldPath, "utf8")).toBe(beforeWorld);
  });

  it("appendChapters 拒绝重复序号并保留原大纲", async () => {
    const slug = await projectWithPlan(1);
    const planPath = path.join(projectPath(slug), "plan.json");
    const before = await fs.readFile(planPath, "utf8");

    await expect(
      store.appendChapters(slug, [
        { index: 2, title: "新增", summary: "摘要", keyBeats: [] },
        { index: 2, title: "重复", summary: "摘要", keyBeats: [] },
      ]),
    ).rejects.toThrow("章节序号重复");

    expect(await fs.readFile(planPath, "utf8")).toBe(before);
  });

  it("目标章节数不能低于现有大纲章节数", async () => {
    const slug = await projectWithPlan(2);
    await expect(
      store.updateProject(slug, { meta: { targetChapters: 1 } }),
    ).rejects.toThrow("不能小于现有大纲章节数");

    const meta = await store.updateProject(slug, { meta: { targetChapters: 2 } });
    expect(meta.targetChapters).toBe(2);
  });
});

describe("大纲与主线同步修复", () => {
  it("完整性检查发现缺失章节，自动修复只补缺失内容", async () => {
    const slug = await projectWithPlan(2);
    // 模拟旧项目：主线大纲只有高层结构，没有章节列表。
    const outlinePath = path.join(projectPath(slug), "outline.md");
    await fs.writeFile(outlinePath, "# 全书主线大纲\n\n## 分卷结构\n", "utf8");

    const before = await store.checkProjectIntegrity(slug);
    expect(
      before.issues.some((issue) => issue.code === "outline-no-chapters"),
    ).toBe(true);

    const fixed = await store.fixPlanOutlineConsistency(slug);
    expect(fixed.fixedChapters).toEqual([1, 2]);
    const outline = await fs.readFile(outlinePath, "utf8");
    expect(outline).toContain("## 分卷结构");
    expect(outline).toContain("### 第 1 章 · 第 1 章标题");
    expect(outline).toContain("### 第 2 章 · 第 2 章标题");

    const second = await store.fixPlanOutlineConsistency(slug);
    expect(second.fixedChapters).toEqual([]);
    expect(await fs.readFile(outlinePath, "utf8")).toBe(outline);
  });
});
