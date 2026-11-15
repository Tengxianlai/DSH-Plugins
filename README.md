# DSH-Plugins

自建 DSH 插件的单仓正本。每个 `plugins/<name>/` 是一个可托管安装的 bundle，通过 `link:` 挂在
profile 上；挂载行写在插件自己的 `cordis.patch.yml` 里，profile 只记依赖与 bundle 清单。

## 插件清单

| 插件 | 版本 | 半边 | 说明 |
|---|---|---|---|
| `dsh-deliverable-download` | 0.1.0 | host + web | 交付/变更卡片与预览标题栏的「下载」动作，经认证路由以附件下发 |
| `dsh-playwright-per-agent` | 0.2.0 | host | 在每个根 agent 上下文里挂 Playwright MCP |
| `dsh-session-id` | 0.1.0 | host + web | 会话标题栏显示当前 session id，点击复制 |
| `dsh-image-gen` | 0.3.0 | host | GPT（TeamoRouter）与 MiniMax H3-Image 生图/改图：一个工具切换后端；GPT 1K/2K/4K 档位（1K=2K ¥0.18，4K ¥0.60）与人民币价格快照内建 |
| `dsh-minimax-video` | 0.1.0 | host | MiniMax H3 视频：四档模型、480P/768P/2K、首尾帧与多模态参考、768P→2K 再生成，以及提示词/运镜/类型配方 skill |
| `dsh-gemini` | 0.3.0 | host | Gemini 4 Argon 多模态工具：写、看、读、对照；图片/PDF/片段/文本，自然语言提问 |
| `dsh-gemini-creative` | 0.3.0 | host | 按需加载的创作与审看技能：写剧本/文案，或拿场景图、分镜、PDF 与剧本对照 |
| `dsh-claude` | 0.1.0 | host | Claude Opus 5.5 外场专家：难题、多次被反驳、卡住或用户点名时的第二意见；图片/PDF/文本，扩展推理与提示缓存默认开启 |
| `dsh-notify` | 0.4.0 | host + web | 本轮完成 / 出错 / 等待审批 / 等待回答时提醒，四类各有音效；横幅走页面（DSH 图标、可点击聚焦），声音跟着屏幕走（页面 Web Audio；页面关掉时宿主兜底：macOS `afplay` / WSL PowerShell / Linux `paplay`） |

每个插件都带一张 36×36 的 `icon.svg`（青绿 `#2f6f6a` 主体 + 米白 `#f4f1e8` 细节 + 琥珀 `#d99a2b`
点缀），在 `package.json` 顶层用 `icon` 声明；Plugin Manager 和设置页据此显示插件行图标，
`npm run verify` 会校验它存在、在包内、格式与体积合规。

## 装机状态（profile `web`）

| 项 | 值 |
|---|---|
| profile 目录 | `~/.dsh-wsl/profiles/web` |
| 依赖形态 | `link:` → 本仓 `plugins/<name>/` |
| 挂载通道 | bundle（`dsh.profile.bundles`） |
| 生效条件 | 重启 dsh-web；浏览器半边刷新页面 |

> 本机（macOS Desktop 应用）当前生效的是 profile `desktop`：`~/.dsh/profiles/desktop`，
> 插件同样以 `link:` 指向本仓；`~/.dsh-wsl` 在这台机器上不存在。改 profile 前先看 `$DSH_PROFILE_DIR`。

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
