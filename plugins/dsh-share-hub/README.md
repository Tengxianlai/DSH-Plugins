# dsh-share-hub

DSH 会话分享中心：**一个入口，两种出口**——把当前会话发布成只读链接，或在本机生成 PDF / HTML / Markdown 后下载。

链接走你现有的反代中转（默认 `https://dsh.soarteng.cn/s/<短码>/`），只读服务跑在本机、只绑回环；导出产物在本机生成，经同源认证路由下发，不上传任何第三方。

## 面板

会话标题栏（标题右侧 chip 区）多一个 **分享** 按钮，浮层面板分两个 tab（分段控件）：

- **分享**：卡片式开关（工具调用 / 工具结果 / 思考 / 脱敏）、链接有效期胶囊按钮；四个动作：
  - **生成链接** → 只读快照发布到 `https://<域名>/s/<短码>/`
  - **导出 PDF** → 本机 Chromium 渲染 A4 PDF，下载保存
  - **导出 HTML** → 自包含单文件，离线可开
  - **导出 Markdown** → 进知识库 / 二次编辑
- **管理分享**：活动链接列表（标题、到期时间、复制、打开、撤销）。
- 面板头部显示当前 **发布地址**（`publicBaseUrl`），换服务器后一眼能确认。

分享页按报告排版：封面标题（取首条提问）+ 元信息 + KPI 卡片（轮次/提问/字数/代码块/工具调用），
正文按轮次切成「问题卡 + 回答流」，代码块带语言头，工具调用折叠成摘要行；深浅色跟随系统。
链接页与导出的 HTML 同一份模板，PDF 用同一份的 A4 打印版。

正文按 GFM 渲染：表格（列对齐）、嵌套列表、任务清单、引用、围栏代码（JSON/JS/TS/Python/Bash 高亮）、
加粗/斜体/删除线/行内代码/链接/图片。只认 http(s) 链接，原始 HTML 一律当文本。

## 安装

托管安装本仓插件（profile `web`）：

```sh
# 用 Plugins 页面的「添加插件」，target 填本目录绝对路径
# 或 plugin_manager 的 install_bundle
```

装完刷新页面（浏览器半体在页面加载时注入）。

## 配置分享服务器

分享地址、本机端口、有效期、内容开关都是**配置项**，两种写法，改完不需要改代码：

### 方式一：插件设置卡（推荐）

**Plugins → Share Hub → 设置**，改完保存即生效（写入 profile 的 Cordis patch）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `publicBaseUrl` | `https://dsh.soarteng.cn/s/` | 分享链接前缀，**必须与反代路径一致**；末尾斜杠自动补齐 |
| `port` | `3099` | 本机只读服务端口，反代/隧道指向它；**改动后需重新加载插件** |
| `chromiumPath` | 空 | 导出 PDF 用的浏览器；留空自动探测（Playwright → 系统 Chrome/Chromium/Edge） |
| `ttlHours` | `72` | 链接默认有效期（1–720 小时） |
| `redact` | `true` | 导出/分享前脱敏 |
| `includeToolCalls` / `includeToolResults` / `includeReasoning` | `false` | 默认只导出真人输入与助手可见文本 |

`publicBaseUrl`、`ttlHours`、内容开关保存后**即时生效**；`port` 决定监听套接字，需重新加载插件
（Plugins 里关再开）。

### 方式二：profile patch 定向覆盖（可版本化）

在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 里写一条**不带 `insert`** 的定向行——
它按 `id` 改现有条目，不会重复挂载：

```yaml
- id: share-hub
  config:
    publicBaseUrl: https://share.example.com/s/
    port: 3099
    ttlHours: 168
    includeToolCalls: true
```

注意：`config` 是**整体替换**，不是深合并——没写的字段回落内置默认值，所以要把需要的字段一次写全。

### 换成自己的服务器

`publicBaseUrl` 只是“链接长什么样”，流量路径要同时对齐三处：

1. **本机端口**：`port`（默认 3099），只读服务只监听 `127.0.0.1`；
2. **隧道/端口转发**：把中转机的一个回环端口转到本机 3099（示例见下一节）；
3. **反代路径**：中转机 nginx 的 `location` 必须与 `publicBaseUrl` 的路径一致，并放行到隧道端口。

例如换成 `https://share.example.com/s/`：本机 `port: 3099` → 隧道
`-R 127.0.0.1:9310:127.0.0.1:3099` → nginx 在 `share.example.com` 上
`location ^~ /s/ { proxy_pass http://127.0.0.1:9310; }`，然后
`publicBaseUrl: https://share.example.com/s/`。

## 反代（一次性）

只读服务只监听 `127.0.0.1:3099`，需要宿主机把 `/s/` 转发进来。本机（WSL）已有的做法：

1. `dsh-tunnel.service` 增加 `-R 127.0.0.1:9310:127.0.0.1:3099`；
2. 中转机 nginx 在 `dsh.soarteng.cn` 的 vhost 里加：

```nginx
location ^~ /s/ {
    proxy_pass http://127.0.0.1:9310;
    proxy_set_header Host $host;
    add_header X-Robots-Tag "noindex, nofollow" always;
}
```

这段必须在 oauth2-proxy 之前匹配（链接本身就是凭据），且只放行 `GET`。

## 安全与隐私

- 只读服务**只绑回环**、只认 `GET /s/<短码>/…`；无写接口、无目录列表、不代理 DSH GUI。
- 链接是**地址即凭据**：短码 8 位 base36（≈41 bit），转发即再分享；撤销/到期后立即 404。
- 导出与链接内容都会经过脱敏（API key、GitHub token、AWS key、Bearer、私钥块、家目录绝对路径）；**尽力而为，不是保证**——业务机密、客户名、内网 IP 挡不住，发之前自己过一眼。
- 工具结果默认不导出；思考过程默认不导出。
- **注入上下文不导出**：DSH 把 AGENTS.md、运行时快照、技能目录、时间上下文也发成 `user` 角色消息，
  但 `source.kind` 不是 `user`；导出只收 `source.kind === "user"` 的真人输入，系统提示词不会进快照。
- 导出文件落在 `$DSH_HOME/share-hub/exports/`，只经认证路由下发；链接快照在 `$DSH_HOME/share-hub/sites/<短码>/`。

## PDF 怎么生成

本机 Chromium 内核 `--headless --print-to-pdf`，不联网、不用云端：

- Linux/WSL：`~/.cache/ms-playwright/current/chrome` → 系统 `chromium` / `google-chrome`
- Windows：系统自带 Edge（`msedge.exe`）→ Chrome
- 找不到时明确报错并提示安装或配置 `chromiumPath`

## 已知限制

- 链接只在**本机 + 隧道都在线**时可用；机器或隧道停了就 404（中转不存内容）。
- 桌面宿主（Electron）目前没有这条隧道：链接分享以 Web 宿主为准，桌面端用导出/下载。
- 桌面端「保存到哪个文件夹」由 Electron 下载流程决定；若官方桌面端不弹保存框，后续在这里接 `showSaveDialog`。
- 图片附件暂未内联（只导出文本、工具调用摘要与工具结果）。

## 自测

```sh
node --check index.js client.js lib/*.js
node scripts/verify.mjs
```

覆盖脱敏、快照规范化、HTML/Markdown/打印渲染、导出与下载路由、短码白名单、只读服务的越界与过期、分享目录的创建/撤销/清理，以及本机 Chromium 真实生成 PDF。
