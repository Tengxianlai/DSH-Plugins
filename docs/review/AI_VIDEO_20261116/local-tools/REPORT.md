# 《探路》本地核验与批准素材复用能力盘点（task-9）

- 审计日期：2026-11-16 18:20–18:35（Asia/Shanghai）
- 审计人：子代理 `local-tools-auditor`（task-9）；只读审计项目 `~/DSH_ZONE/VideoStudio/Projects/TanLu-CJU75th`
- 写入范围：仅本目录 `docs/review/AI_VIDEO_20261116/local-tools/`
- 未做：未调用付费 API、未运行 Gemini/Claude、未整片解码/渲染、未改工程/媒体/工具/manifest/STATE、未 Git 提交；未碰 `08_AUDIO/EXPLORE/LOG.md`、`tools/gen_tts.py`、`tools/gen_music.py` 三处原有 dirty 文件
- 附件：`TOOLS.md` · `tools.json` · `REUSE_GAPS.md` · `ASSET_REGISTRY_CONTRACT.md` · `asset_registry.example.json` · `LOCAL_QA_ROUTE.md` · `EVIDENCE.json` · `ASR_ADAPTER.md`
- 复核更新（2026-11-16 18:5x，按 lead 要求）：身份根时间线与 ENV 旁注哈希两处结论已按证据收紧重写；新增 `ASR_ADAPTER.md`（`local_asr.py` 传路径必失败的最小修法，已在项目 venv 实测）

## 0. 一句话结论

1. **本地核验链是真的、也跑通过**：ASR（faster-whisper small CPU int8）、ffprobe/完整解码/响度、音频包散列、逐窗帧差、抽帧联排、SRT/字卡/关键帧结构校验、场景引用预检都有真实脚本和落盘证据；缺的不是能力，而是**没有统一的资产索引和采用台账**，所以核验只能一个版本一个脚本地临时拼。
2. **批准资产与生产输入之间存在实质断链，但因果要分开说**：25 张场景卡在登记里全部“待验收”，实际关键帧用的是静演线 master。人物方面不能简单说“早期代理忽略了已有的身份根”：90 份关键帧记录创建于 2026-11-15 04:28–07:07（+08:00），**全部早于身份根内容生成（15:03:50，`.work/v02/gen/rang3/…ROOT3_T1`，sha `aed16ce1…`；工具文件名 07:03:50 是 UTC）**；用户“以 A 为唯一身份依据”的决定记录在 `DECISIONS.md` 的 12:14–12:17。**准确结论是**：早期关键帧用的是当时已批准的旧 B/C 定稿（合理）；根创建/批准后，v04 修复批的 25 个 ADOPT* 决定（最终 `USER_SELECTED` 中来自 `REBUILD_v04` 的 19 张）**没有任何生成记录**（`REBUILD_v04` 0 JSON），无法证明是否带入根；而采用的图片一经复制为 `USER_SELECTED` 就被 11-16 的 2K/video 首帧冻结，链条上没有“新根回灌”机制。
3. **关键帧本身有完整记录，但“批准”语义散在 4 个地方**：生成记录（`07_SHOT_GENERATION/ANIMATIC_v01/**/*.json`，90 份、含 refs+sha256）→ 人工选片导出（`09_EDITING/MANUAL_SELECTION_20261115_2203/USER_SELECTION_ORIGINAL.json`，90/92 格 confirmed）→ 采用清单（`ADOPTION_USER_v02.json`）→ 复制件（`USER_SELECTED_20261115_2203/`，90 文件）→ prompt 集/订单（`docs/video/PROMPT_SET_v01`、`docs/video/**/ORDERS*.json`，含 sha256）。每一段都可核，但没有一层是“registry”。
4. **文件名不能当状态**：当前成片 S03_001 用的关键帧文件叫 `S03_001_IN_A1_REJECTED_gaze-at-camera.png`，同目录记录 `status: REJECTED_NOT_DELIVERED`，但用户在选片册里明确确认、并被 v05 manifest 采用。任何“按 REJECTED/alt 过滤”的校验都会误杀在用资产；反过来也不能因为“目录里最多/最新”就当批准。
5. **本地已跑通的检查大多只到 L1/L2**（技术测量/自动转录），不能升级成口型、表演、听感或客户验收。已有方法审计（`docs/review/CLOSEOUT_20261116/method-audit/REPORT.md`）的 L1–L5 分级是现成口径，应直接复用。
6. **低复用是可解释、可修的机制问题**，不是“素材不好”：入口分裂（ENV 卡 / 静演 master / 选片册三套入口）、批准状态没有机器可读字段、没有 root→依赖 的 DAG、没有“未复用批准资产”告警、没有把 sha256 当唯一身份。下面给出最小契约与验证规则，主代理可直接实现。
7. **旁注哈希不是“文件坏/被覆盖”，而是字段指向了另一个制品**：`ENV/*.json` 的 `out_sha256`/`bytes` 与 `.work/scene3_png_originals/<同名>.png` **28/28 完全一致**（例 boxgirder：`96cfc63a…` / 9,636,727 B 是原始下载 PNG）；交付的 `ENV/*.jpg` 是后来转换的真 JPEG（PIL 识别为 JPEG，3840×2160，1.29–1.95 MB，mtime 2026-11-13 12:50:08，与 Mac 接收快照同 sha `aeaed359…`，一直没变）。根因是 `tools/gen_image.py` 的 `save()` 把 API 原始字节直接写到 `--out` 路径（批脚本给的 `.jpg` 扩展名），之后 PNG→JPEG 转换没有刷新旁注。**修正口径**：sidecar 记的是“下载原件哈希”，交付文件哈希未记录；registry 必须分别记录二者，不能把差异说成覆盖/损坏。

## 1. 本次实际跑过的自检（只读、轻量，无整片解码）

| 自检 | 命令 | 结果 |
|---|---|---|
| 镜头表结构 | `python3 tools/check_shots.py` | PASS，65 镜；2 条 WARN：`S00_003`/`S00_004` 状态 LOCKED 但 `selected_take`/`in_frame` 为空（旧静演字段，不是错误） |
| 场景引用预检 | `python3 tools/check_scene_refs.py --spec docs/animatic/lines/tianquan/derivations_tianquan_v02.json --master 04_LOCATIONS/ANIMATIC_v01/TIANQUAN/master/TIANQUAN_MASTER_M1_v01.png` | PASS：所选条目都携带同一母版（工具自报边界：不证明批准、送达、几何） |
| v05 容器头 | `ffprobe -v error -show_entries … 12_FINAL/MOTION_v05/探路_全片字幕与字卡修订_v05_2K.mp4` | 2560×1440 / 24/1 / 13680 帧 / 570.000 s / 1,069,518,035 B / AAC 48 kHz 立体声，与交付记录一致 |
| manifest 引用闭包 | 脚本遍历 `manifest_motion_v05.json` | 91 画面段、84 个唯一视频文件、缺失 0；19 个全幅叠层文件都在；母轨与旧 OTF 字体存在；4 处转场、1 处淡变 |
| ASR 环境 | `.work/asr-venv/bin/python -c "import faster_whisper…"` | faster-whisper 1.2.1 / ctranslate2 4.9.0 / numpy 2.5.5；模型 snapshot `536b0662…` 完整（model.bin 等 4 文件）；系统 ffmpeg 6.1.1 |

没有重跑 `verify_final_local.py`、`verify_motion_v0x.py`（会解码成片），只核对其落盘证据（见 `TOOLS.md` 的“已实测状态”列）。

## 2. 工具盘点（摘要；逐项见 `TOOLS.md` / `tools.json`）

按能力分六类，真实路径都在项目根下：

| 类 | 真实入口 | 证明什么 | 不能证明什么 | 实测状态 |
|---|---|---|---|---|
| 本地 ASR | `docs/review/MOTION_v04_ASR/tools/run_asr_blind.py` + `.work/asr-work/{run_asr.py,assemble.py}` | 音频里“有没有这句中文、几秒到几秒”、字级时码 | 口型同步、表演、听感、字幕断句 | 已跑通：2 条对白 × VAD 两遍 + 波形对照，产物 JSON/SRT/CSV/README 齐全 |
| 本地 ASR（VO） | 同模型；证据 `docs/review/MOTION_v05_VO/{README.md,VERIFY.json,ASR_…json}`、脚本 `08_AUDIO/VO/feedback_v05/gen_vo_fix.py` | 新旁白字音、删词是否残留、speech 起止 | 混音听感、音色连续 | 已跑通（1 次生成、0 重试，含 F0/包络/`silencedetect` 交叉核） |
| 容器/解码/响度 | `tools/verify_motion_v05.py`、`verify_motion_v04.py`、`verify_motion_v05_streaming1080.py`、`verify_motion_v05_under200.py`、`verify_feedback_v03_final.py` | 规格/帧数/时长、`ffmpeg -f null` 完整 AV 解码退出 0、loudnorm/ebur128 数值、AAC 包散列、faststart moov 偏移 | 画面内容、动作自然、听感 | 已跑通：v03/v04/v05 与两档 1080P 都有 `VERIFY.json`+解码日志/抽帧 |
| 帧扫描/抽帧 | `tools/verify_final_local.py`（指定窗口逐帧灰度）、`tools/review_user_v04.py`（94 段中点帧+联排）、`tools/animatic_subtitles.py`、`tools/build_keyframe_picker.py` | 指定窗口内每帧的亮度/帧差/音频 RMS 是否越界；指定帧是否存在、联排是否可读 | 全片“看完”、动作是否自然、颜色/构图是否达标 | 已跑通：`LOCAL_VERIFY.json`、`ACTUAL_FRAME_INDEX_v04.json`、选图册 2487 张可显示图 |
| 音频分析 | `tools/audio_probe.py`（astats/ebur128/频谱重心/立体声相关/接缝建议）、`tools/hit_detect.py`（低频重音）、`tools/blind_sheet.py`（盲听包） | 片段响度/底噪/频段差、切点交叠帧建议、配乐重音点、盲听流程 | 听感、音乐是否合适 | 有实现、有历史文档引用；未找到生产落盘产物（本次未运行） |
| 结构/引用校验 | `tools/check_shots.py`、`tools/check_scene_refs.py` | CSV 结构硬约束；引用文件存在且含指定母版 sha | 内容正确、批准状态、送达 | 两者本次均实跑 PASS |
| 生成记录/订单 | `07_SHOT_GENERATION/ANIMATIC_v01/**/*.json`（90 份关键帧记录）、`docs/video/PROMPT_SET_v01/`、`docs/video/**/ORDERS*.json` | 每次生成的 prompt、refs、sha256、输出 sha256；每次下单实际输入与状态 | 自动批准；跨版本一致性 | 记录完整：80 个 PROMPT_SET 关键帧 100% 能在 docs/video 订单记录里找到 sha256 |

关键判读：**“逐帧扫描 ≠ 看完整片”**。`verify_final_local.py` 只扫 0–10 s、335–342 s、373–383 s、524–528 s 等指定窗口（640×360 灰度），`review_user_v04.py` 每段只取 1 个中点帧（94 帧/13680 帧）；`run_asr_blind.py` 只证明字音。三者都不能替代人耳连续试听或逐音素口型，这与 AGENTS/STATE 的现行口径一致。

## 3. 复用缺口实测（数字与样例）

测量基线：`07_SHOT_GENERATION/ANIMATIC_v01/**/*.json` 的 90 份关键帧生成记录（`refs` 或 `reference_images`，共 226 条引用 / 68 个唯一资产）；`09_EDITING/MANUAL_SELECTION_20261115_2203/` 的选片导出与采用清单；`docs/video/PROMPT_SET_v01/`（83 clips）与 `docs/video/**/ORDERS*.json`；`09_EDITING/MOTION_v05/manifest_motion_v05.json`。细节见 `REUSE_GAPS.md`。

| 指标 | 实测 | 含义 |
|---|---|---|
| 场景卡（`04_LOCATIONS/SCENES_4K/ENV/`，25 张有效 + 3 道具）在关键帧记录中被引用 | 仅 5 张、10 条引用（`ENV_S05_1964_survey`×3、`hzmb_top`×2、`1980s_archbridge`×3、`deck_hatch`×2、`1984_workshop`×1） | 批准/制作的 4K 场景卡几乎没进入最终关键帧链（25 张里只有 5 张、10 条引用） |
| 静演线 master 被引用 | 58 条（`BOXGIRDER_ANIMATIC_MASTER`×17、`TIANQUAN_MASTER_M1`×17、HISTORICAL 各 master 若干） | 实际空间根是静演 master，不是生产 ENV 卡 |
| 13 个 APPROVED 人物卡被引用 | 63 条 / 15 个文件（CHAR_004×11、CHAR_005×11、CHAR_003×10、CHAR_001 旧 FINAL×9、CHAR_001 C_FINAL×4…） | 人物卡确实在用，但用的是**旧版定稿** |
| `CHAR_001` 身份根在 90 份关键帧记录中被引用 | **0 次**；这 90 份记录全部创建于根内容（15:03:50）之前 → 0 引用是时间顺序的必然 | 不能据此说“忽略已有根”；能说的是：根生成后的 v04 修复帧无记录可证、采用 QC 仍用 A 参考 |
| 关键帧记录状态 | 38 `DIRECTOR_ACCEPTED_ANIMATIC`、1 待组版、46 仅 `review` 文本、4 `SUPERSEDED_NOT_DELIVERED`、1 `REJECTED_NOT_DELIVERED` | 状态字段不统一，且与最终采用不一致 |
| 人工选片 | 92 格 / 90 格 confirmed / 2 格 pending；90 个文件复制到 `USER_SELECTED_20261115_2203/` | 用户选择是**真正生效的批准**，但没有回写进任何“批准字段” |
| PROMPT_SET 关键帧覆盖 | 83 clips，81 带图，80 唯一图；80/80 在 docs/video 订单里有 sha256 | 关键帧→视频这一段闭包完好 |
| 同一关键帧被两个 clip 复用 | 1 例：`S06_004_f03_98263339a6.png` 同时给 `S06_004-2a`（周原台词镜，合理）和 `S06_004-2b`（教授+桥管方，输入图错配，已由 task-8 报告定位为 7:58 角色错误根因） | 复用本身不是错，缺的是“这张图承担什么角色”的登记 |
| v05 成片画面段复用 | 91 段 / 84 个唯一视频文件 | 有 7 段同源复用，manifest 无资产 ID，只能靠路径比对 |
| manifest 内部计数 | `motion_meta.slots_motion=91`、`expected.keyframe_count=91`，但 `integration.picture_segments=92` | 同一文件里计数不一致（integration 是 feedback_v03 残留），说明“复制旧字段”不可靠 |
| 旁注哈希 | 关键帧记录 58/58 匹配、静演母版 3/3 匹配；`SCENES_4K/ENV` 的 `out_sha256`/`bytes` 与 `.work/scene3_png_originals/*.png` **28/28 匹配** | 不是文件坏：旁注记的是原始下载 PNG，交付 `.jpg` 是转换件未记哈希（见 §3.2） |

示例（可直接给主代理看）：
- **批准后未回灌/无记录可证的根**：`CHAR_001_IDENTITY_ROOT_1950_v01.png`（早期关键帧早于根，后期 v04 修复帧无生成记录）、`ENV_S01_2026_boxgirder_v04.jpg`（只在 BOXGIRDER master 里作参考）、`PROP_002_robot_B_film_v01.jpg`（正片候选，未进入关键帧记录；关键帧用的是 `PROP_002_ANIMATIC_MASTER`×12）。
- **不该复用却复用的**：`S06_004_f03` 跨角色/跨语义复用（输入图与 prompt 矛盾）。
- **状态与实际相反的**：`S03_001_IN_A1_REJECTED_gaze-at-camera.png`（REJECTED 标记，实际用户确认且成片在用）。

### 3.1 时间线核查（身份根：先统一时区，mtime ≠ 创建/批准时间）

**时区规则（实测，必须先归一）**：
- DSH 生图/视频插件用 `new Date().toISOString()` 生成输出文件名 → **工具文件名是 UTC**（`plugins/dsh-image-gen/index.js:180`、`plugins/dsh-minimax-video/index.js:179`）。例：`.work/v02/gen/rang3/2026-11-15_07-03-50-…png` 的文件 mtime 是 `2026-11-15 15:03:50 +0800`，正好 +8 h。
- 代理写入的 JSON `created` 与文件 mtime 是本机 +0800（例：`S00_001_IN_A1_v01.json` `created=05:01:52+08:00`，同图 mtime `05:01:52.57 +0800`）。
- `DECISIONS.md` 的时间为 +0800。**比较前把工具文件名 +8 h**；本次复核即因此把“10:52–12:35”更正为“18:52–20:35”。

| 时间（2026-11-15，+08:00） | 事件 | 证据 |
|---|---|---|
| 04:28:33–07:07:53 | 90 份 v01 关键帧生成记录（refs 为 `CHAR_001_DESIGN_FINAL`/`DESIGN_C_FINAL`/1938 母版） | 各 JSON `created`（本机 +08:00）；文件 mtime 与之吻合 |
| **12:14–12:17** | **用户拍板**“穰明德以 A 为唯一身份依据”；方法=身份只由参考图承担 | `00_PROJECT_BIBLE/DECISIONS.md`「2026-11-15（下午）」 |
| 12:21–12:29 | 旧法身份根 pilot 3 takes（后被标“已冻结不采用”） | `.work/v02/LEDGER_v02.json` ROOT_T1/T2/T3（文件名 04:21–04:29 UTC→+8 h）；`.work/v02/identity` 目录 mtime 12:21 |
| 13:29 / 15:01 / 15:46 | v02 三轮渲染校验（manifest_FINAL_v03） | `.work/v02/validate_v03{,b,d}.json`（`generated_at` +08:00） |
| **15:03:50** | **身份根内容生成**：`.work/v02/gen/rang3/…07-03-50…-1.png`（ROOT3_T1，sha `aed16ce1…`，4,650,347 B，note“只传A+1938母版…2K”；文件名 07:03:50 UTC） | `.work/v02/LEDGER_v02.json` row ROOT3_T1；stat mtime 15:03:50 |
| **15:19:34** | 根复制到生产路径 `designs/CHAR_001_IDENTITY_ROOT_1950_v01.png`（mtime=**拷贝时间**，内容同 sha） | `stat` |
| **18:52–20:35** | v04 修复批 25 个 ADOPT* 决定（24 有生成时间；**全部晚于根 15:03**；最终进 `USER_SELECTED` 的 `REBUILD_v04` 图 19 张）；文件名 10:52–12:35 UTC → +8 h | `ADOPTION_v04.json`、`ADOPTION_USER_v02.json`；图 mtime 19:24/20:47 与 +8 h 后的生成时间吻合 |
| 20:36 / 20:57 / 22:03 | ADOPTION_v04（25 采用/待QC）、选片册构建、用户选择导出 | 对应 JSON `createdAt`/`exportedAt`（Z 时间已换算 +08:00） |
| 11-16 08:40+ | 2K 再生成/视频订单，首帧 = `USER_SELECTED` 副本 | `docs/video/REGEN_2K…/ORDERS.json`、`ORDERS_B3_B7.json` |

**有证据的结论（替代“早期代理忽略了已有根”）**：
1. 90 份关键帧记录（04:28–07:07）**全部早于**身份根内容（15:03:50）约 8–11 小时；当时已批准的是旧 B/C 定稿，用旧卡是当次正确输入，**不是忽略**。
2. v04 修复批（18:52–20:35）**全部晚于根**（15:03）和用户方向确认（12:14），但 `REBUILD_v04` 里 **0 份生成记录**、QC 文档也不记输入参考 → **无法证明这批图实际带入了根**。
3. 采用 QC 对照的不是根：`REBUILD_v04_GEMINI_QC/REVIEW_BRIEF.json`（20:36 建）给 CHAR_001 的 7 个镜只发 `_previews/REF_A_rangmingde.jpg`；该 preview 与 `refs/CHAR_001_DERIVED_color_unverified.webp`（A）的 96×96 灰度相关 **corr=1.000**（与身份根仅 0.024）→ 审核基准是 A，不是根。
4. 采用图复制为 `USER_SELECTED` 后即冻结为 11-16 的 2K/video 首帧，链条没有“新根回灌/重出已采用帧”的机制。task-8 的 296/300 s 脸不符是这条冻结链的可见后果，但**不能**反推成“当时已有根却不用”。
5. mtime 在本项目常等于生成落地/拷贝/传输时间（根副本、v04 修复图），**不能当创建或批准时间**；批准证据只有 INDEX/NOTES（日期级）与 DECISIONS 12:14–12:17（时间级），根图片本身缺“带时刻的批准记录”——这是台账缺口，不是事实缺失。

### 3.2 旁注哈希核查（ENV 卡：不是覆盖/损坏）

| 检查 | 结果 |
|---|---|
| 28 份 `SCENES_4K/ENV/*.json` 的 `out_sha256`/`bytes` 指向什么 | **28/28 与 `.work/scene3_png_originals/<同名>.png` 完全一致**（boxgirder v04: `96cfc63a…` / 9,636,727 B；`bytes` 也逐个匹配） |
| 当前交付 `ENV/*.jpg` 是什么 | 真 JPEG（PIL 识别 format=JPEG），3840×2160，1,291,188–1,942,186 B；mtime 2026-11-13 12:50:08；与 `.work/mac-receive-20261115/incoming/...` 快照 **同 sha（如 boxgirder `aeaed359…`）**，说明自 11-13 起未被替换 |
| 为什么会不一致 | `tools/gen_image.py` 的 `save()` 把 API 返回的原始字节直接写入 `--out`（批脚本用 `.jpg` 名），并当场算 `out_sha256`/`bytes`；事后 PNG→JPEG 转换替换了文件内容，但**没有更新旁注**（`out` 字段仍指 `.jpg`） |
| 结论 | **不是文件损坏/被覆盖**；是“旁注记录的是下载原件（PNG）哈希，交付件（JPEG）哈希从未登记”。转换脚本/日志未找到 → 标“转换步骤未留记录” |
| 对 registry 的要求 | 同时存 `downloaded_artifact_sha256` 与 `delivered_file_sha256`，并记录转换（工具/时间/质量）；读取时对交付文件重算 sha |

### 3.3 ASR 适配（lead 新文件）

`plugins/dsh-minimax-video/production/local_asr.py` 当前 `model.transcribe(str(file))` 在本机 **必然失败**：已复现 `TypeError: open() got an unexpected keyword argument 'metadata_errors'`（faster-whisper 1.2.1 内部 `av.open(..., metadata_errors="ignore")` vs PyAV 19.0.2）。最小修法为 ffmpeg→float32 numpy，已在项目 venv 实测（2 条片段，文本与既有 ASR 记录一致）。详见 **`ASR_ADAPTER.md`**。

## 4. 低复用的机制原因（可修）

1. **三套入口没有合并**：生产场景卡 `04_LOCATIONS/SCENES_4K/ENV/`、静演空间根 `04_LOCATIONS/ANIMATIC_v01/*/…_MASTER`、选片册 `12_FINAL/KEYFRAME_PICKER_20261115/` 各有一套“索引”，彼此不引用。
2. **批准没有机器可读字段**：`ENV/REVIEW.md` 全是“待验收”，`INDEX.md` 用文字写“未转 APPROVED”；人物 `INDEX.md` 用表格写 APPROVED；关键帧用 `review` 自由文本/文件名标记。程序无法回答“这个 asset 现在能不能用”。
3. **没有 root → dependencies 的 DAG**：关键帧记录里有 `refs`（人可读，含 role 文本），但没有 asset_id/root 指针；`check_scene_refs.py` 只能按“文件内容 sha 等于母版 sha”做一次性检查，不能回答“这张关键帧的根是谁、根有没有被替换”。
4. **没有“未复用/未回灌”告警**：没有脚本统计“APPROVED 但 0 引用”，也没有“根更新后哪些已采用帧变旧”的清单，所以身份根批准后没人发现采用链没有回灌。
5. **sha256 不是身份**：同一图片被改名复制（`USER_SELECTED_*` 是 `ANIMATIC_v01` 的副本），路径变、名字变，只有 sha 稳定；当前多处按路径匹配（如 picker 的 shotIds 归组），路径一换就丢关联。
6. **“批准”与“采用”混在一起**：用户选片是采用决定，不是新图批准；但导出 JSON 没有 approval 字段，adoption 清单又只存在于 `09_EDITING/MANUAL_SELECTION_*`。
7. **延伸机制**：静演线有最完整的记录格式（prompt/refs/role/out_sha256/status/spacecheck），但它是“一条记录一份 JSON、靠目录表达阶段”，没有跨阶段主键；新生成的 REBUILD_v04、PRODUCTION_20261116、REGEN_2K 目录 **0 个 JSON 记录**（订单在 `docs/video`），记录与媒体分家。

## 5. 给主代理的最小实现结构

完整字段/校验规则见 `ASSET_REGISTRY_CONTRACT.md`，可复制的真实样例见 `asset_registry.example.json`（用本项目真实 sha256 和真实 role 文本）。三块：

### 5.1 asset_registry（roles / approval / root / dependencies）

一条资产一个对象，**媒体文件不重复存**，只存指针与 sha256：

```json
{
  "asset_id": "CHAR_001.IDENTITY_ROOT.1950",
  "family": "character",                     // character|location|prop|keyframe|voice|packaging|audio|final
  "role": "identity_root",                   // identity_root|scene_master|prop_root|keyframe|approved_take|plate|voice_ref|final_render
  "file": "03_CHARACTERS/CHAR_001/designs/CHAR_001_IDENTITY_ROOT_1950_v01.png",
  "sha256": "…", "bytes": 0, "width": 0, "height": 0,
  "approval": { "state": "APPROVED", "by": "user", "at": "2026-11-15",
                "evidence": "03_CHARACTERS/INDEX.md#CHAR_001" },
  "scope": { "lines": ["1950","1951"], "shots": ["S02_004","S04_002"] },
  "root": null,
  "dependencies": [],
  "provenance": { "record": "…json", "model": "…", "prompt_sha256": "…", "tool": "…" }
}
```

关键规则（每条都能落到现有工具）：
- `asset_id` 永久稳定；改名/换文件必须新 id + `supersedes`，不能原地改 sha。
- `approval.state` 只允许 `APPROVED/PENDING/REJECTED/SUPERSEDED/ADOPTED`，必须有 `evidence` 指向真实记录；**文件名（REJECTED/alt/FINAL）不参与判定**。
- `root` 指向空间/身份根；`dependencies` 是“生成时实际送入的参考”，必须带 sha256；`check_scene_refs.py` 的“母版 sha 必须在 refs 里”可直接升级为对 `dependencies` 的校验。
- 关键帧必须声明 `root`（场景 master）与人物 `dependencies`（身份根 id），这样“身份根 0 引用”当天就能报出来。
- 采用（adopted）与批准（approved）分开：`adoption = {shot_id, slot, at, evidence}` 放 shot plan 侧，不覆盖 approval。

### 5.2 shot plan references

把现在散在 `PROMPT_SET_v01/*.json` + `ORDERS*.json` + `manifest_motion_v05.json` 的引用收敛成一条链（不新增文件格式，只加字段）：

```
shot/slot → keyframe(asset_id, sha256, approval, adoption)
          → video(asset_id, sha256, in_sec, duration, mode, source_order)
          → manifest 段(shot_id, duration_sec, in_sec)
```
校验：`orders.inputs.image.sha256 == keyframe.sha256`；`manifest 段指向的 video.sha256 == order.output.sha256`；每个 keyframe 的 `root/dependencies` 在 registry 中存在且 sha 未变。现有数据已满足前两条（80/80），只缺字段名与 registry。

### 5.3 local QA route / evidence

每条检查输出一条 `evidence` 记录（tool / args / scope / proves / does_not_prove / result / artifacts / decoded_seconds），并**按 L1→L5 分级**；交付报告只能引用已填的等级。字段和现成命令见 `LOCAL_QA_ROUTE.md`；与现有脚本一一对应：
- L1：ffprobe、完整解码、loudnorm/ebur128、AAC 包散列、sha256、帧数/时长
- L2：ASR 字音、`silencedetect`/RMS、指定窗口帧差、抽帧联排
- L3：模型审看（只在确有综合判断必要时用 Gemini；默认质检不路由到付费 API）
- L4/L5：用户/老师验收，**当前 L5 未发生**（STATE 明确：老师反馈待下一会话）

## 6. 跨项目验证建议（可直接做成验收门槛）

1. **registry lint（离线，秒级）**：文件存在、sha256 匹配、root 存在、dependencies 无环、`approval.evidence` 可解析、role/family 枚举合法。
2. **shot plan lint**：每个被采用的 slot 的 keyframe 必须在 registry 且 `approval.state ∈ {APPROVED, ADOPTED}`；orders 的 image/audio sha 必须等于 registry sha；manifest 的 video 必须存在且 sha 等于订单 output sha；`PROMPT_SET.image` 必须等于 adopted keyframe。
3. **复用报告（每次收尾自动生成）**：`refs_by_root` 计数 + “APPROVED 但 0 引用”清单 + “同一 sha 被 ≥2 个 clip 使用”清单 + “被 REJECTED/SUPERSEDED 标记但仍在 adopted 集合”清单。本项目的输出会立刻暴露：身份根 0 引用、`S06_004_f03` 跨语义复用、`S03_001` 的 REJECTED 名。
4. **交付 QA 门槛**：最终渲染必须同时具备 L1 完整 AV 解码 + 响度 +（派生版）音轨包散列；字幕/字卡必须有点位帧或单帧核验；ASR 只作 L2 辅助；L4/L5 未签字就写 `CUSTOMER_REVIEW_PENDING`（v05 的 `VERIFY.json` 就是这个口径，照抄即可）。
5. **成本/时间排序**：先 `check_*`（毫秒）→ 再 ffprobe/抽帧（秒）→ 再窗口帧差/RMS（十秒级）→ 最后才完整解码（分钟级）；ASR 只对可疑片段跑，不默认全片。
6. **Gemini 边界**：把“技术质检默认走 Gemini”改成默认不路由；仅当任务确需文字综合或跨镜整体判断、且已附本地证据（帧/ASR/测量）时才调用，并在返回里记录“本地已证明什么、还缺什么”。

## 7. 证据与边界

- 本项目所有引用路径均可按项目根解析；本报告没有移动/修改任何被引用文件。
- 已确认的本地证据（存在且非空）：`docs/review/FEEDBACK_V03_FINAL_LOCAL/LOCAL_VERIFY.json`、`docs/review/MOTION_v04_FINAL/{VERIFY.json,full_decode.log}`、`docs/review/MOTION_v05_FINAL/{VERIFY.json,ALL_12_CARDS_FINAL.jpg}`、`docs/review/MOTION_v05_1080P/VERIFY.json`、`docs/review/MOTION_v05_1080P_UNDER200MB/VERIFY.json`、`docs/review/ANIMATIC_v04_DIRECTOR_QC/ACTUAL_FRAME_INDEX_v04.json`、`docs/review/MOTION_v04_ASR/*`、`docs/review/MOTION_v05_VO/*`、`12_FINAL/MOTION_v03/{DELIVERY_MANIFEST_FINAL.json,FINAL_FFPROBE_FINAL.json}`、`12_FINAL/MOTION_v05/DELIVERY_MANIFEST.json`、`09_EDITING/MOTION_v05/{manifest_motion_v05.json,RESOLVE_TIMELINE_SPEC.json,MIX_SHEET_MOTION_v05.json}`。
- 未核/不知道：`audio_probe.py`/`hit_detect.py`/`blind_sheet.py` 是否有生产运行产物（只找到历史文档引用）；`MOTION_v05_FINAL/full_decode.log` 为 0 字节（成功时 stderr 为空，语义是“无错误输出”，不是“没跑”——以 `VERIFY.json` 的 `full_av_decode_exit: 0` 为准）；账户实扣与远端任务状态未核。
