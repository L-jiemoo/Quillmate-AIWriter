import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  confirmRepairDecision,
  createRepairDecision,
  getPendingRepairDecision,
  getRepairDecision,
} from "@/lib/repair-decision";

let dataDir: string;
let store: typeof import("@/lib/store");

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "quillmate-decision-"));
  process.env.QUILLMATE_DATA_DIR = dataDir;
  vi.resetModules();
  store = await import("@/lib/store");
});

afterEach(async () => {
  vi.resetModules();
  delete process.env.QUILLMATE_DATA_DIR;
  await rm(dataDir, { recursive: true, force: true });
});

async function makeSlug(): Promise<string> {
  return (await store.createProject({ title: "决策测试" })).meta.slug;
}

function input(slug: string) {
  return {
    slug,
    chapterIndex: 5,
    source: "draft" as const,
    params: { indices: [5], source: "draft" as const },
    jobId: "job-1",
    reason: "电话真相存在互斥路径",
    issues: [
      {
        severity: "critical" as const,
        type: "时间线",
        evidence: "陈玉华上午已被带到阴巷。",
        detail: "与第 4 章下午电话冲突。",
      },
    ],
    options: [
      {
        label: "A 保留第 4 章电话",
        description: "修改第 5 章时间线",
        affectedChapters: [5],
        anchors: ["陈玉华在省城超市收银台旁接电话。"],
      },
      {
        label: "B 保留第 5 章时间线",
        description: "把第 4 章电话改为录音",
        affectedChapters: [4, 5],
        anchors: ["陈玉华在省城超市收银台旁接电话。"],
      },
    ],
  };
}

describe("修复决策持久化", () => {
  it("创建后成为待确认决策，确认后不再出现在待确认列表", async () => {
    const slug = await makeSlug();
    const decision = await createRepairDecision(input(slug));
    expect(decision.id).toBeTruthy();
    expect(decision.options).toHaveLength(2);

    const pending = await getPendingRepairDecision(slug);
    expect(pending?.id).toBe(decision.id);

    const confirmed = await confirmRepairDecision(slug, decision.id, 1);
    expect(confirmed.chosenIndex).toBe(1);
    expect(await getPendingRepairDecision(slug)).toBeUndefined();

    const loaded = await getRepairDecision(slug, decision.id);
    expect(loaded?.chosenIndex).toBe(1);
    expect(loaded?.params.source).toBe("draft");
  });

  it("非法选项、重复确认和不存在的决策都会被拒绝", async () => {
    const slug = await makeSlug();
    const decision = await createRepairDecision(input(slug));
    await expect(confirmRepairDecision(slug, decision.id, 5)).rejects.toThrow(
      "选择的修复方案不存在",
    );
    await confirmRepairDecision(slug, decision.id, 0);
    await expect(confirmRepairDecision(slug, decision.id, 1)).rejects.toThrow(
      "已经确认过",
    );
    await expect(confirmRepairDecision(slug, "missing", 0)).rejects.toThrow(
      "不存在",
    );
  });

  it("同一章只保留最新一份待确认决策，已确认记录不会被覆盖", async () => {
    const slug = await makeSlug();
    const first = await createRepairDecision(input(slug));
    const second = await createRepairDecision(input(slug));
    const pending = await getPendingRepairDecision(slug);
    expect(pending?.id).toBe(second.id);
    expect(await getRepairDecision(slug, first.id)).toBeUndefined();

    await confirmRepairDecision(slug, second.id, 0);
    const third = await createRepairDecision(input(slug));
    expect((await getPendingRepairDecision(slug))?.id).toBe(third.id);
    // 已确认的历史记录保留，便于追踪作者当时的选择。
    expect((await getRepairDecision(slug, second.id))?.chosenIndex).toBe(0);
  });
});
