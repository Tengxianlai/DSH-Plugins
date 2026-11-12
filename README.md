# DSH-Plugins

自建 DSH 插件的单仓正本。每个 `plugins/<name>/` 是一个可托管安装的 bundle，通过 `link:` 挂在
profile 上；挂载行写在插件自己的 `cordis.patch.yml` 里，profile 只记依赖与 bundle 清单。

## 插件清单

| 插件 | 版本 | 半边 | 说明 |
|---|---|---|---|
| `dsh-deliverable-download` | 0.1.0 | host + web | 交付/变更卡片与预览标题栏的「下载」动作，经认证路由以附件下发 |
| `dsh-playwright-per-agent` | 0.2.0 | host | 在每个根 agent 上下文里挂 Playwright MCP |
| `dsh-session-id` | 0.1.0 | host + web | 会话标题栏显示当前 session id，点击复制 |
| `dsh-image-gen` | 0.1.0 | host | TeamoRouter 生图/图生图工具：一次调用出图或改图，文件落盘，替代 magpie 的 image MCP |

## 装机状态（profile `web`）

| 项 | 值 |
|---|---|
| profile 目录 | `~/.dsh-wsl/profiles/web` |
| 依赖形态 | `link:` → 本仓 `plugins/<name>/` |
| 挂载通道 | bundle（`dsh.profile.bundles`） |
| 生效条件 | 重启 dsh-web；浏览器半边刷新页面 |

## 常用命令

```sh
cd ~/DSH_ZONE/Projects/DSH-Plugins
npm run verify                      # 全仓体检：manifest / 语法 / 各插件自测
git config core.hooksPath .githooks # 启用提交门禁（本地配置，不入库，换机重设）
git tag <name>@<version>            # 记录对外发布点
node --check plugins/<name>/index.js
```

新装插件走 Plugins 页面或 `plugin_manager install_bundle`，target 用**绝对路径**；
详见 [AGENTS.md](AGENTS.md)。
