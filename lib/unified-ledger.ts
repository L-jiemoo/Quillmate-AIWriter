import { formatCanonForPrompt } from "./canon";
import type { CanonFacts, ContinuityIssue, StoryLedger } from "./types";

function key(value: string): string {
  return value.trim().toLowerCase();
}

function latestState(
  story: StoryLedger,
  name: string,
  chapterIndex: number,
): StoryLedger["states"][number] | undefined {
  const target = key(name);
  return story.states
    .filter(
      (state) =>
        key(state.name) === target && state.chapter <= chapterIndex,
    )
    .sort((left, right) => right.chapter - left.chapter)[0];
}

// 事实台账与剧情台账冲突时，事实台账优先；剧情台账只作为补充，
// 并把冲突统一归为“台账冲突”，避免审校同时拿到两套互相打架的说法。
export function buildUnifiedLedger(
  canon: CanonFacts,
  storyContext: string,
  story: StoryLedger | undefined,
  chapterIndex: number,
): { text: string; conflicts: ContinuityIssue[] } {
  const conflicts: ContinuityIssue[] = [];
  if (story) {
    for (const character of canon.characters) {
      if (character.status !== "dead" && character.status !== "alive") continue;
      const state = latestState(story, character.name, chapterIndex);
      if (
        !state ||
        (state.lifeStatus !== "dead" && state.lifeStatus !== "alive") ||
        state.lifeStatus === character.status
      ) {
        continue;
      }
      conflicts.push({
        severity: "warning",
        type: "台账冲突",
        evidence: `事实台账：${character.name} ${character.status}（第 ${character.statusChapter} 章）；剧情台账：${state.lifeStatus}（第 ${state.chapter} 章）`,
        detail:
          "事实台账与剧情台账对同一人物的生死状态说法不一致。以事实台账为准；剧情台账需要按当前正文重新抽取，不能再用旧记录要求改稿。",
        affectedCharacters: [character.name],
        conflictCategory: "character-status",
      });
    }
  }

  const text = [
    "【事实台账（硬约束；与其他台账冲突时以此为准）】",
    formatCanonForPrompt(canon, { includeChapters: true }),
    "",
    "【剧情台账（事件/状态/关系/伏笔补充；只能辅助，不得否定事实台账）】",
    storyContext || "（未检索到剧情台账）",
  ].join("\n");

  return { text, conflicts };
}
