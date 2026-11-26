import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Character } from "@/lib/types";

let dataDir: string;
let store: typeof import("@/lib/store");
let skillRoute: typeof import("@/app/api/projects/[slug]/skills/route");
let namingRoute: typeof import("@/app/api/projects/[slug]/skills/naming/route");
let designRoute: typeof import("@/app/api/projects/[slug]/skills/design/route");
let proseRoute: typeof import("@/app/api/projects/[slug]/skills/prose/route");
let proseApplyRoute: typeof import("@/app/api/projects/[slug]/skills/prose/apply/route");

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

function request(
  url: string,
  method: string,
  body?: unknown,
): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { "Content-Type": "application/json", Host: "localhost" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "quillmate-skills-api-"));
  process.env.QUILLMATE_DATA_DIR = dataDir;
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(
    path.join(dataDir, "settings.json"),
    JSON.stringify({
      provider: "mock",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
      apiKey: "",
      temperature: 0.8,
      maxTokens: 8192,
      storyContextChars: 4000,
      repairModel: "",
    }),
    "utf8",
  );
  vi.resetModules();
  store = await import("@/lib/store");
  skillRoute = await import("@/app/api/projects/[slug]/skills/route");
  namingRoute = await import("@/app/api/projects/[slug]/skills/naming/route");
  designRoute = await import("@/app/api/projects/[slug]/skills/design/route");
  proseRoute = await import("@/app/api/projects/[slug]/skills/prose/route");
  proseApplyRoute = await import(
    "@/app/api/projects/[slug]/skills/prose/apply/route"
  );
});

afterEach(async () => {
  vi.resetModules();
  delete process.env.QUILLMATE_DATA_DIR;
  await rm(dataDir, { recursive: true, force: true });
});

async function project(): Promise<string> {
  const slug = (await store.createProject({ title: "技能 API", targetChapters: 2 }))
    .meta.slug;
  await store.savePlan(
    slug,
    {
      logline: "主线",
      tags: ["悬疑"],
      chapters: [
        { index: 1, title: "夜行", summary: "李明夜行", keyBeats: [] },
        { index: 2, title: "追踪", summary: "追踪", keyBeats: [] },
      ],
    },
    "# 世界观",
    "# 主线",
  );
  await store.saveCharacters(slug, [character("李明")]);
  await store.saveChapter(
    slug,
    1,
    "李明不由得停下脚步，仿佛听见身后的呼吸。他顿时回头，心中暗道不好。\n\n他看见3枚铜钱。",
    "夜行",
  );
  return slug;
}

describe("Skills API", () => {
  it("返回项目技能配置、清单、人物设定与日志", async () => {
    const slug = await project();
    const response = await skillRoute.GET(
      request(`/api/projects/${slug}/skills`, "GET"),
      { params: Promise.resolve({ slug }) },
    );
    expect(response.status).toBe(200);
    const data = (await response.json()) as {
      config: { enabled: Record<string, boolean> };
      skills: { id: string; available: boolean }[];
      designs: Record<string, unknown>;
      logs: unknown[];
    };
    expect(data.config.enabled["prose-style"]).toBe(true);
    expect(data.skills).toHaveLength(3);
    expect(data.skills.every((item) => item.available)).toBe(true);
    expect(data.logs).toEqual([]);
  });

  it("禁用技能后调用返回明确错误", async () => {
    const slug = await project();
    const patched = await skillRoute.PATCH(
      request(`/api/projects/${slug}/skills`, "PATCH", {
        enabled: { "prose-style": false },
      }),
      { params: Promise.resolve({ slug }) },
    );
    expect(patched.status).toBe(200);

    const response = await proseRoute.POST(
      request(`/api/projects/${slug}/skills/prose`, "POST", { index: 1 }),
      { params: Promise.resolve({ slug }) },
    );
    expect(response.status).toBe(409);
    const data = (await response.json()) as { code?: string; error?: string };
    expect(data.code).toBe("SKILL_DISABLED");
    expect(data.error).toContain("禁用");
  });

  it("命名、塑造、润色与确认写回可以走完整 API 流程", async () => {
    const slug = await project();

    const namingResponse = await namingRoute.POST(
      request(`/api/projects/${slug}/skills/naming`, "POST", {
        task: "generate",
        role: { role: "主角", identity: "捕快" },
      }),
      { params: Promise.resolve({ slug }) },
    );
    expect(namingResponse.status).toBe(200);
    const namingData = (await namingResponse.json()) as {
      candidates: { name: string }[];
      existingNames: string[];
    };
    expect(namingData.candidates).toHaveLength(5);
    expect(namingData.existingNames).toContain("李明");

    const designResponse = await designRoute.POST(
      request(`/api/projects/${slug}/skills/design`, "POST", {
        characterName: "李明",
        mode: "design",
      }),
      { params: Promise.resolve({ slug }) },
    );
    expect(designResponse.status).toBe(200);
    const designData = (await designResponse.json()) as {
      design: Record<string, string>;
    };
    expect(Object.keys(designData.design)).toHaveLength(10);

    const proseResponse = await proseRoute.POST(
      request(`/api/projects/${slug}/skills/prose`, "POST", { index: 1 }),
      { params: Promise.resolve({ slug }) },
    );
    expect(proseResponse.status).toBe(200);
    const proseData = (await proseResponse.json()) as {
      candidateId: string;
      optimized: string;
    };
    expect(proseData.optimized).toContain("李明");

    const noConfirm = await proseApplyRoute.POST(
      request(`/api/projects/${slug}/skills/prose/apply`, "POST", {
        index: 1,
        candidateId: proseData.candidateId,
      }),
      { params: Promise.resolve({ slug }) },
    );
    expect(noConfirm.status).toBe(400);

    const applied = await proseApplyRoute.POST(
      request(`/api/projects/${slug}/skills/prose/apply`, "POST", {
        index: 1,
        candidateId: proseData.candidateId,
        confirm: true,
      }),
      { params: Promise.resolve({ slug }) },
    );
    expect(applied.status).toBe(200);
    const detail = await store.getProjectDetail(slug);
    // 章节文件落盘时会补齐结尾换行，这里只比较正文内容本身。
    expect(detail.chapters[0].content.replace(/\s+/gu, "")).toBe(
      proseData.optimized.replace(/\s+/gu, ""),
    );

    const logs = await (await skillRoute.GET(
      request(`/api/projects/${slug}/skills`, "GET"),
      { params: Promise.resolve({ slug }) },
    )).json() as { logs: { skillId: string; status: string }[] };
    expect(logs.logs.map((item) => item.skillId)).toEqual(
      expect.arrayContaining(["character-naming", "character-design", "prose-style"]),
    );
    expect(logs.logs.every((item) => item.status === "success")).toBe(true);
  });

  it("多章可以分别润色，确认一章不会影响其他章", async () => {
    const slug = await project();
    await store.saveChapter(
      slug,
      2,
      "李明追踪线索，仿佛听见身后的脚步。",
      "追踪",
    );
    const beforeFirst = (await store.getProjectDetail(slug)).chapters[0].content;

    const first = await proseRoute.POST(
      request(`/api/projects/${slug}/skills/prose`, "POST", { index: 1 }),
      { params: Promise.resolve({ slug }) },
    );
    const second = await proseRoute.POST(
      request(`/api/projects/${slug}/skills/prose`, "POST", { index: 2 }),
      { params: Promise.resolve({ slug }) },
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstData = (await first.json()) as {
      candidateId: string;
      optimized: string;
    };
    const secondData = (await second.json()) as {
      candidateId: string;
      optimized: string;
    };
    // 每章各自生成候选，批量润色时不能互相覆盖。
    expect(firstData.candidateId).not.toBe(secondData.candidateId);

    const applied = await proseApplyRoute.POST(
      request(`/api/projects/${slug}/skills/prose/apply`, "POST", {
        index: 2,
        candidateId: secondData.candidateId,
        confirm: true,
      }),
      { params: Promise.resolve({ slug }) },
    );
    expect(applied.status).toBe(200);

    const detail = await store.getProjectDetail(slug);
    expect(detail.chapters[1].content.replace(/\s+/gu, "")).toBe(
      secondData.optimized.replace(/\s+/gu, ""),
    );
    expect(detail.chapters[0].content).toBe(beforeFirst);
  });
});
