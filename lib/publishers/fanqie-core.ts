import type { FanqieSelectors } from "../types";

export class PublishUncertainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishUncertainError";
  }
}

export const AUTH_COOKIE_NAMES = ["sessionid", "sessionid_ss", "sid_guard", "sid_tt"];

export const DEFAULT_SELECTORS: FanqieSelectors = {
  bookEntry: [".completion-book-item"],
  createChapter: ['a:has-text("创建章节")', 'a:has-text("新建章节")'],
  titleInput: [
    'input[placeholder="请输入标题"]',
    'input[placeholder*="章节名"]',
    'input[placeholder*="章节标题"]',
    'input[placeholder*="标题"]',
  ],
  contentEditor: [
    ".serial-editor-container .ProseMirror",
    ".syl-editor-container .ProseMirror",
    '[contenteditable="true"]',
    "textarea",
  ],
  saveButton: [
    'button:has-text("存草稿")',
    "text=存草稿",
    "text=保存草稿",
    'button:has-text("保存")',
  ],
  publishButton: ["button.publish-button", 'button:has-text("下一步")'],
  confirmButton: [
    'button:has-text("确认提交")',
    'button:has-text("确认发布")',
    'button:has-text("确定")',
    'button:has-text("确认")',
    "text=确认提交",
    "text=确认发布",
  ],
};

export interface FanqieChapterInput {
  index: number;
  title: string;
  content: string;
}

// 平台错别字提示的识别规则：文案必须明确提到错别字，且不能是发布设置弹窗本身
// （发布设置会显示“错别字 0”统计并带“确认提交”按钮，误点会跳过 AI 声明）。
export function isTypoWarningText(text: string): boolean {
  if (!/错别字|错字|typo/iu.test(text)) return false;
  return !/是否使用\s*AI|确认提交/.test(text);
}

// 只点明确表示“继续/忽略/不修改/仍然提交”的按钮，不能用泛化的“确定/确认”。
// 番茄新版错别字提示只有「取消 / 提交」两个按钮，点“提交”才是忽略错别字继续发布；
// 这个弹窗已被“含错别字”条件限定，因此精确的“提交”是安全的。
export const TYPO_CONTINUE_BUTTON_NAMES: RegExp[] = [
  /仍(然|要)?(发布|提交)/u,
  /继续(发布|提交)/u,
  /忽略(并发布|全部)?/u,
  /不用修改/u,
  /不修改/u,
  /^跳过$/u,
  /^提\s*交$/u,
];

export function isTypoContinueButton(label: string): boolean {
  const text = label.replace(/\s+/g, "").trim();
  return TYPO_CONTINUE_BUTTON_NAMES.some((pattern) => pattern.test(text));
}

export interface FanqiePublishValidationInput {
  bookName: string;
  bookId?: string;
  autoSubmit: boolean;
  chapters: FanqieChapterInput[];
}

export type FanqiePublishErrorCode =
  | "book-name"
  | "book-id"
  | "no-chapters"
  | "chapter-index"
  | "duplicate-chapter"
  | "empty-title"
  | "empty-content"
  | "too-short";

export interface FanqiePublishValidationError {
  code: FanqiePublishErrorCode;
  message: string;
  chapter?: number;
}

export interface FanqiePublishValidation {
  errors: FanqiePublishValidationError[];
  chapters: FanqieChapterInput[];
}

function wordCount(text: string): number {
  return text.replace(/\s+/g, "").length;
}

export function validateFanqiePublishRequest(
  input: FanqiePublishValidationInput,
): FanqiePublishValidation {
  const errors: FanqiePublishValidationError[] = [];
  const bookName = input.bookName.trim();
  if (!bookName) {
    errors.push({ code: "book-name", message: "请先填写番茄书名" });
  }
  const bookId = (input.bookId ?? "").trim();
  if (bookId && !/^[A-Za-z0-9_-]{1,64}$/.test(bookId)) {
    errors.push({
      code: "book-id",
      message: "bookId 只能包含字母、数字、下划线和中划线",
    });
  }

  if (!Array.isArray(input.chapters) || !input.chapters.length) {
    errors.push({ code: "no-chapters", message: "没有需要发布的章节" });
    return { errors, chapters: [] };
  }

  const seen = new Set<number>();
  for (const chapter of input.chapters) {
    if (!Number.isInteger(chapter.index) || chapter.index < 1) {
      errors.push({ code: "chapter-index", message: "章节号必须是大于 0 的整数" });
      continue;
    }
    if (seen.has(chapter.index)) {
      errors.push({
        code: "duplicate-chapter",
        message: `第 ${chapter.index} 章在一次发布任务中重复出现`,
        chapter: chapter.index,
      });
      continue;
    }
    seen.add(chapter.index);

    if (!chapter.title.trim()) {
      errors.push({
        code: "empty-title",
        message: `第 ${chapter.index} 章标题为空`,
        chapter: chapter.index,
      });
    }
    if (!chapter.content.trim()) {
      errors.push({
        code: "empty-content",
        message: `第 ${chapter.index} 章正文为空`,
        chapter: chapter.index,
      });
      continue;
    }
    if (input.autoSubmit && wordCount(chapter.content) < 1000) {
      errors.push({
        code: "too-short",
        message: `第 ${chapter.index} 章不足 1000 字，番茄会拒绝提交`,
        chapter: chapter.index,
      });
    }
  }

  return { errors, chapters: input.chapters };
}

export function hasFanqieAuthCookie(
  cookies: Array<{ name: string; value: string }>,
): boolean {
  return cookies.some(
    (cookie) => AUTH_COOKIE_NAMES.includes(cookie.name) && Boolean(cookie.value),
  );
}

export function mergeFanqieSelectors(
  custom: Partial<FanqieSelectors> | undefined,
  defaults: FanqieSelectors = DEFAULT_SELECTORS,
): FanqieSelectors {
  const merged = {} as FanqieSelectors;
  for (const key of Object.keys(defaults) as (keyof FanqieSelectors)[]) {
    const candidate = custom?.[key];
    // 空数组表示“没配置”，不能把默认选择器清空，否则页面改版时会失去所有兜底。
    merged[key] =
      Array.isArray(candidate) && candidate.some((item) => item.trim())
        ? candidate
        : defaults[key];
  }
  return merged;
}

export type FanqieFailureKind =
  | "uncertain"
  | "login"
  | "network"
  | "page-structure"
  | "unknown";

export interface FanqieFailureInfo {
  kind: FanqieFailureKind;
  label: string;
  advice: string;
}

export function classifyFanqieFailure(error: unknown): FanqieFailureInfo {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "";
  if (name === "PublishUncertainError" || /结果不确定|无法确认提交结果/.test(message)) {
    return {
      kind: "uncertain",
      label: "提交结果不确定",
      advice: "已暂停自动重发；请到番茄后台核对后人工标记状态。",
    };
  }
  if (/登录|会话|未登录|cookie|auth/i.test(message)) {
    return {
      kind: "login",
      label: "登录状态失效",
      advice: "请重新点击「登录番茄」完成扫码或验证码登录。",
    };
  }
  if (/网络|超时|timeout|ECONN|ETIMEDOUT|ENOTFOUND|net::|连接/i.test(message)) {
    return {
      kind: "network",
      label: "网络异常",
      advice: "请检查网络、代理和番茄站点是否可访问后重试。",
    };
  }
  if (/找不到|选择器|编辑器|页面结构|入口|输入框|发布设置|未进入发布设置/i.test(message)) {
    return {
      kind: "page-structure",
      label: "页面结构变化",
      advice: "请检查番茄后台改版情况，并在发布页高级设置中调整选择器。",
    };
  }
  return {
    kind: "unknown",
    label: "未知发布错误",
    advice: "请查看发布日志和截图后重试。",
  };
}
