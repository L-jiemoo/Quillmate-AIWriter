import { describe, expect, it } from "vitest";
import {
  classifyFanqieFailure,
  DEFAULT_SELECTORS,
  hasFanqieAuthCookie,
  isTypoContinueButton,
  isTypoWarningText,
  mergeFanqieSelectors,
  PublishUncertainError,
  validateFanqiePublishRequest,
} from "@/lib/publishers/fanqie-core";

const LONG = "正".repeat(1000);

function chapter(index: number, content = LONG) {
  return { index, title: `第${index}章`, content };
}

describe("番茄发布预检", () => {
  it("检查书名、作品 ID、章节号、重复序号、标题和正文", () => {
    const missingBook = validateFanqiePublishRequest({
      bookName: " ",
      bookId: "../bad",
      autoSubmit: false,
      chapters: [chapter(1)],
    });
    expect(missingBook.errors.map((item) => item.code)).toEqual([
      "book-name",
      "book-id",
    ]);

    const invalid = validateFanqiePublishRequest({
      bookName: "测试书",
      autoSubmit: false,
      chapters: [
        { index: 0, title: "", content: "" },
        chapter(1),
        chapter(1),
        { index: 2, title: "标题", content: "   " },
      ],
    });
    expect(invalid.errors.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "chapter-index",
        "duplicate-chapter",
        "empty-content",
      ]),
    );
  });

  it("自动提交要求每章至少 1000 字，草稿模式允许短稿", () => {
    const short = [chapter(1, "很短的正文")];
    const submit = validateFanqiePublishRequest({
      bookName: "测试书",
      autoSubmit: true,
      chapters: short,
    });
    expect(submit.errors.map((item) => item.code)).toContain("too-short");

    const draft = validateFanqiePublishRequest({
      bookName: "测试书",
      autoSubmit: false,
      chapters: short,
    });
    expect(draft.errors).toEqual([]);
  });

  it("完整请求通过预检", () => {
    const result = validateFanqiePublishRequest({
      bookName: "测试书",
      bookId: "book_1",
      autoSubmit: true,
      chapters: [chapter(1), chapter(2)],
    });
    expect(result.errors).toEqual([]);
    expect(result.chapters).toHaveLength(2);
  });
});

describe("番茄登录态与选择器", () => {
  it("只把非空认证 cookie 视为已登录", () => {
    expect(
      hasFanqieAuthCookie([
        { name: "sessionid", value: "ok" },
        { name: "other", value: "x" },
      ]),
    ).toBe(true);
    expect(hasFanqieAuthCookie([{ name: "sessionid", value: "" }])).toBe(false);
    expect(hasFanqieAuthCookie([])).toBe(false);
  });

  it("自定义选择器覆盖默认值，空数组回退默认值", () => {
    const merged = mergeFanqieSelectors({
      bookEntry: [".my-book"],
      titleInput: [],
      confirmButton: ["button.ok"],
    });
    expect(merged.bookEntry).toEqual([".my-book"]);
    expect(merged.confirmButton).toEqual(["button.ok"]);
    expect(merged.titleInput).toEqual(DEFAULT_SELECTORS.titleInput);
    expect(DEFAULT_SELECTORS.bookEntry).toEqual([".completion-book-item"]);
  });
});

describe("番茄错别字提示", () => {
  it("识别错别字拦截弹窗，不误伤发布设置弹窗", () => {
    expect(
      isTypoWarningText("发布提示 检测到你还有错别字未修改，是否确定提交？"),
    ).toBe(true);
    expect(isTypoWarningText("错别字 0 是否使用 AI 辅助创作 确认提交")).toBe(false);
    expect(isTypoWarningText("请选择发布时间")).toBe(false);
  });

  it("「提交」按钮视为忽略错别字继续发布", () => {
    expect(isTypoContinueButton("提交")).toBe(true);
    expect(isTypoContinueButton(" 提 交 ")).toBe(true);
    expect(isTypoContinueButton("仍然发布")).toBe(true);
    expect(isTypoContinueButton("取消")).toBe(false);
    expect(isTypoContinueButton("确定")).toBe(false);
    expect(isTypoContinueButton("确认提交")).toBe(false);
  });
});

describe("番茄失败分类", () => {
  it("区分结果不明、登录失效、网络异常和页面结构变化", () => {
    expect(classifyFanqieFailure(new PublishUncertainError("提交结果不确定")).kind).toBe(
      "uncertain",
    );
    expect(classifyFanqieFailure(new Error("番茄登录会话已失效")).kind).toBe("login");
    expect(classifyFanqieFailure(new Error("net::ERR_CONNECTION_RESET")).kind).toBe(
      "network",
    );
    expect(classifyFanqieFailure(new Error("找不到「下一步」入口")).kind).toBe(
      "page-structure",
    );
    expect(classifyFanqieFailure(new Error("其他错误")).kind).toBe("unknown");
  });
});
