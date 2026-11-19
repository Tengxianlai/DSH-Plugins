# dsh-share-hub 现状

> 本文件是插件的现状权威；行为变化先改这里，再改 README。

## 2026-11-18 · 0.2.0 面板现代化 + 分享服务器配置项

**面板**：标题栏按钮不变；浮层重做——毛玻璃遮罩、圆角 18px 卡片、渐变图标块、
分段 tab、卡片式开关（自定义 switch）、有效期胶囊、主按钮渐变、成功态结果卡（复制/下载）、
管理列表行 hover；`prefers-reduced-motion` 下关闭动效。头部显示当前 `publicBaseUrl`。

**配置**：导出 `Config`（`@deepseek-ai/schemastery`），字段 `publicBaseUrl` / `port` /
`chromiumPath` / `ttlHours` / `redact` / 三个内容开关，全部 `.volatile()`——出现在
**Plugins → Share Hub → 设置卡**。运行时通过 `loader/volatile-update` 重读：
`publicBaseUrl`、`ttlHours`、内容开关即时生效；`port` 只影响启动时监听，需重载插件。

**文档**：README 新增「配置分享服务器」：设置卡字段表、profile patch 定向覆盖示例
（不带 insert，按 id 改现有行；config 整体替换）、以及换服务器时
「端口 → 隧道 → 反代路径 → publicBaseUrl」四处对齐清单。

**依赖**：仓根 `dependencies` 增加 `@deepseek-ai/schemastery@3.19.0`（与 DSH 安装一致），
插件 `peerDependencies` 同步声明。

**验证**：离线 19/19（新增配置默认值/volatile 解引用用例）；角色注册模拟通过。

## 2026-11-18 · 0.1.4 正文改 GFM 渲染

**问题**：0.1.3 的正文只认围栏代码、标题、简单列表，Markdown 的表格、嵌套列表、任务清单、
强调、删除线、图片、裸 URL 都按纯文本输出——「不像给人看的」。

**改动**：新增 `lib/markdown.js`（零依赖 GFM 子集）：

- 块：围栏代码（```/~~~）、ATX 标题、引用（递归）、有序/无序列表（缩进嵌套）、
  GFM 表格（`:--`/`:-:`/`--:` 对齐）、任务清单 `[x]`、分割线、段落保留换行；
- 行内：代码、加粗、斜体、删除线、`[文字](链接)`、`![图](链接)`、裸 URL 自动链接；
- 只认 http(s) 链接，`javascript:` 等一律当文本；原始 HTML 不执行；
- 代码高亮：JSON 专用分词（键/字符串/数字/字面量），JS/TS/Python/Bash 通用分词
  （注释/字符串/数字/关键字），其它语言原样转义；
- 只读服务 CSP 的 `img-src` 增加 `https:`，远程图片可显示（`referrerpolicy=no-referrer`、lazy）。

**验证**：离线 18/18（新增表格对齐、嵌套列表、任务清单、高亮、`javascript:` 链接用例）；
用带表格/嵌套列表/任务清单/高亮代码的合成会话渲染并截图目检（docs/preview.png）。

## 2026-11-18 · 0.1.3 修复系统提示词泄漏

**问题**：0.1.2 的分享页把系统注入内容一起导出了（AGENTS.md、运行时快照、技能目录、时间上下文）。
根因：DSH 把这些内容发成 `user` **角色**消息，只有 `source.kind` 不同（`agent-instructions` /
`runtime-context` / `skill-catalog` / `time-context` / `action-cards` / `user-approval`），
旧实现只按 role 过滤。

**修复**：`normalizeMessages` 增加 source 过滤——`user` 只收 `kind === "user"`，
`assistant` 只收 `kind === "model"`，`tool` 只收 `kind === "tool"`。

**处置**：已生成的两条泄漏链接（`nr8wx55g`、`6ofai8qx`）页面目录已移出到
`/tmp/share-quarantine/`，公网立即 404；索引条目待撤销或到期回收。

**验证**：真实会话日志（session-60a6ae0d…）派生后按 role/source.kind 统计为
`user/user` 10、`agent-instructions` 1、`runtime-context` 2、`skill-catalog` 1、`time-context` 6、
`action-cards` 1、`user-approval` 1；过滤后 19 条消息、注入内容残留 0。离线自测 16/16。

## 2026-11-18 · 0.1.2 分享页改版（为人读）

**问题**：0.1.0/0.1.1 的链接页是平铺消息流（「你/助手」两段），像日志不像文章。

**改版**（参考 dsh-session-export 的报告页结构）：

- 封面区：eyebrow + 由首条提问派生的标题 + 导出时间/工作目录；
- KPI 卡片：轮次、提问、字数、代码块、工具调用；
- 按轮次切分：每轮一个问题卡（左侧强调条）+ 回答流，轮次分隔线；
- 轻量 Markdown：标题、列表、引用、分割线、围栏代码（带语言头）、行内代码/加粗/http(s) 链接；
- 工具调用/工具结果/思考默认折叠成 `<details>` 摘要行（打印版展开）；
- 深浅色跟随系统；打印版 A4 浅色、代码 9pt、问答卡片不跨页断开。

**验证**：`scripts/verify.mjs` 15/15；另用合成会话渲染页面与 PDF 并截图目检（文章版式正常，中文/代码/列表/引用均正确）。

## 2026-11-18 · 0.1.1 弹层修复

**问题**：0.1.0 把弹层用 `position:fixed` 渲染在会话头部槽位里；头部容器带裁切/层叠上下文，
弹层被裁掉，点击按钮视觉上「没反应」。

**修复**：弹层改挂 AppFrame 官方浮层座位 `shell.overlay`（`kind:list, scope:root`），
标题栏按钮只通过模块级 store 置 `open`；弹层根用 `position:absolute; inset:0`。
注册 `shell.overlay` 加了 try/catch——旧宿主没有该座位时只丢弹层，不会连按钮一起消失。

**验证**：Node 模拟客户端加载，`apply` 两条注册均成功
（`conversation.session.header.actions#share-hub`、`shell.overlay#share-hub-overlay`）。

## 2026-11-18 · 0.1.0 首次上线

**代码**：`plugins/dsh-share-hub/`（bundle，host + web 半边）。托管安装到 profile `web`，
`application=applied`，无需重启 dsh-web。

**本机**：

- 只读服务监听 `127.0.0.1:3099`（端口被占时自动退随机端口，以日志为准）。
- 数据：`$DSH_HOME/share-hub/{sites/<短码>/,exports/,state.json}`。
- 导出走同源认证路由 `api/share-hub/download`，带 `Content-Disposition`。
- PDF：本机 Chromium `--headless --print-to-pdf`，本机探测 Playwright 缓存 → 系统 chrome/chromium；
  Windows 桌面宿主按 Edge → Chrome 探测。

**中转（`tengxlper-lab-01`）**：

- `dsh.soarteng.cn` vhost 新增 `location ^~ /s/` → `proxy_pass http://127.0.0.1:9310`，
  不挂 `auth_request`（链接即凭据），只放行 GET/HEAD。
- 隧道单元 `dsh-share-tunnel.service`（WSL → lab-01 `127.0.0.1:9310` → WSL `127.0.0.1:3099`），
  与 `dsh-tunnel.service` 分开，坏只坏 `/s/`。

**lab-01 上的改动与回滚**（改前均有备份）：

| 改动 | 备份 | 回滚 |
|---|---|---|
| `/etc/nginx/sites-available/dsh.soarteng.cn.conf` 插入 `location ^~ /s/` | `*.bak-20261118-202024` 左右（同目录 `ls -t *.bak-*`） | 还原备份文件 → `nginx -t` → `systemctl reload nginx` |
| `/etc/ssh/sshd_config` 的 `Match User dsh-tunnel` 增加 `PermitListen 127.0.0.1:9310` | `/etc/ssh/sshd_config.bak-20261118-201949` | 还原 → `sshd -t` → `systemctl reload ssh` |
| `/var/lib/dsh-tunnel/.ssh/authorized_keys` 增加 `permitlisten="127.0.0.1:9310"` | 同目录 `.bak-20261118-*` | 还原（保持属主 `dsh-tunnel`、权限 600） |

**已验证**：

- 离线 14/14：脱敏、规范化、三种渲染、导出/下载路由、短码白名单、只读服务越界与过期、目录创建/撤销/清理、真实 PDF。
- 端到端：种一条分享 → 公网 `https://dsh.soarteng.cn/s/<短码>/` 返回 200 与页面正文；
  9 秒内恢复生产隧道后 `http://127.0.0.1:9310/healthz` 仍为 200。

**待办 / 已知缺口**：

- 桌面端（Windows Electron）保存目录行为未验证：下载路由已按官方下载插件同一模式实现，
  是否需要接 `showSaveDialog` 取决于桌面端下载处理器。
- 图片附件尚未内联（当前只导出文本、工具调用摘要、工具结果）。
- 会话标题暂用 id 前缀，接入标题投影后再换成真实标题。
- 分享页消费端没有访问计数；需要时从中转机 access log 派生。
