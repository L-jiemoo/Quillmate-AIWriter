import { describe, expect, it } from "vitest";
import {
  analyzeFormulaicPassage,
  formulaicPassageSuspicion,
} from "@/lib/canon";
import { styleRepairMessages } from "@/lib/prompts";

describe("正文套话检测", () => {
  it("套话密集时判定需要重写", () => {
    const text = [
      "陆闲不由得停住脚步，心中一沉。",
      "他深吸一口气，眉头微皱。",
      "空气仿佛凝固了，他顿时觉得背后发凉。",
      "他攥紧拳头，苦涩一笑。",
    ].join("");
    const report = analyzeFormulaicPassage(text);
    expect(report.shouldRewrite).toBe(true);
    expect(report.hits.some((hit) => hit.term === "不由得")).toBe(true);
    expect(report.perKilo).toBeGreaterThan(1.5);
  });

  it("正常叙述不误报", () => {
    const text = [
      "陆闲把灯芯掐短，屋里暗下来。",
      "他摸到门闩，手指停了一瞬，才把门拉开一条缝。",
      "风灌进来，带着湿土味。",
      "门外没人，台阶上留着一只湿脚印。",
    ].join("");
    const report = analyzeFormulaicPassage(text);
    expect(report.shouldRewrite).toBe(false);
    expect(report.endingCliche).toBe("");
  });

  it("章末总结句单独计入", () => {
    const report = analyzeFormulaicPassage(
      "他把信折好，放进怀里。这一切才刚刚开始。",
    );
    expect(report.endingCliche).not.toBe("");
    expect(report.hits.some((hit) => hit.term === "章末总结句")).toBe(true);
  });

  it("命中时生成的审校线索只记 warning", () => {
    const issues = formulaicPassageSuspicion(
      "他不由得一顿，心中一沉。他深吸一口气，眉头微皱。空气仿佛凝固了，他顿时不敢动。他攥紧拳头，苦涩一笑。",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("warning");
    expect(issues[0].type).toBe("文风套话");
    expect(issues[0].detail).toContain("不由得");
  });

  it("没有命中时不生成线索", () => {
    const issues = formulaicPassageSuspicion("他把门推开，院子里空着。");
    expect(issues).toEqual([]);
  });
});

describe("文风自检重写提示词", () => {
  it("把命中清单交给模型，并要求保持剧情与字数", () => {
    const report = analyzeFormulaicPassage(
      "他不由得一顿，心中一沉。他深吸一口气，眉头微皱。空气仿佛凝固了。",
    );
    const content = styleRepairMessages("原文正文", report)
      .map((message) => message.content)
      .join("\n");
    expect(content).toContain("不由得");
    expect(content).toContain("不得改动剧情");
    expect(content).toContain("10%");
    expect(content).toContain("原文正文");
  });
});
