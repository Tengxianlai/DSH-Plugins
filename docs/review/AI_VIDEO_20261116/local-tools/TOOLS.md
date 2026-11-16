# 本地核验工具清单（TanLu-CJU75th，2026-11-16 实测）

> 口径：只记录**真实存在**的文件；"已实测"指找到了该工具自己的落盘产物/README 证据（不重复解码成片），"有实现未验证"指代码在但没有生产产物。机器可读版：`tools.json`。

## A. 本地 ASR / 语音

### A1 `docs/review/MOTION_v04_ASR/tools/run_asr_blind.py`

- 作用：对两条 H3 对白候选做**盲转录**（不喂期待句），输出 segments + word timestamps。
- 依赖：`.work/asr-venv`（Python 3.12.3 隔离 venv；faster-whisper 1.2.1、ctranslate2 4.9.0、numpy 2.5.5）；模型 `Systran/faster-whisper-small` 本地 snapshot；系统 `ffmpeg` 6.1.1（因 `av 19.0.2` 与 faster-whisper 的 `decode_audio` 不兼容，改为 ffmpeg 解码成 float32 numpy 再喂模型）。
- 输入：`s01_004.wav`、`s06_001-1.wav`（16 kHz mono，从候选 mp4 提取；工作区 `.work/asr-work/`）。
- 输出：`.work/asr-work/out/*.json|*.txt`（两遍：`vad_filter=False/True`）+ 终端日志。
- 能证明：音频里**有没有**这句中文、字级时码、VAD 两遍是否一致。
- 不能证明：口型同步、表演/动机、语气、字幕断句；同音字（钙/盖、腔/枪）无法据此判真伪。
- 实测状态：**已跑通**（`docs/review/MOTION_v04_ASR/README.md`、`tools/run_asr.log`、`S01_004_LADDER_FINAL_asr.json`、`S06_001-1_ZHOUYUAN_FINAL_asr.json`、`words.csv`、`energy_silence.json`、`provenance.json`）。
- 成本：CPU int8，两条 5–7 s 片段秒级到十几秒；无网络（`HF_HUB_OFFLINE=1`）。
- **关键实现细节（复用到别的脚本时）**：本环境 `av 19.0.2` 与 faster-whisper 1.2.1 的 `decode_audio` 不兼容——`model.transcribe(str(file))` 会抛 `TypeError: open() got an unexpected keyword argument 'metadata_errors'`（已复现）。本脚本因此用 `ffmpeg -vn -ac 1 -ar 16000 -f f32le` 解成 float32 numpy 再传 `transcribe(audio)`。最小适配与实测速度见 `ASR_ADAPTER.md`。

### A2 能量/静音扫描（无独立正式脚本）

- `docs/review/MOTION_v04_ASR/tools/energy_scan.py` 只有注释（说明输入输出），实际算法在 `.work/asr-work/assemble.py`（20 ms RMS、门限 −45 dBFS，生成 `energy.json` → `energy_silence.json`）。
- 交叉方法：`ffmpeg silencedetect -40 dB`（三档 −30/−35/−40 dB 起止差 ≤15 ms）。
- 能证明：有声段起止、句首/句尾静音、短瞬态；**不能**证明口型或听感。
- 状态：已跑通（产物见 A1 同目录）；脚本位置在 `.work`（草稿区，非正式入口）。

### A3 VO 核音（旁白）

- 脚本：`08_AUDIO/VO/feedback_v05/gen_vo_fix.py`（复用 `tools/gen_tts.py` 的 preset，不改原脚本）。
- 核验产物：`docs/review/MOTION_v05_VO/{README.md,VERIFY.json,ASR_VO_SCIENCE_CAMPUS_FIX_v01.json}`。
- 能证明：新句字音、删词是否残留、speech 起止/气口/峰值、F0 参考；不能证明混音听感或音色连续（README 明确“不下音色通过结论”）。
- 状态：**已跑通**（1 次生成 0 重试，含 `usage_chars`、trace、费用估算；未改旧 mp3）。

## B. 容器 / 完整解码 / 响度 / 音频包

### B1 `tools/verify_motion_v05.py`

- 作用：v05 交付技术 QC。断言 manifest 与 v04 画面一致、100 条字幕、ffprobe 规格（2560×1440/24/13680 帧/570 s）、`ffmpeg -xerror -f null` 完整 AV 解码、`loudnorm` 实测、母轨 PCM 窗口外逐字节一致、12 张信息卡抽中点帧拼图、字幕/字卡点位帧。
- 依赖：`ffmpeg/ffprobe`、`PIL`（Python 3）。
- 产物：`docs/review/MOTION_v05_FINAL/{VERIFY.json,full_decode.log,ALL_12_CARDS_FINAL.jpg,IC_*_final.png,*.png}`、`12_FINAL/MOTION_v05/DELIVERY_MANIFEST.json`。
- 能证明（L1）：规格、帧数、时长、完整解码无错、AAC 响度/峰值、音频窗口外字节保留、字卡画面取样。
- 不能证明：画面内容/动作自然、口型、听感、客户验收；`VERIFY.json` 自己写 `CUSTOMER_REVIEW_PENDING`。
- 实测状态：**已跑通**（VERIFY.json 存在；`full_av_decode_exit: 0`；`full_decode.log` 0 B 表示 stderr 为空）。

### B2 `tools/verify_motion_v04.py` / `tools/verify_feedback_v03.py` / `tools/verify_feedback_v03_final.py`

- 同一套路线的前版本：ffprobe 规格断言、完整解码、loudnorm、源音轨/母轨窗口对照、定点抽帧、白色校训像素统计（v04）。
- 产物：`docs/review/MOTION_v04_FINAL/{VERIFY.json,full_decode.log,aac_loudness.json,*.png}`、`12_FINAL/MOTION_v03/{DELIVERY_MANIFEST_FINAL.json,FINAL_FFPROBE_FINAL.json,FULL_AV_DECODE_AND_LOUDNESS_FINAL.log}`、`docs/review/FEEDBACK_V03_*`。
- 状态：已跑通（v03/v04 交付记录在案）。

### B3 `tools/verify_motion_v05_streaming1080.py` / `tools/verify_motion_v05_under200.py`

- 作用：校验两档 1080P 派生版——源 2K sha256 固定、ffprobe 规格、完整解码、**音频包散列与 2K 完全一致**（`-c:a copy -f hash`）、MP4 顶层 atom 顺序（moov 在 mdat 前，faststart）、200 MB 十进制硬上限、抽 3 帧。
- 产物：`docs/review/MOTION_v05_1080P/VERIFY.json`、`docs/review/MOTION_v05_1080P_UNDER200MB/VERIFY.json`、`12_FINAL/MOTION_v05/STREAMING_1080P*_MANIFEST.json`。
- 能证明：派生版没有偷偷重编码音频、尺寸/帧数/时长/faststart 达标。
- 状态：**已跑通**（两版 VERIFY.json、日志都在）。

### B4 `tools/audio_probe.py`

- 作用：H3 片段音频体检与接缝建议（ffprobe 流信息 + `astats` + `ebur128` + `aspectralstats` 频谱重心 + 立体声相关度；按 Δ响度/Δ底噪给 8/4/2 帧交叠建议）。
- 依赖：`ffmpeg`（astats/ebur128/aspectralstats 滤镜）、Python 标准库。
- 能证明：片段级响度/底噪/频段差/相关度；不能证明听感、音乐契合、对白归属。
- 状态：**有实现，未找到生产产物**（只在历史方法文档中被引用；本次未运行，避免解码大量片段）。

### B5 `tools/hit_detect.py`

- 作用：配乐低频重音检测（低通+10 ms 能量跃升取峰），输出时间点/强度/时间码，JSON 可给 EDL。
- 依赖：`ffmpeg`、标准库（无 numpy/librosa）。
- 状态：**有实现**；引用见 `08_AUDIO/EXPLORE/LOG.md`（原 dirty 文件，本次未读改）、`docs/handoff/WSL_RECEIPT_20261115.*`；未找到成片级产物。

### B6 `tools/blind_sheet.py`

- 作用：试音盲听包（打乱+改名+评分表+封存 mapping，含种子可复现）。
- 状态：**有实现**；引用见 `08_AUDIO/EXPLORE/README.md`；未找到生产产物。

## C. 帧扫描 / 抽帧 / 联排

### C1 `tools/verify_final_local.py`

- 作用：v03 成片的**指定窗口**逐帧检查（640×360 灰度）：片头闪电是否有常亮bolt、帧差连续性、0–36 s 逐秒 RMS、掌声段运动、学生离场、524 s 旁白起点。输出 `LOCAL_VERIFY.json` 并 `assert` 全部 verdict。
- 产物：`docs/review/FEEDBACK_V03_FINAL_LOCAL/LOCAL_VERIFY.json`。
- 能证明（L1/L2）：指定窗口里“没有常亮闪电/没有硬起音/人物是否离场/音量是否连续”这类可量化断言。
- 不能证明：全片观感、其他未扫窗口、动作自然、颜色/构图；不是“看完整片”。
- 状态：**已跑通**（JSON 中 7 个 verdict 全 true）。

### C2 `tools/review_user_v04.py`

- 作用：按 manifest 给**每个画面段抽 1 个编码后中点帧**（94 段），拼 8 张联排并写 `ACTUAL_FRAME_INDEX_v04.json`（段号/帧号/源）。
- 依赖：`ffmpeg`（`select=eq(n,…)` 一次性抽帧 + `-err_detect explode`）、`PIL`。
- 能证明：每段中点确实存在且可读、联排可人工翻看；不能证明段内其他帧、动作、口型。
- 状态：**已跑通**（`docs/review/ANIMATIC_v04_DIRECTOR_QC/{ACTUAL_FRAME_INDEX_v04.json,STORYBOARD_*.jpg}`）。

### C3 `tools/build_keyframe_picker.py` + `tools/keyframe-picker/app.html`

- 作用：离线人工选图册（扫描 8 个根目录，按内容 sha 去重，生成 1280 px 预览、镜号分组、导出 JSON）。
- 实测数据（`12_FINAL/KEYFRAME_PICKER_20261115/picker-data.json` 的 meta）：扫描 2723 文件 → 2492 内容组 → **2487 张可显示**，5 张无效保留在 errors；`manifestSha256=8261dfaf…`（对应 `09_EDITING/ANIMATIC_v01/manifest_DIRECTOR_v03.json`）。
- 能证明：候选存在、可读、与镜号的归组关系；**明确不按旧 PASS/FAIL 隐藏**，所以文件名/旧状态不是批准。
- 状态：**已跑通**（选图册 HTML + previews + 候选索引 + 使用说明齐全；用户导出 `USER_SELECTION_ORIGINAL.json`）。

### C4 `tools/animatic_subtitles.py`、`tools/build_motion_v05_text.py`、`tools/finish_motion_v05.py`

- 作用：字幕/字层构建与烧录（本项目 100 条 SRT、12 张信息卡 + 7 个包装层的实际渲染路径）。
- 状态：v05 已完成版本脚本，只作模板；文档明确“不要对 v05 默认输出原路径重跑”。
- 能证明：字层几何/文本落盘；不能证明观感与验收。

## D. 结构 / 引用校验

### D1 `tools/check_shots.py`

- 作用：`02_STORYBOARD/SHOTS.csv` 结构与硬约束（表头、order 连续、状态/段落枚举、fact_ids 非空、REWORK 需 risk、duration 可解析、S03_008 不得复活）。
- 实测：`PASS`，65 镜，2 条 WARN（S00_003/S00_004 LOCKED 但无 selected_take/in_frame）。
- 不能证明：素材存在、画质、史实、听感、验收。

### D2 `tools/check_scene_refs.py`

- 作用：场景派生**本地预检**——给定派生清单 + 空间母版（可锁 sha256），逐条要求 refs 非空、文件存在、其中至少一张内容 sha 等于母版 sha；缺母版/散列变化直接 BLOCK。
- 实测：对 `docs/animatic/lines/tianquan/derivations_tianquan_v02.json` + `TIANQUAN_MASTER_M1_v01.png` 运行 `PASS`。
- 能证明：清单层面的引用完整性；工具自报**不能**证明母版获批、服务端真的收到图、输出几何正确。
- 状态：**已跑通**（本次实跑；原始用于天全母版纠偏）。

## E. 生成记录 / 订单（不是脚本，但是核验的事实源）

| 证据 | 内容 | 用途 |
|---|---|---|
| `07_SHOT_GENERATION/ANIMATIC_v01/**/*.json`（90 份） | 每张静演关键帧的 prompt、refs（含 sha256/role）、out_sha256、status/review、模型与成本估算 | 关键帧→参考根 的唯一细粒度溯源 |
| `09_EDITING/MANUAL_SELECTION_20261115_2203/USER_SELECTION_ORIGINAL.json` | 90 格 confirmed、2 格 pending、manifest sha | 用户采用决定（真正的“批准”） |
| `…/ADOPTION_USER_v01/v02.json`、`IMPORT_VALIDATION.json` | 采用清单、逐文件 sha 校验（`all_files_match: true`） | 选片→采用 的桥 |
| `07_SHOT_GENERATION/USER_SELECTED_20261115_2203/`（90 文件） | 采用关键帧副本（文件名带内容 hash 前缀） | 生产入口 |
| `docs/video/PROMPT_SET_v01/S00–S07.json`（83 clips） | 每 clip 的 prompt、mode、`image`（80 唯一图）、dialogue/voice 字段 | 关键帧→视频 的计划 |
| `docs/video/**/ORDERS*.json`、`SHARD_*.json`、`MASTER_PLAN_82.json` | 实际提交的 task_id、规格、`inputs.image.sha256`、输出 sha256/帧数/大小、usage | 计划→实际调用 的事实源（80/80 关键帧有 sha256） |
| `09_EDITING/MOTION_v05/{manifest_motion_v05.json,RESOLVE_TIMELINE_SPEC.json,MIX_SHEET_MOTION_v05.json}` | 91 段画面源/入点、119 文字层、母轨与 patch | 实际成片采用表 |
| `12_FINAL/MOTION_v05/DELIVERY_MANIFEST.json` 等 | 交付文件的字节数/sha256 | 交片事实 |

## 已知工具坑（会影响资产记录）

- `tools/gen_image.py` 的 `save()` 把 API 返回的**原始字节**直接写入 `--out`；批脚本给的 `--out` 是 `.jpg` 时，文件内容其实是 PNG，且 `out_sha256`/`bytes` 当场按该原始字节计算。之后若做 PNG→JPEG 转换，必须同时更新旁注哈希，否则会出现“记录 hash 与交付文件不符”——本项目 `SCENES_4K/ENV` 28 张卡就是这样（28/28 与 `.work/scene3_png_originals/*.png` 一致，与交付 `.jpg` 不同）。这不是文件损坏。
- `review_user_v04.py` 的 manifest 路径写死为 `09_EDITING/ANIMATIC_v01/manifest_DIRECTOR_v04.json`；`verify_final_local.py` 的成片路径/窗口/分辨率写死为 v03。复用前先改常量，别直接跑出“假通过”。
- `check_scene_refs.py` 只做本地文件与母版 sha 检查；它自报的边界（不证明批准、送达、几何）必须原样转述。

## 依赖与环境速查

- 系统：`ffmpeg/ffprobe` 6.1.1（Ubuntu），Python 3.12.3。
- Python 包：`numpy`（系统/venv 均有）、`PIL`（Pillow，系统环境）、`faster-whisper`+`ctranslate2`（只在 `.work/asr-venv`）。
- 字体：`06_STYLE_BIBLE/FONTS/NotoSansSC-Medium_legacy20261107.otf`（旧 OTF，不能用同字重新 TTF 替代）。
- 无 GPU 依赖；全部 CPU。ASR 需模型缓存 `~/.cache/huggingface/hub/models--Systran--faster-whisper-small/snapshots/536b0662…`。
- 付费 API：本清单内所有脚本都是本地 ffmpeg/numpy/PIL；唯一涉及外部服务的是 `gen_tts.py`/`gen_feedback_vo.py`/`gen_image.py`/视频插件，**不在本地核验链默认路径里**。
