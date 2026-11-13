# 交接文档 · 视频 + 网页 AI 阅读扩展（合并版）

写给下一个接手的人 / AI。读完本文你应该能在不追问原作者的前提下继续开发。

最后更新：2026-11-14

---

## 1. 一句话现状

一个 Edge/Chrome MV3 扩展：同一个侧栏，遇到 B站/抖音自动用视频字幕总结，遇到其他文字网页自动读正文总结，两套能力互不干扰；每个页面（按 URL）的总结与追问都持久保存在本地，切标签、切站点、重开浏览器都能各自找回。

**代码可跑、单元测试 15/15 通过、尚未在真实浏览器做过端到端付费验收。**

---

## 2. 位置与硬边界

| 项 | 值 |
| --- | --- |
| 工作目录 | `<仓库根目录>` |
| 原始视频扩展（**只读，不许改**） | `<原视频扩展目录>（只读参考，未随仓库分发）` |
| 早期独立文字扩展（已于 2026-11-14 删除，334 个文件） | ~~`webpage-ai-reader-extension`~~ |
| Git | 本地 `main`，**从未 commit、无 remote** |

纪律：

- 不修改原始视频扩展目录的任何文件，它只是参考源。
- 不自动提交 Git，不推远程，除非用户明确要求。
- 不替用户改动已加载到浏览器的扩展，加载 / 重载由用户自己在 `edge://extensions` 操作。
- 没有用户明确同意，不调用付费模型接口（真实验收会花钱）。

---

## 3. 目录结构

```
video-and-web-ai-extension/
├─ manifest.json            MV3 清单（v1.7.0）
├─ background.js            服务 worker：视频总结流 + 模型域授权 + 转调 reader
├─ rules.json               声明式网络规则（原视频扩展带来的）
├─ content/                 ★ 旧视频扩展的站点脚本，基本未改
│   ├─ bilibili.js          字幕 / 弹幕 / 评论采集
│   ├─ douyin.js            抖音文案采集
│   ├─ douyin-hook.js       抖音页面注入钩子
│   ├─ wbi.js               B站 wbi 签名
│   └─ common.js            共用工具
├─ lib/                     ★ 旧视频扩展的共享库，基本未改
│   ├─ llm.js               模型配置读写 + chatStream/chatOnce（两套面板共用）
│   ├─ chat-background.js   流式聊天编排（useWeb 分支）
│   ├─ web-research.js      联网检索的查询规划
│   ├─ search.js            Tavily / Bing RSS / 360 / 搜狗 检索
│   ├─ archive.js           会话归档写盘（视频侧）
│   ├─ conversation.js / prompts.js / markdown.js
├─ panel/                   ★ 旧视频面板（视频侧 UI）
│   ├─ router.html / router.js   ← 新的统一路由外壳
│   ├─ panel.html / panel.js / chat.js / controls.js
│   ├─ frame-capture.js     画面帧截取
│   └─ panel.css / studio.css
├─ reader/                  ☆ 新写的文字网页侧
│   ├─ background.js        正文提取、联网判断、流式问答
│   ├─ lib/extract.js       站点选择器 + 通用正文提取
│   ├─ lib/decision.js      要不要联网的判定
│   ├─ lib/session.js       URL 级会话持久化（本轮新增）
│   └─ panel/panel.html|css|js  文字侧栏
├─ options/                 设置页（模型 Key / endpoint / model / 测试连接）
├─ memory/                  历史记录页
├─ icons/                   16/32/48/128 现有图标
├─ design-preview/          ☆ 新 UI/图标设计预览（**未接入正式扩展**）
│   ├─ index.html           自包含可交互预览
│   ├─ icon.svg             新图标「知页」概念稿
│   └─ preview-desktop.png / preview-compact.png / preview-mobile.png
├─ tests/                   node:test 单测
└─ docs/PROGRESS.md          实施与验收记录
```

---

## 4. 架构

### 4.1 单侧栏 + iframe 路由

`manifest.json` 的 `side_panel.default_path` 指向 `panel/router.html`。`panel/router.js` 做三件事：

1. `chrome.tabs.query({active:true,currentWindow:true})` 拿当前标签。
2. 用正则判定是不是视频页：
   ```js
   const VIDEO = /^https?:\/\/([^/]+\.)?bilibili\.com\/(video|list|bangumi\/play)\/|^https?:\/\/([^/]+\.)?douyin\.com\//i;
   ```
   是 → iframe 载 `panel.html`（原视频面板）；否 → iframe 载 `../reader/panel/panel.html`。
3. 监听 `tabs.onActivated` / `tabs.onUpdated` / `windows.onFocusChanged` 重新路由。

关键点：**路由不是立刻 remove 旧 iframe**。先 `await handoff(old)`，给旧 iframe 发 `{type:'route-away',token}`，等它回 `{type:'route-away-done',token}` 或 1400ms 超时兜底，才移除并创建新 iframe。这样进行中的流式输出不会因为切页丢字节。

`currentKey = \`${tab.id}:${identity(url)}\``，`identity()` 去掉 `#fragment`；key 没变就不重建 iframe。

### 4.2 视频侧（旧代码，几乎未动）

- content script 采集字幕/文案 → `chrome.tabs.sendMessage` 的 `COLLECT_VIDEO`。
- 面板 `panel/panel.js` 每 1200ms 轮询当前 tab URL（`collectFromActiveTab()`，约 145–200 行）。
- 每完成一次总结 `finish()`（约 316–332 行）会 `chat.save()`。
- 缓存键 `video-chat:${key}`，`panel/chat.js` 的 `setVideo()`（约 329–345 行）先读 `chrome.storage.local` 再读 `session`。
- 本轮只给它补了「切页时保存未完成内容」的钩子，采集与 UI 逻辑没改。

### 4.3 文字侧（新代码）

- 提取：`chrome.scripting.executeScript({target:{tabId}, func: extractPage})`，`reader/lib/extract.js` 内按 GitHub / 知乎 / CSDN / 贴吧 / 通用（`article, main`）走不同选择器，克隆可见 DOM、清广告、按 4000 字分块、打 `data-ai-reader-anchor` 供回跳。
- 判定：`reader/lib/decision.js` 的 `quickWebDecision(question, mode)` —— 时效性问题、明确指向站外、或问句模糊时走模型 JSON 判定。
- 问答：`reader/background.js` 用 `lib/llm.js` 的 `getSettings/chatStream`（**共用合并版自己的 `chrome.storage.sync` 配置**），页面引用编号 `[P#]`，联网来源编号 `[W#]`，两类来源分开。
- 持久化：`reader/lib/session.js`（见下节）。

### 4.4 权限模型（重要）

`manifest.json` 只永久要 DeepSeek 与 Bing 的 host 权限；其余 HTTPS 全站在 `optional_host_permissions`。

所以文字侧**必须**在用户点「总结 / 提问」时同步调用 `chrome.permissions.request({origins:[...]})` 申请当前站点权限，拿到后重新核对 tabId + URL 再注入。直接 `executeScript` 会报：

```
Cannot access contents of url "https://tieba.baidu.com/p/...".
Extension manifest must request permission to access this host.
```

这不是 API Key 问题，是站点权限问题。不要退回「让用户去扩展详情里开站点访问」——那里只列出永久权限，贴吧根本不在列表里。

---

## 5. 本轮已完成：按 URL 持久化（用户选的方案 A）

需求原话：切换不同网站时能看到各自总结的东西，切出去再回来不能没了。

### 5.1 新增 `reader/lib/session.js`

```js
export function pageKey(rawUrl)          // 保留 query，丢弃 #fragment；非 http(s) 抛 Unsupported page URL
export function createSessionStore(storage)  // { load(url), save(url,state), flush() }
```

- 存储前缀 `reader-page:v1:`，键 = 前缀 + 规范化 URL。同一站点不同帖子靠 query 区分。
- `save()` 在**同步段**先 `structuredClone` 出快照，再挂到串行 `writes` 链上写盘——防止切页后旧的流式片段覆盖已完成结果。
- `load()` 先 `await writes` 再读，并校验 `record.url === identity`，不符返回 `null`（避免键冲突读到别人的记录）。

### 5.2 重写 `reader/panel/panel.js`

- `snapshot()` → `{title, page, turns}`。
- `persist()` / `queueSave()`（400ms 防抖）/ `flush()`。
- `restore(record)` 渲染历史；未完成的 turn 追加标记「[未完成 · 切换页面或连接中断，可重新提问]」。
- `run()` 开头：`if (activeUrl !== url) { await flush(); activeUrl = url; restore(await store.load(url)); }`
- turn 结构：`{question, answer, sources, complete, created}`；流式 delta 直接追加 `turn.answer` 并 `queueSave()`；`done` 置 `complete = true`；`aborted` / `error` / port 断开也走 `finish()` 并落盘。
- 发给模型的 `history` 只取 `turns.slice(0,-1).filter(t => t.complete)`，避免把半截回答当上下文。
- 新增 `message` 监听处理 `route-away`：在忙时 `runEpoch++`、发 stop、断开端口、保存，最后回 `route-away-done`。

### 5.3 重写 `panel/router.js`

见 4.1。`handoff()` 是新增的核心，超时 1400ms。

### 5.4 改 `panel/panel.js`（视频侧）

- `initChat({restoreSummary})` 的 record 分支补：`show($('btn-summary-continue'), !!record.summaryPending && !!summary)`，并 `setStatus('上次切换页面时总结未完成；已恢复收到的内容。')`。
- 新增 `message` 监听处理 `route-away`：`state.generating` 时置 `state.archiveSummaryPending = true`、让后台 abort、`finish('已切换页面；总结未完成，已保存收到的内容。')`；`chat.isBusy()` 就 `chat.abort()`；`await chat.save()` 后回 `route-away-done`。

### 5.5 测试

- 新增 `tests/session.test.js`（3 项）：URL 区分帖子且忽略 hash、跨 store 实例（模拟重启）恢复、快照先于异步写 + 串行写不被旧片段覆盖。
- 改 `tests/integration.test.js`：注入 `window/location/URL/setTimeout`，新增「router waits for old frame to acknowledge saved session before replacing it」，断言在 ack 前 `frames.length === 1`。
- 结果：`node --test tests/*.test.js` → **15/15 通过**（decision 8 + router 2 + 权限拒绝 1 + manifest 1 + session 3）。

### 5.6 设计原则（别破坏）

- **不在后台并发跑多个模型的总结**。切走就停，保留已收内容并标记未完成。用户明确不想为此多花钱。
- 已完成的总结不自动续跑；未完成的也不自动续跑，等人再点。

---

## 6. 尚未完成

1. **`docs/PROGRESS.md` 还没写本轮切页持久化这一段**（15/15 那行也还是旧的 11/11）。补上即可。
2. **真实浏览器端到端验收**（PROGRESS.md 末尾那张表）：B站字幕、贴吧/知乎/GitHub/CSDN 首次授权弹窗、切页串页、DeepSeek + Bing RSS 实际答复。需要用户自己在 `edge://extensions` 加载未打包扩展，并配置 Key；会调用付费接口，**必须先征得同意**。
3. **UI / 图标 / 名称正式接入**：`design-preview/` 里是「知页」概念稿（墨绿 `#122c28` / 叶绿 `#147c61` / 纸白 `#f4f4ec`，图标书页 + 播放三角）。用户看过预览说「两边设计统一了」，但**还没有把预览样式接进 `panel/panel.css`、`reader/panel/panel.css` 和 `icons/`**。接的时候两个面板要统一顶栏、状态条、总结卡、引用样式、底部提问框。
4. 第一批自定义项的落地：主题深浅、默认总结长度、默认联网模式、是否自动总结、每站读取偏好。目前 `options/` 只有模型配置。

---

## 7. 踩过的坑

- **贴吧权限报错**：见 4.4。根因是 optional host 未申请就 `executeScript`，不是 Key 错。
- **DeepSeek 模型 id**：官方 Chat Completions 的 id 是 `deepseek-flash`（对应 DeepSeek-V4.1-Flash-1017），endpoint `https://api.deepseek.com/chat/completions`。`4.1flash-1017` 这类写法是第三方网关的叫法，不能直接填官方接口。第三方渠道要按该渠道自己的 baseURL + model 填。
- **截图宽度**：Chrome headless 有最小布局宽度，430px 会被裁切，窄屏用 500px 出图才正常。
- **iframe 重建丢流式内容**：先 ack 再 remove，别图省事直接 remove。
- **写入竞态**：`save()` 必须同步快照，异步写要串行，否则切页时旧片段会盖掉新结果。
- **`#fragment`**：同页跳锚点不应重置会话，所以 `identity()` 要剥 hash；但 query 必须留。

---

## 8. 怎么验证（不花钱的部分）

```powershell
cd <仓库根目录>
node --test tests/*.test.js
node --check panel/router.js
node --check panel/panel.js
node --check reader/panel/panel.js
node --check reader/lib/session.js
```

期望：15 pass / 0 fail。

改完 CSS 或设计稿时，用隔离 profile 的 Chrome headless 截图核对，不要污染用户日常浏览器配置。

---

## 9. 接手后建议的动作顺序

1. 跑上面 5 条命令，确认还是 15/15。
2. 把本轮改动补进 `docs/PROGRESS.md`。
3. 问用户：是先做「UI 正式接入」，还是先做「真实站点验收」。（两件事都要他本人操作浏览器 / 决定是否花钱。）
4. 谁先做都别动旧视频扩展原件，也别动 `content/`、`lib/search.js` 这些视频侧逻辑，除非在验收里真的复现了 bug。
