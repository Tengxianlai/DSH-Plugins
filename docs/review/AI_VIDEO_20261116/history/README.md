# 《探路》AI 视频项目 · DSH 归档会话审计（时间索引 + 可追溯事实）

- 审计日期：2026-11-16 18:2x（Asia/Shanghai）
- 审计人：`history-auditor`（子代理；任务板 `task-8`，owner `history-auditor`）
- 写入范围：仅本目录 `docs/review/AI_VIDEO_20261116/history/`
- 被审计对象：`/home/tengxlper/DSH_ZONE/VideoStudio/Projects/TanLu-CJU75th`（重庆交通大学 75 周年校史微电影《探路》）
- 数据来源（只读）：`/home/tengxlper/.dsh-wsl/sessions/--home-tengxlper-DSH_ZONE-VideoStudio-Projects-TanLu-CJU75th--/<session-id>/session.v4.jsonl.zstd`
- 方法：逐会话流式 `zstd -dc` 解压后按行解析 JSONL，只抽取 `session / model/selection / request/header / user/message / assistant/message / tool/call / tool/result / turn/end / llm/retry / subagent/catalog / session/title` 等事件，压缩成脱敏摘要后再人工核对；**未恢复、未创建、未修改任何会话**，未访问无关项目正文，未调用任何付费 API，未改任何配置。

## 先说结论（三条最值得立即可做的）

1. **H3 的「参考音频 ≠ 台词」和「升 2K 前必须先审 768」这两条，已经在一次真实付费返工里被验证过。**
   证据：`session-213b3228…` T7（2026-11-16 10:46–11:03，模型 `deepseek-official/deepseek-flash`，10:13:19 切换）先写 `speaking the line of <Audio 1>`（没有 `<d>` 台词文本）生成 768P，未审片即于 10:48:41 提交两条 2K 再生成；用户 11:02 原话纠正「谁他妈跟你说参考音频必须是台词音频了？……真的台词不是靠提示词输入吗？」「不应该是测生成后的音频的 ASR 转录吗」。修正后（11:02:43 起）改为 `<d>[Chinese]台词</d>` + `<Audio 1>` 只做音色参考。
2. **`minimax-video` skill 没把「2K 直出」和「再生成的源条件」分开，且这条混淆至今未改。**
   `SKILL.md:23`「2K only on `MiniMax-H3`…Lite and Max stop at 768P」是 **direct generation 的真限制**（不算错）；错的是 `:118`「Source must be a **MiniMax-H3 768P output**」——官方再生成接口只约束源的物理规格，`model:MiniMax-H3` 是输出模型。**已实测**：Lite 768P → 2K 再生成成功（`session-2f08495b…` 00:21:48 用户「实际是可以的，我测试过」；项目 task `463851531801158`）；**未实测**：Highspeed/Max 源（只能按物理 schema 推导，不能写成已验证）。
3. **`video_generate` 把空字符串当真参数：一次返工里 9 次连续失败（7 次是同一参数重试）。**
   `plugins/dsh-minimax-video/index.js:156-157` 只判 `undefined`，`plugins/dsh-minimax-video/lib/media.js:53-56` 对 `""` 直接抛错且不点名字段。`session-213b3228…` T1 在 03:15:09–03:17:05（模型 `magpie/codex/gpt-6.1-sol`）连续 9 次带 `first_frame:""` / `last_frame:""` 提交（其中 7 次是同一参数重试），全部报 `image input must be a non-empty path or URL`，最后靠 harness 的「Repeated tool call detected: consecutive_calls: 5」护栏才停。

## 本目录怎么读

| 文件 | 内容 |
|---|---|
| `00_SESSION_INDEX.md` | 65 个会话的时间索引（创建时间、ID、标题、模型链、工具量、错误/重试/子代理数），以及与本次审计无关/需排除的会话（另：`07_RECOMMENDATIONS.md` 是按杠杆排序的建议） |
| `01_TIMELINE.md` | 按时间排序的事实时间线：每段写清「谁（模型）→ 用户要求 → 关键工具调用/结果 → 结果与修正」 |
| `02_MODEL_PHASES.md` | Codex 阶段 / DeepSeek 阶段的分界证据（`model/selection` + `request/header` 事件），以及**按 turn 归因**的方法与陷阱 |
| `03_FAILURE_PATTERNS.md` | 反复失败模式逐条取证（首帧语义、参考音频、技能文档、ASR/抽帧、预算/任务 ID/重试、中间稿当采用稿、卡复用低…） |
| `04_LOCAL_TOOLS.md` | 本地工具成功替代 Gemini 的实例（本地 ASR、silencedetect、verify 脚本、字体溯源、Pillow 重渲、本地核价） |
| `05_PLUGIN_FIXES.md` | 由本审计可直接落地的插件缺陷与最小修改建议（含 `文件:行`） |
| `06_GAPS.md` | 读不到 / 不在当前存储 / 不属于本项目的会话，明确缺口，不猜 |
| `07_RECOMMENDATIONS.md` | 按杠杆排序的落地建议（R1–R8），每条带证据指针与预期效果 |
| `08_EVIDENCE_TABLE.md` | 50 条证据速查表：时间 → 会话/seq → 模型 → 原始片段（复核时一行直插日志） |

## 脱敏与合规

- 正文不出现任何 token、密钥、授权 URL 参数；如日志中出现形如凭据的片段一律写 `[REDACTED]`。
- 不引用与本项目无关的会话正文；同机其他项目会话只做到「header 级」比对（见 `06_GAPS.md`）。
- 本目录之外的路径未被写入；中间解压摘要放在 `/tmp` 临时目录，收尾已删除。

## 事实粒度说明

- 时间一律按日志事件的 `time`/`createdAt`（毫秒 epoch）换算到 Asia/Shanghai。
- `seq` 是会话内事件序号，可直接回到原 `session.v4.jsonl.zstd` 定位（同一 seq 唯一）。
- 「模型」一律按 `model/selection` / `request/header` 事件写实际值；只有子代理会话没有这两类事件时才写「继承自父会话」，并注明推断依据。
