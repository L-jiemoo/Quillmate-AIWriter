import { describe, expect, it } from "vitest";
import {
  deadNameSuspicions,
  emptyCanon,
  mergeCanon,
  normalizeExtractedFacts,
} from "@/lib/canon";
import type { CanonFacts, ExtractedFacts } from "@/lib/types";

function canonWith(characters: CanonFacts["characters"]): CanonFacts {
  return {
    ...emptyCanon(),
    characters,
    lastChapter: 30,
    updatedAt: "2026-11-20T00:00:00.000Z",
  };
}

function extracted(
  characters: ExtractedFacts["characters"],
): ExtractedFacts {
  return {
    summary: "本章摘要",
    characters,
    items: [],
    timeline: { currentDay: "", deadlines: [] },
    rules: [],
  };
}

describe("人物别名可靠性", () => {
  it("通用骂法不会被合并进已死人物，也不会写进别名", () => {
    const canon = canonWith([
      {
        name: "赵四",
        aliases: ["老东西", "老把头"],
        status: "dead",
        location: "",
        note: "",
        statusChapter: 2,
        chapter: 2,
      },
    ]);

    const result = mergeCanon(
      canon,
      extracted([
        {
          name: "柳先生",
          aliases: ["老东西"],
          status: "alive",
          location: "山道",
          note: "",
          evidence: "这老东西，跑是跑了。",
        },
      ]),
      7,
    );

    expect(result.conflicts).toEqual([]);
    const zhaosi = result.canon.characters.find((item) => item.name === "赵四");
    expect(zhaosi?.status).toBe("dead");
    const liu = result.canon.characters.find((item) => item.name === "柳先生");
    expect(liu?.status).toBe("alive");
    expect(liu?.aliases).toEqual([]);
  });

  it("独一无二的别名仍然可以匹配同一人物", () => {
    const canon = canonWith([
      {
        name: "赵四",
        aliases: ["老把头"],
        status: "dead",
        location: "",
        note: "",
        statusChapter: 2,
        chapter: 2,
      },
    ]);

    const result = mergeCanon(
      canon,
      extracted([
        {
          name: "老把头",
          aliases: [],
          status: "dead",
          location: "洞壁名单",
          note: "",
          evidence: "赵四的名字刻在洞壁名单上。",
        },
      ]),
      7,
    );

    expect(result.canon.characters).toHaveLength(1);
    expect(result.canon.characters[0].name).toBe("赵四");
    expect(result.canon.characters[0].location).toBe("洞壁名单");
  });

  it("其他角色的名字不会被当成别名参与合并", () => {
    const canon = canonWith([
      {
        name: "赵小乙",
        aliases: ["小翠"],
        status: "dead",
        location: "",
        note: "",
        statusChapter: 2,
        chapter: 2,
      },
      {
        name: "赵小翠",
        aliases: [],
        status: "unknown",
        location: "",
        note: "",
        statusChapter: 0,
        chapter: 0,
      },
    ]);

    const result = mergeCanon(
      canon,
      extracted([
        {
          name: "赵小翠",
          aliases: [],
          status: "alive",
          location: "寨门",
          note: "",
          evidence: "赵小翠站在寨门口。",
        },
      ]),
      7,
    );

    expect(result.conflicts).toEqual([]);
    expect(result.canon.characters.find((item) => item.name === "赵小乙")?.status).toBe(
      "dead",
    );
    expect(result.canon.characters.find((item) => item.name === "赵小翠")?.status).toBe(
      "alive",
    );
  });

  it("已死人物检查不再把通用称呼误当成名字出现", () => {
    const canon = canonWith([
      {
        name: "赵四",
        aliases: ["老东西"],
        status: "dead",
        location: "",
        note: "",
        statusChapter: 2,
        chapter: 2,
      },
    ]);

    expect(deadNameSuspicions(canon, "这老东西，跑是跑了。", 7)).toEqual([]);
    expect(deadNameSuspicions(canon, "赵四的名字刻在名单上。", 7)).toHaveLength(1);
  });

  it("抽取结果里的通用别名和通用人名会被过滤", () => {
    const facts = normalizeExtractedFacts(
      {
        summary: "摘要",
        characters: [
          {
            name: "柳先生",
            aliases: ["老东西", "爷爷", "柳先生"],
            status: "alive",
            evidence: "行啊柳先生。",
          },
          {
            name: "老东西",
            aliases: [],
            status: "alive",
            evidence: "这老东西。",
          },
        ],
      },
      "回退摘要",
    );

    expect(facts.characters).toHaveLength(1);
    expect(facts.characters[0].name).toBe("柳先生");
    expect(facts.characters[0].aliases).toEqual([]);
  });
});
