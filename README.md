# dsh-deliverable-download

给 DSH Web 加「下载」：点一下，文件以附件形式存到**浏览器所在的机器**（Mac / PC），而不是像现在这样只能在服务端那台机器上打开。

## 解决什么问题

DSH 原本只有两条"打开文件"的动作，对远程浏览器（Mac/PC 访问跑在 WSL 上的 DSH）都不解决问题：

| 动作 | 远程浏览器的真实效果 |
|---|---|
| 点卡片 → 侧边栏预览 | 受 iframe 沙箱限制：HTML 里的相对图片、`/api/file` 图片都取不到（不透明源带不上 `SameSite=Strict` 会话 Cookie，实测 401）。PDF/图片/md 能看，但只是在**浏览器里看**，拿不走 |
| 「打开方式 / 显示文件位置」 | **主机侧**动作：在跑 DSH 的那台 WSL/Windows 上执行 `explorer.exe`。远程浏览器只会看到「当前工作区或本地应用不可用」 |

本插件补第三条路：把文件当附件交给浏览器。

## 三个入口（都覆盖）

| 入口 | 槽位 | 做法 |
|---|---|---|
| **交付卡片**（`present` 交付的文件） | `deliverables.file.actions` | 卡片自带 actionUrl 是 `api/present.open?sessionId&seq&index` → 末段改成 `.download`，宿主侧新路由读字节返回 |
| **变更文件卡片**（git 变更摘要） | `deliverables.review.file.actions` | 同上，`api/changes.open` → `api/changes.download` |
| **预览标题栏**（任何被预览的文件，含只用「文件」面板打开的） | `sidebar.right.tab.document.actions` | 不需要宿主新路由：文档预览的 ownerProps 给 `absolutePath`，用官方 `/api/file?path=`，文件名由 `<a download>` 带 |

**为什么下载能成而预览不行**：卡片/标题栏上的 `<a href download>` 是**顶层同源 GET**，会话 Cookie 会带上；服务端再给 `Content-Disposition: attachment`，浏览器直接存盘。预览 iframe 里做不到的事，在这一层成立。

**没覆盖的**：正文里"提到"但当轮**没产出、没交付**的文件，聊天渲染出的路径芯片是惰性的（官方 `producedFileMentions` 只解析当轮 produced/presented 路径）。那种文件请走右侧「文件」面板打开后从标题栏下载，或让 agent 用 `present` 交付一次。

## 组成

- `lib/index.js` —— 宿主半体。认证围栏内的两条只读路由：
  `GET /api/present.download` 与 `GET /api/changes.download`（坐标与官方
  `/api/present.open`、`/api/changes.open` **一字不差**，校验链照抄官方实现，
  最后一步从"调原生程序打开"换成"读字节 + `Content-Disposition: attachment`"）。
- `client.js` —— 浏览器半体。往三个槽位各加一个 28×28 下载图标。
- `STATE.md` —— 现状（唯一权威）；`scripts/check-docs-drift.mjs` —— 对账；
  `scripts/verify.mjs` —— 质量门。

零第三方依赖：宿主半体只用注入的服务与 `Response`（连 `node:path` 都不用），
浏览器半体只用 ModuleLoader 的静态模块（`react`、`@deepseek-ai/dsh-client-ui-primitives`）。
原因见 STATE.md 第 3.4 条——profile 的 `node_modules` 里没有 `@deepseek-ai/*`。

## 安装（WSL / Teng-PC）

正本 `~/DSH_ZONE/tools/dsh-deliverable-download/`，安装位（软链）
`~/.dsh/profiles/web/node_modules/dsh-deliverable-download`；
`node_modules/` 在 DSH-Home 的 `.gitignore` 里，不污染版本库。

```bash
ln -s ~/DSH_ZONE/tools/dsh-deliverable-download \
      ~/.dsh/profiles/web/node_modules/dsh-deliverable-download
```

挂载：在**本机层** `~/.dsh/machine.yml` 加（不放共享层，Mac 上没装这个包）：

```yaml
- insert:
    - id: deliverable-download
      name: 'dsh-deliverable-download'
```

重启（`machine.yml` 与客户端插件清单都只在启动时读取；**不要在会话进行中重启**，会掐断正在跑的 turn）：

```bash
systemctl --user restart dsh-web
```

换机器后启用提交门禁（`core.hooksPath` 是本仓本地配置，不入库）：

```bash
git config core.hooksPath .githooks
```

## 验证

两个半边各自的自测 + 语法 + 对账，一条命令：

```bash
node scripts/verify.mjs
```

- `test/host-route.test.mjs`：假 ctx 捕获两条路由，覆盖 200 附件响应与响应头
  （含中文文件名的 `filename*`）、工作区根回退、400/404/422、FS 失败码映射、MIME 回退。
- `test/client-href.test.mjs`：假 `__ModuleLoader__` 载入浏览器半体，断言三个槽位的注册，
  以及地址改写（`present.open`→`present.download`、`changes.open`→`changes.download`、
  `absolutePath`→`/api/file?path=`）与边界拒绝（相对路径/UNC/控制字符）。
- `scripts/check-docs-drift.mjs`：宿主路由 ↔ 浏览器改写必须一一对上、安装软链与
  `machine.yml` 挂载在位、现在时文件引用的路径存在、已停用术语带标记。

重启起效后按这三步验收（**当前尚未验收，见 STATE.md 第 4 节**）：

1. 交付一个文件 → 卡片右下出现下载图标（在 open-in-app 左边）；打开一个被修改的文件 → 变更卡片同样有。
2. 预览任一文件 → 标题栏出现下载图标；点它浏览器存盘，文件名与工作区一致（中文/空格也对）。
3. 无 Cookie 直连任一路由应得 401（认证围栏生效）：

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  'http://127.0.0.1:3080/api/present.download?sessionId=<id>&seq=<seq>&index=0'
```

## 卸载

删 `machine.yml` 里那一节 + 移除软链 + 重启 dsh-web。

## 已知边界

- 单次响应上限 512 MiB（`lib/index.js` 的 `MAX_BYTES`）。
- 只读：只服务已存在的文件，不新增任何可写入面。
- 正文里惰性的路径芯片（当轮未产出/未交付）没有下载入口，见上面「没覆盖的」。
