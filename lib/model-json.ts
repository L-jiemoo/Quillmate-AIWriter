import { errorMessage } from "./utils";

export class ModelJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelJsonError";
  }
}

function stripFence(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fence ? fence[1].trim() : text;
}

function candidates(raw: string): string[] {
  const trimmed = raw.replace(/^﻿/, "").trim();
  if (!trimmed) return [];
  const fenced = stripFence(trimmed);
  const values = [fenced, trimmed];
  for (const text of [fenced, trimmed]) {
    const objectStart = text.indexOf("{");
    const objectEnd = text.lastIndexOf("}");
    if (objectStart >= 0 && objectEnd > objectStart) {
      values.push(text.slice(objectStart, objectEnd + 1));
    }
  }
  return [...new Set(values.filter(Boolean))];
}

// 只删除字符串外的尾随逗号，避免改动正文里的逗号。
function removeTrailingCommas(text: string): string {
  const out: string[] = [];
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      out.push(char);
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out.push(char);
      continue;
    }
    if (char === ",") {
      let next = index + 1;
      while (next < text.length && /\s/.test(text[next])) next += 1;
      if (text[next] === "}" || text[next] === "]") continue;
    }
    out.push(char);
  }
  return out.join("");
}

type Token = "value" | "close" | "colon" | "comma" | "open" | null;

const DELIMITERS = new Set(["{", "}", "[", "]", ":", ",", '"']);

function isDelimiter(char: string): boolean {
  return /\s/.test(char) || DELIMITERS.has(char);
}

function isValueStart(char: string): boolean {
  return char === '"' || char === "{" || char === "[" || /[0-9tfn-]/.test(char);
}

function isValueEnd(token: Token): boolean {
  return token === "value" || token === "close";
}

// 模型最常见的错误是数组元素/对象属性之间漏逗号。这里在外面补逗号，
// 字符串内部完全跳过；无法修复的结构仍会交给调用方重试或报错。
function insertMissingCommas(text: string): string {
  const out: string[] = [];
  let depth = 0;
  let previous: Token = null;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      out.push(char);
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
        previous = "value";
      }
      continue;
    }

    if (char === '"') {
      if (depth > 0 && isValueEnd(previous)) out.push(",");
      inString = true;
      out.push(char);
      continue;
    }

    if (char === "{" || char === "[") {
      if (depth > 0 && isValueEnd(previous)) out.push(",");
      out.push(char);
      depth += 1;
      previous = "open";
      continue;
    }

    if (char === "}" || char === "]") {
      out.push(char);
      depth = Math.max(0, depth - 1);
      previous = "close";
      continue;
    }

    if (char === ":") {
      out.push(char);
      previous = "colon";
      continue;
    }

    if (char === ",") {
      out.push(char);
      previous = "comma";
      continue;
    }

    if (/\s/.test(char)) {
      out.push(char);
      continue;
    }

    if (/[0-9tfn-]/.test(char)) {
      if (depth > 0 && isValueEnd(previous)) out.push(",");
      let end = index;
      while (end < text.length && !isDelimiter(text[end])) end += 1;
      out.push(text.slice(index, end));
      previous = "value";
      index = end - 1;
      continue;
    }

    // 其他字符保持原样，让 JSON.parse 给出真正的错误位置。
    if (depth > 0 && isValueEnd(previous) && isValueStart(char)) out.push(",");
    out.push(char);
    previous = null;
  }

  return out.join("");
}

function repair(text: string): string {
  return insertMissingCommas(removeTrailingCommas(text));
}

function syntaxLocation(
  text: string,
  error: unknown,
): { line: number; column: number } | null {
  const message = errorMessage(error);
  const lineColumn = /line (\d+) column (\d+)/i.exec(message);
  if (lineColumn) {
    return { line: Number(lineColumn[1]), column: Number(lineColumn[2]) };
  }
  const positionMatch = /at position (\d+)/i.exec(message);
  if (!positionMatch) return null;
  const position = Number(positionMatch[1]);
  const before = text.slice(0, position);
  const line = before.split("\n").length;
  const column = position - before.lastIndexOf("\n");
  return { line, column };
}

export function extractJson<T>(raw: string): T {
  let lastError: unknown = null;
  let lastText = "";

  for (const candidate of candidates(raw)) {
    for (const text of new Set([candidate, repair(candidate)])) {
      if (!text) continue;
      lastText = text;
      try {
        return JSON.parse(text) as T;
      } catch (error) {
        lastError = error;
      }
    }
  }

  if (!lastError) {
    throw new ModelJsonError("模型没有返回可解析的 JSON 内容。");
  }

  const location = syntaxLocation(lastText, lastError);
  const where = location
    ? `第 ${location.line} 行第 ${location.column} 列附近`
    : "某个位置";
  throw new ModelJsonError(
    `模型返回的 JSON 不合法（${where}），常见原因是漏写英文逗号、尾随逗号或引号未闭合。`,
  );
}
