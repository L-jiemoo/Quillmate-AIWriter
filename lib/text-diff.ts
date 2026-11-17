export type DiffLineType = "same" | "add" | "remove";

export interface DiffLine {
  type: DiffLineType;
  text: string;
}

const MAX_MATRIX_CELLS = 4_000_000;

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n");
}

// 行级差异：章节正文通常只有几十到几百行，直接 LCS 足够；
// 超大文本退化为“整段删除 + 整段新增”，避免阻塞页面。
export function diffLines(before: string, after: string): DiffLine[] {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  const n = beforeLines.length;
  const m = afterLines.length;

  if (n * m > MAX_MATRIX_CELLS) {
    return [
      ...beforeLines.map((text) => ({ type: "remove" as const, text })),
      ...afterLines.map((text) => ({ type: "add" as const, text })),
    ];
  }

  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] =
        beforeLines[i] === afterLines[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (beforeLines[i] === afterLines[j]) {
      result.push({ type: "same", text: beforeLines[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ type: "remove", text: beforeLines[i] });
      i += 1;
    } else {
      result.push({ type: "add", text: afterLines[j] });
      j += 1;
    }
  }
  while (i < n) {
    result.push({ type: "remove", text: beforeLines[i] });
    i += 1;
  }
  while (j < m) {
    result.push({ type: "add", text: afterLines[j] });
    j += 1;
  }
  return result;
}
