import { promises as fs } from "fs";
import path from "path";
import type { BrowserContext, Page } from "playwright";
import { ARTIFACT_DIR, BROWSER_PROFILE_DIR, getBrowserChannel } from "../config";
import { nowIso } from "../utils";
import type { FanqieSelectors } from "../types";
import {
  classifyFanqieFailure,
  DEFAULT_SELECTORS,
  hasFanqieAuthCookie,
  mergeFanqieSelectors,
  PublishUncertainError,
  validateFanqiePublishRequest,
} from "./fanqie-core";

export { PublishUncertainError } from "./fanqie-core";

type LogFn = (message: string) => void;

const WRITER_HOME = "https://fanqienovel.com/writer/zone/";
const WORKBENCH_URL = "https://fanqienovel.com/main/writer/";
const LOGIN_URL = "https://fanqienovel.com/main/writer/login?enter_from=author_zone";

const CHAPTER_NUMBER_INPUTS = [".serial-editor-title-left input", "input.serial-input"];

export interface FanqiePublishOptions {
  bookName: string;
  bookId?: string;
  enabled?: boolean;
  autoSubmit: boolean;
  headless: boolean;
  selectors?: Partial<FanqieSelectors>;
  chapters: { index: number; title: string; content: string }[];
  onLog: LogFn;
  onChapterPublished?: (index: number) => void | Promise<void>;
  // 点击确认后无法确认是否成功：登记为待人工确认，并且本次任务停止。
  onChapterUncertain?: (index: number, message: string) => void | Promise<void>;
  // 每个章节开始前调用；抛出取消错误时关闭浏览器并终止发布。
  checkCancelled?: () => void;
}

async function launch(headless: boolean, log: LogFn): Promise<BrowserContext> {
  const { chromium } = await import("playwright");
  const channel = getBrowserChannel();
  const browserName = channel === "msedge" ? "Edge" : channel === "chrome" ? "Chrome" : "Chromium";
  await fs.mkdir(BROWSER_PROFILE_DIR, { recursive: true });
  log(`启动 ${browserName}（${headless ? "无头" : "可见"}窗口，复用本地登录会话）…`);
  try {
    // 持久化 profile 保存番茄登录态，登录一次后可反复发布。
    // 这个目录等同于账号凭据，绝不能提交到仓库或分享给他人。
    return await chromium.launchPersistentContext(BROWSER_PROFILE_DIR, {
      headless,
      channel,
      viewport: { width: 1360, height: 900 },
    });
  } catch {
    throw new Error(
      "无法启动浏览器：请确认系统已安装 Edge，或在 .env.local 设置 BROWSER_CHANNEL=chromium 后执行 npx playwright install chromium",
    );
  }
}

async function snapshot(page: Page, name: string): Promise<string | null> {
  try {
    await fs.mkdir(ARTIFACT_DIR, { recursive: true });
    const file = path.join(
      ARTIFACT_DIR,
      `${nowIso().replace(/[:.]/g, "-")}-${name}.png`,
    );
    await page.screenshot({ path: file, fullPage: true });
    return file;
  } catch {
    return null;
  }
}

// 番茄的按钮文案和 DOM 结构会随版本变化，所以选择器都按数组配置：
// 依次等待并点击，命中第一个可见元素就返回，全部失败才报错提示改配置。
async function clickFirst(page: Page, selectors: string[], label: string, log: LogFn): Promise<void> {
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      await locator.waitFor({ state: "visible", timeout: 4000 });
      await locator.click();
      log(`已点击「${label}」`);
      return;
    } catch {
      continue;
    }
  }
  throw new Error(`找不到「${label}」入口，请到发布页的高级设置中调整选择器`);
}

async function fillFirst(
  page: Page,
  selectors: string[],
  label: string,
  value: string,
  log: LogFn,
): Promise<void> {
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      await locator.waitFor({ state: "visible", timeout: 4000 });
      await locator.fill(value);
      log(`已填写「${label}」`);
      return;
    } catch {
      continue;
    }
  }
  throw new Error(`找不到「${label}」输入框，请到发布页的高级设置中调整选择器`);
}

async function locateCreateChapterHref(
  page: Page,
  bookName: string,
  bookId: string | undefined,
  customSelectors: string[] | undefined,
  createSelectors: string[] | undefined,
  log: LogFn,
): Promise<string> {
  const trimmedId = bookId?.trim();
  // 填了 bookId 就直接拼新建章节 URL，跳过卡片匹配；
  // 这是平台改版导致书名定位失效时最稳的兜底入口。
  if (trimmedId) {
    log(`使用配置的 bookId：${trimmedId}`);
    return `/main/writer/${trimmedId}/publish/?enter_from=newchapter_0`;
  }

  log(`正在定位作品《${bookName}》…`);
  // 没有 bookId 时只能在作品卡片里按书名匹配。卡片内优先找现成的 /publish/ 链接，
  // 找不到再点“创建章节”并读取其 href，兼容两种不同的工作台布局。
  const selectors = customSelectors?.length ? customSelectors : [".completion-book-item"];
  for (const selector of selectors) {
    const cards = page.locator(selector).filter({ hasText: bookName });
    const count = await cards.count().catch(() => 0);
    for (let i = 0; i < count; i += 1) {
      const card = cards.nth(i);
      const link = card.locator('a[href*="/publish/"]').first();
      const href = await link.getAttribute("href").catch(() => null);
      if (href) {
        log("已定位作品与创建章节入口");
        return href;
      }

      for (const createSelector of createSelectors?.length
        ? createSelectors
        : DEFAULT_SELECTORS.createChapter) {
        const candidate = card.locator(createSelector).first();
        if (!(await candidate.count().catch(() => 0))) continue;
        const createHref = await candidate
          .evaluate((el) => el.closest("a")?.getAttribute("href") ?? null)
          .catch(() => null);
        if (createHref) {
          log("已定位作品与创建章节入口");
          return createHref;
        }
      }
    }
  }

  const shot = await snapshot(page, "fanqie-book-not-found");
  throw new Error(
    `在番茄工作台找不到作品《${bookName}》，请确认书名与当前登录账号${
      shot ? `（截图：${shot}）` : ""
    }，或填写 bookId / 高级设置中的作品卡片选择器`,
  );
}

async function chooseBasicCheck(page: Page, log: LogFn): Promise<void> {
  // 内容检测弹窗有两个不稳定点：
  // 1. 遮罩 #publish-check-chapter-mask 会在按钮动画期间拦截点击；
  // 2. 弹窗整体重渲染时，已拿到的按钮 locator 会 detached。
  // 因此轮询等待可点击状态，8 秒后允许 force，仍失败就直接派发 DOM click，
  // 后续由 submitForReview 继续等待发布设置弹窗来确认这一步是否生效。
  const mask = page.locator("#publish-check-chapter-mask").first();
  const start = Date.now();

  while (Date.now() - start < 20000) {
    const basic = page.getByRole("button", { name: "仅基础检测", exact: true }).first();

    if (!(await basic.count().catch(() => 0))) {
      // 平台偶尔会记住上次选择，直接跳过检测弹窗进入发布设置；
      // 这时按钮不存在是正常路径，不能当成失败。
      if (await page.locator(".publish-confirm-container-new").first().isVisible().catch(() => false)) {
        return;
      }
      await page.waitForTimeout(400);
      continue;
    }

    if (!(await basic.isVisible().catch(() => false))) {
      await page.waitForTimeout(400);
      continue;
    }

    const blocked = await mask.isVisible().catch(() => false);
    const force = blocked && Date.now() - start > 8000;
    try {
      await basic.click({ timeout: force ? 2000 : 4000, force });
      log("已选择「仅基础检测」");
      return;
    } catch {
      try {
        // 检测弹窗会整体重渲染，按钮可能被替换；直接派发点击后由下一步等待校验结果
        await basic.evaluate((el) => (el as HTMLElement).click());
        log("已选择「仅基础检测」");
        return;
      } catch {
        await page.waitForTimeout(400);
      }
    }
  }

  const basic = page.getByRole("button", { name: "仅基础检测", exact: true }).first();
  if (await basic.count().catch(() => 0)) {
    await basic.evaluate((el) => (el as HTMLElement).click()).catch(() => undefined);
    log("已选择「仅基础检测」");
  }
}

async function submitForReview(
  page: Page,
  selectors: FanqieSelectors,
  chapterIndex: number,
  log: LogFn,
): Promise<void> {
  await clickFirst(page, selectors.publishButton, "下一步", log);
  await page.waitForTimeout(1500);
  await chooseBasicCheck(page, log);
  await page.waitForTimeout(1200);

  const modal = page.locator(".publish-confirm-container-new").first();
  // 选择基础检测后，平台可能先插入字数提示或自动编辑器错误提示。
  // 能自动点“提交/确定”就继续；出现需要人工判断的提示则立即中止并报告，
  // 不能在后台替用户盲选。
  for (let round = 0; round < 4; round += 1) {
    if (await modal.isVisible().catch(() => false)) break;

    const prompts = page.locator(".publish-modal-confirm, .auto-editor-error-modal");
    const promptCount = await prompts.count().catch(() => 0);
    let visiblePrompt: typeof prompts | null = null;
    for (let i = 0; i < promptCount; i += 1) {
      if (await prompts.nth(i).isVisible().catch(() => false)) {
        visiblePrompt = prompts.nth(i);
        break;
      }
    }

    if (visiblePrompt) {
      const text = (await visiblePrompt.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
      const submit = visiblePrompt.getByRole("button", { name: /^(提交|确定)$/ });
      if (await submit.count()) {
        await submit.first().click();
        log(`已确认发布前提示：${text.slice(0, 80)}`);
        await page.waitForTimeout(1200);
        continue;
      }
      throw new Error(`发布前需要人工处理平台提示：${text.slice(0, 200)}`);
    }

    await page.waitForTimeout(800);
  }

  try {
    await modal.waitFor({ state: "visible", timeout: 20000 });
  } catch {
    // 等不到发布设置弹窗，通常是标题、章节号或正文被前端校验拦住。
    // 从页面文本里提取“至少/请选择/请输入”这类提示，给出比超时更有用的错误。
    const bodyText = await page.locator("body").innerText().catch(() => "");
    const errors = [...new Set(
      bodyText
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.includes("至少") || line.includes("请选择") || line.includes("请输入")),
    )];
    throw new Error(
      `第 ${chapterIndex} 章未进入发布设置${
        errors.length ? `：${errors.join("；")}` : "，请检查标题、章节号和正文"
      }`,
    );
  }

  // 番茄要求作者声明是否使用 AI 辅助；这里固定按“是”提交，
  // 与发布页说明保持一致。找不到选项时沿用平台默认值，不阻断发布。
  const aiYes = modal.locator("label.arco-radio").filter({ hasText: /^是$/ }).first();
  if (await aiYes.count()) {
    await aiYes.click();
    log("已在发布设置中选择「是否使用 AI：是」");
  } else {
    log("未找到「是否使用 AI」选项，按平台默认值提交");
  }

  let clicked = false;
  // 确认按钮同样支持多选择器；只点发布设置弹窗内部的按钮，
  // 避免误点到页面其他“确认”按钮。
  for (const selector of selectors.confirmButton) {
    const button = modal.locator(selector).first();
    if (await button.count().catch(() => 0)) {
      await button.click();
      clicked = true;
      break;
    }
  }
  if (!clicked) {
    throw new Error("发布设置中找不到「确认提交」按钮，请到高级设置调整 confirmButton");
  }

  // 点击确认不等于提交成功：平台可能弹二次提示或拦截。
  // 只有弹窗关闭，或页面出现成功/审核中字样，才认为本章已进入审核；
  // 超时则截图留证，方便排查是风控还是页面结构变化。
  let submitted = false;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const stillOpen = await modal.isVisible().catch(() => false);
    const bodyText = await page.locator("body").innerText().catch(() => "");
    if (!stillOpen || /提交成功|发布成功|已提交|审核中/.test(bodyText)) {
      submitted = true;
      break;
    }
    await page.waitForTimeout(500);
  }
  if (!submitted) {
    const shot = await snapshot(page, "fanqie-submit-blocked");
    // 确认按钮已经点过，可能已提交成功也可能被拦截；交给人工核对，不能自动重发。
    throw new PublishUncertainError(
      `第 ${chapterIndex} 章点击确认后无法确认提交结果，可能已被平台拦截或仍在处理${
        shot ? `（截图：${shot}）` : ""
      }`,
    );
  }
  log(`第 ${chapterIndex} 章已提交发布`);
}

// 登录态判断只检查 cookie 是否非空，不校验有效期；
// 真正过期时后续编辑页加载会失败，届时会提示重新登录。
async function hasAuthCookie(context: BrowserContext): Promise<boolean> {
  return hasFanqieAuthCookie(await context.cookies());
}

async function openLoginEntry(page: Page, log: LogFn): Promise<void> {
  if (page.url().includes("/writer/login")) {
    log("已进入番茄登录页，请扫码或使用验证码登录。");
    return;
  }

  for (const selector of ["text=立即登录", "text=登录/注册", 'button:has-text("立即登录")']) {
    const locator = page.locator(selector).first();
    try {
      await locator.waitFor({ state: "visible", timeout: 4000 });
      await locator.click();
      await page.waitForTimeout(1500);
      log("已打开番茄登录页，请扫码或使用验证码登录。");
      return;
    } catch {
      continue;
    }
  }

  try {
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    log("已打开番茄登录页，请扫码或使用验证码登录。");
  } catch {
    log("未能自动打开登录页，请在窗口右上角点击「登录/注册」。");
  }
}

export async function loginFanqie(
  log: LogFn,
  checkCancelled?: () => void,
): Promise<void> {
  const context = await launch(false, log);
  // 用户可能登录完成后直接关窗，也可能中途放弃；用 close 事件区分这两种情况，
  // 避免把“手动关窗”误报成登录超时。
  let userClosed = false;
  context.on("close", () => {
    userClosed = true;
  });

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    page.setDefaultTimeout(15000);

    if (await hasAuthCookie(context).catch(() => false)) {
      log("检测到本机已保存番茄登录会话，无需重复登录。");
      return;
    }

    await page.goto(WRITER_HOME, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2500);
    await openLoginEntry(page, log);
    log("请完成扫码或验证码登录，登录成功后窗口会自动关闭（最多等待 10 分钟）。");

    // 登录检测靠轮询 cookie，而不是等待页面跳转：
    // 扫码成功后番茄可能停留在原页或弹窗内，URL 变化不可靠。
    // 用户手动关闭窗口时也立即结束，避免进程空等满 10 分钟。
    const deadline = Date.now() + 10 * 60 * 1000;
    let lastNotice = Date.now();
    while (Date.now() < deadline) {
      checkCancelled?.();
      if (userClosed) break;

      let loggedIn = false;
      try {
        loggedIn = await hasAuthCookie(context);
      } catch {
        // 浏览器被强制关闭时 context 已失效，直接结束等待
        break;
      }

      if (loggedIn) {
        await page.waitForTimeout(1500).catch(() => undefined);
        const shot = await snapshot(page, "fanqie-login");
        log(`登录成功，会话已保存${shot ? `（截图：${shot}）` : ""}。`);
        return;
      }

      if (Date.now() - lastNotice > 30000) {
        log("仍在等待登录，请完成扫码或验证码…");
        lastNotice = Date.now();
      }
      await page.waitForTimeout(2000).catch(() => undefined);
    }

    if (userClosed || page.isClosed()) {
      log("浏览器窗口已关闭。若已完成登录，会话会保存在本地；可再次点击「登录番茄」确认。");
      return;
    }

    await snapshot(page, "fanqie-login-timeout");
    throw new Error("登录等待超时（10 分钟），请重试");
  } finally {
    await context.close().catch(() => undefined);
  }
}

export async function publishFanqie(options: FanqiePublishOptions): Promise<void> {
  options.checkCancelled?.();
  const log = options.onLog;
  const selectors = mergeFanqieSelectors(options.selectors);

  // 启动浏览器前完成选品、选章、正文和字数预检；草稿模式允许短稿。
  const validation = validateFanqiePublishRequest(options);
  if (validation.errors.length) {
    throw new Error(validation.errors.map((item) => item.message).join("；"));
  }

  const context = await launch(options.headless, log);
  let page: Page | undefined;
  try {
    const activePage = context.pages()[0] ?? (await context.newPage());
    page = activePage;
    activePage.setDefaultTimeout(20000);
    await activePage.goto(WORKBENCH_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

    if (!(await hasAuthCookie(context))) {
      const shot = await snapshot(activePage, "fanqie-not-logged-in");
      throw new Error(
        `尚未登录番茄作家后台，请先在「发布」页点击「登录番茄」完成扫码${
          shot ? `（截图：${shot}）` : ""
        }`,
      );
    }

    await activePage
      .locator(".completion-book-item")
      .first()
      .waitFor({ state: "visible", timeout: 15000 })
      .catch(() => undefined);

    const createHref = await locateCreateChapterHref(
      activePage,
      options.bookName,
      options.bookId,
      selectors.bookEntry,
      selectors.createChapter,
      log,
    );
    const createUrl = new URL(createHref, "https://fanqienovel.com").toString();

    // 每章都重新打开新建页，避免复用上一章编辑器时标题/正文残留。
    // 编辑器加载失败时先区分“登录失效”和“页面结构变化”，给出不同提示。
    for (const chapter of options.chapters) {
      options.checkCancelled?.();
      log(`第 ${chapter.index} 章《${chapter.title}》：打开新建章节页…`);
      await activePage.goto(createUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      try {
        await activePage
          .locator(".serial-editor-container")
          .first()
          .waitFor({ state: "visible", timeout: 30000 });
      } catch {
        if (!(await hasAuthCookie(context).catch(() => false))) {
          throw new Error("番茄登录会话已失效，请重新点击「登录番茄」");
        }
        const shot = await snapshot(activePage, "fanqie-editor-timeout");
        throw new Error(`第 ${chapter.index} 章编辑器加载失败${shot ? `（截图：${shot}）` : ""}`);
      }
      await activePage.waitForTimeout(800);

      await fillFirst(activePage, CHAPTER_NUMBER_INPUTS, "章节序号", String(chapter.index), log);
      await fillFirst(activePage, selectors.titleInput, "章节标题", chapter.title, log);
      await fillFirst(activePage, selectors.contentEditor, "章节正文", chapter.content, log);
      await activePage.waitForTimeout(1500);
      const wordCount = await activePage
        .locator(".publish-header-count")
        .innerText()
        .catch(() => null);
      if (wordCount) log(`平台统计正文约 ${wordCount} 字`);

      if (options.autoSubmit) {
        // 只有走完提交校验才回调记账；若中途抛错，调用方会把该章记为失败，
        // 下次发布会自动重试，不会误跳过。
        try {
          await submitForReview(activePage, selectors, chapter.index, log);
          await options.onChapterPublished?.(chapter.index);
        } catch (error) {
          if (error instanceof PublishUncertainError) {
            await options.onChapterUncertain?.(chapter.index, error.message);
          }
          throw error;
        }
      } else {
        await clickFirst(activePage, selectors.saveButton, "存草稿", log);
        await activePage.waitForTimeout(1500);
        log(`第 ${chapter.index} 章已保存为草稿`);
      }
    }

    const shot = await snapshot(activePage, "fanqie-publish-done");
    log(`全部 ${options.chapters.length} 章处理完成${shot ? `（截图：${shot}）` : ""}。`);
  } catch (error) {
    const shot = page ? await snapshot(page, "fanqie-error") : null;
    if (shot) log(`出错截图：${shot}`);
    const failure = classifyFanqieFailure(error);
    log(`发布失败类型：${failure.label}；${failure.advice}`);
    throw error;
  } finally {
    await context.close().catch(() => undefined);
  }
}
