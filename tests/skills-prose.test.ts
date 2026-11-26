import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Character } from "@/lib/types";
import type { LLMClient } from "@/lib/llm";
import type { ProsePolishResult } from "@/lib/skills/types";

let dataDir: string;
let store: typeof import("@/lib/store");
let prose: typeof import("@/lib/skills/prose");
let candidates: typeof import("@/lib/skills/prose-candidates");

const MOCK_CLIENT = { isMock: true } as unknown as LLMClient;

const ORIGINAL = [
  "李明不由得停下脚步，仿佛听见身后的呼吸。他顿时回头，心中暗道不好。",
  "天色非常暗，他缓缓地握紧刀柄，指节发白。",
  "他看见门槛上落着3枚铜钱，铜钱边缘沾着湿泥。",
].join("\n\n");

function character(name: string): Character {
  return {
    name,
    role: "主角",
    gender: "男",
    age: "二十岁",
    appearance: "",
    personality: "",
    background: "",
    goals: "",
    arc: "",
    relationships: "",
    speechStyle: "",
  };
}

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "quillmate-skills-prose-"));
  process.env.QUILLMATE_DATA_DIR = dataDir;
  vi.resetModules();
  store = await import("@/lib/store");
  prose = await import("@/lib/skills/prose");
  candidates = await import("@/lib/skills/prose-candidates");
});

afterEach(async () => {
  vi.resetModules();
  delete process.env.QUILLMATE_DATA_DIR;
  await rm(dataDir, { recursive: true, force: true });
});

async function projectWithChapter(content = ORIGINAL): Promise<string> {
  const slug = (await store.createProject({ title: "润色测试", targetChapters: 2 }))
    .meta.slug;
  await store.savePlan(
    slug,
    {
      logline: "主线",
      tags: ["悬疑"],
      chapters: [
        { index: 1, title: "夜行", summary: "李明夜行", keyBeats: ["发现铜钱"] },
        { index: 2, title: "追踪", summary: "追踪", keyBeats: [] },
      ],
    },
    "# 世界观",
    "# 主线",
  );
  await store.saveCharacters(slug, [character("李明")]);
  await store.saveChapter(slug, 1, content, "夜行");
  return slug;
}

describe("文风优化 Skill", () => {
  it("生成候选稿、差异和修改说明，并保留原文", async () => {
    const slug = await projectWithChapter();
    const result = (await prose.runProseSkill(
      slug,
      { index: 1 },
      { client: MOCK_CLIENT },
    )) as ProsePolishResult;

    expect(result.optimized).not.toBe(result.original);
    expect(result.optimized).toContain("李明");
    expect(result.optimized).toContain("3");
    expect(result.changes.length).toBeGreaterThan(0);
    expect(result.factCheck.unchanged).toBe(true);
    expect(result.diff.some((block) => block.type === "removed")).toBe(true);
    expect(result.diff.some((block) => block.type === "added")).toBe(true);

    const file = path.join(
      candidates.proseCandidatesDir(slug),
      `${result.candidateId}.json`,
    );
    const stored = JSON.parse(await fs.readFile(file, "utf8")) as {
      original: string;
      optimized: string;
      status: string;
    };
    expect(stored.original).toContain("不由得");
    expect(stored.optimized).toContain("李明");
    expect(stored.status).toBe("pending");
  });

  it("接受润色会先保留原文版本，再写入优化稿", async () => {
    const slug = await projectWithChapter();
    const result = await prose.runProseSkill(
      slug,
      { index: 1 },
      { client: MOCK_CLIENT },
    );
    const applied = await prose.applyProseCandidate(
      slug,
      1,
      result.candidateId,
    );

    expect(applied.chapter.content).toBe(result.optimized);
    const detail = await store.getProjectDetail(slug);
    // 章节文件落盘时会补齐结尾换行，比较正文时忽略首尾空白。
    expect(detail.chapters[0].content.trim()).toBe(result.optimized);
    const versions = await store.listChapterVersions(slug, 1);
    expect(versions.some((version) => version.source === "ai-polish")).toBe(true);
    expect(
      versions.some((version) => version.source === "user"),
    ).toBe(true);
  });

  it("正文变化后拒绝应用旧候选，避免覆盖新内容", async () => {
    const slug = await projectWithChapter();
    const result = await prose.runProseSkill(
      slug,
      { index: 1 },
      { client: MOCK_CLIENT },
    );
    await store.saveChapter(slug, 1, `${ORIGINAL}\n\n后来，门外传来脚步。`, "夜行");

    await expect(
      prose.applyProseCandidate(slug, 1, result.candidateId),
    ).rejects.toThrow(/正文在润色后已发生变化/);
  });

  it("优化稿丢失人物名或数字时标记事实问题，必须人工确认才能应用", async () => {
    const slug = await projectWithChapter();
    const fakeClient = {
      isMock: false,
      json: async () => ({
        optimized: ORIGINAL.replace("李明", "他").replace("3枚", "几枚"),
        changes: [
          { type: "wording", excerpt: "李明 / 3枚", reason: "改写代词与数量" },
        ],
        recommendation: "accept",
        warnings: [],
      }),
    } as unknown as LLMClient;

    const result = await prose.runProseSkill(
      slug,
      { index: 1 },
      { client: fakeClient },
    );
    expect(result.factCheck.unchanged).toBe(false);
    expect(result.recommendation).toBe("review");
    expect(result.factCheck.issues.map((issue) => issue.term)).toEqual(
      expect.arrayContaining(["李明", "3"]),
    );

    await expect(
      prose.applyProseCandidate(slug, 1, result.candidateId),
    ).rejects.toThrow(/事实核对问题/);

    const applied = await prose.applyProseCandidate(slug, 1, result.candidateId, {
      confirmFactIssues: true,
    });
    expect(applied.candidate.status).toBe("applied");
  });

  it("拒绝润色不会修改正文", async () => {
    const slug = await projectWithChapter();
    const result = await prose.runProseSkill(
      slug,
      { index: 1 },
      { client: MOCK_CLIENT },
    );
    const rejected = await prose.rejectProseCandidate(slug, result.candidateId);
    expect(rejected.status).toBe("rejected");
    const detail = await store.getProjectDetail(slug);
    expect(detail.chapters[0].content.trim()).toBe(ORIGINAL.trim());
  });

  it("超过单次润色上限时明确报错，不静默截断", async () => {
    const slug = await projectWithChapter("夜".repeat(30_001));
    await expect(
      prose.runProseSkill(slug, { index: 1 }, { client: MOCK_CLIENT }),
    ).rejects.toThrow(/暂不支持一次性润色/);
  });
});
