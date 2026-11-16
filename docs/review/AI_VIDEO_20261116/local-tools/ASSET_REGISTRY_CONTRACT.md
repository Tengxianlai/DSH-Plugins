# 跨项目资产注册与本地 QA 契约（最小可实现版）

> 目标：让“批准的身份根 / 场景母版 / 关键帧 / 视频 / 声音”可被程序查询、被校验、被复用；让本地核验的结论带等级和证据，而不是散在多份 README。
> 本文只定义结构，不要求迁移旧目录；落地方式可以是 `docs/asset_registry.json`（或 `project.json` 内的 `assets` 段），也可以由插件生成。字段命名刻意保持扁平、可 JSON Schema 化。

## 1. asset_registry

### 1.1 条目（一条资产一个对象）

```jsonc
{
  "asset_id": "CHAR_001.IDENTITY_ROOT.1950",   // 永久稳定，唯一；建议 "<家系>.<角色>.<版本>"
  "family": "character",                        // character | location | prop | keyframe | video | voice | packaging | audio | final
  "role": "identity_root",                      // identity_root | scene_master | scene_state | prop_root | keyframe | approved_take | plate | voice_ref | mix_stem | final_render
  "file": "03_CHARACTERS/CHAR_001/designs/CHAR_001_IDENTITY_ROOT_1950_v01.png",
  "sha256": "aed16ce1…",                        // 当前文件；读取时必须重算比对
  "bytes": 4650347,
  "width": 0, "height": 0,                      // 视频/图片可选
  "duration_sec": null,
  "approval": {
    "state": "APPROVED",                        // APPROVED | PENDING | REJECTED | SUPERSEDED | ADOPTED
    "by": "user",                               // user | director | teacher | line-owner
    "at": "2026-11-15",
    "evidence": "03_CHARACTERS/INDEX.md#CHAR_001"  // 必须可解析到真实记录
  },
  "scope": { "lines": ["1950", "1951"], "shots": ["S02_004", "S04_002"], "valid_for": ["keyframe_gen", "poster"] },
  "root": null,                                 // 该资产派生自哪个根 asset_id；根资产为 null
  "dependencies": [                             // 生成/合成时**实际送入**的参考
    { "asset_id": "CHAR_001.MASTER.1938", "sha256": "…", "role": "一手历史母版" }
  ],
  "provenance": {
    "record": "07_SHOT_GENERATION/ANIMATIC_v01/S03/S03_001/S03_001_IN_A1_REJECTED_gaze-at-camera.json",
    "model": "gpt-image-2.6-sunburst", "tool": "DSH image_generate", "prompt_sha256": "…"
  },
  "supersedes": [], "superseded_by": null,
  "notes": "文件名含 REJECTED，但用户 2026-11-15 选片确认；以 adoption 为准"
}
```

### 1.2 硬规则（每条都能被 lint 检查）

| # | 规则 | 检查方式 | 失败后果 |
|---|---|---|---|
| R1 | `asset_id` 永久稳定；文件/内容变化必须新 id + `supersedes` | 重算 sha 与条目不符 → 报 drift，不静默更新 | 路径还在但内容换了，下游全部失效 |
| R2 | 媒体文件只存一份，registry 只存指针 + sha256 | 同 sha 多路径可合并 aliases；禁止复制进 registry | 副本改名丢失关联（本项目已发生） |
| R3 | `approval.evidence` 必须指向真实文件/锚点 | 文件存在 + 锚点可 grep | “口头批准”无法复现 |
| R4 | 文件名不参与状态判定 | lint 不看 `REJECTED/alt/FINAL` 字样 | 误杀在用资产（`S03_001` 实例） |
| R5 | `root`/`dependencies` 构成 DAG | DFS 检环；root 必须同 family 的 master | 身份/空间漂移无法追溯 |
| R6 | 空间派生：`dependencies` 必须包含 `root` 的 sha 内容（等价于 `check_scene_refs.py` 的母版检查） | 比对 sha | 空 refs 静默退化成文生图（本项目历史事故） |
| R7 | `role=scene_master` 全项目每“地点+年代”唯一；`scene_state` 必须挂 master | 统计 role+scope | 多张“母版”互相矛盾（天全 01/06/07 历史问题） |
| R8 | 采用与批准分离：`adoption` 写在 shot plan，不改 approval | lint：adoption 只能引用已存在 asset | 用选片覆盖批准语义 |
| R9 | 状态迁移 append-only（`events: [{state, by, at, evidence}]`） | 事件时间单调 | 无法回答“何时、被谁、凭什么改的” |
| R10 | 记录内哈希必须与当前文件一致；不一致就当 drift 报错 | 重算 sha | 本项目 28/28 ENV 卡记录 sha 与现文件不符（经查是记录指向下载 PNG，见下文） |
| R11 | **下载原件与交付件分开记哈希**：`downloaded_artifact_sha256`（API 返回的原始字节，可能是 PNG 却写成 .jpg）与 `delivered_file_sha256`（实际交付文件），并记转换工具/时间/参数 | 两条 sha 都存在且各自可重算 | 本项目 ENV 卡 28/28：记录 hash 是原始 PNG，交付 JPG 从未登记 → 被误当成 drift/覆盖 |

### 1.3 家族最小字段

| family/role | 必填额外字段 | 现有可复用来源 |
|---|---|---|
| `character/identity_root` | `scope.lines`、`dependencies`（一手历史母版）、`approval.evidence` | `03_CHARACTERS/INDEX.md`、各 `NOTES.md`、`CHAR_001/refs/CHAR_001_MASTER_v01.webp` |
| `location/scene_master` | `scope.lines`、`scope.locations`、`dependencies`（真实参考/母版候选） | `04_LOCATIONS/ANIMATIC_v01/*/…_MASTER.json`（`refs`→dependencies） |
| `location/scene_state` | `root`（master）、`dependencies` 含 root sha；`state`（汛期/雨后/吊装…） | `docs/animatic/lines/tianquan/derivations_tianquan_v02.json` |
| `prop/prop_root` | `approval.state`、`dependencies`（专利/实物参考） | `05_PROPS/README.md`、`PROP_002/…MASTER.json` |
| `keyframe/keyframe` | `root`（场景）、`dependencies`（人物身份根 + 道具 + 场景）、`shot_id`、`frame_order`、`provenance.record` | `07_SHOT_GENERATION/ANIMATIC_v01/**/*.json`（90 份，字段已含 refs/out_sha256） |
| `video/approved_take` | `parent`（keyframe）、`mode`（first_frame/reference）、`in_sec`/`duration`、`task_id`、`output.sha256` | `docs/video/**/ORDERS*.json`、`REGEN_2K…/ADOPTION_*.json` |
| `voice/voice_ref` | `character`、`source`（原生/ TTS）、`duration` | `08_AUDIO/H3_NATIVE_VOICES_v01/README.md`、`MIX_SHEET_MOTION_v05.json` |
| `packaging/card` | `start_sec`/`end_sec`、`text_sha256`、事实来源 | `11_VFX/MOTION_v05/cards/*`、`manifest.overlays` |
| `final/final_render` | `duration/frames/规格`、`sha256`、`qa` 证据引用 | `12_FINAL/MOTION_v05/*`、`docs/review/MOTION_v05_FINAL/VERIFY.json` |

## 2. shot plan references（镜表 → 关键帧 → 视频 → manifest）

不新增文件格式，只把现有三层加字段并保证可 join：

```jsonc
{
  "shot_id": "S03_001",
  "slot": "f01",
  "duration_sec": 7.625,
  "keyframe": {
    "asset_id": "KF.S03_001.f01",
    "sha256": "2627cdfa35f153cee9df55ff7bd3c731950940f4e07eaee8beffbb7361f36189",
    "approval_state": "ADOPTED",             // 采用；不是“新图批准”
    "adoption": { "by": "user", "at": "2026-11-15",
                  "evidence": "09_EDITING/MANUAL_SELECTION_20261115_2203/USER_SELECTION_ORIGINAL.json#S03_001:f01" }
  },
  "video": {
    "asset_id": "VID.S03_001-0.2K",
    "sha256": "…",
    "mode": "first_frame",
    "in_sec": 1.25,
    "task_id": "…",
    "order_record": "docs/video/REGEN_2K_V03_20261116/BATCH_B/ORDERS.json#S03_001-0"
  },
  "covers": ["S03_001#0"],
  "manifest_ref": "09_EDITING/MOTION_v05/manifest_motion_v05.json#shots[S03_001]"
}
```

**校验（全部可离线跑）：**
1. `keyframe.sha256 == registry[keyframe.asset_id].sha256`，且 `approval_state ∈ {APPROVED, ADOPTED}`。
2. `video.sha256 == order.output.sha256`，且 `order.inputs.image.sha256 == keyframe.sha256`。
3. `manifest` 中该段的 `video` 路径/入点与 shot plan 一致；`in_sec + duration_sec ≤ 源时长 − 安全尾`（余量规则见 `00_PROJECT_BIBLE/VIDEO_TIMING_AND_HANDLES.md`，是规划提醒不是机械裁切）。
4. `covers` 与 `SHOTS.csv` 的镜号一致；同一 `keyframe.sha256` 被 ≥2 个 clip 使用时，两个 clip 的 `dependencies` 必须都覆盖各自角色。
5. 计数只有一个来源：`Σ frames == motion_meta.slots_motion == expected.keyframe_count`（本项目 manifest 里 `integration.picture_segments=92` 是旧版残留，必须删）。

## 3. local QA route / evidence

### 3.1 检查项定义

```jsonc
{
  "check_id": "FULL_AV_DECODE",
  "tool": "ffmpeg -xerror -f null",
  "scope": "file",                    // file | segment | window | sampled
  "level": "L1",                      // L1 技术测量 / L2 自动转录与信号 / L3 模型审看 / L4 用户验收 / L5 客户/老师验收
  "proves": ["容器可完整解码", "无损坏帧/流"],
  "does_not_prove": ["画面内容正确", "动作自然", "听感"],
  "cost_sec": "30–60s/570s 2K",
  "evidence": { "result": "exit=0", "artifacts": ["docs/review/MOTION_v05_FINAL/full_decode.log"] }
}
```

### 3.2 项目内现成映射（直接用）

| check_id | tool（真实路径） | level | scope | proves | does_not_prove |
|---|---|---|---|---|---|
| `SPEC_PROBE` | `ffprobe`（`tools/verify_motion_v05.py`） | L1 | file | 宽高/帧率/帧数/时长/声轨规格 | 内容 |
| `FULL_AV_DECODE` | `ffmpeg -xerror -f null`（同上） | L1 | file | 完整解码无错 | 内容/听感 |
| `LOUDNESS` | `ffmpeg -af loudnorm/ebur128` | L1 | file | LUFS/真峰值 | 听感、音乐契合 |
| `AUDIO_PACKET_HASH` | `ffmpeg -c:a copy -f hash`（`verify_motion_v05_streaming1080.py`） | L1 | file | 派生版音轨逐包一致/未重编码 | 音轨内容是否合适 |
| `PCM_WINDOW_EXACT` | `wave` 比对（`verify_motion_v04.py`/`patch_feedback_v03_audio.py`） | L1 | window | 窗口外母轨逐字节保留 | 窗口内听感 |
| `FRAME_WINDOW_DIFF` | `tools/verify_final_local.py` | L2 | window | 指定窗口内亮度/帧差/音量越界 | 全片、动作自然、色彩 |
| `SEGMENT_MIDPOINT_SHEET` | `tools/review_user_v04.py` | L2 | sampled | 每段中点存在/可读/可联排 | 段内其他帧、口型 |
| `ASR_WORD_TIMES` | `docs/review/MOTION_v04_ASR/tools/run_asr_blind.py` | L2 | segment | 字音/时码、删词残留 | 口型、表演、字幕断句 |
| `SPEECH_BOUNDS` | `silencedetect` + 20 ms RMS（assemble.py） | L2 | segment | 语音起止/气口/峰值 | 听感 |
| `CARD_SEMANTICS` | 抽帧 + 人工/Gemini 复核（`ALL_12_CARDS_FINAL.jpg`） | L2→L3 | sampled | 卡文字/时机与画面台词对位 | 全片审美 |
| `STRUCTURE_LINT` | `tools/check_shots.py` | L1 | file | CSV 结构/枚举/必填 | 素材存在、质量 |
| `SCENE_REF_LINT` | `tools/check_scene_refs.py` + registry | L1 | file | 引用存在、含母版 sha | 批准、送达、几何 |
| `ADOPTION_LINT` | 本文 shot plan 规则 | L1 | file | 采用链 sha 一致、状态合法 | 内容好坏 |
| `HUMAN_REVIEW` | 用户/老师 | L4/L5 | full | 验收 | ——（只能人给） |

### 3.3 交付门槛（建议写进项目验收）

- 任何 `final_render` 必须至少有 `SPEC_PROBE/FULL_AV_DECODE/LOUDNESS` 三条 L1；派生码率版另加 `AUDIO_PACKET_HASH`。
- 字层/字卡变更必须有 `SEGMENT_MIDPOINT_SHEET` 或点位帧 + `CARD_SEMANTICS` 证据；只改字不重渲画面要额外证明 `PICTURE_MASTER_RECORD`（如 v05 的 `native_picture_rerendered: false`）。
- 任何“台词/口型相关”的结论只能引用 L2（ASR/波形）作辅助，交付文档必须写 `LIP_SYNC: NOT_MEASURED`，除非有人（L4/L5）明确看过并签字。
- `CUSTOMER_REVIEW_PENDING` 是默认终态；`TECHNICAL_QC_PASS` 不等于验收。

## 4. 跨项目落地顺序（最小步骤）

1. **只读生成**：写一个脚本扫描现有目录，产出 `asset_registry.json` 草稿（不移动文件）：
   - `03_CHARACTERS/INDEX.md` 表格 → character 条目；
   - `04_LOCATIONS/SCENES_4K/ENV/*.json` + `INDEX/REVIEW` → location/prop 条目（`approval.state=PENDING`，除非有明确批准）；
   - `04_LOCATIONS/ANIMATIC_v01/**/*_MASTER.json`、`05_PROPS/**/*_MASTER.json` → master 条目（`approval.state` 由 `review` 文本人工确认后填）；
   - `07_SHOT_GENERATION/ANIMATIC_v01/**/*.json`（90）→ keyframe 条目（`root`/`dependencies` 从 `refs[].path/.sha256/.role` 映射）；
   - `09_EDITING/MANUAL_SELECTION_20261115_2203/*.json` → `adoption` 事件；
   - `docs/video/**/ORDERS*.json` → video 条目 + `order_record`。
2. **lint**：实现 R1–R10 + shot plan 5 条；先以 warning 模式接进现有 `check_*`，不要一上来阻断。
3. **复用报告**：每次收尾输出 `refs_by_root`、`approved_unused`、`cross_scope_reuse`、`drift`、`status_adoption_conflict`。
4. **接入生成入口**：`dsh-image-gen`/`dsh-minimax-video` 提交前要求 `asset_id` 或 `sha256` 来源（task-10/task-12 的接口），拒绝空 refs 与“身份根未随行”的人物镜。
5. **只读工具复用**：把 `check_shots.py`、`check_scene_refs.py` 路径抽成插件可调用的 `scripts/verify.mjs`（spawn python3），不复制逻辑。

## 5. 与 Gemini 的分工（用户明确要求）

- 默认技术质检：本地工具（ffmpeg/numpy/PIL/ASR）+ DeepSeek 子代理；**不默认路由到付费 API**。
- Gemini 只在两类场景：① 文学/文字创作与改写（既定约定）；② 确有必要、且已附本地证据（抽帧、ASR、测量）的整体判断（如“这场戏是否成立”），调用记录里写清“本地已证明/还缺什么”。
- 插件侧的落地对应 task-11：把“媒体过大先本地裁片/转码/ASR”的预检做进工具，而不是读入后 base64 再判。

## 6. 已知不适用/不要做

- 不要把 registry 做成“每次生成自动写媒体副本”的库：会破坏现有目录与 DRP 引用（`09_EDITING/MOTION_v03/cache/flat_cards` 已被 DRP 引用，不能按 cache 清）。
- 不要用目录名/文件时间表达状态（本项目已有 `REJECTED` 文件在用、`FINAL` 有旧版本的反例）。
- 不要在 lint 里默认“最新/最大/模型 PASS = 采用”；采用只由 `adoption` 事件决定。
- 不要把 28/28 的 ENV 卡“记录不符”当作文件坏了：本项目已查明记录指向原始下载 PNG（`.work/scene3_png_originals/*.png` 28/28 匹配），交付 `.jpg` 是转换件未登记；按 R11 补 `delivered_file_sha256`，不要用“覆盖/损坏”叙事，也不要只更新一条 sha 了事。
- 不要用文件 mtime 当创建/批准时间，也不要混用工具文件名：DSH 插件用 `new Date().toISOString()` 命名输出（**文件名是 UTC**），代理 JSON `created` 与文件 mtime 是本机 +08:00。本项目身份根内容 15:03:50(+08) 生成（文件名 07:03:50 UTC）、生产路径 mtime 15:19 是拷贝时间；v04 修复图 mtime 19:24/20:47 与生成时间吻合。所有跨源时间戳先归一化（建议存 ISO-8601 带偏移 + 原始字符串）。
