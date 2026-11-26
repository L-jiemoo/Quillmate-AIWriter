import type { DiffBlock } from "./types";

function units(text: string): { text: string; key: string }[] {
  return text
    .split(/\n+/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .map((line) => ({ text: line, key: line.trim() }));
}

// 按段落做 LCS 差异。章节通常只有几十到几百段，直接 O(n*m) 足够；
// 超大文本退化为“只标出首尾不同”，避免阻塞请求。
export function diffParagraphs(original: string, optimized: string): DiffBlock[] {
  const left = units(original);
  const right = units(optimized);
  if (!left.length && !right.length) return [];
  if (!left.length) {
    return [{ type: "added", text: right.map((item) => item.text).join("\n") }];
  }
  if (!right.length) {
    return [{ type: "removed", text: left.map((item) => item.text).join("\n") }];
  }

  if (left.length * right.length > 250_000) {
    return [
      { type: "removed", text: left.map((item) => item.text).join("\n") },
      { type: "added", text: right.map((item) => item.text).join("\n") },
    ];
  }

  const rows = left.length;
  const cols = right.length;
  const table = Array.from({ length: rows + 1 }, () =>
    new Uint16Array(cols + 1),
  );
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      table[i][j] =
        left[i].key === right[j].key
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const blocks: DiffBlock[] = [];
  const push = (type: DiffBlock["type"], text: string) => {
    if (!text) return;
    const last = blocks[blocks.length - 1];
    if (last && last.type === type) {
      last.text = `${last.text}\n${text}`;
      return;
    }
    blocks.push({ type, text });
  };

  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (left[i].key === right[j].key) {
      push("equal", left[i].text);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      push("removed", left[i].text);
      i += 1;
    } else {
      push("added", right[j].text);
      j += 1;
    }
  }
  while (i < rows) {
    push("removed", left[i].text);
    i += 1;
  }
  while (j < cols) {
    push("added", right[j].text);
    j += 1;
  }
  return blocks;
}
