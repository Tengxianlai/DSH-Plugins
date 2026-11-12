# STATE.md —— dsh-deliverable-download 现状（现在时，唯一权威）

> 只回答"现在是什么样"。与其它文档冲突以本文件为准；与代码/运行现场冲突**以现场为准，并立刻改本文件**。
> 过去时（为什么这么选）→ `docs/decisions/`；将来时（要变成什么样）→ 本仓暂无目标基线文件。

**最后核实**：2026-11-13（迁入 DSH-Plugins 单仓并改走 bundle 托管通道；DSH 0.2.2-rc.2）

## 1. 东西在哪（拓扑）

| 位置 | 是什么 | 状态 |
|---|---|---|
| `~/DSH_ZONE/Projects/DSH-Plugins/plugins/dsh-deliverable-download/` | 源码正本（本仓） | 维护中（2026-11-13 从 `tools/` 迁入） |
| `~/.dsh-wsl/profiles/web/node_modules/dsh-deliverable-download` | 软链 → 正本（DSH 的插件解析路径） | 待重装（迁移后重新托管安装） |
| `~/.dsh-wsl/profiles/web/package.json` | `dependencies` 记 `link:`；`dsh.profile.bundles` 含本包 | 托管通道（2026-11-13 起） |
| 本包的 `cordis.patch.yml` | 挂载行 `- id: deliverable-download / name: dsh-deliverable-download` | 已写入；**只在 dsh 启动时读取** |
| 运行中的 dsh-web | 迁移前已加载；**重启后**才走 bundle 通道 | 待重启 |

## 2. 已停用 / 已废止

| 东西 | 停用日期 | 为什么 | 恢复/追溯入口 |
|---|---|---|---|
| （暂无） | | | |

## 3. 现在有效的关键结论（代码里看不出来的）

1. **为什么必须有它**：远程浏览器（Mac/PC 访问跑在 WSL 上的 DSH）拿不到交付文件。
   DSH 原有两条动作对远程都不成立（权威测量见第 6 节的 skill，本仓只记结论）：
   - 侧边栏预览受 iframe 沙箱限制 —— HTML 预览把文档塞进 `blob:` 的
     `sandbox="allow-scripts"` iframe：相对路径在 blob 文档里解析不了（连请求都不发）；
     就算写成绝对 `/api/file?path=`，不透明源也带不上 `SameSite=Strict` 的会话
     Cookie，服务端 401。本机实测（2026-10-19）：同一地址 `allow-scripts` 下
     `naturalWidth=0`，加上 `allow-same-origin` 才是 720。
   - 「在本地打开 / 显示文件位置」是**主机侧**动作：在跑 DSH 的那台 WSL/Windows 上
     执行 `explorer.exe`。远程浏览器只会看到「当前工作区或本地应用不可用」。
2. **下载为什么能成**：卡片上的 `<a href download>` 是**顶层同源 GET**，会话 Cookie 会带上；
   服务端再给 `Content-Disposition: attachment`，浏览器直接存盘。
   预览 iframe 里做不到的事，在卡片/标题栏这一层是成立的。
3. **客户端插件清单是启动时构建的**：DSH 的 client-modules 按 Loader 条目扫 `dsh.client`
   并组合 `__DSH_BOOT__`（源码注释：owing-tree base URL "until restart"）。
   所以**加了插件必须重启 dsh-web**；bundle 层同样是启动时合并的 —— 两者一致。
4. **本包刻意零第三方依赖**：profile 的 `node_modules`（`~/.dsh-wsl/profiles/web/node_modules/`）
   里**没有** `@deepseek-ai/*`——那些包装在 `~/DSH_ZONE/tools/dsh-rc2-clean/node_modules/`。
   所以宿主半体不 import 任何东西（连 `node:path` 都自己写了 `basename`），
   浏览器半体只用 ModuleLoader 的静态模块（`react`、`ui-primitives`）。
   一旦引第三方依赖，必须同时往 profile 的 `node_modules` 里装。
5. **两条路由的坐标与官方同族路由一字不差**：`/api/present.download` 对应
   `/api/present.open`（`deliverables/presented` 事件 + 第 index 个文件）；
   `/api/changes.download` 对应 `/api/changes.open`（`workspace/changes` 摘要 + 第 index 个文件）。
   校验链（`sessionQuery.readEvent` / `workspaceChanges.summary` → `workspaceFiles.stat`
   → `fs` 主机路径往返核对）照抄官方实现，只把最后一步"调原生程序"换成"读字节"。
6. **三个入口**（都在浏览器侧，与主机桌面无关）：交付卡片
   `deliverables.file.actions`、变更文件卡片 `deliverables.review.file.actions`
   （都靠 actionUrl 末段 `.open` → `.download`）、预览标题栏
   `sidebar.right.tab.document.actions`（用 ownerProps 的 `absolutePath` 拼 `/api/file`，
   文件名由 `<a download>` 给，因为 `/api/file` 不设 Content-Disposition）。
7. **没有覆盖的**：正文里"提到"但**当轮没产出/没交付**的文件，聊天渲染出的路径芯片是
   惰性的（官方 `producedFileMentions` 只解析当轮 produced/presented 路径）——那种文件要
   靠右侧「文件」面板打开后从标题栏下载，或让 agent 用 `present` 交付一下。

**2026-10-20 rc.2 复核（升级后重跑契约检查）**

| 检查 | 结果 |
|---|---|
| 原生是否已提供下载动作 | **没有**：交付卡片客户端包里只有 `api/present.open`、`api/present.host`、`api/changes.open/.diff/.summary`，无 download 动作、无 `Content-Disposition` 路由 ⇒ 本插件仍必要 |
| 三个挂载槽位 | `deliverables.file.actions`、`deliverables.review.file.actions`、`sidebar.right.tab.document.actions` 在 rc.2 仍在 |
| 宿主依赖的服务 | `sessionQuery.readEvent`、`workspaceChanges.summary`、`workspaceFiles.stat`、`fs.*`、`connection.fetch.register` 在 rc.2 都在 |
| 两条路由是否注册 | `/api/present.download`、`/api/changes.download` 无 Cookie → **401**（与官方 `/api/present.open` 同码，说明仍在认证围栏后，不是 404） |
| 客户端半体是否下发 | 页面组合包里 `dsh-deliverable-download` 出现 11 处 ⇒ 已随 rc.2 的 client-modules 组合下发 |

## 4. 验收记录 / 在制品

**2026-10-19 真机验收**（重启后 MainPID 379 → 89762；用本机无头 CfT 驱动真实界面）

| 验收项 | 结果 |
|---|---|
| 两条路由是否注册 | 无 Cookie → **401**（不是 404，说明在认证围栏后） |
| 交付卡片图标 | 3 张交付卡片 → 3 个图标，href 精确等于 `/api/present.download?sessionId=…&seq=5906/5966/6110&index=0` |
| 点图标真存盘 | 得到 `rehearsal-qr.png`（6183 B），**sha256 与源文件逐字节一致**（`4a40a694…`），页面未跳转 |
| 中文文件名 | `查寝员端-样张.inlined.html`（12 640 104 B）→ `Content-Disposition` 带 ASCII 回退 + `filename*`；sha256 与源一致（`4920c4d3…`） |
| 预览标题栏（**非交付文件**） | 从「文件」面板打开工作区里的 `AGENTS.md` → 标题栏出现图标 → 点它存下 2249 B，sha256 与源一致（`93fae07a…`） |
| 坐标不存在 | 修复后 → 404（修复前是 500，见下） |

**验收中发现并修掉的两个缺陷**（都已进本仓）：

1. **tooltip 显示原始 key**（`downloadNamed`）：客户端半体没把 `locale` 写进 `inject`，
   而原先的 `try/catch` 兜底把"字典没注册上"这件事吞掉了。修法：inject 补 `locale`、
   删掉兜底文案与吞错（一份字典、一个真相）。
   **已现场验证**：同一浏览器 UI 为英文，tooltip 显示 `Download` / `Download AGENTS.md`（插值也通）。
2. **坐标不存在时返回 500 而非 404**：查询层抛的是 `SESSION_QUERY_EVENT_NOT_FOUND`
   （session-query 的字符串码），不在映射表里。修法：补官方 `failureStatus` 同口径的码，
   并容错读一层嵌套码。
   **修正需再重启一次**才在运行进程里生效（宿主半体是启动时载入的，machine 层无 HMR）。

**在制品 / 未覆盖**：

- 第二次重启（已排定）以让上述第 2 条生效。
- **变更文件卡片**的图标渲染未现场看到：那类卡片要求当轮 `workspace/changes` 摘要还在
  （重启后旧摘要已失效，界面上只见到 404 的摘要请求）。同一代码路径的地址改写有单测，
  路由注册已由 401 证明；但"变更卡片点一下存盘"**没有**像另两个入口那样点过。
- 客户端半体的改动（第 1 条）**不需要**重启即可生效——浏览器半体是按请求从磁盘取的。

## 5. 每条事实的「何时会陈旧」

| 事实 | 什么时候必须回来改 |
|---|---|
| 官方路由名 `/api/present.open` `/api/changes.open` 及其坐标 | DSH 升级后（改名则两半都要跟着改；对账脚本会红） |
| "客户端插件必须重启才生效" | DSH 支持客户端插件热加载之后 |
| iframe 沙箱与 SameSite 的边界（第 3.1 条） | 官方改了预览 iframe 的 sandbox 或 Cookie 策略之后 |
| 三个入口的槽位 id | 官方调整 `deliverables.*.actions` / `sidebar.right.tab.document.actions` 之后 |
| 安装软链与 bundle 挂载 | 任何一次挪动正本 / 重装 DSH / 换机器 |
| 本插件的存在意义 | 官方把"下载"并入交付卡片之后（本插件可退场） |

## 6. 外部事实指针（basic-memory）——只留指针，不复制内容

| 主题 | 笔记 | 覆盖什么 |
|---|---|---|
| DSH 运行环境（本机） | `bm:env/DSH WSL 运行环境基线.md` | dsh-web 单元、端口、启动方式、重启命令 |
| 交付/预览边界的权威测量 | skill `html-report-assets`（`~/.dsh/skills/html-report-assets/SKILL.md`） | HTML 预览两种模式取不到相对图片的实测结论、内联做法；本仓只引用，不复制 |

## 质量门

```bash
node scripts/verify.mjs        # 两个半边自测 + 语法 + 对账
```

`.githooks/pre-commit` 调用同一个脚本；仓库本地已设 `core.hooksPath=.githooks`
（该配置不入库，换机器要重设一次，见 README）。

<!-- 机器可判部分：scripts/check-docs-drift.mjs 读这个块 -->

```drift-check
present-tense-files: README.md, STATE.md
retired:
```
