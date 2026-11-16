# AI视频生产修复交接（2026-11-16）

本次修改已实现为可复用插件与本地CLI。唯一源码在本仓；《探路》已验收v05、原768/2K输入、原生声线及已完成海报不在本轮修改范围。未新增付费媒体生成，未推送、合并主线或打标签。

## 下个项目如何进入

在DSH中加载 `ai-video-production`，从该技能的Base定位本地CLI，先建立 `.ai-video/project.json`，登记实际批准人物根、场景母版、关键帧及原生声线和来源证据。不要复制《探路》的旧采用表或预算。详细命令在[生产工作流](../../../plugins/dsh-minimax-video/skill/production-workflow.md)。

- 文学写作按既有约定交Gemini 4 Argon；技术测量默认本地工具与DeepSeek子代理。
- 实际输入按hash与槽位绑定，关键帧继承人物/场景根；缺根、字节漂移、跨镜头或未批准来源会拒绝登记项目的H3提交。
- 声音参考提供音色，新对白原句必须出现在实际prompt；不混用首尾帧与reference模式。
- `inspect`默认只做显式要求的本地核查；`--asr`才启用已配置长期工具链。无下载或云兜底。
- `frame_scan`通过仅证明解码与覆盖范围；黑帧/静止、ASR同音误识保留证据，需有范围的实际复核，不能当动作、身份、口型或用户验收。
- `video_prepare`只做离线准备，不产生视频；H3生成/再生成按单次cap与原子累计预约执行。Context-IR无法预封顶，不能纳入该预算。
- 未知提交保留task id与预算预约，不以超时当免费重试；再生成保存原prompt、全部原输入及实际源。注册项目byTask另核同task映射和journal下载hash，不能用合格A替远端B作QC。

## 已完成与运行态

| 部分 | 版本 | 行为 |
|---|---|---|
| dsh-image-gen | 0.4.0 | 离线预演、required/hash参考契约、真实输入输出收据、并发防覆盖、原2K/4K费用门保留 |
| dsh-minimax-video | 0.2.0 | 7工具、计划与累计预算、可恢复journal、来源/原句/QC/源规格检查、生产CLI与新项目技能 |
| dsh-gemini | 0.4.0 | 本地技术QA优先、音视频目的/证据预检、默认不扩大预算重试、逐次usage累计与未知量标记 |
| dsh-gemini-creative | 0.4.0 | 写作分工与必要综合判断边界，链接新项目生产技能 |

托管安装对已安装link包返回 `already-installed`。随后托管 `set_bundle` 对H3及image各执行disable→enable，均返回 `application:applied`；没有移除包、手写profile或重启DSH进程。当前目录可发现 `ai-video-production` 并实际加载；plugin-manager核查四个目标fiber均active。

运行态离线烟测：Lite768/4s/disabled扩展参数准备成功，估价¥1.04，上限¥1.04，明确 `no paid call was made`；该plan不执行。生图2K/16:9预演成功，解析2048×1152，明确无请求无扣费，收据仅在ignored `.work/runtime-smoke-images/`。预检中的价格是目录估计，未成为生成授权。

## 长期本地ASR

运行环境与缓存模型已复制到 `VideoStudio/Tooling` 的长期位置，原项目环境与缓存保留。共享工具状态保存在 `$DSH_HOME/state/dsh-minimax-video/toolchain.json`，不修改profile凭据。

已验证模型4文件逐文件hash与缓存相等；Python和包均从长期目录加载。复制后的activate与22个console入口已纠正旧前缀，原venv与发布模块未改。两条现成短源实际转写成功；“钙→盖”等误识仍为review_required，不自动重生。详见[integration/ASR_LONGTERM_VERIFY.json](integration/ASR_LONGTERM_VERIFY.json)。

## 验证与审计

- 根 `npm run verify`：9插件全绿；production 47/47通过、0跳过（包含两条真实本地源ASR与静音测试）。全部最终代码与空路径回归后的hash和日志在[integration/FINAL_VERIFY_V3.json](integration/FINAL_VERIFY_V3.json)，现场预检记录在[integration/RUNTIME_VERIFY.json](integration/RUNTIME_VERIFY.json)。V1/V2仅保留为修复过程的先前检查，不作为最终源码认证。
- [65会话按时间审计](history/README.md)：按事件归因模型切换；付费错误截图/漏原句/提前2K发生在DeepSeek阶段，9次免费空参数错误发生在Codex阶段；缺失旧Mac/早期CLI日志没有冒充已审。
- [本地工具与复用证据](local-tools/REPORT.md)：区别UTC文件名和本地审批时间、mtime与审批时间、下载PNG与转码JPEGhash、旧拒绝与后来明确采用。
- [独立复核决策](lead-expert/DECISIONS.md)：专家审查的是原型快照，后续实现由本地回归验证；未把声明reviewer/budget包装成身份认证。
- [工具目录度量](integration/TOOL_SURFACE.json)：新增2工具，schema UTF8从17,353B增至44,864B。是字节/参数代理指标，不是首轮token或账单；当前不再扩接口。

## 仍需知道的边界

再生成原参考视频会重计；base视频是否额外计费未由官方/现有usage完全核定，故费用始终partial，cap与预约按保守upper。无本地原任务记录的byTask不能把未知原输入计成0。成功任务预算按目录保守估计结转，不是账户对账；failed/unknown保留预约供明确理由核销。

技术报告不认证人，也不替代有范围的实际图像/媒体审查；自动逐帧信号扫描不能证明自然动作或唇音同步。必要Gemini综合判断仍保留，避免重复上传片段代替本地检查。

回退采用独立修复分支上的有范围revert，再走托管重组并重验。不要直接切旧树破坏其它会话，也不要将本地修复推送或合并主线，除非另获授权。
