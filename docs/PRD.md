# PRD: Obsidian Twitter/X 书签同步插件（obsidian-x-bookmarks）

Status: ready-for-agent
Labels: ready-for-agent
Created: 2026-06-16
Source plan: docs/plans/2026-06-16-001-feat-obsidian-twitter-bookmarks-plugin-plan.md
Target repo: 新建独立插件仓库 obsidian-x-bookmarks（尚未创建）

---

## Problem Statement

我（Ken）在 Twitter/X 上收藏（bookmark）了大量有价值的推文，但它们困在 X 里：不可全文检索、会随原推删除而永久丢失、也无法被我的 Obsidian 知识库和下游工具（如 PersonOS）消费。X 官方 API 已付费且 gated，我不想为此付费。我已经用 obsidian-weread-plugin 把微信读书笔记同步进 Obsidian，希望 X 书签也能有同样体验：登录一次，之后自动把书签沉淀成我 vault 里的 Markdown 笔记。

## Solution

一个 Obsidian 插件：在 Obsidian 内嵌一个网页登录窗口完成 X 登录（抓取会话 cookie，和 weread 插件一样的体验，无需手动找 cookie），然后用该 cookie 走 X 的非官方内部接口拉取我自己的全部书签，把每一条书签渲染成一份尽量完整的 Markdown 笔记（正文、作者、时间、原推链接、图片/视频、引用推文），存进 vault 的 `Twitter/` 子目录。重复同步时，已存在的书签自动跳过、绝不覆写我手动改过的笔记。支持手动命令触发和可选的定时同步。

## User Stories

1. 作为 Obsidian 用户，我想在插件设置里点一下「登录 X」就弹出 X 的网页登录窗口，这样我不用手动去浏览器里翻 cookie。
2. 作为 Obsidian 用户，我想登录成功后窗口自动关闭、凭据自动存好，这样登录是一步到位的。
3. 作为 Obsidian 用户，我想在已登录后点「同步书签」就把我所有 X 书签拉进来，这样我一条命令就能归档。
4. 作为 Obsidian 用户，我想每条书签存成 vault 里 `Twitter/` 子目录下的一份 Markdown，这样它和我其它笔记一样可检索、可链接。
5. 作为知识管理者，我想每条书签笔记包含推文正文全文（包括超过 280 字的长推 note_tweet），这样不会被截断。
6. 作为知识管理者，我想笔记里有作者名、@handle、头像、发布时间，这样我知道是谁什么时候发的。
7. 作为知识管理者，我想笔记里有指向原推的永久链接，这样我能回到出处。
8. 作为知识管理者，我想推文里的图片、视频、GIF 都被保存下来，这样视觉内容不丢。
9. 作为知识管理者，我想被引用的推文（quoted tweet）内容也嵌进同一份笔记，这样上下文完整。
10. 作为知识管理者，我想推文里的外链卡片（card：标题/描述/缩略图）也被记录，这样链接预览信息不丢。
11. 作为重视存档的人，我想可选地把媒体下载到本地附件目录，这样即使原推被删，我的笔记仍然完整。
12. 作为重复使用者，我想再次同步时已经存过的书签被跳过，这样不产生重复笔记。
13. 作为会手动整理笔记的人，我想我手动编辑过的已存书签笔记**不会被同步覆写**，这样我的批注不会丢（这正是 weread 插件让人头疼的点）。
14. 作为需要刷新的人，我想有个「强制重渲染」选项，这样在我改了模板后能重新生成已存笔记。
15. 作为想自定义的人，我想能配置笔记的 Nunjucks 模板，这样输出格式按我的喜好来。
16. 作为想自定义的人，我想能配置书签存放的目标文件夹（默认 `Twitter`），这样符合我的 vault 结构。
17. 作为想省事的人，我想能开启定时自动同步并设间隔，这样不用每次手动点。
18. 作为长期用户，我想在 cookie 失效时收到明确提示让我重新登录，这样我知道为什么同步停了、怎么修。
19. 作为非技术用户，我想当 X 改了内部接口（queryId 轮换）导致拉取失败时，插件给出可理解的报错并尝试自动恢复，而不是默默不工作。
20. 作为大量书签的用户，我想同步在拉取很多页时不会卡死、不会无限请求，这样我的账号不被风控、Obsidian 不被拖垮。
21. 作为中途被打断的用户，我想同步能记住进度、下次接着拉，这样不用每次从头来。
22. 作为隐私敏感者，我想我的 X cookie 只存在本机插件数据里、不上传任何第三方，这样我的凭据安全。
23. 作为移动端用户，我想在手机上即使不能内嵌登录，也能通过手动粘贴 cookie 使用（降级路径），这样我不是完全用不了。
24. 作为关注合规的人，我想插件说明白这是非官方、个人用途、风险自负，这样我对边界心里有数。
25. 作为只想要书签的人，我**不**需要插件去重建整条推文线程（thread），单条书签 + 其引用推文就够。

## Implementation Decisions

- **路线（用户已定）**：非官方 cookie 路线，不使用付费 X API。嵌入式网页登录抓 cookie（weread 式）。
- **模块划分**（高内聚、可独立测试）：
  - **auth**：嵌入登录窗口（Electron `BrowserWindow`，桌面专属，`Platform.isDesktopApp` 门控）+ cookie 存取/拼装/校验。捕获 `auth_token` 与 `ct0`，存进插件 `data.json`（Obsidian `saveData`）。移动端降级为手动粘贴 cookie。
  - **api/client**：所有 X 请求走 Obsidian `requestUrl()`（在主进程上下文、绕过 CORS），而非 `fetch`。
  - **api/queryId**：解决 X 内部 GraphQL `queryId` 每 2–8 周轮换——三层策略：自动从 X JS bundle 抓取（带 TTL 缓存）> 用户手动覆盖设置 > 静态兜底常量。
  - **api/bookmarks**：调 `Bookmarks` GraphQL 端点，游标（Bottom cursor）分页拉全量。
  - **model/parser**：把深层嵌套响应解析成稳定的 Bookmark 模型。
  - **render**：Nunjucks 模板渲染 + frontmatter 生成。
  - **sync**：增量去重 + 文件写入 + 可选媒体下载，编排整个流程。
- **鉴权约定**：`Authorization: Bearer <X 静态 web bearer>`、`x-csrf-token = ct0`（与 cookie 的 ct0 双提交必须一致）、`x-twitter-auth-type: OAuth2Session`、`x-twitter-active-user: yes`、`Cookie: auth_token=…; ct0=…`、浏览器 UA。`x-client-transaction-id` 是否必需为执行期验证项。
- **Bookmark 模型契约（字段）**：`tweet_id`、`text`（note_tweet 长文优先，回退 legacy.full_text）、`author {name, handle, avatar}`、`created_at`、`permalink`、`media[] {type, url}`、`quoted`（递归一层的同构对象）、`card {title, desc, thumb, url}`。
- **去重契约（关键架构决策）**：按**不可变 `tweet_id`** 去重。同步时扫描 vault 中 frontmatter 含 `doc_type: x-bookmark` 的笔记，收集已存 `tweet_id` 集合；已存在的书签**跳过、绝不 `vault.modify` 覆写**——从设计上规避 weread 插件「计数变化即覆写、丢失手动编辑」的问题。仅 `vault.create` 缺失的。提供可选「强制重渲染」。
- **frontmatter 哨兵**：`doc_type: x-bookmark` + `tweet_id`（+ author/handle/created/url/bookmarked_at），既是去重键也是 vault 扫描标记。
- **文件命名**：`{handle}-{tweet_id}.md`，对块引用敏感字符（`_`/`~`）做替换。
- **循环护栏（用户硬规则：任何 loop 必须配护栏）**：分页拉取循环必须有 MAX_PAGES 上限、no-progress 检测（游标不前进或 0 新条目即停）、429 指数退避（有限次）、进度（cursor + 已见 id）落盘以便中断续跑。
- **技术栈**：TypeScript + esbuild（Obsidian 官方模板默认；比 weread 的 webpack 轻）+ Nunjucks 模板 + `set-cookie-parser`。设置状态用轻量 store，不强制引入 Svelte。
- **定时**：Obsidian `registerInterval`（分钟级），非 cron。
- **媒体本地化（可选）**：开启时用 `requestUrl` 下载媒体到 `Twitter/_attachments/`、模板引用本地相对路径；失败回退 CDN URL，不阻断成文。

## Testing Decisions

- **什么是好测试**：只测外部行为（输入 → 输出），不测实现细节。优先在最高、已有的接缝上测；用录制的真实响应/bundle 作 fixture，不打真实 X 网络。
- **测试接缝（已选，待你确认）**：
  - `parser`（响应 JSON → Bookmark 模型）：纯函数，fixture 驱动——**主力测试面**。覆盖短推/长推(note_tweet)/图/视频/GIF/引用推文/外链 card/已删除条目容错。
  - `render`（Bookmark 模型 → Markdown）：纯函数，断言产出 Markdown 与 frontmatter。
  - `api/queryId`（bundle 文本 → queryId）：纯函数，正则抽取 + 覆盖优先 + 缓存 + 兜底 + 抽取失败回落。
  - `api/bookmarks` 分页循环 + 护栏：**注入可替换的请求函数**，喂分页 fixture 序列——断言 no-progress 停、MAX_PAGES 停、429 退避后重试、401/404 错误路径。
  - `auth/cookies`（拼装/解析/校验）：纯函数往返。
  - `sync` 去重决策（已存 id 集 → skip/create）：注入文件列表，断言幂等、新增只补新、**已存不覆写**。
  - 嵌入登录 `BrowserWindow` 的真实交互：Electron 依赖，**手动测试**（标注），不强求自动化。
- **被测模块**：parser、render、queryId、bookmarks(护栏)、cookies、sync(去重)。
- **prior art**：obsidian-weread-plugin 的渲染/frontmatter/去重模式；twscrape `models.py` 的响应解析作为 parser 参考。

## Out of Scope

- 推文线程（thread）重建——用户明确不要。
- 书签以外的同步（likes、关注列表、时间线等）。
- 任何写操作（发推/改推/删书签/X 端双向同步）。
- 付费官方 X API 路线。
- 通用 Twitter 客户端功能。
- 多账号。
- Obsidian 社区插件库上架的合规打磨（先自用 / BRAT 手动安装）。
- 跨设备 cookie 同步（CookieCloud 式）。

## Further Notes

- **头号脆弱点**：X 内部 GraphQL 的 `queryId`/`features` 每 2–8 周轮换，是同步失效的最常见原因；queryId 三层策略（自动发现+手动覆盖+兜底）专为此设计，且失败必须明确报错、绝不静默。
- **风险与现实**：Electron `remote` 已弃用（weread 同款仍可用，备选 `<webview>`）；cookie 会失效需重登；限流/风控（仅拉自己书签风险低）；ToS 灰区（个人拉自己数据执行风险极低，文档注明个人用途、风险自负）。
- **执行期取证项**：X 静态 web bearer 与 `features` 全集当前值、`x-client-transaction-id` 是否必需、Obsidian 沙箱内 `require('electron').remote` 可用性、MAX_PAGES/退避参数标定。
- 完整技术分解、HTD 图、逐单元实现细节见源计划 `docs/plans/2026-06-16-001-feat-obsidian-twitter-bookmarks-plugin-plan.md`（U1–U8）。
