# STATE.md —— dsh-deliverable-download 现状（现在时，唯一权威）

> 只回答"现在是什么样"。与其它文档冲突以本文件为准；与代码/运行现场冲突**以现场为准，并立刻改本文件**。
> 过去时（为什么这么选）→ `docs/decisions/`；将来时（要变成什么样）→ 本仓暂无目标基线文件。

**最后核实**：2026-10-19（源码与单测当场跑过；"已生效"一栏**尚未**现场核实——见第 4 节）

## 1. 东西在哪（拓扑）

| 位置 | 是什么 | 状态 |
|---|---|---|
| `~/DSH_ZONE/tools/dsh-deliverable-download/` | 源码正本（本仓） | 维护中 |
| `~/.dsh/profiles/web/node_modules/dsh-deliverable-download` | 软链 → 正本（DSH 的插件解析路径） | 已建立（2026-10-19） |
| `~/.dsh/machine.yml` 末节 | 挂载行 `- id: deliverable-download / name: 'dsh-deliverable-download'` | 已写入；**只在 dsh 启动时读取** |
| 运行中的 dsh-web | 尚未加载本插件 | **待重启**（见第 4 节） |

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
   所以**加了插件必须重启 dsh-web**，`machine.yml` 又是启动时读取的 —— 两者一致。
4. **本包刻意零第三方依赖**：profile 的 `node_modules`（`~/.dsh/profiles/web/node_modules/`）
   里**没有** `@deepseek-ai/*`——那些包装在 `~/DSH_ZONE/tools/dsh-alpha/node_modules/`。
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

## 4. 未完成 / 在制品

- **重启后的真机验收（唯一未完成项）**：重启 dsh-web 后要核实三件事——
  ① 三个入口的下载图标出现；② 点它浏览器存盘、文件名（含中文/空格）正确；
  ③ 路由在认证围栏后（无 Cookie 401，带 Cookie 200 且字节一致）。
  在此之前**不得**声称"已生效"。
- 这一步无法在重启前完成：客户端插件清单在进程启动时构建。

## 5. 每条事实的「何时会陈旧」

| 事实 | 什么时候必须回来改 |
|---|---|
| 官方路由名 `/api/present.open` `/api/changes.open` 及其坐标 | DSH 升级后（改名则两半都要跟着改；对账脚本会红） |
| "客户端插件必须重启才生效" | DSH 支持客户端插件热加载之后 |
| iframe 沙箱与 SameSite 的边界（第 3.1 条） | 官方改了预览 iframe 的 sandbox 或 Cookie 策略之后 |
| 三个入口的槽位 id | 官方调整 `deliverables.*.actions` / `sidebar.right.tab.document.actions` 之后 |
| 安装软链与 `machine.yml` 挂载 | 任何一次挪动正本 / 重装 DSH / 换机器 |
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
