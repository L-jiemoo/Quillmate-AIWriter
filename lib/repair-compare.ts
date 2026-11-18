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

  const leftEvidence = normalizeIssueText(left.evidence);
  const rightEvidence = normalizeIssueText(right.evidence);
  if (
    leftEvidence.length >= MIN_EVIDENCE_LENGTH &&
    rightEvidence.length >= MIN_EVIDENCE_LENGTH &&
    (leftEvidence.includes(rightEvidence) || rightEvidence.includes(leftEvidence))
  ) {
    return 1;
  }

  const leftText = normalizeIssueText(`${left.evidence}${left.detail}`);
  const rightText = normalizeIssueText(`${right.evidence}${right.detail}`);
  const evidenceScore = dice(bigrams(leftEvidence), bigrams(rightEvidence));
  const textScore = dice(bigrams(leftText), bigrams(rightText));
  const score = evidenceScore * 0.7 + textScore * 0.3;
  const threshold = GENERIC_TYPES.has(left.type.trim())
    ? GENERIC_MATCH_THRESHOLD
    : MATCH_THRESHOLD;
  if (score < threshold) return 0;
  if (!anchorOverlap(leftText, rightText)) return 0;
  if (!entitiesOverlap(presentEntities(leftText, names), presentEntities(rightText, names))) {
    return 0;
  }
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

export function compareCriticalIssues(
  before: ContinuityIssue[],
  after: ContinuityIssue[],
  characters: Character[] = [],
): IssueComparison {
  const beforeCritical = criticalIssues(before);
  const afterCritical = criticalIssues(after);
  const names = characterNames(characters);
  const pairs: { before: number; after: number; score: number }[] = [];
  for (let left = 0; left < beforeCritical.length; left += 1) {
    for (let right = 0; right < afterCritical.length; right += 1) {
      const score = issueSimilarity(
        beforeCritical[left],
        afterCritical[right],
        names,
      );
      if (score > 0) pairs.push({ before: left, after: right, score });
    }
  }
  pairs.sort((left, right) => right.score - left.score);

  const matchedBefore = new Set<number>();
  const matchedAfter = new Set<number>();
  for (const pair of pairs) {
    if (matchedBefore.has(pair.before) || matchedAfter.has(pair.after)) continue;
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
