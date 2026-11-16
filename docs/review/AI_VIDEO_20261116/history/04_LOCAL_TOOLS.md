# 04 · 本地工具成功替代 Gemini 的实例

> 用户 11-16 18:13 的原话：「但是 gemini 不是文字性工作的强者吗？很多东西其实完全可以由 DeepSeek 子代理自己去做，我们本地有 ASR 工具，也有全帧扫描工具，为什么要舍近求远呢？」（`session-78b8ee8a…` seq2139）
> 这一节把「日志里真实跑通过的本地替代」列清楚：**哪个会话、什么时候、用什么命令/脚本、得到什么可复现的结论**。这些是可以直接写进下一版工作流的部分。

---

## L1 本地 ASR：不花一分钱拿到逐字与起止

| 项 | 事实 |
|---|---|
| 会话 | `session-eb99a563-1f32-4cd5-a20a-3d92c0ce03d6`（11-16 11:17:32 创建；对应主会话里的 `asr-check` 角色，task-2） |
| 用户要求（任务原话） | 「请在共享任务板读取并claim task-2，完成最后两条最新候选本地ASR。用户急着交片，请只做这项，**勿用Gemini/付费服务**。现有 `.work/asr-venv` 安装被中断；可在隔离 venv 补装 `faster-whisper` 并下载 `small` 模型，CPU/int8、不要 initial_prompt」 |
| 实现 | 隔离 venv + `faster-whisper` `small`（CPU/int8），盲转录，不改任何既有文件 |
| 产出 | `docs/review/MOTION_v04_ASR/`（README + segments/词时码） |
| 为什么比 Gemini 好 | 无 12MB 上限、无 `fetch failed`、可离线重复、时间码可精确到 word；Gemini 同一需求在 `213b3228` seq4905 直接 `Error: [object Object]` |

## L2 `ffmpeg silencedetect` + F0 检测：纠正 ASR 的「首 token 幻觉」

| 项 | 事实 |
|---|---|
| 会话 | `session-78b8ee8a…` seq404（11-16 11:23:32），子代理 `asr-check` |
| 结论 | LADDER S01_004 实际人声 **4.79→6.39s**（ASR 报 4.54）；周原 S06_001-1 实际 **0.334→4.874s**（ASR 段报 0.00） |
| 依据 | `silencedetect -40dB`：`silence_end=4.79694` / `silence_start=6.39394`；−30/−35/−40 dB 三档阈值起止仅差 ±15ms；4.2–4.78s 全段 −63…−70 dBFS、F0 为空 |
| 价值 | 直接推翻「ASR 起点＝人声起点」，避免把 0.48–0.60s 的非人声瞬态当台词切点；同时也明确了「这只证明台词与时间窗，不等于口型通过」 |

## L3 `verify_motion_v04.py`：全片技术验收一张 JSON

| 项 | 事实 |
|---|---|
| 会话 | `session-78b8ee8a…` seq663（11:38:52）后台任务输出 |
| 结果 | `status: TECHNICAL_QC_PASS_CUSTOMER_REVIEW_PENDING`；570s / 13680 帧 / 2560×1440 / 24fps；`subtitle_cues: 100`；`full_av_decode_exit: 0`；AAC 响度 `input_i −18.45 / input_tp −2.07 / LRA 11.60`；**motto 像素均值 `[246.53, 246.53, 246.53]`、墨迹像素 47374**（用像素证明「校训确实是白字」）；`audio_outside_three_patch_windows_pcm_exact: true` |
| 价值 | 这类「可量化信号」是 Gemini 给不了的；同会话里 Gemini 的判断只能到「看起来对」 |

## L4 字体溯源：读旧交付实片定标准，不靠模型回忆

| 项 | 事实 |
|---|---|
| 会话 | `session-1b8435f1-848c-4735-9076-32e1ddc62aef`（11-16 11:50:48，task-4） |
| 方法 | 读 `/mnt/e/Videos/《探路》交付_20261107/探路_交付版_2K.mp4` + `/mnt/e/Document/ChatGPT/AIVIDEO/delivery/tanlu-final-20261107/finish_film.py`（mtime 11-07 19:05）+ `design/approved-text-v1/hist_switch_1950.json` |
| 结论（可复核） | 旧版字体 = `NotoSansSC-Medium.otf`（8,345,436 B，sha256 `7633f5a0…ed5dda`），**不是**当前工程里的 `NotoSansSC_500.ttf`（10,589,212 B，sha256 `4337ed54…2f940`）；旧版参数 54px / tracking 2px / `#F5F7FA` / 描边 2px `#14181F` / 阴影 blur6 offset2 alpha .55 / 底边距 108px；并从实片 12.5s 抽帧实测底距 103px |
| 价值 | 「像不像旧版」是像素与字节问题，本地 5 分钟可证；交给 Gemini 只会得到形容词 |

## L5 校训白字：Pillow 同 alpha 重渲 + framemd5 定点校验

| 项 | 事实 |
|---|---|
| 会话 | `session-78b8ee8a…` seq512（11:30:09，子代理 `white-motto`） |
| 做法 | 官方书法字**同一 alpha 重渲**（不重绘字形、不从金字涂白），只改 31s 片尾 master 的第 348–407 帧（全片 553.5–556.0s）；`ffmpeg framemd5` 比对：**其余 684 帧与 v03 完全一致** |
| 价值 | 60 帧的定点改动可以逐帧证明；Gemini 无法提供这种证明 |

## L6 本地核价与只读清单：先算钱再决定

| 项 | 事实 |
|---|---|
| 会话 | `session-7cb9c746-3b6f-416f-ad96-c0b5d7d4d8b6`（11-16 07:23:37，task-12） |
| 证据 | 用户原话「其余片子可以再生成2K，帮算钱，我同意后再生成」；该会话只做 read-only inventory/quote，**未提交任何生成任务**，产出 `docs/video/FEEDBACK_V03_2K_QUOTE/` |
| 价值 | 报价基于本地文件与真实 usage（`total_seconds=12,input_seconds=0,output_seconds=12` → ¥3.60），而不是模型印象 |

## L7 ffprobe / 全解码 / SSIM：2K 再生成「是否真是同一帧」的证据

| 项 | 事实 |
|---|---|
| 会话 | `session-78b8ee8a…` seq495（11:29:18）子代理报告 + `213b3228` seq3688 摘要 |
| 结论 | 2K 与 768P 源**帧数一致**（158f/6.5833s、124f/5.1667s）、2560×1440/24fps、`ffmpeg -xerror -f null -` exit 0、与 768 原音轨包络互相关 **best lag = +0.00s，r = 0.998 / 0.997**；2K 试点 SSIM 0.9503 / PSNR 33.14（对 bicubic） |
| 价值 | 「再生成没有偷偷换脸/换运镜」这件事只能靠本地测量 |

## L8 人工选片器：把「模型审美」降级为「人做选择」

| 项 | 事实 |
|---|---|
| 会话 | `session-5119fd9b-37bd-4d41-9015-2ab9d8299f1c`（11-15 20:51:33，task-4） |
| 用户原话 | 「停止自动生图/审片，要求将所有现有生成关键帧汇聚，**由人工手动选择**每镜用哪张」 |
| 产出 | `tools/keyframe-picker/app.html`；`session-9e5b4806` seq1981 记录打包 **2491 文件 / 173.9 MiB** 候选选图册（zip sha256 `f2c89a64…`） |
| 价值 | 复用率低的问题，最终靠「让资产可见 + 人来选」缓解，而不是继续让模型猜 |

---

## 结论：分工应该是这样的

| 任务 | 应该由谁做 | 依据 |
|---|---|---|
| 剧本/旁白/提示词文字、图文综合判断 | Gemini（`gemini-creative`） | 这段时期确实产出可用文本（`213b3228` seq148/153/165、`6d3edcfa` 等） |
| 逐字听写、人声起止 | 本地 faster-whisper + silencedetect + F0 | L1、L2 |
| 帧级测量、时长/帧数/解码/响度/SSIM/像素色值 | 本地 ffprobe/ffmpeg/Pillow 脚本 | L3、L5、L7 |
| 「像不像旧版」的字体/版式 | 读旧交付实片与源脚本 | L4 |
| 钱 | 本地清单 + 真实 usage 反算 | L6 |
| 关键帧归属 | 人 + 选片器 | L8 |

> 现行 `dsh-gemini` 的工具描述已经把这条分工写进去了（`plugins/dsh-gemini/index.js:478` 附近：「Gemini is the literary/text specialist; technical checks — ASR transcription, frame-by-frame scanning, ffprobe/decode, contact sheets, audio sync — belong to local tools and subagents, and sampled frames or ASR cannot prove lip-sync, identity, or performance」）。但 11-16 当天的会话仍反复把视频丢给 Gemini，说明**写进描述不等于会被遵守**（见 `05_PLUGIN_FIXES.md` P5 的强制化建议）。
