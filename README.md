# DSH-Plugins

自建 DSH 插件的单仓正本。每个 `plugins/<name>/` 是一个可托管安装的 bundle，通过 `link:` 挂在
profile 上；挂载行写在插件自己的 `cordis.patch.yml` 里，profile 只记依赖与 bundle 清单。

## 插件清单

| 插件 | 版本 | 半边 | 说明 |
|---|---|---|---|
| `dsh-deliverable-download` | 0.1.0 | host + web | 交付/变更卡片与预览标题栏的「下载」动作，经认证路由以附件下发 |
| `dsh-playwright-per-agent` | 0.2.0 | host | 在每个根 agent 上下文里挂 Playwright MCP |
| `dsh-session-id` | 0.2.0 | host + web | 会话标题栏显示当前 session id；点击复制带说明的三行（会话 ID / 存储目录＝日志所在 / 工作目录），粘贴即可让其他会话去读日志 |
| `dsh-image-gen` | 0.4.0 | host | 生图/改图，保留2K/4K费用保护；新增离线预演、required/hash参考契约、输入/输出收据与并发防覆盖 |
| `dsh-minimax-video` | 0.2.1 | host | H3七个工具：离线准备、累计预算、可恢复任务与原始输入追溯；登记项目兼容未用素材ID空占位，附跨项目资产登记、本地QA及两项生产技能 |
| `dsh-gemini` | 0.4.0 | host | Gemini 4 Argon文学写作与必要综合判断；本地技术QA优先，媒体目的/证据预检、默认不自动加预算重试、逐次累计用量 |
| `dsh-gemini-creative` | 0.4.0 | host | 写剧本/对白/文案及必要素材对照；技术证据由本地工具与子代理整理，新项目先登记批准资产 |
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
| 生效条件 | 以托管安装/重载结果的 applied 与 nextStep 为准；不直接改profile文件，不重启正在工作的轮次；web半边改动另核构建与页面刷新 |

> 每台宿主以 `$DSH_HOME`、`$DSH_PROFILE_DIR` 和当前运行态为准。2026-11-16本轮是在WSL的web profile核查；macOS Desktop的desktop profile是另一宿主，不能用旧机器的目录是否存在推断当前环境。

## AI视频项目的入口

新项目先加载 `ai-video-production`，建立批准人物／场景／关键帧及原生声线的登记，再由具体生成工具执行。可复用步骤与本地CLI在[生产工作流](plugins/dsh-minimax-video/skill/production-workflow.md)，API边界在[H3技能](plugins/dsh-minimax-video/skill/SKILL.md)。本地声明记录不认证人的身份；插件可校验实际字节、来源槽位、证据范围与账务约束。

本轮可复用入口、已生效版本、真实本地验证与未核定边界见[AI视频修复交接](docs/review/AI_VIDEO_20261116/HANDOFF.md)。

本轮修复依据是[65会话历史审计](docs/review/AI_VIDEO_20261116/history/README.md)、[本地工具与资产复用盘点](docs/review/AI_VIDEO_20261116/local-tools/REPORT.md)及[独立复核决策](docs/review/AI_VIDEO_20261116/lead-expert/DECISIONS.md)。旧Mac日志不在本机，未把缺失部分写成已审；时区、原始下载与转码交付的哈希、旧拒绝与后来采用均分开核对。

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
