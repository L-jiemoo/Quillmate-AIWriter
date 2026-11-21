import { describe, expect, it } from "vitest";
import { emptyCanon, mergeChapterExtractions } from "@/lib/canon";
import type { ExtractedFacts, FactCharacter, FactItem } from "@/lib/types";

function character(name: string, location: string, chapter: number): FactCharacter {
  return {
    name,
    aliases: [],
    status: "alive",
    location,
    note: "",
    evidence: `第${chapter}章：${name}在${location}。`,
  };
}

function item(name: string, holder: string, chapter: number): FactItem {
  return {
    name,
    aliases: [],
    holder,
    state: "完整",
    note: "",
    evidence: `第${chapter}章：${name}交给${holder}。`,
  };
}

function facts(characters: FactCharacter[], items: FactItem[] = []): ExtractedFacts {
  return { summary: "", characters, items, timeline: null, rules: [] };
}

describe("跨章修复后的台账合并", () => {
  it("按章节顺序合并，目标章和跨章章节的新事实都不会丢失", () => {
    const merged = mergeChapterExtractions(emptyCanon(), [
      {
        index: 21,
        extracted: facts([character("角色丙", "城内", 21)], [item("旧令牌", "角色丙", 21)]),
      },
      {
        index: 20,
        extracted: facts([character("角色乙", "外地", 20)], [item("旧令牌", "角色乙", 20)]),
      },
    ]);

    expect(merged.characters.map((entry) => entry.name).sort()).toEqual([
      "角色丙",
      "角色乙",
    ]);
    expect(merged.items.find((entry) => entry.name === "旧令牌")?.holder).toBe(
      "角色丙",
    );
  });
});
