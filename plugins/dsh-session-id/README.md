# dsh-session-id

在 DSH Web 的会话标题栏显示当前会话 ID，点一下把三行一起复制到剪贴板（已知几个写几个）：

```text
session-81e19121-b2fc-4a0b-99d1-d8fc7199945d
/home/me/.dsh-wsl/sessions/--home-me-DSH_ZONE-Projects-DSH-Plugins--/session-81e19121-b2fc-4a0b-99d1-d8fc7199945d
/home/me/DSH_ZONE/Projects/DSH-Plugins
```

第一行是完整 session id，第二行是这个会话**在磁盘上的存储目录**（`session.v4.jsonl.zstd` 所在目录），
第三行是会话的工作目录。把这段贴给另一个会话，对方就能直接去读日志/排查，不用再翻 URL 或问路径；
工作目录那行让对方同时知道项目在哪。目录拿不到时（宿主路由缺失、会话还没落盘、或日志已删除）
退回只复制 id——复制动作永远不被查询拖住。

## 组成

- **宿主半边**（`index.js`）：Connection 认证围栏内一条只读路由
  `GET /api/session.location?sessionId=<id>` → `{ sessionId, dir, log, cwd }`。
  位置来自 `ctx.sessionPersistence.stat()` 快照的 `location`，工作目录来自 `header.cwd`
  （存储根是 profile 配置，浏览器算不出来），只读文件元信息与 header：不读事件日志、不创建 Agent；
  失败只回错误码，不回显可能带主机绝对路径的异常文本。
- **浏览器半边**（`client.js`）：渲染截断后的 id 与复制交互。挂载时预查一次存储位置，
  拿到后 tooltip 显示「会话 ID / 存储目录 / 工作目录」；点击时同步读缓存并复制三行，
  不用等网络。点得太早（查询还没回来）就先复制 id，并补发一次查询。
- **挂载**：`cordis.patch.yml` 里一条 `insert`（`id: session-id`，`name: dsh-session-id`）。

生效：改宿主半边（`index.js`）标准路径是重启 dsh-web；改浏览器半边（`client.js`）刷新页面。
本机开着 HMR 时，宿主半边也能热换：触发一次 profile 重组合即可（2026-11-16 实测：临时创建
`$DSH_HOME/cordis.patch.yml` 再删掉，dsh-hmr 会在重组合时替换 link 目标里改过的模块，
只换本插件、其他会话的 turn 不受影响；没必要为此重启进程）。

## 测试

```sh
node --check index.js && node --check client.js
node test/host.test.mjs     # 路由坐标、200/400/404/499/500/503、异常不回显路径
node test/client.test.mjs   # tooltip 三态、复制三行、只复制 id 的退化、切会话取消旧请求
```
