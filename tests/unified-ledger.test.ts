import { describe, expect, it } from "vitest";
import { emptyCanon } from "@/lib/canon";
import { buildUnifiedLedger } from "@/lib/unified-ledger";
import type { StoryLedger } from "@/lib/types";

function storyWithState(
  name: string,
  lifeStatus: "alive" | "dead",
  chapter: number,
): StoryLedger {
  return {
    version: 1,
    states: [
      {
        id: `state-${chapter}`,
        name,
        chapter,
        identity: "",
        age: "",
        location: "",
        bodyState: "",
        lifeStatus,
        abilities: [],
        goals: [],
        knowledge: [],
        faction: "",
        experience: "",
        eventIds: [],
        source: "ai",
        updatedAt: "",
      },
    ],
    relations: [],
    events: [],
    foreshadows: [],
    suppressedIds: [],
    updatedAt: "",
  };
}

describe("统一台账", () => {
  it("事实台账排在剧情台账之前，冲突按事实台账优先", () => {
    const canon = emptyCanon();
    canon.characters.push({
      name: "角色乙",
      aliases: [],
      status: "dead",
      location: "",
      note: "",
      statusChapter: 3,
      chapter: 3,
    });
    const story = storyWithState("角色乙", "alive", 5);

    const { text, conflicts } = buildUnifiedLedger(
      canon,
      "第 5 章：角色乙还在行动。",
      story,
      6,
    );

    expect(text.indexOf("事实台账")).toBeLessThan(text.indexOf("剧情台账"));
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].type).toBe("台账冲突");
    expect(conflicts[0].severity).toBe("warning");
  });

  it("两套台账一致时不产生冲突", () => {
    const canon = emptyCanon();
    canon.characters.push({
      name: "角色乙",
      aliases: [],
      status: "alive",
      location: "",
      note: "",
      statusChapter: 3,
      chapter: 3,
    });
    const story = storyWithState("角色乙", "alive", 5);

    expect(buildUnifiedLedger(canon, "剧情", story, 6).conflicts).toEqual([]);
  });
});
