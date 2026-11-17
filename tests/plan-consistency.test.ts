import { describe, expect, it } from "vitest";
import type { ProjectMeta, ProjectPlan } from "@/lib/types";
import {
  checkPlanOutlineConsistency,
  ensurePlanOutlineSync,
  extractOutlineChapters,
  missingOutlineChapters,
} from "@/lib/plan-consistency";

const meta: ProjectMeta = {
  slug: "test-book",
  title: "测试书",
  genre: "玄幻",
  tone: "热血",
  idea: "",
  author: "",
  language: "zh-CN",
  targetChapters: 3,
  wordsPerChapter: 3000,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const plan: ProjectPlan = {
  logline: "",
  tags: [],
  chapters: [
    { index: 1, title: "开端", summary: "出发", keyBeats: ["出发"] },
    { index: 2, title: "夜行", summary: "赶路", keyBeats: [] },
    { index: 3, title: "决战", summary: "对决", keyBeats: [] },
  ],
};

describe("主线大纲章节同步", () => {
  it("解析不同写法的章节标题", () => {
    const entries = extractOutlineChapters(`# 大纲

## 补充章节（第 1–2 章）

### 第 1 章 · 开端

### 第2章：夜行
`);
    expect(entries).toEqual([
      { index: 1, title: "开端" },
      { index: 2, title: "夜行" },
    ]);
  });

  it("只追加缺失章节，不重复添加", () => {
    const first = ensurePlanOutlineSync("# 大纲\n", plan.chapters);
    expect(first).toContain("### 第 1 章 · 开端");
    expect(first).toContain("### 第 3 章 · 决战");
    const second = ensurePlanOutlineSync(first, plan.chapters);
    expect(second).toBe(first);
  });

  it("给出缺失、标题不一致和孤儿章节提示", () => {
    const outline = `# 大纲

### 第 1 章 · 开端

### 第 2 章 · 别的标题

### 第 9 章 · 大纲外章节
`;
    expect(missingOutlineChapters(plan, outline).map((item) => item.index)).toEqual([3]);
    const issues = checkPlanOutlineConsistency(plan, outline, meta);
    expect(issues.some((issue) => issue.code === "outline-missing-chapter")).toBe(true);
    expect(issues.some((issue) => issue.code === "outline-title-mismatch")).toBe(true);
    expect(issues.some((issue) => issue.code === "outline-orphan-chapter")).toBe(true);
  });

  it("大纲没有章节列表时提示可自动补全", () => {
    const issues = checkPlanOutlineConsistency(plan, "# 只有分卷结构\n", meta);
    expect(issues.find((issue) => issue.code === "outline-no-chapters")?.severity).toBe(
      "warning",
    );
  });
});
