import type { StoryLedger } from "./types";
import { nowIso } from "./utils";

export interface ForeshadowVerdictLike {
  id: string;
  verdict: "open" | "resolved" | "abandoned";
  chapter: number;
  evidence: string;
  confidence: "high" | "medium" | "low";
}

export interface ForeshadowVerdictResult {
  ledger: StoryLedger;
  resolvedCount: number;
  abandonedCount: number;
  suspiciousCount: number;
}

// 只有「高置信 + 有具体章节」的结论才直接落库；其余只记“疑似回收”，
// 这样正文明确收掉的伏笔能自动结案，模糊提及仍保留人工复核的机会。
export function applyForeshadowVerdicts(
  ledger: StoryLedger,
  verdicts: ForeshadowVerdictLike[],
  maxChapter: number,
  updatedAt = nowIso(),
): ForeshadowVerdictResult {
  const verdictById = new Map(verdicts.map((item) => [item.id, item]));
  let resolvedCount = 0;
  let abandonedCount = 0;
  let suspiciousCount = 0;
  const foreshadows = ledger.foreshadows.map((item) => {
    const verdict = verdictById.get(item.id);
    if (!verdict) return item;
    const chapter = Math.min(Math.max(verdict.chapter, 1), maxChapter);
    const highConfidence = verdict.confidence === "high";
    if (verdict.verdict === "resolved") {
      if (!highConfidence || verdict.chapter <= 0) {
        if (!item.resolutionCandidate) suspiciousCount += 1;
        return {
          ...item,
          resolutionCandidate: `第 ${verdict.chapter || "?"} 章疑似回收：${
            verdict.evidence || "模型未给出证据"
          }`,
          updatedAt,
        };
      }
      resolvedCount += 1;
      return {
        ...item,
        status: "resolved" as const,
        resolvedChapter: chapter,
        resolution: verdict.evidence || "AI 判定正文已回收",
        source: "ai" as const,
        updatedAt,
      };
    }
    if (verdict.verdict === "abandoned") {
      if (!highConfidence) return item;
      abandonedCount += 1;
      return {
        ...item,
        status: "abandoned" as const,
        resolution: verdict.evidence || "AI 判定该伏笔已被放弃",
        source: "ai" as const,
        updatedAt,
      };
    }
    // open：不改状态。只有模型指出具体章节、且说明是“确实提到/发生”时才记疑似；
    // “未交代/未明确”这类否定说明是未回收的理由，写进候选会误导。
    const negativeEvidence =
      /(未交代|未明确|未见|未说明|未揭示|未点明|未再提及|未回收|尚未|没有交代|无后续|并未)/u.test(
        verdict.evidence,
      );
    if (
      verdict.evidence &&
      !negativeEvidence &&
      verdict.chapter > 0 &&
      verdict.confidence !== "low" &&
      !item.resolutionCandidate
    ) {
      suspiciousCount += 1;
      return {
        ...item,
        resolutionCandidate: `第 ${verdict.chapter} 章疑似提到：${verdict.evidence}`,
        updatedAt,
      };
    }
    return item;
  });

  return {
    ledger: { ...ledger, foreshadows },
    resolvedCount,
    abandonedCount,
    suspiciousCount,
  };
}
