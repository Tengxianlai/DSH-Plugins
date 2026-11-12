# DSH-Plugins —— 自建 DSH 插件单仓

本仓是自建 DeepSeek Harness 插件的**唯一正本**：一个目录一个插件，全部以 `link:` 挂到
profile 上，走 bundle 托管通道。改这里的代码就是改正在运行的插件。

## 拓扑（实测于 2026-11-13）

| 位置 | 是什么 |
|---|---|
| `~/DSH_ZONE/Projects/DSH-Plugins/plugins/<name>/` | 插件源码正本（本仓） |
| `~/.dsh-wsl/profiles/web/` | 当前唯一在用的 profile（`DSH_PROFILE=web`） |
| `~/.dsh-wsl/profiles/web/node_modules/<name>` | 软链 → 本仓 `plugins/<name>/` |
| `~/.dsh-wsl/profiles/web/package.json` | `dependencies` 记 `link:`；`dsh.profile.bundles` 记托管清单 |
| `~/.dsh-wsl/profiles/web/cordis.patch.yml` | 用户补丁层（模型、MCP 等）。**不在这里挂插件** |
| `~/DSH_ZONE/tools/dsh-rc2-clean/node_modules/@deepseek-ai/` | dsh 发行包，只读 |

`~/.dsh/`（无 `-wsl`）是另一套旧 home，profile 里存的是插件副本，与本仓无关，别混。

## 硬规则

1. **每个插件必须是 bundle**：`package.json` 的 `dsh.bundle.patch` 指向自己的 `cordis.patch.yml`，
   挂载行写在那份 patch 里。没有 `dsh.bundle` 的包，托管安装会直接拒绝（`not-a-bundle`）。
2. **只走托管安装**：新装 `plugin_manager` 的 `install_bundle`（或 Plugins 页面的「添加插件」），
   卸载用 `remove_bundle`。禁止手写 profile 的 `package.json` / `pnpm-workspace.yaml`，也禁止**新增**挂载行；
   唯一允许的手工编辑是**删除**迁移遗留的重复 `insert` 行（改前先备份 `.bak-<时间戳>`）。
   `dsh plugin --profile web add` 只是把参数转给 pnpm，不会补 `dsh.profile.bundles`，不能当托管通道。
3. **一个插件只挂一次**：profile 自己的 patch 里出现同名 `insert` 行即为重复挂载，必须删掉。
4. **零运行时依赖优先**。必须引第三方包时：
   - 在**仓根** `package.json` 的 `dependencies` 声明并跑仓根 `pnpm install`；
   - 插件自己的 `package.json` 用 `peerDependencies` 声明同一包（版本与仓根一致），表示"由宿主/仓根提供"；
   - **不要在插件目录里单独装**：`pnpm install` 加参数只作用于插件目录时，会在插件里长出一份
     `node_modules/`，换机或重建 profile 立刻 `Cannot find module`。`link:` 只连目录，不装依赖。
   - `@deepseek-ai/*` 宿主包（如 `dsh-tools`）由 DSH 运行时提供：运行期解析沿目录树向上找到仓根副本，
     所以仓根那份只服务自测与类型；版本必须与 `DSH_INSTALL_DIR` 的版本一致。
5. **每个插件必带**：`cordis.patch.yml` + 入口文件 + `README.md` + `test/` 或 `scripts/verify.mjs`。
   有界面再加 `client.js`、`icon.svg`、`locale/`，并在 `package.json` 里声明 `dsh.client.platform`。
6. **不碰发行版**：`DSH_INSTALL_DIR` 与其 `node_modules` 只读；不改别人装的包。

## 加一个插件

1. 建 `plugins/dsh-<name>/`，`package.json` 至少包含：`name`、`version`、`private: true`、`type: module`、
   `main`、`dsh.bundle.patch`；有浏览器半边再加 `dsh.client.platform: "web"`。
2. 写 `cordis.patch.yml`：一条 `insert`，`id` 用短名（如 `session-id`），`name` 用包名。
3. 自测：`node --check` 入口与 client 文件；跑插件自己的 `test/`。
4. 仓根 `npm run verify` 必须全绿。
5. 托管安装：把 `plugins/dsh-<name>` 的**绝对路径**作为 `install_bundle` 的 target。
6. 装机后核对四项：profile `package.json` 有 `link:` 依赖、`dsh.profile.bundles` 有该包名、
   `node_modules/<name>` 软链指向本仓、profile patch 里没有同名 `insert`。
7. 在 `README.md` 表格里登记；有持续状态要记的写 `STATE.md`（现状唯一权威）。

## 生效与回滚

- 改**宿主半边**（`index.js` / `lib/`）：必须重启 dsh-web 才生效（插件代码在启动时装入）。
- 改**浏览器半边**（`client.js`）：刷新页面。
- 改**挂载行**（插件自己的 `cordis.patch.yml`）：重启 dsh-web。
- 回滚：插件是软链，`git checkout <tag>` / `git revert` 即可；对外发布过的点打 `git tag <name>@<version>`。
- 卸载：`remove_bundle`，再从 README 表格删行。

## 写插件的 API 契约（踩过的坑）

- **`output.schema` 是标准 JSON Schema，不是 DSH 参数 DSL**。属性级 `required: true` 只适用于
  `parameters`；`output.schema` 必须写成对象层 `required: [...]`。裸 `ctx.tools.register({...})`
  时写错会启动报 `JsonSchemaError: ... required is not supported on type "..."`，整条 entry 不激活。
  稳妥写法：用 `defineTool()` 包一层。
- 工具定义改动后接口不会自己变，见「生效与回滚」：宿主半边必须重启。
- 调用外部 API 时，**先用最小请求验证字段语义**再封装：HTTP 200 + 有返回不代表参数生效
  （例：`/v1/images/edits` 的多参考图必须用重复 `image` 字段；`image[]` 会静默只读第一张）。
  验证要挑一个可量化的信号（usage 里的 token 数、返回张数、尺寸），不要只看"没报错"。

## 已知坑

- 删/挪插件目录会断 profile 里的软链（记录的是绝对路径），必须先重新托管安装再删旧目录。
- 手写挂载行没有兼容性门禁：dsh 升级后不兼容也不会报错，只会启动时炸；bundle 通道会先评估、坏的那层被跳过。
- 本机有两个 dsh home（`.dsh` 与 `.dsh-wsl`）时，确认 `$DSH_PROFILE_DIR` 再动手。
- `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 是**必要**的：DSH 的 rc 包发布不到冷却期，
  去掉后 `pnpm install --frozen-lockfile` 直接 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`。
  原则：只点名确需的包+版本，不写通配；不加新条目除非装包被拒且确认是官方 rc 包。

## 验证与提交

- 改完必须本地过：`node --check <入口>` → 插件自测 → 仓根 `npm run verify` 全绿。
- 提交只 stage 本次归属文件；提交前扫一遍 diff 看有没有密钥/绝对路径泄漏。
- 推 `main` 前确认 `git log origin/main..HEAD` 只有本次要推的提交；推完用 `git status -sb` 确认
  显示 `## main...origin/main`（无 ahead）。
- 插件行为变化要在 `README.md` 的表格行或插件 `README.md` 里写清楚，别只留在提交信息里。
