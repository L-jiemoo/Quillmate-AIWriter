# Quillmate — 本地全自动 AI 小说工作台

Quillmate 是一个跑在本地的长篇小说生产工作台。启动服务后用浏览器打开，就能完成 **立项 → 世界观架构 → 角色设定 → 章节细纲 → 自动写作 → 审校 → 导出 / 发布** 的全流程。

- **本地优先**：小说、设定、登录会话都保存在你本机的 `data/` 目录，不依赖云端数据库。
- **模型自由**：兼容任意 OpenAI 风格接口（DeepSeek、通义千问、OpenAI、Ollama、vLLM 等），未配置时自动使用离线 `mock` 模式跑通流程。
- **浏览器内配置模型**：右上角「模型设置」填写 API Key、切换服务商与模型，保存后立即生效，无需重启。
- **浏览器工作台**：多项目作品库、人物卡、章节编辑器、实时任务日志，全部在一个 Next.js 应用里。
- **自动发布**：内置番茄小说 Playwright 适配器，扫码登录一次后自动建章、填表、存草稿或提交发布。

> 这是可运行的骨架版本：核心链路已经打通，发布选择器需要按番茄后台的实际页面校验，详见「番茄小说自动发布」。

---

## 核心能力

| 模块 | 说明 |
| --- | --- |
| 作品库 | 创建 / 删除小说项目，展示章节进度、字数与更新时间 |
| 模型设置 | 浏览器内填写 API Key、选择服务商与模型，保存即热切换；密钥本机保存、脱敏回显 |
| 架构 Agent | 生成一句话卖点、标签、世界观圣经、主线大纲与章节细纲 |
| 大纲扩充 | 章节不够时按需补充细纲，续排后续章节；已写正文与设定保持不变 |
| 角色 Agent | 生成结构化人物卡：目标、缺陷、关系、弧光、说话口吻 |
| 人物卡编辑器 | 可视化表单编辑全部字段，支持新增、删除、撤销与批量保存；高级模式可编辑 JSON |
| 写作 Agent | 逐章写作，自动注入世界观、人物卡、前情摘要与本章细纲 |
| 审校 Agent | 输出本章摘要、设定冲突与改进建议，摘要滚动进入下一章上下文 |
| 章节编辑器 | 手动修改正文与标题，保存后立即计入进度；可随时重新生成 |
| 任务台 | 后台任务队列 + 轮询日志，长任务不会阻塞页面 |
| 发布适配器 | 本地 Markdown 导出；番茄小说自动登录、建章、内容检测与提交（可配置选择器） |

## 工作流

```
一句创意
   │
   ▼
┌───────────────┐     ┌───────────────┐     ┌────────────────────┐
│ 架构 Agent      │ ──▶ │ 角色 Agent      │ ──▶ │ world / outline /  │
│ 世界观·主线·细纲 │     │ 人物卡          │     │ characters 文件     │
└───────────────┘     └───────────────┘     └─────────┬──────────┘
                                                       ▼
                              ┌────────────────────────────────────┐
                              │ 写作 Agent ──▶ 审校 Agent（逐章循环） │
                              │      ▲                │             │
                              │      └── 前情摘要 ◀────┘             │
                              └────────────────┬───────────────────┘
                                               ▼
                                     ┌───────────────────┐
                                     │ 导出 / 番茄自动发布 │
                                     └───────────────────┘
```

每个阶段都是独立的后台任务，页面右侧的「AI 任务台」会实时显示进度与日志。

## 技术栈

- **Next.js 14（App Router）+ React 18 + TypeScript**
- **OpenAI Node SDK**：调用任意 OpenAI 兼容接口
- **Playwright**：番茄小说发布自动化，持久化浏览器会话
- **文件存储**：Markdown / JSON / YAML 风格的项目目录，无数据库
- **react-markdown + remark-gfm**：世界观与大纲渲染

## 快速开始

要求：Node.js ≥ 18.17（开发验证使用 Node 24）。

```bash
npm install
npm run dev
```

番茄自动发布默认**复用系统 Edge**，无需额外下载浏览器。如果系统没有 Edge，可以改用 Playwright 自带 Chromium：在 `.env.local` 设置 `BROWSER_CHANNEL=chromium`，再执行 `npx playwright install chromium`。只做本地导出则完全不需要浏览器。

打开 http://localhost:3000 。

首次启动无需任何 API Key：工作台会使用 `mock` 模式生成示例架构、角色与占位章节，用于验证全流程。

需要真实模型时，点右上角「模型设置」，选服务商预设、填写 API Key，点「保存并热切换」即可，不用重启服务。

建议操作顺序：

1. 在作品库填写书名与一句创意，点击「创建工作台」。
2. 进入工作台，点右侧「生成架构与角色」。
3. 在「总览」查看世界观、大纲与章节细纲。
4. 在「角色设定」检查人物卡；点「编辑」用可视化表单修改，改完点「保存全部」。
5. 在「章节」点「写下一章」，或回任务台一次写多章；章节不够时在任务台点「补充 N 章大纲」续排，无需重新生成整本架构。
6. 在「发布」导出全书 Markdown，或登录番茄后自动发布。

## 接入真实模型

### 方式一：浏览器设置（推荐）

点右上角「模型设置」：

1. 选择一个预设（DeepSeek / OpenAI / 通义千问 / Ollama），或手动填写接口地址和模型名。
2. 填写 API Key，可先点「测试连接」验证是否可用。
3. 点「保存并热切换」，后续生成任务立即使用新配置，无需重启。

配置保存在 `data/settings.json`，优先级高于 `.env.local`。页面只回显脱敏后的 Key 尾号；清除密钥后会回到 mock 模式。该文件包含明文密钥，已在 `.gitignore` 中忽略，请勿分享整个 `data/` 目录。

### 方式二：.env.local

没有保存过页面设置时，会读取环境变量。复制 `.env.example` 为 `.env.local`，按所用服务填写：

```ini
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_MODEL=deepseek-chat
LLM_API_KEY=sk-your-key
```

常见服务示例：

| 服务 | LLM_BASE_URL | LLM_MODEL |
| --- | --- | --- |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| DeepSeek 推理版 | `https://api.deepseek.com/v1` | `deepseek-reasoner` / `deepseek-flash`（需较大 token 上限） |
| OpenAI | `https://api.openai.com/v1` | 任意可用模型 |
| Ollama | `http://localhost:11434/v1` | `qwen2.5:14b` 等 |
| vLLM / 其它 | 你的 OpenAI 兼容地址 | 已部署的模型名 |

使用 Ollama 时 API Key 可以填任意非空字符串（例如 `ollama`），OpenAI SDK 要求该字段存在。

修改 `.env.local` 后重启 `npm run dev`。页面任务日志会提示当前是否处于 mock 模式。

## 目录结构

```
Quillmate/
├── app/
│   ├── page.tsx                    # 作品库
│   ├── projects/[slug]/page.tsx    # 工作台
│   ├── settings/page.tsx           # 模型设置
│   ├── layout.tsx                  # 顶栏与全局布局
│   ├── globals.css                 # 工作台视觉样式
│   └── api/                        # REST API（见下表）
├── components/
│   ├── Dashboard.tsx               # 作品库与新建表单
│   ├── Markdown.tsx
│   └── workspace/                  # 总览 / 角色 / 章节 / 发布 / 任务台
├── lib/
│   ├── agents.ts                   # 架构、角色、写作、审校调度
│   ├── prompts.ts                  # 中文提示词
│   ├── llm.ts                      # OpenAI 兼容客户端与 JSON 修复
│   ├── mock.ts                     # 离线示例生成
│   ├── pipeline.ts                 # 后台任务编排
│   ├── jobs.ts                     # 内存任务队列
│   ├── store.ts                    # 项目文件读写
│   ├── publishers/fanqie.ts        # 番茄 Playwright 适配器
│   ├── types.ts
│   └── utils.ts
├── data/                           # 运行时生成，已在 .gitignore 中忽略
│   ├── projects/<slug>/
│   │   ├── project.json            # 作品元数据 + 发布设置
│   │   ├── plan.json               # 卖点、标签、章节细纲
│   │   ├── world.md                # 世界观圣经
│   │   ├── outline.md              # 主线大纲
│   │   ├── characters.json         # 人物卡
│   │   ├── state.json              # 已写章节、摘要、审校、发布历史
│   │   ├── chapters/001.md         # 章节正文
│   │   └── exports/全书.md
│   ├── browser/fanqie/             # 持久化登录会话
│   ├── publish-artifacts/          # 发布失败截图
│   └── settings.json               # 浏览器保存的模型配置（含密钥）
├── .env.example
├── package.json
└── next.config.mjs
```

## API 一览

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/projects` | 项目列表 |
| POST | `/api/projects` | 创建项目 |
| GET | `/api/projects/[slug]` | 项目完整详情 |
| PATCH | `/api/projects/[slug]` | 更新元数据 / 发布设置 |
| DELETE | `/api/projects/[slug]` | 删除项目及本地全部文件 |
| PUT | `/api/projects/[slug]/chapters/[index]` | 保存章节标题与正文 |
| PUT | `/api/projects/[slug]/characters` | 保存角色数组 |
| POST | `/api/projects/[slug]/jobs` | 启动后台任务 |
| GET | `/api/jobs/[id]` | 查询任务状态与日志 |
| GET | `/api/projects/[slug]/export` | 下载合并后的全书 Markdown |
| GET | `/api/settings` | 读取模型设置（密钥脱敏） |
| PUT | `/api/settings` | 保存模型设置并热切换 |
| POST | `/api/settings/test` | 用当前表单参数测试模型连接 |

任务类型：`plan`、`extend`、`write`、`export`、`fanqie-login`、`fanqie-publish`。其中 `extend` 用于补充章节大纲。

任务队列保存在进程内存中，重启服务后历史任务日志会清空，小说文件不受影响。

## 番茄小说自动发布

适配器位于 `lib/publishers/fanqie.ts`，会打开番茄作家工作台：

- https://fanqienovel.com/main/writer/

流程：

1. 在「发布」页填写番茄后台里的**作品名**（也可填写 bookId），保存设置。
2. 点击「登录番茄」。服务会打开可见的 Edge 窗口并自动进入登录页，用番茄 App 扫码或手机验证码登录。登录成功后程序会识别登录 Cookie 并自动关闭窗口，最长等待 10 分钟；也可以手动关闭窗口保存会话。登录态保存在 `data/browser/fanqie/`，后续任务复用。
3. 默认关闭「自动提交」，先验证存草稿：点「发布 N 章」，适配器会逐章打开新建章节、填写章节序号、标题与正文、存草稿。
4. 正式提交时，适配器会点击「下一步」，选择「仅基础检测」，在发布设置中声明「使用 AI：是」，最后点击「确认提交」。番茄后台通常需要数十分钟到 1 小时审核上线。
5. 番茄要求每章正文不少于 1000 字，标题需要配合章节序号。已成功提交的章节会记录在发布历史里，后续发布会自动跳过，避免重复上传。

**选择器可配置**：发布页「高级：站点选择器」可以覆盖 `bookEntry / createChapter / titleInput / contentEditor / saveButton / publishButton / confirmButton`。其中 `bookEntry` 默认指向工作台的作品卡片 `.completion-book-item`；番茄后台改版后，按 F12 检查元素，填入新的 CSS 选择器或 `text=文案` 即可，无需改代码。

注意事项：

- 自动发布依赖第三方网页结构，**选择器未针对你的账号后台逐项验证前，请务必先用存草稿模式测试**。
- 平台可能要求验证码、实名认证或额外弹窗；适配器失败时会把截图写入 `data/publish-artifacts/`，便于排查。
- 账号登录会话相当于账号凭据，请勿把 `data/browser/` 提交到版本库或分享。
- 自动化发布可能违反平台规则或触发风控。请自行确认平台条款，控制频率，并对最终内容负责。

## 扩展指南

### 新增发布平台

1. 在 `lib/publishers/` 新建适配器，导出 `publishXxx`（可参考 `fanqie.ts` 的持久化浏览器与选择器模式）。
2. 在 `lib/types.ts` 增加平台配置结构，并扩展 `ProjectPublish`。
3. 在 `lib/pipeline.ts` 增加任务类型和编排函数，在 `app/api/projects/[slug]/jobs/route.ts` 放行新类型。
4. 在 `components/workspace/PublishTab.tsx` 增加设置区块。

### 调整生成效果

- 所有提示词集中在 `lib/prompts.ts`，可直接修改文风、字数、JSON 字段要求。
- 想加入新的 Agent（例如封面文案、章节钩子评分），在 `lib/agents.ts` 增加函数，并在 `lib/pipeline.ts` 编排。
- 长篇记忆目前使用「最近 6 章摘要」。更长篇可以接入向量检索或分层摘要。

## Roadmap

- [ ] 任务队列持久化（SQLite）与重启续跑
- [ ] 多平台适配器：起点作家专区、晋江作者后台
- [ ] 定时连载 / 自动发布日历
- [ ] 长篇记忆：向量库 + 分卷摘要 + 设定冲突检测
- [ ] 多模型路由（架构用强模型、正文用快模型）
- [ ] AI 封面与简介生成
- [ ] 发布前人工审核工作流与差异对比
- [ ] 账号体系与多用户隔离（当前为单机单人）

## 常见问题

**页面能打开，但生成的是示例内容？**  
还没有可用的模型配置：打开右上角「模型设置」填写 API Key 并保存即可，或按「接入真实模型」配置 `.env.local` 后重启。注意页面保存的设置优先级更高。

**任务失败提示「模型返回了空内容」？**  
多见于推理型模型（deepseek-flash、deepseek-reasoner 等）：它们会先耗一段输出额度“思考”，如果「单次最大 tokens」太小，额度会被思考用光，正文为空。工作台会自动提高上限重试一次；仍失败时，请到「模型设置」把单次最大 tokens 调到 16384 以上，或改用非推理的 `deepseek-chat`。

**登录窗口刚打开就自己关了？**  
程序现在通过番茄的登录 Cookie 判断状态，不会再把宣传页误当成已登录。如果窗口仍立即关闭，任务日志会提示「检测到本机已保存番茄登录会话」，说明已有有效登录。需要重新登录时，可删除 `data/browser/fanqie/` 后再试。

**登录窗口一直不自动关闭？**  
说明尚未检测到登录成功，请确认已完成扫码或验证码登录；也可以手动关闭窗口，会话会保存到本地。

**点「登录番茄」没有弹出窗口？**  
默认使用系统 Edge。确认本机已安装 Edge，或在 `.env.local` 设置 `BROWSER_CHANNEL=chromium` 并执行 `npx playwright install chromium`。远程无桌面环境无法显示登录窗口；登录必须在有图形界面的本机完成。

**发布时报「找不到作品」或「找不到入口」？**  
先确认「发布」页的书名与番茄工作台完全一致（或填写 bookId），并确认登录的是同一账号。适配器现在从 https://fanqienovel.com/main/writer/ 的作品卡片进入；若界面再次改版，查看 `data/publish-artifacts/` 截图，到发布页高级设置里更新选择器。

**为什么发布前提示正文不足 1000 字？**  
番茄要求每章正文至少 1000 字。任务会在打开浏览器前检查并列出不满足的章节，补足后再发布即可。已经成功提交的章节会自动跳过，不会重复上传。

**怎么删除一部作品？**  
在作品库的卡片底部点「删除作品」，确认后会连同 `data/projects/<slug>/` 下的设定、章节和导出文件一起永久删除，无法恢复。重要作品建议先备份 `data/`。

**重新生成架构会删除已写章节吗？**  
不会删除 `chapters/*.md`，但会覆盖 `plan.json` 和设定文件，旧章节可能不再出现在新大纲里。重要项目建议先备份 `data/`。

**大纲里的章节写完了，想继续写怎么办？**  
在右侧「AI 任务台」找到「补充章节大纲」，填写要新增的章数（1–50），点「补充 N 章大纲」。程序会参考最近章节细纲、已写章节摘要和世界观，从当前最大章节号往后续排；已写正文、设定和世界观都不会被覆盖，规划章节数会同步更新，新增章节也会以「补充章节（第 X–Y 章）」追加到总览的主线大纲末尾。补充时会避开已有章节标题；若模型仍返回重复标题，会自动改名。补充完成后再继续「自动写 N 章」即可。

**章节在编辑器里保存后就算「已写」吗？**  
有非空正文即计入已写章节，可参与导出与发布；清空正文不会自动回退状态。

## 免责声明

本项目是写作效率工具。AI 生成内容可能存在事实错误、设定冲突或侵权风险，请在使用和发布前人工复核。自动发布功能可能触及第三方平台的服务条款，使用者需自行承担账号与合规风险。
