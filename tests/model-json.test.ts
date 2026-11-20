import { describe, expect, it } from "vitest";
import { extractJson, ModelJsonError } from "@/lib/model-json";

describe("模型 JSON 宽松解析", () => {
  it("解析纯 JSON", () => {
    expect(extractJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  it("剥离 Markdown 围栏和前后解释", () => {
    const raw = '以下是结果：\n```json\n{"chapters":[{"index":1}]}\n```\n希望有帮助。';
    expect(extractJson(raw)).toEqual({ chapters: [{ index: 1 }] });
  });

  it("修复对象属性之间漏掉的逗号", () => {
    expect(extractJson('{"a":1 "b":"x" "c":true}')).toEqual({
      a: 1,
      b: "x",
      c: true,
    });
  });

  it("修复数组元素之间漏掉的逗号", () => {
    expect(extractJson('[{"index":1} {"index":2} [3] "x" 4]')).toEqual([
      { index: 1 },
      { index: 2 },
      [3],
      "x",
      4,
    ]);
  });

  it("修复嵌套对象和数组后漏掉的逗号", () => {
    expect(extractJson('{"a":{"b":1} "c":[2] "d":3}')).toEqual({
      a: { b: 1 },
      c: [2],
      d: 3,
    });
  });

  it("删除尾随逗号", () => {
    expect(extractJson('{"a":[1,2,],"b":{"c":3,},}')).toEqual({
      a: [1, 2],
      b: { c: 3 },
    });
  });

  it("不修改字符串内部的逗号、括号和引号", () => {
    const value = extractJson<{ text: string; next: number }>(
      '{"text":"a, b } { \\"quoted\\", [x]","next":2}',
    );
    expect(value).toEqual({ text: 'a, b } { "quoted", [x]', next: 2 });
  });

  it("无法修复时给出中文位置提示", () => {
    expect(() => extractJson('{"a": 1, "b": "unterminated}')).toThrow(
      ModelJsonError,
    );
    try {
      extractJson('{"a": 1, "b": "unterminated}');
    } catch (error) {
      expect(error).toBeInstanceOf(ModelJsonError);
      expect((error as Error).message).toMatch(/第 \d+ 行第 \d+ 列/);
    }
  });
});
