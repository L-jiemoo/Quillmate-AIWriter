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
  // accepted 表示“可以写回正式正文”：原问题全部解决、没有新增、匹配无歧义。
  accepted: boolean;
  // improved 只表示“相比上一版有改善”，用于继续迭代，不能当作验收通过。
  improved: boolean;
  // 同一问题存在多个接近匹配时视为歧义，验收时必须保守拒绝。
  ambiguous: boolean;
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

function anchorsOf(issue: ContinuityIssue): Set<string> {
  const text = normalizeIssueText(`${issue.evidence}${issue.detail}`);
  const anchors = new Set([...chapterRefs(text), ...numericTokens(text)]);
  if (issue.sourceChapter) anchors.add(String(issue.sourceChapter));
  return anchors;
}

function anchorsOverlap(left: Set<string>, right: Set<string>): boolean {
  if (!left.size || !right.size) return true;
  for (const anchor of left) {
    if (right.has(anchor)) return true;
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

function entitiesOf(issue: ContinuityIssue, names: string[]): Set<string> {
  const text = normalizeIssueText(`${issue.evidence}${issue.detail}`);
  const result = presentEntities(text, names);
  for (const name of issue.affectedCharacters ?? []) {
    const normalized = normalizeIssueText(name);
    if (normalized.length >= 2) result.add(normalized);
  }
  return result;
}

function issueSimilarity(
  left: ContinuityIssue,
  right: ContinuityIssue,
  names: string[],
): number {
  const leftType = normalizeIssueText(left.type);
  const rightType = normalizeIssueText(right.type);
  if (leftType !== rightType) return 0;

  // 结构化的冲突类别和来源章节优先于文本相似度。
  if (
    left.conflictCategory &&
    right.conflictCategory &&
    left.conflictCategory !== right.conflictCategory
  ) {
    return 0;
  }
  if (
    !anchorsOverlap(anchorsOf(left), anchorsOf(right)) ||
    !entitiesOverlap(entitiesOf(left, names), entitiesOf(right, names))
  ) {
    return 0;
  }
  // 稳定指纹相同才可直接确认；指纹由类型、章节和实体共同生成。
  if (
    left.fingerprint &&
    right.fingerprint &&
    left.fingerprint.trim().toLowerCase() === right.fingerprint.trim().toLowerCase()
  ) {
    return 1;
  }

  const leftText = normalizeIssueText(`${left.evidence}${left.detail}`);
  const rightText = normalizeIssueText(`${right.evidence}${right.detail}`);
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

  // 同一行或同一列存在分数接近的备选时，配对并不唯一：
  // 保守起见标记歧义，验收不得据此判定原问题已解决。
  const AMBIGUITY_MARGIN = 0.05;
  let ambiguous = false;
  for (const pair of pairs) {
    const row = scores[pair.before];
    for (let column = 0; column < row.length; column += 1) {
      if (column !== pair.after && row[column] > 0 && row[column] >= pair.score - AMBIGUITY_MARGIN) {
        ambiguous = true;
        break;
      }
    }
    if (ambiguous) break;
    for (let rowIndex = 0; rowIndex < scores.length; rowIndex += 1) {
      const alternative = scores[rowIndex][pair.after];
      if (rowIndex !== pair.before && alternative > 0 && alternative >= pair.score - AMBIGUITY_MARGIN) {
        ambiguous = true;
        break;
      }
    }
    if (ambiguous) break;
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
      beforeCritical.length > 0 &&
      remaining.length === 0 &&
      added.length === 0 &&
      !ambiguous,
    improved: beforeCritical.length > afterCritical.length && added.length === 0,
    ambiguous,
  };
}
