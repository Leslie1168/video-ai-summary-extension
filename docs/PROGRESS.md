# 合并版实施与验收记录

## 已执行步骤

1. 将原视频扩展（34 个文件，约 208 KB）完整复制到独立的 `video-and-web-ai-extension` 文件夹；新建本地 `main` Git 仓库，不改原目录。原文件哈希对照：合并版副本中的原始文件仅 `manifest.json`、`background.js` 有修改；复制来的浏览器生成 `_metadata` 已从副本移除。
2. 复制文字扩展的可见正文采集、自动联网判断、侧栏和后台问答组件到 `reader/`；保留旧视频面板和 B站/抖音内容脚本。
3. 在 `panel/router.html` 加载单个侧栏，根据活跃标签 URL 在原视频界面和文字阅读界面间切换。切换时销毁先前 iframe，后台端口断开时中止文字请求；原视频面板由原逻辑中止自身请求。
4. 文字页用户点击总结/提交提问时，先同步触发 `chrome.permissions.request` 为当前站点申请访问；拒绝后显示提示且不启动后台；授权后重新核对 tab ID 与 URL，再注入正文提取。
5. 后台文字模式使用原扩展 `lib/llm.js` 的 `getSettings/chatStream`，共用**合并版自身**的 `chrome.storage.sync` 模型配置，页内引用与 Bing RSS 来源单独编号；没有导出/复制旧扩展密钥。
6. 新增 `tests/integration.test.js` 用模拟 Chrome API 验证视频→贴吧→GitHub→视频切换、原视频面板保留、权限被拒不发后台请求。
7. 按页面 URL 持久保存文字页会话（用户选定方案 A）：新增 `reader/lib/session.js`，前缀 `reader-page:v1:`，`pageKey()` 保留 query、丢弃 `#fragment`；`save()` 同步 `structuredClone` 快照后串行写盘，`load()` 先 `await writes` 并校验 URL 身份。
8. 重写 `reader/panel/panel.js`：`snapshot/restore/persist/queueSave(400ms)/flush`；turn 结构 `{question,answer,sources,complete,created}`，流式 delta 实时落盘，`aborted/error/端口断开` 也保存；未完成 turn 显示「[未完成 · 切换页面或连接中断，可重新提问]」；发给模型的历史只含已完成 turn。
9. 重写 `panel/router.js`：切换前先 `handoff()` 给旧 iframe 发 `route-away` 并等待 `route-away-done`（1400ms 超时兜底），再移除重建，避免流式内容被截断。
10. 改 `panel/panel.js`（视频侧）：`route-away` 时置 `archiveSummaryPending`、中止生成、`chat.save()` 后回 ack；恢复记录时若待续总结未完成则显示「继续总结」并提示已保留已收内容。

## 已验证

- `node --test tests/*.test.js`：15/15 通过；路由 2 项（含「等待旧 iframe 确认已保存后才替换」）、会话持久化 3 项、权限拒绝、清单、联网判断 8 项均通过。
- 本轮改动的 `panel/router.js`、`panel/panel.js`、`reader/panel/panel.js`、`reader/lib/session.js` 均通过 `node --check`。
- `node --check`：新/改 JavaScript 文件语法检查通过。
- 原始视频扩展 34 个文件哈希对比：仅在独立副本中改变 `background.js` 与 `manifest.json`；其余原视频资源一致。
- Git 本地分支 `main`；没有提交或远程。

## 尚需浏览器内验收

| 情形 | 验收要点 |
| --- | --- |
| B站/抖音视频 | 路由到原面板、字幕读取与视频追问正常；失败时不回退为文字正文 |
| 贴吧/GitHub/知乎/CSDN | 首次点总结弹出站点授权，许可后提取该页正文；拒绝时显示未授予并不继续 |
| 切换标签及同页导航 | 侧栏立刻切换，之前的输出与进行中的文字请求不会串页 |
| 模型与联网 | 在合并版重新配置 Key 后，官方 DeepSeek Flash 和 Bing RSS 可实际答复并标记 `[P#]`/`[W#]` |

当前未操作用户浏览器加载合并版，也未调用付费 API，因此上述真实站点/付费模型项没有标记为通过。若实际站点 DOM 或模型服务与模拟环境有差异，以浏览器实测为准并针对性修复。

## 2026-11-14 · 知页 UI 接入（第 1–3 项）

把 `design-preview/` 的「知页」视觉接进正式扩展，不改采集、路由和会话逻辑。

| 项 | 改动 | 证据 |
| --- | --- | --- |
| 主题 token | `panel/panel.css` 的 `:root` 与深色媒体查询换成纸白/墨绿两套，新增 `--accent-ink`、`--brand-deep`、`--brand-paper`；`panel/studio.css` 的 60 余处硬编码紫/深蓝全部改成 `var()` 引用，并在自身 `:root` 补 `--accent-line/--accent-ink/--accent-text/--border-strong/--danger-*` 两套 | `Select-String` 复查：`panel.css` 与 `studio.css` 剩余 hex 只出现在 token 定义中 |
| 视频侧栏 | `panel/panel.html` 品牌改为内联 SVG 书页图标 + 「知页」；`panel.css` 补 `.brand-symbol`/`.brand small` 布局；主按钮与 `.ts` 白字改用 `var(--accent-ink)` | `docs/ui-preview/video-light.png`、`video-dark.png` |
| 文字侧栏 | `reader/panel/panel.html` 重写为同一套顶栏/工具行/气泡/提问框结构，保留 `settings/site/summarize/stop/mode/status/meta/conversation/ask/question` 全部 id；`reader/panel/panel.css` 引入 `../../panel/panel.css` 复用 token，提问按钮固定宽度不再折行 | `docs/ui-preview/reader-light.png`、`reader-dark.png` |
| 切换页 | `panel/router.html` 背景与标题跟随主题，标题改「知页」 | 与上面截图同批渲染 |
| 设置页 | `options/options.css` 删掉末尾强制深紫覆盖块，token 换成同一套纸白/墨绿；`h1` 改「知页 · 设置」 | Chrome 无头渲染 900×1100 目检通过 |
| 记忆页 | `memory/memory.css` 的 `:root` 拆成浅/深两套，`#191f28`/`#b8a7f5`/`#2d283d` 等 11 个硬色改为变量 | 同上 |
| 图标 | 按 `design-preview/icon.svg` 的几何用 Pillow 在 1024×1024 重绘（圆角矩形 + 双贝塞尔书页 + 书脊 + 三横划 + 播放三角），LANCZOS 输出 128/48/32/16；旧图备份到 `docs/icon-backup/` | `icons/icon128.png` 目检 |
| 名称 | `manifest.json` name → 「知页 · 视频与网页 AI 阅读」、version → 1.8.0、action title → 「知页」、description 重写 | `ConvertFrom-Json` 读回确认 |

测试：`node --test tests/*.test.js` 15 pass / 0 fail。截图方法为 Chrome `--headless=new --screenshot`，夹具复制真实面板 HTML、把 CSS 链接改成绝对 `file:///` 并注入示例内容；浅色用 token 覆盖 `!important` 模拟 `prefers-color-scheme: light`（无头 Chrome 继承了系统的深色）。**没有**在真实 Edge 侧栏里加载验收，也没有调用模型。

当时仍未做（后续进展见本文件后面的日志）：新设置项、`webpage-ai-reader-extension` 旧目录、Git 未提交。其中主题切换已在 `f9903ca` 做完，旧目录已删除，仓库已提交。“自动总结”与“每站偏好”经用户确认不做。

## 2026-11-14 · 排版刻度修正（可读性）

上一版接入把主题颜色换对了，但字号沿用旧面板的 10–12px 区间，中文在这个尺寸下发糊；`body` 只声明 `"Microsoft YaHei"`，小字号中文容易回落到衬线体。

- 新增 `panel/typography.css`，在 `panel.css`、`studio.css` 之后加载（文字面板放在自己的 `panel.css` 之后），只改字号、字重、行高和块级层次，不动布局与逻辑。
- 基准字号 13px → 14px，字体栈补 `"Microsoft YaHei UI"` 和 `system-ui`，加 `-webkit-font-smoothing: antialiased`。
- 梯度照 `design-preview` 的 19/15/12/11 按比例放大：视频标题 15.5px、小节标题 12px 绿色、小节首句 15px / 650、正文 14px / 1.85、列表 13.5px / 1.8、辅助信息不低于 11.5px、输入框 14px。
- `#output` 包成白底圆角卡片（radius 13px、padding 18/16、`0 7px 18px -15px` 阴影）；列表换绿色圆点，引用块换浅绿底加左描边，和预览稿的层次对齐。
- `--text-faint` 从 `#8b9c90` 调到 `#6d8174`（深色 `#8aa192` → `#9db3a6`），小字对比度达标。
- 截图重出到 `docs/ui-preview/`，宽 500。Chrome 无头最小布局宽度约 500px，低于此值会被裁切，那是截图工具的限制，不是页面横向溢出。
- 回归：`node --test tests/*.test.js` 15 pass / 0 fail，三个样式表花括号平衡。

仍未在真实 Edge 侧栏加载核对；`--window-size` 与真实侧栏拖拽宽度可能有细微差异。

## 2026-11-14 · 黑白重做与字号自定义

用户否定了绿色方案，要求纯黑白、HarmonyOS 字体、字号粗细可调、总结内容用不同颜色/字号/粗细/emoji 标注。

| 项 | 改动 | 验证 |
| --- | --- | --- |
| 配色 | `panel/panel.css`、`panel/studio.css`、`options/options.css`、`memory/memory.css` 的 token 全换黑白灰，只留错误红 `#b42318`/`#f59387` | grep `#147c61\|#8ee0ae\|#122c28\|20,124,97` 在四个样式表零命中 |
| 字体 | 改 `"HarmonyOS Sans SC"` → `"HarmonyOS Sans"` → `"Segoe UI"` → `"Microsoft YaHei UI"` → `system-ui`。不打包字体 | 本机 `C:\Windows\Fonts` 与 `HKCU` 字体注册表已有六个字重 |
| 字号体系 | `panel/typography.css` 重写：字号 = `calc(var(--fs-base) * k)`，行高 = `calc(var(--lh-base) * k)`，字重走 `--fw-body`/`--fw-head` | 无头 Chrome 截图核对 |
| 自定义 | 新增 `panel/ui-prefs.js`；设置页新增「3 · 外观与字号」四个下拉（正文 13–17px、行距 1.6–2.05、正文粗细 300/400/500、标题粗细 600/650/700/900），保存即时生效 | `node --check` 通过；`options.js` 走独立 `chrome.storage.sync.get(UI_DEFAULTS)`，绕开 `getSettings()` 的白名单 |
| 标注语法 | `lib/markdown.js` 的 `renderInline` 加 `==x==` → `<mark>`；`mark` 用浅灰底 + 内阴影，不靠颜色 | 新增 `tests/markdown.test.js` 6 项全过 |
| 提示词 | `lib/prompts.js`、`lib/conversation.js`、`reader/background.js` 统一要求 `## emoji 小节名`、`**2–6 字抓手**`、最多 3 处 `==高亮==` | 只改提示词文本，未调用模型验证输出 |

回归：`node --test tests/*.test.js` **21 pass / 0 fail**。截图按新配色重出到 `docs/ui-preview/`（500 宽四张）。

未做：设置项到侧栏的真实联动只在 CSS 变量层验证过，没在真实 Edge 侧栏里点过；新提示词没跑过真实模型调用。

## 2026-11-14 · 文字侧详细程度三档

| 项 | 改动 | 验证 |
| --- | --- | --- |
| 面板控件 | `reader/panel/panel.html` 工具行加 `#style-seg`：精简 / 标准 / 精读，与「读取并总结」「停止」「联网模式」同排 | 无头 Edge 截图，500 宽与 420 真实布局两版均单行不溢出 |
| 状态与记忆 | `reader/panel/panel.js` 加 `style` 状态、`applyStyle()`；选择写 `chrome.storage.local` 的 `readerStyle`，初始化时 `get({mode,readerStyle})` 一并恢复；运行中禁点避免串档 | 新增测试断言 `postMessage` 带 `style:'detailed'`、`mode:'web'` |
| 提示词 | 三档预设从 `reader/background.js` 提到 `lib/prompts.js`，导出 `WEB_STYLE_PRESETS` 与 `webStylePreset()`；`task` 措辞、`scope` 篇幅、`maxTokens`（900 / 1800 / 3200）随档位变化，非法值回落标准 | 新增测试断言三档 label、预算递增、非法值回落 |
| 选中态 | `panel/panel.css` 的 `.seg button.active` 从 `--bg-elev` 改 `--border` 底 + `--text` 字，深浅两套都能看出选中块 | 放大截图核对 light/dark |
| 文案统一 | 视频侧按钮与设置页下拉的「速览」统一为「精简」，`STYLE_PRESETS.brief.label` 同步 | grep 无残留 |

回归：`node --test tests/*.test.js` **23 pass / 0 fail**；全项目 `node --check` 0 失败。

## 2026-11-14 · 文字页主体卡片

| 项 | 改动 | 验证 |
| --- | --- | --- |
| 提取字段 | `reader/lib/extract.js` 的 `extractPage()` 新增返回 `host`、`author`、`published`、`siteStats`；站点规则优先（GitHub 作者/`relative-time`、知乎 `.AuthorInfo-name`/`.ContentItem-time`、CSDN `.profile-intro-name`/`.time`/`#read-count`、贴吧 `.p_author_name`/回复数），通用回退 `meta[name=author]`、`meta[property=article:published_time]`、`time[datetime]`；日期统一成 `YYYY-MM-DD` | 站点缺失时字段为空字符串，不抛错 |
| 卡片结构 | `reader/panel/panel.html` 在工具行上方加 `#page-card`：`#p-mark` 站点缩写块 + `#p-title` 标题 + `#p-sub` 域名/作者/日期 + `#p-stats` 统计 + `#p-badges` 徽章，复用视频侧 `.card.video-card`、`.video-meta`、`.v-title`、`.badges` | 500 宽浅/深截图核对 |
| 渲染 | `reader/panel/panel.js` 新增 `SITE_INFO` 与 `renderPageCard(current, cut)`；`restore()` 与 `page` 事件都走它，`#meta` 只留「只读取了可见部分」的提示 | 新增测试 `text panel renders a page card with site, author and coverage` |
| 显隐 | `.page-card` 自己控 `display:none`，`.page-card.ready` 才 `display:flex`——`panel.css:199` 的 `.video-card{display:flex}` 定义在 `.hidden`（`:66`）之后，会盖掉 `.hidden` | 截图确认未读取时不占位 |
| 字体对齐 | `reader/panel/panel.css` 的 `:root` 从 `"Segoe UI","Microsoft YaHei"` 改为 HarmonyOS 栈，`font-size` 改 `var(--fs-base,14px)`；各组件字号改 `calc(var(--fs-base) * k)`，与视频侧一起响应设置页字号 | grep 无硬编码 `px` 字号残留（站点缩写块除外） |

回归：`node --test tests/*.test.js` **24 pass / 0 fail**；全项目 `node --check` 0 失败。

## 2026-11-14 · 网页侧复制与导出

| 项 | 改动 | 验证 |
| --- | --- | --- |
| 导出模块 | 新建 `reader/lib/export.js`：`pageMarkdown(record)` 生成带标题、来源、作者日期、段数字数的 Markdown；`pagePlainText(record)` 去掉 `#`/`>`/`**`/`==`/反引号转纯文本；`pageFileName(record)` 清洗 Windows 非法字符；`downloadPage(record)` 用 Blob + `<a download>` 触发下载，不申请 `downloads` 权限 | 新增 `tests/export.test.js` 7 项 |
| 操作条 | `reader/panel/panel.html` 在 `#meta` 与 `#conversation` 之间加 `#reader-actions`（`.result-head` + `#btn-copy`、`#btn-export`）；`reader/panel/panel.js` 的 `syncActions()` 按 `turns.length` 切 `.ready` | 500 宽浅/深截图核对 |
| 复制 | 点「复制」走 `navigator.clipboard.writeText(pagePlainText(snapshot()))`，状态栏回「已复制本页对话」；失败显示原始错误 | 未做真实剪贴板验证，仅语法与 DOM 挂钩 |
| 导出 | 点「导出 .md」走 `downloadPage(snapshot())`，文件名 `知页-<标题>-<YYYYMMDD-HHMM>.md`，含每轮问答与外部来源链接 | 同上 |
| 行为 | 没有 turns 时操作条不显示；第一轮总结的 `question` 为空串，导出时标题写作「页面总结」 | `tests/export.test.js` 覆盖 |

回归：`node --test tests/*.test.js` **31 pass / 0 fail**；全项目 `node --check` 0 失败。


## 2026-11-14 · 记忆页「视频 / 网页」双栏

| 项 | 改动 |
|---|---|
| 数据 | `lib/archive.js` 增 `PAGE_PREFIX = 'reader-page:v1:'` 与 `listPageMemories()`，只读，按 `updated` 降序，`id` 就是页面 URL |
| 记忆页 | `memory/memory.js` 全文重写，`mode` 在 video/page 间切换；两套列表共用外壳、搜索与详情；网页详情在右侧渲染，不开 iframe |
| 文案 | 切 tab 时标题、副标、eyebrow、搜索 placeholder、空态提示一起换（「我的视频记忆」↔「我的阅读记录」） |
| 导出 | 网页记录走 `reader/lib/export.js` 的 `downloadPage` / `downloadPages`，单条与全部都支持 md/json |
| 样式 | `memory/memory.css` 追加 `.tabs` / `.tab` / `.tab.active`，选中态用 `--text` 反底，`padding:0 36px` 与 header 对齐 |
| 测试 | 新增 `tests/pagememory.test.js` 4 项；全量 35 pass / 0 fail |
| 截图 | `docs/ui-preview/memory-light.png`、`memory-dark.png`（1100×980） |

已知边界：记忆页只读 `chrome.storage.local`，没有删除按钮；网页记录不会自动清理，长期使用会一直累积。

## 2026-11-14 · 坚果云同步（v1.9.0）

| 项 | 实际行为 | 证据 |
|---|---|---|
| 传输层 | `lib/webdav.js` 自写最小客户端：PROPFIND / GET / PUT / DELETE / MKCOL、Basic 认证、20 秒超时、1/4/16 秒退避；service worker 里没有 DOMParser，multistatus 用正则拆 | `tests/webdav.test.js` 7 项 |
| 同步层 | `lib/cloudsync.js`：每浏览器一个子目录、`index.json` 记归属与字节、单条记录一个文件、墓碑表防回传 | `tests/cloudsync.test.js` 7 项 |
| 触发 | 网页侧 `finish()` 与视频侧 `chat.save()` 落盘后单条上传；视频侧 1.5 秒合并一次，流式保存不会打爆请求 | `reader/panel/panel.js`、`panel/chat.js` |
| 上限 | 默认 50 MB，超了从最旧的删，云端文件 + 墓碑 + 本地一起删 | `trimIndex()` |
| 设置 | 设置页「5 · 坚果云同步」：地址 / 账号 / 应用密码 / 文件夹 / 设备名 / 上限 / 实时开关 / 测试连接 / 立即同步 | `docs/ui-preview/options-cloud-light.png` |
| 记忆页 | 右上「云同步」按钮 + 一行状态；没配置时提示去设置页 | `memory/memory.js` |
| 权限 | `optional_host_permissions` 增加 `https://dav.jianguoyun.com/*`，点测试连接时申请 | `manifest.json` |
| 已知边界 | 两个浏览器**同时**写 `index.json` 有极小概率互相盖掉一条索引（文件本身不会丢，下次同步会重建）；坚果云 1500 次/30 分钟配额与手机客户端共用，大量导入时要留意 | 未做并发写测试 |

回归：`node --test tests/*.test.js` **49 pass / 0 fail**；全项目 `node --check` 0 失败。

## 2026-11-14 · 云同步索引瘦身（v2）

问题：每上传一条记录就要全量重写 `index.json`，而旧版索引每条都带完整 key（网页 URL 常 60–100 字符），一天 50 轮就是几百 KB 级别的重复传输。

| 改动 | 内容 | 文件 |
|---|---|---|
| 索引结构 | `version: 2`，`files` 改为 `{<sha1>: [updated, size, deviceIndex]}`，设备名收进 `devices[]`，**不再存 key 与 kind** | `lib/cloudsync.js` |
| 旧数据迁移 | `readIndex()` 读到 v1 就地转成 v2，key 挂在临时 `carry` 上，写盘前摔掉 | `lib/cloudsync.js` |
| 取 key 方式 | 新增 `entryOf()` / `hashLocal()`；缺 key 时读回云端记录文件取 `body.key` | `lib/cloudsync.js` |
| 上限 | 默认 50 → **200 MB**，档位改为 50 / 200 / 500 / 1000 MB | `lib/cloudsync.js`、`options/options.html` |
| 墓碑表 | 上限 600 → 400 条 | `lib/cloudsync.js` |
| 测试 | 断言索引里**不得出现原始 URL**；新增“无 key 仍能拉回远端记录”“默认 200 且档位含 500/1000” | `tests/cloudsync.test.js` |

体积实测（600 条混合记录，一个 URL 一条，脚本 `%TEMP%\idxsize.mjs`）：

| 项 | v1 | v2 | 变化 |
|---|---|---|---|
| 索引体积 | 115183 B | 40335 B | **–65.0%** |
| 一天 50 轮×30 天 | 164.8 MB/月 | 57.7 MB/月 | –65% |
| 6800 条（200 MB 记录）每次 PUT | — | 0.44 MB | 可接受 |

已知边界：索引里没有 key 后，做删除、裁剪时要多一次读回记录文件（多 1 个 GET），属于用带宽换存储的取舍。

回归：`node --test tests/*.test.js` **51 pass / 0 fail**；`node --check` 全项通过。

## 2026-11-14 · 记忆页删除

之前 `deleteEverywhere` 只有后台出口，界面没有任何地方能删。现在补上。

| 改动 | 内容 | 文件 |
|---|---|---|
| 按钮 | 详情区 `.actions` 末尾加 `#delete-one`，红字红边 | `memory/memory.html` |
| key 推导 | `storageKey(record)`：网页用记录自带的全传 key，视频拼 `video-memory:` + id | `memory/memory.js` |
| 分流 | 已配置罐果云 → 发 `CLOUD_DELETE`（云端文件 + 索引 + 墓碑 + 本地）；未配置 → 直接 `storage.local.remove` | `memory/memory.js` |
| 确认 | 弹框写清文件名与后果，取消就不动 | `memory/memory.js` |
| 样式 | `——danger` 变量（浅 `#b42318` / 深 `#f59387`）+ `.actions button.danger` | `memory/memory.css` |
| 测试 | 断言按钮、key 拼法、CLOUD_DELETE、本地回退、confirm、样式 | `tests/pagememory.test.js` |

一个已知取舍：未配置罐果云时只删本地，云端没有可删的东西，不会留墓碑；如果之后才开启云同步，这条不会被重新上传（本地已没有）。

已知边界：删除时如果那条视频的侧栏对话还开着（memory 页侧栏模式），它下一次 `chat.save()` 会把记录写回本地；当前没做跨 iframe 通知，遇到就把那个侧栏关掉再删。

回归：`node --test tests/*.test.js` **52 pass / 0 fail**。

## 2026-11-14 · 人设与导出提示

人设只改语气，不改事实。这条写在代码里也写在提示词里。

| 改动 | 内容 | 文件 |
|---|---|---|
| 新模块 | `clampPersona` / `loadPersona` / `savePersona` / `normalizePersona` / `personaBlock` / `withPersona`，上限 1000 字 | `lib/persona.js` |
| 视频总结 | `withPersona(SYSTEM_PROMPT, opts.persona)` | `lib/prompts.js` |
| 视频追问 | `withPersona(system, settings.persona)`，persona 在 `chat-background.js` 读好塞进 settings | `lib/conversation.js` |
| 网页总结/追问 | system 末尾拼 `${persona}` | `reader/background.js` |
| 设置页 | 新增「4 · 人设」卡片：开关 + 文本框（`maxlength=1000`）+ 实时字数 | `options/options.html`、`options.js`、`options.css` |
| 导出提示 | `downloadMemory` 返回文件名；记忆页导出后在 `#notice` 标出落地 | `lib/archive.js`、`memory/memory.js` |

**三处绝不挂人设**（测试里反向断言）：

- `reader/lib/decision.js` 的 needWeb 判定——它只允许吐 JSON，人设一进去就开演，解析直接炸。
- `lib/conversation.js:37` `buildSearchQuery`——人设混进检索词就不是搜东西了。
- 存储用 `chrome.storage.sync`，跟浏览器账号走，不进云同步的 WebDAV。

**导出只进下载文件夹**（用户定案）：`showDirectoryPicker()` 在侧栏 iframe 里不可靠，不做。代价是无法记住自定义目录，好处是零新增权限。文件名都带 `知页-` 前缀，在下载列表里一眼能挑出来。

回归：`node --test tests/*.test.js` **60 pass / 0 fail**（新增 `tests/persona.test.js` 8 项）。

## 2026-11-14 · 主题手动切换与联网开关合并

两件事：主题能手动选，两侧的联网开关变成同一个。

| 改动 | 内容 | 文件 |
|---|---|---|
| 新模块 | `<head>` 里同步跑，`localStorage` 先定色防闪白，再对齐 `storage.sync`，只写 `data-theme` | `panel/theme.js` |
| 五个样式表 | `@media (prefers-color-scheme: dark)` 全挤掉，改成 `html[data-theme="dark"]` | `panel/panel.css`、`studio.css`、`typography.css`、`options/options.css`、`memory/memory.css` |
| 侧栏外壳 | 硬编码墨绿 `#f7f8f4`/`#1b2e25`/`#14221e`/`#edf7ed` 全清，也按 `data-theme` 走 | `panel/router.html` |
| 设置页 | 「3 · 外观与字号」顶部加「主题」三档 | `options/options.html`、`options.js` |
| 联网开关 | 网页侧 `mode` 改存 `storage.sync`，并同步 `webEnabled`；没设过 `readerMode` 时按 `webEnabled` 推 | `reader/panel/panel.js` |
| 歧义标签 | 「联网模式」改「联网后的思考档」（它一直是 fast/deep 的推理档，不是要不要联网） | `options/options.html`、`panel/panel.html` |

**一个自己挖的坑**：批量把 media 块改成选择器时，抽提声明的脚本把分号吃了，`color-scheme: dark` 后面直接跟 `--bg`——整块声明作废。现在 `tests/theme.test.js` 有一条专门盯 `color-scheme:\s*dark;` 的分号。

**两套模式到底是什么关系**（之前诊断错了，记一笔）：

- `webEnabled`（`sync`）= 要不要联网，视频侧的「联网搜索」按钮就是它。
- `webMode`（`sync`，`fast`/`deep`）= 联网之后的推理档，**不是**联网开关。只听名字会当成开关，所以改了标签。
- `mode`（网页侧三档）= 仅本页 / 自动判断 / 强制联网。之前只存 `storage.local`，所以跟视频侧互不影响。

现在网页侧改一次，`webEnabled` 跟着变：`auto`/`web` → `true`，`page` → `false`。反过来视频侧点关了联网，网页侧下次开就是「仅当前页」。

回归：`node --test tests/*.test.js` **67 pass / 0 fail**（新增 `tests/theme.test.js` 7 项）。

## 2026-11-14 · 全项目体检（版本 2.0.0）

用户问“还有没有遗漏”，不凭记忆，直接扫了一遍。

**扫出来并修掉的**

| 问题 | 证据 | 处理 |
|---|---|---|
| 记忆页引了两次 `memory.css` | `memory/memory.html` 里 `href="memory.css"` 出现 2 次 | 删掉重复的一个 |
| 记忆页标题还叫「视频学习记忆库」 | `<title>` 实测 | 改「知页 · 记忆」 |
| `manifest.json` 版本停在 1.9.0 | 中间已加主题、人设、删除、双栏 | 升 2.0.0 |
| `docs/HANDOFF.md` 还列着已删的旧目录 | `HANDOFF.md:23` | 标注已删除 |
| `docs/PROGRESS.md:52` 写着“待确认删除”“Git 未提交” | 已过时 | 改成当时状态 + 后续进展 |

**扫了没问题的**：全部页面都挂了 `theme.js`（无遗漏）；`prefers-color-scheme` 零残留；旧绿色 `#147c61`/`#8ee0ae`/`#122c28` 在 CSS/HTML/JS 零命中；`TODO`/`FIXME` 零命中；工作区干净。

**仍开着的真缺口**（写清楚，不假装已经没事）：

1. **真机零验收**。67 项测试全是模拟 `chrome` API。真浏览器里的 iframe 沙箱、`navigator.clipboard`、`chrome.permissions.request` 弹窗、`sidePanel` 具体行为，一个都没实测。
2. **删除后被写回**。那条视频的侧栏如果还开着，下一次 `chat.save()` 会把记录写回本地。要修得改 iframe 消息协议。
3. **两个浏览器同时写 `index.json`** 有极小概率互相盖掉一条索引（无锁）。
4. **网页侧粘贴在 iframe 里**可能被浏览器拒，拒了会在 `#status` 显示原始错误，不会弹窗。

回归：`node --test tests/*.test.js` **67 pass / 0 fail**。

