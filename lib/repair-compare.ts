import type { Character, ContinuityIssue } from "./types";

export interface SeedIssueFilter {
  active: ContinuityIssue[];
  stale: ContinuityIssue[];
}

export interface IssueComparison {
  beforeCount: number;
  afterCount: number;
  resolved: ContinuityIssue[];
  remaining: ContinuityIssue[];
  added: ContinuityIssue[];
  accepted: boolean;
}

const PUNCTUATION =
  /[\s，。！？；：、“”‘’（）()《》【】〔〕…—\-·,.!?;:'"\\/\[\]{}<>|@#$%^&*+=~`]/gu;
const MIN_EVIDENCE_LENGTH = 6;
const GENERIC_TYPES = new Set(["其他", "剧情因果"]);
const MATCH_THRESHOLD = 0.35;
const GENERIC_MATCH_THRESHOLD = 0.55;

export function normalizeIssueText(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(PUNCTUATION, "");
}

function bigrams(text: string): Set<string> {
  const chars = [...text];
  const result = new Set<string>();
  for (let index = 0; index + 1 < chars.length; index += 1) {
    result.add(`${chars[index]}${chars[index + 1]}`);
  }
  return result;
}

function dice(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) {
    if (right.has(token)) shared += 1;
  }
  return (2 * shared) / (left.size + right.size);
}

function chapterRefs(text: string): Set<string> {
  const result = new Set<string>();
  for (const match of text.matchAll(/第(\d+)章/gu)) result.add(match[1]);
  return result;
}

function numericTokens(text: string): Set<string> {
  const result = new Set<string>();
  for (const match of text.matchAll(/\d+(?:[:：]\d+)?/gu)) result.add(match[0]);
  return result;
}

function anchorOverlap(left: string, right: string): boolean {
  const leftAnchors = new Set([...chapterRefs(left), ...numericTokens(left)]);
  const rightAnchors = new Set([...chapterRefs(right), ...numericTokens(right)]);
  if (!leftAnchors.size || !rightAnchors.size) return true;
  for (const anchor of leftAnchors) {
    if (rightAnchors.has(anchor)) return true;
  }
  return false;
}

function characterNames(characters: Character[]): string[] {
  return characters
    .map((character) => normalizeIssueText(character.name))
    .filter((name) => name.length >= 2);
}

function presentEntities(text: string, names: string[]): Set<string> {
  const result = new Set<string>();
  for (const name of names) {
    if (text.includes(name)) result.add(name);
  }
  return result;
}

function entitiesOverlap(left: Set<string>, right: Set<string>): boolean {
  if (!left.size || !right.size) return true;
  for (const name of left) {
    if (right.has(name)) return true;
  }
  return false;
}

function issueSimilarity(
  left: ContinuityIssue,
  right: ContinuityIssue,
  names: string[],
): number {
  const leftType = normalizeIssueText(left.type);
  const rightType = normalizeIssueText(right.type);
  if (leftType !== rightType) return 0;

  const leftText = normalizeIssueText(`${left.evidence}${left.detail}`);
  const rightText = normalizeIssueText(`${right.evidence}${right.detail}`);

  // 证据相同/互相包含不等于同一问题：先校验冲突章节和关键实体，
  // 否则不同章节、不同人物的问题会被合并，新增严重问题也会被旧问题吸收。
  if (!anchorOverlap(leftText, rightText)) return 0;
  if (!entitiesOverlap(presentEntities(leftText, names), presentEntities(rightText, names))) {
    return 0;
  }

  const leftEvidence = normalizeIssueText(left.evidence);
  const rightEvidence = normalizeIssueText(right.evidence);
  if (
    leftEvidence.length >= MIN_EVIDENCE_LENGTH &&
    rightEvidence.length >= MIN_EVIDENCE_LENGTH &&
    (leftEvidence.includes(rightEvidence) || rightEvidence.includes(leftEvidence))
  ) {
    return 1;
  }

  const evidenceScore = dice(bigrams(leftEvidence), bigrams(rightEvidence));
  const textScore = dice(bigrams(leftText), bigrams(rightText));
  const score = evidenceScore * 0.7 + textScore * 0.3;
  const threshold = GENERIC_TYPES.has(left.type.trim())
    ? GENERIC_MATCH_THRESHOLD
    : MATCH_THRESHOLD;
  if (score < threshold) return 0;
  return score;
}

function issueKey(issue: ContinuityIssue): string {
  return `${issue.severity}|${issue.type}|${issue.evidence}|${issue.detail}`;
}

function uniqueIssues(issues: ContinuityIssue[]): ContinuityIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = issueKey(issue);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function criticalIssues(issues: ContinuityIssue[]): ContinuityIssue[] {
  return uniqueIssues(issues.filter((issue) => issue.severity === "critical"));
}

export function filterSeedIssues(
  issues: ContinuityIssue[],
  chapterText: string,
): SeedIssueFilter {
  const normalizedText = normalizeIssueText(chapterText);
  const active: ContinuityIssue[] = [];
  const stale: ContinuityIssue[] = [];
  for (const issue of uniqueIssues(issues)) {
    const evidence = normalizeIssueText(issue.evidence);
    if (
      evidence.length >= MIN_EVIDENCE_LENGTH &&
      normalizedText.includes(evidence)
    ) {
      active.push(issue);
    } else {
      stale.push(issue);
    }
  }
  return { active, stale };
}

// 最小权完美匹配（Hungarian）。传入方阵成本矩阵，返回每一行匹配到的列。
function minimizeAssignment(cost: number[][]): number[] {
  const size = cost.length;
  const rowPotential = new Array<number>(size + 1).fill(0);
  const columnPotential = new Array<number>(size + 1).fill(0);
  const matchedRow = new Array<number>(size + 1).fill(0);
  const previousColumn = new Array<number>(size + 1).fill(0);
  for (let row = 1; row <= size; row += 1) {
    matchedRow[0] = row;
    let column = 0;
    const minValue = new Array<number>(size + 1).fill(Number.POSITIVE_INFINITY);
    const used = new Array<boolean>(size + 1).fill(false);
    do {
      used[column] = true;
      const currentRow = matchedRow[column];
      let delta = Number.POSITIVE_INFINITY;
      let nextColumn = 0;
      for (let candidate = 1; candidate <= size; candidate += 1) {
        if (used[candidate]) continue;
        const value =
          cost[currentRow - 1][candidate - 1] -
          rowPotential[currentRow] -
          columnPotential[candidate];
        if (value < minValue[candidate]) {
          minValue[candidate] = value;
          previousColumn[candidate] = column;
        }
        if (minValue[candidate] < delta) {
          delta = minValue[candidate];
          nextColumn = candidate;
        }
      }
      for (let candidate = 0; candidate <= size; candidate += 1) {
        if (used[candidate]) {
          rowPotential[matchedRow[candidate]] += delta;
          columnPotential[candidate] -= delta;
        } else {
          minValue[candidate] -= delta;
        }
      }
      column = nextColumn;
    } while (matchedRow[column] !== 0);
    do {
      const next = previousColumn[column];
      matchedRow[column] = matchedRow[next];
      column = next;
    } while (column !== 0);
  }
  const assignment = new Array<number>(size).fill(-1);
  for (let column = 1; column <= size; column += 1) {
    const row = matchedRow[column];
    if (row !== 0) assignment[row - 1] = column - 1;
  }
  return assignment;
}

// 全局最大权重匹配，避免“先匹配最高分”导致后面的问题被迫错配。
// 真实问题之间用负分数作为成本，配不上的行/列走 0 成本占位。
function maximumWeightPairs(scores: number[][]): {
  before: number;
  after: number;
  score: number;
}[] {
  const rows = scores.length;
  const cols = rows ? scores[0].length : 0;
  if (!rows || !cols) return [];
  const size = rows + cols;
  const cost = Array.from({ length: size }, () =>
    new Array<number>(size).fill(0),
  );
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < cols; column += 1) {
      if (scores[row][column] > 0) cost[row][column] = -scores[row][column];
    }
  }
  const assignment = minimizeAssignment(cost);
  const pairs: { before: number; after: number; score: number }[] = [];
  for (let row = 0; row < rows; row += 1) {
    const column = assignment[row];
    if (column >= 0 && column < cols && scores[row][column] > 0) {
      pairs.push({ before: row, after: column, score: scores[row][column] });
    }
  }
  return pairs;
}

export function compareCriticalIssues(
  before: ContinuityIssue[],
  after: ContinuityIssue[],
  characters: Character[] = [],
): IssueComparison {
  const beforeCritical = criticalIssues(before);
  const afterCritical = criticalIssues(after);
  const names = characterNames(characters);
  const scores = beforeCritical.map((left) =>
    afterCritical.map((right) => issueSimilarity(left, right, names)),
  );
  const pairs = maximumWeightPairs(scores);

  const matchedBefore = new Set<number>();
  const matchedAfter = new Set<number>();
  for (const pair of pairs) {
    matchedBefore.add(pair.before);
    matchedAfter.add(pair.after);
  }

  const resolved = beforeCritical.filter((_, index) => !matchedBefore.has(index));
  const remaining = beforeCritical.filter((_, index) => matchedBefore.has(index));
  const added = afterCritical.filter((_, index) => !matchedAfter.has(index));
  return {
    beforeCount: beforeCritical.length,
    afterCount: afterCritical.length,
    resolved,
    remaining,
    added,
    accepted:
      beforeCritical.length > afterCritical.length && added.length === 0,
  };
}
