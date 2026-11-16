# 本地 QA 路线（可执行，按成本从低到高）

> 适用：新素材接入 / 局部修订 / 交付前。原则：**先结构、再取样、再窗口、最后整片**；默认全部本地、离线、不调付费 API。每条检查都产出 `evidence`（见 `ASSET_REGISTRY_CONTRACT.md` §3）。
> 这里的“本地”= ffmpeg / Python(numpy/PIL) / faster-whisper；DeepSeek 子代理负责编排与判读，不替代测量。

## 0. 三级门槛速查

| 阶段 | 必跑 | 可选 | 绝不默认 |
|---|---|---|---|
| 生成前（关键帧/视频下单） | `check_scene_refs`（有场景派生时）、registry lint（asset 存在+sha+root）、shot plan lint（采用链） | 成本/时长估算、prompt 显式台词检查 | 调用 Gemini 做“先看看” |
| 生成后（单条素材） | `ffprobe` 规格、**完整解该条**、音频起止（`silencedetect`/RMS）、对白镜的 ASR | 中点帧/首尾帧人工看、`audio_probe` 接缝建议 | 把 ASR 当口型结论 |
| 交付前（成片） | `SPEC_PROBE` + `FULL_AV_DECODE` + `LOUDNESS`（+ 派生版 `AUDIO_PACKET_HASH`） | 指定窗口帧差、字幕/字卡点位帧、抽帧联排 | 整片重复解码多次；把抽帧当完整观看 |

## 1. 生成前

### 1.1 场景派生预检（已有工具，秒级）

```bash
cd ~/DSH_ZONE/VideoStudio/Projects/TanLu-CJU75th
python3 tools/check_scene_refs.py \
  --spec docs/animatic/lines/tianquan/derivations_tianquan_v02.json \
  --master 04_LOCATIONS/ANIMATIC_v01/TIANQUAN/master/TIANQUAN_MASTER_M1_v01.png \
  [--master-sha256 <锁定的 sha256>] [--cards 01,06,07]
```

- PASS 只代表：清单非空、文件存在、所选条目 refs 里含母版内容。
- 仍需：母版**已批准**（registry `approval.state`）、真实请求确实带了图、输出几何人工核。
- 升级建议：把校验对象从“清单 JSON”换成 registry 的 `dependencies`，这样母版换代/sha 变化能自动 BLOCK。

### 1.2 registry / shot plan lint（建议实现，毫秒级）

- 资产：`file` 存在、重算 sha == `sha256`、`root` 存在、`dependencies` 无环、`approval.evidence` 可解析。
- 采用：每个被采用的 slot，keyframe 在 registry 且 `approval.state ∈ {APPROVED, ADOPTED}`；orders 的 image/audio sha 与 registry 一致；manifest 的 video 存在且 sha 与订单 output 一致。
- 复用告警：`approved_unused`、`cross_scope_reuse`、`status_adoption_conflict`、`drift`（本项目四条都已有真实样例，见 `REUSE_GAPS.md`）。

### 1.3 提交前（付费前）必核

- [ ] 输入图/音频**显式**、非空 refs（空 refs 会静默退化为文生图）。
- [ ] 对白镜的台词文本在 prompt 里显式写（`<d>[Chinese]…</d>`），不靠参考音频代替。
- [ ] 人物镜带身份根；场景派生带母版；道具带 prop root。
- [ ] 时长按“申请 ≥ 片内 + 首尾余量”规划（余量是规划值，不是机械裁切）。
- [ ] 成本按当前档位先算（插件侧 task-10/task-12 的 dry-run），未知成本不冒充完整估算。

## 2. 生成后（单条素材，秒级到分钟级）

```bash
# 1) 规格/帧数/时长/音轨（L1，<1s）
ffprobe -v error -show_entries format=duration,size \
  -show_entries stream=codec_type,codec_name,width,height,r_frame_rate,nb_frames,sample_rate,channels \
  -of json <clip.mp4>

# 2) 单条完整解码（L1；只解这一条，不重复整片）
ffmpeg -v error -xerror -threads 4 -i <clip.mp4> -f null -

# 3) 语音起止/句尾余量（L2，仅当有对白）
ffmpeg -hide_banner -nostats -i <clip.mp4> -vn -af silencedetect=noise=-40dB:d=0.15 -f null - 2>&1 | tail -20

# 4) ASR 盲核（L2；只对可疑/新增对白片段，不跑全片）
.work/asr-venv/bin/python docs/review/MOTION_v04_ASR/tools/run_asr_blind.py   # 按需改 CLIPS 路径
```

> ⚠️ ASR 适配：本机 `av 19.0.2` + faster-whisper 1.2.1 下，`model.transcribe("file.mp4")` 会抛 `TypeError: … metadata_errors`；必须先用 ffmpeg 解成 16 kHz mono float32 numpy 再转写。最小代码与实测见 `ASR_ADAPTER.md`（针对 `plugins/dsh-minimax-video/production/local_asr.py` 的现有写法）。

判读规则：
- 句尾/句首落在源文件最后/最前 1 秒内 → 不直接套“裁 1 秒”，按实际波形记录 `可用区间`，并在交付说明里写“未满足默认余量”。
- ASR 同音/近音字差异（钙/盖、腔/枪、雾/物）→ 只记“字音一致”，不改台词、不据此判口型。
- 对白镜必须人看口型（L4）；没有 L4 就写 `LIP_SYNC: NOT_MEASURED`。

## 3. 交付前（成片）

```bash
# L1 规格 + 完整解码 + 响度（v05 现成脚本，可复制改常量）
python3 tools/verify_motion_v05.py

# L1 派生版：音轨包散列 + faststart + 200MB 上限
python3 tools/verify_motion_v05_streaming1080.py
python3 tools/verify_motion_v05_under200.py

# L2 指定窗口帧差（改 WINDOWS 常量；不是全片）
python3 tools/verify_final_local.py

# L2 每段中点帧联排（94 段）
python3 tools/review_user_v04.py --video <成片.mp4> --out docs/review/<新目录>
```

交付门槛（建议写成项目验收）：
- 必须有 `SPEC_PROBE/FULL_AV_DECODE/LOUDNESS` 三条 L1 证据；派生版加 `AUDIO_PACKET_HASH`。
- 字层/字卡变更：点位帧或中点联排 + 语义对位（卡内容 ↔ 当时台词/画面），不能只按镜号定时。
- 只改字/一句旁白：必须证明画面未重渲（如 v05 `native_picture_rerendered: false` + 画面清单与 v04 精确一致），声音窗口外 PCM 字节保留。
- 终态默认 `CUSTOMER_REVIEW_PENDING`；`TECHNICAL_QC_PASS` 不是验收。

## 4. 证据模板（每次检查一条）

```json
{
  "check_id": "FULL_AV_DECODE",
  "tool": "ffmpeg -xerror -f null",
  "args": ["-i", "12_FINAL/MOTION_v05/探路_全片字幕与字卡修订_v05_2K.mp4"],
  "scope": "file",
  "level": "L1",
  "proves": ["可完整解码"],
  "does_not_prove": ["画面内容", "听感"],
  "cost_sec": 47,
  "result": "pass",
  "artifacts": ["docs/review/MOTION_v05_FINAL/full_decode.log"],
  "run_at": "2026-11-16T12:03:00+08:00"
}
```

## 5. 什么时候才调用 Gemini（与本地分工）

| 场景 | 本地先做 | Gemini 何时用 |
|---|---|---|
| 台词/旁白写法、文案、文学性 | —— | 默认用它（项目既定约定） |
| 字幕是否对准语音 | ASR + 波形（L2） | 不必要；除非要判断断句/语气 |
| 一场戏是否成立、跨镜连续性 | 抽帧联排 + 关键帧/母版对照（L2） | 有必要时用，附本地证据清单 |
| 口型/表演/听感 | 无法本地证明 | 交用户/老师（L4/L5）；**不要**让模型代替签字 |
| 全片审美 | 抽帧 + 结构表（L2） | 可作初筛（L3），不得写成验收 |

约束：媒体先本地裁片/转码/ASR 再送；不要读入大文件后 base64 再判；调用记录写清“本地已证明什么、还缺什么”。插件侧对应 task-11 的预检机制。

## 6. 反例（本项目真实踩过）

- 用 ASR 命中原句就宣布“台词通过” → 实际口型/表演仍未验（`docs/review/MOTION_v04_ASR/README.md` 自己写明边界）。
- 用 `review_user_v04` 的 94 个中点帧当“看过全片” → 94/13680 帧，段内动作、过渡、闪烁都看不见。
- 场景卡“规则写了连续”就以为派生会自动连续 → 天全 01/06/07 实际是三次独立文生图（`docs/review/TIANQUAN_CONTINUITY_20261115/AUDIT.md`）。
- 只看下载成功/`result=ok` 就记批准 → 批准只能来自 registry 的 `approval.evidence`。
