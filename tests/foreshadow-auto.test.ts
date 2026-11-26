import { describe, expect, it } from "vitest";
import { applyForeshadowVerdicts } from "@/lib/foreshadow-auto";
import { normalizeStory } from "@/lib/story";

const AT = "2026-01-01T00:00:00.000Z";

function story() {
  return normalizeStory({
    foreshadows: [
      { id: "fs-1", text: "测试伏笔甲", plantedChapter: 1, status: "pending" },
      { id: "fs-2", text: "测试伏笔乙", plantedChapter: 1, status: "pending" },
    ],
  });
}

describe("伏笔自动确认", () => {
  it("高置信且章节明确的回收结论直接结案", () => {
    const applied = applyForeshadowVerdicts(
      story(),
      [
        {
          id: "fs-1",
          verdict: "resolved",
          chapter: 3,
          evidence: "正文写明该线索已经回收",
          confidence: "high",
        },
      ],
      5,
      AT,
    );

    const item = applied.ledger.foreshadows.find((entry) => entry.id === "fs-1");
    expect(applied.resolvedCount).toBe(1);
    expect(item?.status).toBe("resolved");
    expect(item?.resolvedChapter).toBe(3);
  });

  it("低置信回收只记疑似，不改状态", () => {
    const applied = applyForeshadowVerdicts(
      story(),
      [
        {
          id: "fs-1",
          verdict: "resolved",
          chapter: 3,
          evidence: "可能已经回收",
          confidence: "medium",
        },
      ],
      5,
      AT,
    );

    const item = applied.ledger.foreshadows.find((entry) => entry.id === "fs-1");
    expect(applied.resolvedCount).toBe(0);
    expect(item?.status).toBe("pending");
    expect(item?.resolutionCandidate).toContain("疑似回收");
  });

  it("高置信废弃直接标废弃", () => {
    const applied = applyForeshadowVerdicts(
      story(),
      [
        {
          id: "fs-2",
          verdict: "abandoned",
          chapter: 0,
          evidence: "该线索已明确放弃",
          confidence: "high",
        },
      ],
      5,
      AT,
    );

    const item = applied.ledger.foreshadows.find((entry) => entry.id === "fs-2");
    expect(applied.abandonedCount).toBe(1);
    expect(item?.status).toBe("abandoned");
  });

  it("否定性证据不会写成疑似回收", () => {
    const applied = applyForeshadowVerdicts(
      story(),
      [
        {
          id: "fs-2",
          verdict: "open",
          chapter: 3,
          evidence: "正文未交代该线索的后续",
          confidence: "medium",
        },
      ],
      5,
      AT,
    );

    const item = applied.ledger.foreshadows.find((entry) => entry.id === "fs-2");
    expect(item?.resolutionCandidate).toBeFalsy();
    expect(applied.suspiciousCount).toBe(0);
  });

  it("越界的回收章节会夹到有效范围", () => {
    const applied = applyForeshadowVerdicts(
      story(),
      [
        {
          id: "fs-1",
          verdict: "resolved",
          chapter: 99,
          evidence: "正文写明已回收",
          confidence: "high",
        },
      ],
      5,
      AT,
    );

    expect(applied.ledger.foreshadows[0].resolvedChapter).toBe(5);
  });
});
