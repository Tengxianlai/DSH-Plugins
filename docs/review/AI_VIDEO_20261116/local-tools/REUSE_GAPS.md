# 批准资产复用实测与缺口（TanLu-CJU75th）

> 测量方式：只读解析现有 JSON/目录，不截取、不解码、不改文件。可复现命令见文末。测量对象是**最终关键帧生成记录**（`07_SHOT_GENERATION/ANIMATIC_v01/**/*.json`，90 份）而不是“目录里有什么图”。

## 1. 资产盘点（实际索引）

| 家族 | 批准/有效资产 | 实际位置 | 状态记录在哪 |
|---|---|---|---|
| 人物身份 | 13 人 APPROVED（14 张定稿：穰明德分两年代）；`CHAR_001` 另有 1 张 **identity root**（2026-11-15 15:19 建） | `03_CHARACTERS/CHAR_*/designs/` | `03_CHARACTERS/INDEX.md` 表格 + 各 `NOTES.md` 文字；**无机器字段** |
| 场景卡 | 25 张有效场景卡 + 3 张道具卡（另 1 张 1980s 桥面卡归档） | `04_LOCATIONS/SCENES_4K/ENV/` | `ENV/INDEX.md`（对应镜头）+ `ENV/REVIEW.md`（逐张结论）；**全部“待验收”，未转 APPROVED** |
| 静演空间根 | TIANQUAN M1、BOXGIRDER、HISTORICAL ×7、PROP_002 静演 master 等（同名 JSON + PNG/JPG） | `04_LOCATIONS/ANIMATIC_v01/*/`、`05_PROPS/PROP_002/designs/ANIMATIC_v01/` | 同名 JSON 的 `review` 文本（导演选定/待组版） |
| 关键帧（静演） | 90 份记录 / 90 个输出图 | `07_SHOT_GENERATION/ANIMATIC_v01/<scene>/<shot>/*.json|png` | 同名 JSON：`status` 或 `review`，不统一 |
| 关键帧（用户采用） | 90 格 confirmed（92 格中 2 格 pending） | `07_SHOT_GENERATION/USER_SELECTED_20261115_2203/`（副本） | `09_EDITING/MANUAL_SELECTION_20261115_2203/USER_SELECTION_ORIGINAL.json` + `ADOPTION_USER_v02.json` |
| 视频采用 | 91 画面段 / 84 唯一文件 | 各生产批次 `07_SHOT_GENERATION/*/…/*.mp4` | `09_EDITING/MOTION_v05/manifest_motion_v05.json`（路径+入点，无 sha）；订单 JSON 有 sha |
| 声音 | 23 条原生对白钩子、100 条字幕、1 条新旁白补丁 | `08_AUDIO/MOTION_v05/*`、`08_AUDIO/VO/feedback_v05/` | `MIX_SHEET_MOTION_v05.json`、`PATCH.json` |
| 包装 | 12 张信息卡 + 7 个片头/片尾层 | `11_VFX/MOTION_v05/cards/` 等 | `manifest_motion_v05.json` overlays |
| 交付 | v05 2K + 两档 1080P | `12_FINAL/MOTION_v05/` | `DELIVERY_MANIFEST.json`、`STREAMING_*_MANIFEST.json`、各 `VERIFY.json` |

**结论：索引存在，但分散在 5 类载体（INDEX/REVIEW 表、同名 JSON、选片导出、订单、manifest），没有任何一个文件能回答“这个资产现在是什么状态、被谁用了、根是谁”。**

## 2. 复用实测（90 份关键帧记录 = 226 条引用 / 68 个唯一资产）

### 2.1 场景

| 资产 | 被引用次数 |
|---|---:|
| `04_LOCATIONS/ANIMATIC_v01/BOXGIRDER/BOXGIRDER_ANIMATIC_MASTER_v01.png` | 17 |
| `04_LOCATIONS/ANIMATIC_v01/TIANQUAN/master/TIANQUAN_MASTER_M1_v01.png` | 17 |
| 其余 HISTORICAL master（SHED/TECHTENT/ERLANGSHAN/CAMPUS/REPORTTENT/PLATEAU_ROAD/SHED_EXTERIOR/CLASSROOM_NIGHT） | 合计 ~21 |
| `.work/scene_review_20261115/*`（候选图） | 7+ |
| 生产 ENV 卡（25 张里） | **10 条 / 5 张**：`ENV_S05_1964_survey_v02`×3、`ENV_S05_2018_hzmb_top_v01`×2、`ENV_S05_1980s_archbridge_v03`×2、`ENV_S01_2026_deck_hatch_v01`×2、`ENV_S05_1984_workshop_v02`×1 |

- 同名母版内部还有对 ENV 卡的引用（如 `BOXGIRDER_ANIMATIC_MASTER.json` 的 `reference_images` 含 `ENV_S01_2026_boxgirder_v04.jpg`），所以 ENV 卡并非“没用”，而是**只作为二级参考**进入，从未作一级空间根。
- 风险：ENV 卡登记为“待验收”，而下线关键帧却以它为参考之一 → 若 ENV 卡被改版，关键帧链条无法被校验出来。

### 2.2 人物

| 资产 | 被引用次数 |
|---|---:|
| `CHAR_004_DESIGN_FINAL_v01.jpg` | 11 |
| `CHAR_005_DESIGN_FINAL_v01.jpg` | 11 |
| `CHAR_003_DESIGN_FINAL_v01.jpg` | 10 |
| `CHAR_001_DESIGN_FINAL_v01.jpg`（旧 B 定稿） | 9 |
| `CHAR_001_DESIGN_C_FINAL_v01.jpg`（旧 C 定稿） | 4 |
| `CHAR_001_MASTER_v01.webp`（1938 母版） | 2 |
| 其余 7 人 | 各 1–3 |
| **`CHAR_001_IDENTITY_ROOT_1950_v01.png`** | **0** |

- **不能据此说“早期代理忽略已有根”**：90 份记录创建于 04:28:33–07:07:53（+08:00），**全部早于**身份根内容生成（15:03:50 的 `.work/v02/gen/rang3/…ROOT3_T1`，sha `aed16ce1…`；工具文件名 07:03:50 为 UTC，+8h 后才是本机时间）。当时已批准的是旧 B/C 定稿，用旧卡是当次正确输入。
- 身份根文件路径的 mtime（15:19:34）是**拷贝落地时间**，不是创建/批准时间；内容生成于 15:03:50（工具文件名 07:03:50 UTC），用户“A 为唯一身份依据”的决定在 `DECISIONS.md` 记录为 12:14–12:17。根图片本身没有单独的带时刻批准记录（台账缺口）。
- 真正的缺口：根生成（15:03）之后，v04 修复批的 25 个 ADOPT* 决定（工具文件名 10:52–12:35 UTC → 本机 18:52–20:35，24 个有时间；最终 `USER_SELECTED` 中来自 `REBUILD_v04` 的 19 张）在 `REBUILD_v04` 里 **0 份生成记录**，无法证明是否带入根；随后这些图被复制为 `USER_SELECTED` 并冻结成 11-16 的 2K/video 首帧，链条无“新根回灌”机制。
- 采用 QC 也没换成根：`REBUILD_v04_GEMINI_QC/REVIEW_BRIEF.json`（20:36 建，晚于根批准）给 CHAR_001 的 7 个镜只发 `_previews/REF_A_rangmingde.jpg`；该 preview 与 `CHAR_001_DERIVED_color_unverified.webp`（A）的 96×96 灰度相关 1.000，与身份根仅 0.024 → 评审对照的是 A 参考，不是根。
- 现场后果（task-8 报告）：296 s/300 s 脸与身份根不一致，首帧图本身“比身份根更圆更年轻”；这是冻结采用链的后果，不能反推成“当时已有根却不用”。

### 2.3 关键帧 → 视频（这一段是好的）

- `PROMPT_SET_v01`：83 clips（61 first_frame、15 reference、5 reference_image_only、1 skip、1 reuse），81 带 `image`，80 唯一。
- 80/80 唯一关键帧都能在 `docs/video/**/ORDERS|SHARD|MASTER_PLAN|QUOTE` 里找到 `inputs.image.sha256`；`USER_SELECTED` 文件 = 选片记录的 sha（`IMPORT_VALIDATION.all_files_match=true`）。
- 跨段复用仅 1 例：`S06_004_f03_98263339a6.png` 同时用于 `S06_004-2a`/`2b`，2b 的 prompt 却写“教授+橙背心”，是 7:58 角色错配的根因。

### 2.4 采用/状态矛盾样例

| 样例 | 记录状态 | 实际使用 | 结论 |
|---|---|---|---|
| `S03_001_IN_A1_REJECTED_gaze-at-camera.png` | 同名 JSON `REJECTED_NOT_DELIVERED` | 用户在选片册 confirmed；`ADOPTION_USER_v02` `status: user_selected`；v05 manifest 采用其生成的 2K 视频 | 文件名/旧状态不能当否决；**adoption 覆盖 rejection 必须显式记录** |
| `S02_001_IN_A1_v01` 等 4 张 | `SUPERSEDED_NOT_DELIVERED` | 未被选（正确） | superseded 应带 `superseded_by`，当前只有状态名 |
| `CHAR_001` 身份根 | `INDEX.md` 文字 APPROVED（日期级；用户方向决定 12:14–12:17 记于 DECISIONS；根内容 15:03:50 生成） | 90 份晨间记录 0 引用（全部早于根内容，属时间顺序）；v04 修复帧（晚于根）无生成记录、采用 QC 仍用 A 参考 | 根未回灌 + 修复帧 provenance 缺失 |
| 25 张 ENV 卡 | REVIEW 全“待验收” | 部分作二级参考 | 状态粒度不足（“待验收”不等于不可用，也不等于可作根） |

## 3. 低复用的 7 个机制原因（按可修性排序）

1. **入口分裂**：ENV 卡 / 静演 master / 选片册 = 三套“场景入口”，没有 `role` 区分（`scene_master` vs `scene_state` vs `plate`），执行者只能按习惯选。
2. **批准不可机读**：`APPROVED/待验收/导演选定` 全是自然语言；下游脚本无法据此选择，只能沿用“上次用的那套”。
3. **没有 root 指针**：关键帧记录有 `refs` 但没有 `root` 字段；身份根/母版换代后无法自动重链。
4. **没有未复用/未回灌告警**：无人统计“APPROVED 但 0 引用”，也没有“根更新后哪些已采用帧变旧”的清单。
5. **sha 不是主键**：`USER_SELECTED` 是副本改名，路径匹配会丢；当前靠人工记录 sha 关联。
6. **批准 vs 采用混用**：用户选片是“采用”，不是“新图批准”；导出格式缺字段，导致 adoption 只活在 `09_EDITING/MANUAL_SELECTION_*`。
7. **记录与媒体分家**：静演线“一图一 JSON”，后续 `REBUILD_v04`、`PRODUCTION_20261116`、`REGEN_2K_V03` 目录 **0 JSON**（记录在 `docs/video` 订单里），新的好做法没有延续。
8. **旁注哈希指向另一个制品（不是文件坏）**：`SCENES_4K/ENV` 的 `out_sha256/bytes` 与 `.work/scene3_png_originals/<同名>.png` **28/28 一致**；交付 `.jpg` 是后来转换的真 JPEG（11-13 12:50 起未变，与 Mac 接收快照同 sha）。根因是 `tools/gen_image.py` 的 `save()` 把 API 原始 PNG 字节写到 `.jpg` 路径并在当时算哈希，后续转换未刷新旁注。registry 必须分别记录下载原件与交付件哈希。

## 4. 每个缺口的可执行修法（与 `ASSET_REGISTRY_CONTRACT.md` 对应）

| 缺口 | 最小修法（不重做资产） | 验证方式 |
|---|---|---|
| 身份根 0 引用 | 在 registry 给 `CHAR_001.IDENTITY_ROOT.1950` 建条目，给 296/300/478 等人物镜的关键帧条目补 `dependencies`（实际用的旧图）并标 `stale_root: true`；下次重出强制带根图 | 复用报告出现“stale_root 计数”，修一镜减一 |
| ENV 卡状态不明 | 给 25 张卡补 `approval.state`（APPROVED/PENDING/SUPERSEDED）+ `evidence` 指向 REVIEW/INDEX 行；`role=scene_master` 只给真正作一级根的卡 | `check_scene_refs` 升级为读 registry，root 非 APPROVED 或 sha 变动即 BLOCK |
| 关键帧状态不一 | 统一 90 份记录：`approval`（导演/用户）+ `adoption`（shot/slot）+ `root` + `dependencies`；`review` 自由文本保留作备注 | lint：状态枚举合法、adoption 的 slot 在 shot plan 存在 |
| 文件名陷阱 | registry 里显式记 `adoption.note: "filename says REJECTED; user confirmed 2026-11-15"`；任何过滤逻辑只读 registry，不读文件名 | lint：adopted 集合与 approves 集合的差集必须为空或显式豁免 |
| 跨语义复用 | 给 `S06_004_f03` 条目标 `scope.shots=["S06_004-2a"]`；2b 的订单校验发现“图片 scope 不含本 clip”即报错 | 订单 lint：image 的 scope 是否覆盖 clip |
| manifest 计数不一致 | manifest 只保留计算得出的计数，删除 `integration.picture_segments` 这类复制字段 | lint：`sum(len(frames)) == motion_meta.slots_motion == expected.keyframe_count` |
| 记录与媒体分家 | 新批次沿用静演线 JSON 格式，或直接把订单 JSON 作为该批 `record` 链入 registry | lint：每个 adopted 媒体都有 `provenance.record` |

## 5. 复现命令（只读）

```bash
cd ~/DSH_ZONE/VideoStudio/Projects/TanLu-CJU75th

# 2.1/2.2 引用统计：90 份关键帧记录里的 refs（含 reference_images）
python3 - <<'EOF'
import json,glob,collections
cnt=collections.Counter()
for f in glob.glob('07_SHOT_GENERATION/ANIMATIC_v01/**/*.json',recursive=True):
    d=json.load(open(f))
    for r in (d.get('refs') or d.get('reference_images') or []):
        p=r.get('path') if isinstance(r,dict) else r
        if p: cnt[p]+=1
for p,c in cnt.most_common(25): print(c,p)
EOF

# 2.3 关键帧→订单 sha 闭包
python3 - <<'EOF'
import json,glob
ps={c['image'] for f in glob.glob('docs/video/PROMPT_SET_v01/S*.json')
    for c in json.load(open(f))['clips'] if c.get('image')}
rec=set()
def walk(o):
    if isinstance(o,dict):
        for k,v in o.items():
            if k=='image' and isinstance(v,dict) and v.get('path'): rec.add(v['path'])
            elif k in ('image','first_frame') and isinstance(v,str): rec.add(v)
            elif k in ('reference_images','images') and isinstance(v,list):
                for x in v:
                    if isinstance(x,dict) and x.get('path'): rec.add(x['path'])
            else: walk(v)
    elif isinstance(o,list):
        for x in o: walk(x)
for f in glob.glob('docs/video/**/*.json',recursive=True):
    try: walk(json.load(open(f)))
    except Exception: pass
print('keyframes',len(ps),'with record',len(ps&rec),'missing',len(ps-rec))
EOF
```
