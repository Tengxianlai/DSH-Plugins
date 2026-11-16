# dsh-image-gen

一个 `image_generate` 工具，接两个生图后端，调用者用 `provider` 任意切换：

- **GPT**：TeamoRouter 的 OpenAI 兼容 Images API（GPT Image 2.x；`gemini-3-pro-image` / `gemini-3.1-flash-image` 也走这个后端）。
- **MiniMax**：MiniMax H3-Image 标准版 / 极速版（`MiniMax-H3-Image`、`MiniMax-H3-Image-Highspeed`）。

两个后端都支持文生图、单图编辑、多参考图合成；都返回文件路径，图片字节不进对话上下文。
选型或算价前先调用 `image_models`，它输出下面这张档位/价格快照的英文版。

另有两项每次都会发生的行为：

- **自动来源收据**：每次调用把 prompt/模型/规格、真实参考图清单（sha256、实际尺寸、角色、批准声明）、
  输出文件 hash/实际尺寸、估价（明确标 `bill:false`）写进 `<out_dir>/receipts/<id>.json`，且在付费请求**之前**落盘。
- **`dry_run`**：不取密钥、不联网，先校验参数/尺寸/档位/来源并生成计划收据，用来在花钱前核对。

## 先读：GPT 的「1K / 2K / 4K」是计费档，不是叫法

GPT 按**实际交付图的最长边**判档，不看请求参数：

| 档位 | 交付图最长边 | 典型尺寸 | 每张（人民币，2026-11-15 用户告知的账户实扣） |
|---|---|---:|---:|
| 1K | ≤ 1024 | 1024×1024 | **¥0.18** |
| 2K | ≤ 2048 | 2048×2048、2048×1152（16:9） | **¥0.18**（和 1K 同价） |
| 4K | > 2048 | 2880×2880（1:1）、3840×2160（16:9） | **¥0.60**（约 3.3 倍） |

由此得出三条硬规则：

1. **要 2K 就写 `size: "2k"` + `aspect`，不要自己算像素。** 16:9 的 2K 是 `2048x1152`。
2. **`2560x1440` 不是 2K，是 4K 计费**（最长边 2560 > 2048）。同理 `2560x1600`、`3440x1440`
   都按 4K 收费。插件会拒绝未显式确认的 GPT 4K 级自定义尺寸（见 `allow_4k`）。
3. **GPT 不要选 1K**：2K 与 1K 同价、像素多 4 倍。默认档已改为 `2k`。

4K 真有必要时，优先用 MiniMax 标准版 `4k`（促销价 ¥0.2261/张、16.8MP），比 GPT 4K 的
¥0.60 便宜且像素约 2 倍。

## 为什么

- 一个工具覆盖两类需求：GPT 的画质/指令遵循档位，MiniMax 的低价 4K 面积档和最多 16 张参考图。
- 直连上游能拿到完整参数：任意合法尺寸、比例、n、质量、输出格式、多参考图。
- 图片落盘为文件，返回值只有路径；不会把几 MB 的 base64 塞进上下文。
- 档位和价格写进插件（`lib/catalog.js` 与 `image_models`），调用前就知道 2K/4K 的差价，
  不会再出现「说 2K、记 4K」的静默超支。

## 工具

### `image_generate`

| 参数 | 说明 |
|---|---|
| `prompt` | 必填。画什么，或怎么改；最长 32,000 字符。 |
| `provider` | `gpt`（默认）或 `minimax`。传了 `model` 时可省略，按模型推断。 |
| `model` | 具体模型 id。默认：`gpt-image-2.6-sunburst`（gpt）、`MiniMax-H3-Image`（minimax）。`*-4k-upscale` 是 4K 专用变体，只能出 4K。 |
| `images` | 参考/源图（本地路径或 http(s) URL，1–16 张）。一张=编辑，多张=合成；不传=文生图。 |
| `size` | **计费档**：`1k` / `2k` / `4k`，或显式 `WIDTHxHEIGHT`。默认：gpt `2k`、minimax `1k`。GPT 按交付最长边判档；2K=≤2048，4K=>2048。 |
| `aspect` | 档位配合的比例：`1:1` `16:9` `9:16` `4:3` `3:4` `3:2` `2:3`。默认 `1:1`；显式宽高时忽略。 |
| `allow_4k` | 仅 gpt，默认 `false`。显式宽高的最长边 >2048（按 4K 收费）时，必须显式设 `true` 才放行。传 `size:"4k"` 不需要它。 |
| `quality` | 仅 gpt：`auto` / `low` / `medium` / `high`，默认 `auto`；不改变尺寸档位。minimax 传非 `auto` 会报错。 |
| `n` | 单次张数：gpt 1–4，minimax 1–10，默认 1。 |
| `format` | `png` / `jpeg` / `webp`，默认 `png`。MiniMax 按请求返回；GPT 2.6 实测会忽略 `jpeg` 仍返回 PNG，插件按实际字节定扩展名，并在返回值 `format` 里给出实际格式。 |
| `out_dir` | 落盘目录，相对会话工作目录，默认 `generated-images`；收据写到 `<out_dir>/receipts/`。 |
| `references` | 可选。给 `images` 里每一项标注来源：`{image, role, approved, source, note}`。`role` 取 `identity_root` / `character_card` / `scene_card` / `keyframe` / `source_frame` / `style_ref` / `other`。`approved:true` 是**调用方声明**（收据记 `caller_declared`），不是插件核验。 |
| `references_file` | 可选。项目资产清单 JSON（数组 / `{references:[...]}` / `{assets:[...]}`）。entry 支持 `image`\|`path`、`role`\|`kind`、`approved`、`required`、`source`、`note`、`sha256`（64 hex，与真实字节比对）、`id`、`approval_evidence`、`root_ids`。**`required:true` 的条目必须实际出现在 `images` 且 sha256 与真实字节一致，否则取凭据/联网前直接拒绝**；未标 required 的 approved 资产只是可选信息，不会强制全塞。清单 path+sha256+required 数量写进收据。 |
| `dry_run` | 默认 false。不取密钥、不发请求，校验参数/尺寸/档位/来源并写计划收据，返回 `plan`/`inputs`/`cost`。远端参考图只列出不抓取。 |
| `label` | 可选。写进收据的标注（如镜头号/场次）。 |

返回值：

```json
{
  "files": ["/abs/path/....png"],
  "provider": "gpt",
  "size": "2048x1152",
  "model": "gpt-image-2.6-sunburst",
  "format": "png",
  "dry_run": false,
  "receipt_path": "/abs/path/generated-images/receipts/2026-11-16_18-30-00-a1b2c3.json",
  "receipt_id": "2026-11-16_18-30-00-a1b2c3",
  "inputs": [
    {
      "image": "/abs/cards/zhou_identity_root.png",
      "resolved": "/abs/cards/zhou_identity_root.png",
      "source_type": "file",
      "checked": true,
      "sha256": "…",
      "bytes": 20480,
      "format": "png",
      "width": 2048,
      "height": 2048,
      "role": "identity_root",
      "approved": true,
      "approval": "caller_declared",
      "approval_evidence": "user approved 2026-11-12",
      "sha256_expected": "…",
      "sha256_match": true,
      "source": "assets/character/zhou/APPROVED.json",
      "note": null,
      "asset_id": "zhou-root",
      "required": true
    }
  ],
  "outputs": [
    {
      "index": 1,
      "file": "/abs/path/....png",
      "sha256": "…",
      "bytes": 1843200,
      "format": "png",
      "width": 2048,
      "height": 1152,
      "size": "2048x1152",
      "billing_tier": "2K"
    }
  ],
  "cost": {
    "currency": "CNY",
    "cny": 0.18,
    "unit_cny": 0.18,
    "known": true,
    "estimated": true,
    "bill": false,
    "basis": "per delivered image tier 2K × n=1",
    "note": "estimate only, not a bill; the provider invoice is authoritative"
  },
  "plan": {
    "provider": "gpt",
    "model": "gpt-image-2.6-sunburst",
    "endpoint": "/images/edits",
    "planned_size": "2048x1152",
    "planned_area": null,
    "billing_tier": "2K",
    "aspect": "16:9",
    "n": 1,
    "format_requested": "png",
    "quality": "auto",
    "prompt_chars": 42,
    "prompt_sha256": "…",
    "reference_count": 1,
    "allow_4k": false
  },
  "warnings": [],
  "billing_tier": "2K",
  "cost_cny": 0.18,
  "revised_prompt": "…",
  "failed": ["image 2: output image failed content safety check"]
}
```

- `billing_tier`：GPT 按**实际交付图**最长边判档；MiniMax 档位模式返回 `1K/2K/4K`（表示面积档）。
- `cost_cny`：GPT 按张计费模型的估算总价（交付张数 × 档位单价）；MiniMax 与 Gemini 是 token 计费，
  不返回该字段。它是估算，不是账单。
- `quality` 只有 GPT 返回；`failed` 只在部分图片失败时出现，成功的文件仍会保存。

顶层 `size`/`format` 现在按**交付字节**给实际值（嗅探 PNG/JPEG/WebP 等并解析宽高）；`outputs[]` 里同时给每张图的 hash、字节数、实际宽高和档位。`cost` 恒为估价：`estimated:true`、`bill:false`；token 计费的 MiniMax/Gemini 返回 `known:false, cny:null`，不伪造数字。

### `image_models`

无参数，返回模型清单、能力、**GPT 档位表**、MiniMax 面积档价格和 token 单价，以及快照日期。
它是模型调用时可直接读取的英文版本；档位表放在最前面，先看档位再看模型。

## 来源收据与 `dry_run`

### 收据

每次调用自动写 `<out_dir>/receipts/<receipt_id>.json`，并在付费请求**之前**先写一份 `status:"requested"` 的版本（输入已经 hash 完），交付后更新为 `delivered`/`partial`，失败写 `failed` 并保留错误（已脱敏）。即使进程被杀、任务 id 丢失，也能从磁盘看到当时到底传了哪些图。

主要字段：

| 字段 | 内容 |
|---|---|
| `request` | `prompt`、`prompt_sha256`、`prompt_chars`、`provider`、`model`、`endpoint`、`n`、`format_requested`、`quality`、`aspect`、`size_requested`、`planned_size`/`planned_area`、`billing_tier`、`allow_4k`、`reference_count`、`dry_run`。 |
| `references_manifest` | 若传了 `references_file`：清单绝对路径、清单文件 sha256、条目数、`required` 条目数（钉住当时查阅的批准清单版本与本次契约）。 |
| `inputs[]` | `source_type`、`resolved`（本地绝对路径）或脱敏 URL、`sha256`、`bytes`、`format`、`width`/`height`、`local_copy`（远端参考图的本地副本）、`role`、`approved`、`approval`（`caller_declared`/`unapproved`）、`approval_evidence`、`sha256_expected`/`sha256_match`、`source`、`note`、`asset_id`、`required`、`root_ids`、`checked`。 |
| `outputs[]` | `file`、`sha256`、`bytes`、实际 `format`、`width`/`height`、`size`、`billing_tier`。 |
| `cost` | `currency`、`cny`、`unit_cny`、`known`、`estimated:true`、`bill:false`、`basis`、`note`。 |
| 其他 | `receipt_version`、`status`、`created_at`/`finished_at`、`label`、`plugin{name,version}`、`warnings`、`failures`、`error`、`approval_policy`、`guard{identity_edit_prompt, identity_preservation_prompt, approved_identity_references}`（记录本次硬门判定，便于复盘）。 |

安全口径：

- **不保存 API key / Authorization**；收据里也没有授权头。
- 远端 URL 一律去掉 userinfo、query 和 fragment（只留 scheme/host/path）；错误文本同样脱敏。
- 生成结果的签名下载 URL 不落盘，只保存下载后的本地文件与其 sha256。
- 远端参考图会在 `receipts/inputs/<receipt_id>/` 留一份本地副本，URL 过期后仍可追溯。
- `approved:true` 只是**调用方声明**；插件不做独立审批审计。唯一可核验的是：`references_file` 里的 `sha256` 与真实字节一致（`sha256_match:true`），不一致会直接拒绝请求。

并发与命名：

- 生图文件名 = `<秒级时间戳>-<prompt slug>-<8 位随机 hex>[-序号].<实际后缀>`；随机段取自本次收据 id，同一秒、同一 prompt 的并发/重试不会撞名。
- 所有交付图用独占创建写入（`wx` / 等价物）：目标已存在时报错而不是覆盖，任何既有交付的字节都不会被重写。
- 收据 id = 秒级时间戳 + 8 位随机 hex；首次写入用 link(2) 独占创建，撞上别的收据会失败而不是覆盖；之后只更新属于该 id 的收据。
- 远端参考图本地副本放在 `receipts/inputs/<receipt_id>/`，目录由唯一 id 拥有。

### `dry_run`

`dry_run:true` 时：不解析/不读取 API key，不发任何网络请求（远端参考图只列出、标 `checked:false`），但会读取本地参考图做 sha256/尺寸校验，写一份 `status:"planned"` 收据，并返回 `plan`、`inputs`、`cost`、`warnings`。适合在真正花钱前核对：档位、`allow_4k`、参考图清单、身份根、估价。

## 身份根与复用保护

用户踩过的两个坑写进了代码，而不是只写文档：

1. **身份根不能被相反形容词覆写。** 编辑类调用（带参考图）的 prompt 若含改脸/五官/长相/更像/更年轻等编辑语义，且处于明确“既有身份”语境（给了 `references_file`，或 prompt 提到已批准/原图/海报/身份/参考图等），而参考图里没有 `role:identity_root|character_card` 且 `approved:true` 的项，**请求前直接拒绝**（不产生费用）。若 `references_file` 里声明了已批准身份根却没传入，错误会点名这些根。正确做法是把已批准身份根直接放进 `images`，而不是继续堆形容词。
2. **低复用要当场可见。** 参考图清单、角色、批准声明、sha256、清单哈希都进收据；以下情况给 `warnings`：只有 `source_frame` 截帧而没有已批准人物/场景/关键帧卡；卡片类参考未标批准；清单里已批准但未传入的资产（最多列 5 个）；标了批准却没有 `source`/`approval_evidence`。`dry_run` 里先看这些警告再决定是否花钱。

**不会被拦的情况**（避免误伤）：

- 保留措辞：`不要改脸` / `保持五官不变` / `do not change the face` 等视为“保持身份”，不触发。
- 新人物概念设计：`新角色` / `概念设计` / `重新设计` 等语境没有批准身份根也能用，只给警告。
- 纯文生图（没有参考图）不拦，只提示“没有身份锚”。
- 没有“既有身份”语境的候选图迭代只警告，不拦。

关键词是启发式 tripwire，不做语义理解；误拦时按错误里的指引直传批准根。`references_file` 与生产层 registry 的契约见下。

### 与生产层（H3 插件）的接口

生图插件**不 import 兄弟插件**（各自是独立 bundle，隐式依赖会在单独安装时炸）。跨项目 registry 用 JSON 清单对接：

1. 生产层把 registry 导出成 references 清单（数组，或 `{assets:[...]}`；entry 形状同 `references_file`，可带 `id`、`kind`、`approval`、`approval_evidence`、`sha256`、`root_ids`）。
2. `image_generate` 用 `references_file` 读取，清单 path+sha256 进收据。也兼容直接读 `.ai-video/project.json`：`assets[]` 里的 `kind`（`character`/`scene`/`keyframe`/`image`）映射成 role，`approval` 支持字符串状态（`approved` / `user_approved` / `director_approved` / `locked`）或对象 `status`；相对路径按 `project_root`（缺省为清单所在目录）解析；`root_ids` 原样记进 `inputs[]`。
3. 生图返回 `inputs[]`/`outputs[]`（真实路径/脱敏 URL、sha256、实际尺寸、角色、批准声明、`root_ids`），生产层的 `validateProductionInputs` 直接拿这两个数组核对即可：把 `inputs[].resolved`（远端图用 `local_copy`）放进它的 `reference_images`/`first_frame` 等参数，它会重新按真实字节 hash 校验是否命中 registry。
4. 两边都只把 `approved` 当**调用方声明**；真正能互证的只有 `sha256`（清单声明 vs 实际字节）。远端参考图在生产层会被视为不可核验输入，应传本地副本路径。

### `required` 契约（解决“有卡却不复用”）

`references_file` 里 `required:true` 是**可执行契约**，不是提示：

- 实际 `images` 没带这个条目 → `collectReferences` 阶段直接报错，**发生在取凭据和任何网络请求之前**；错误里列出缺失路径、role 和 asset id。
- 带了但 `sha256` 与真实字节不一致 → 输入加载阶段直接报错（错误会标明 required）；不会把图发出去。
- 标记了 required 但没给 `sha256`：存在性仍强制，但内容漂移无法检测，会给 warning（建议 root CLI 始终带 sha256）。
- 未标 required 的 approved 资产：不要求全部传入；清单有条目、本次没传也不会报错。仅在清单**没有任何 required 条目**时给一条信息性 warning（列出最多 5 个可用资产），避免为了消警告把不同人物/视角的卡混在一起。
- `required:true` 不改变 `approved` 的语义：`approved` 仍是 caller-declared；`sha256`/`approval_evidence` 只证明“声明与内容一致 / 有审批记录可追溯”，不冒充用户审批认证。

root CLI 的导出约定（生图侧只读 JSON，不需要 import 任何代码）：

- 本次 keyframe 派生：把**本次操作必须复用的已批准人物根/场景根**导出成 `required:true`（关键帧派生至少带人物/场景根）。
- 视频生成：优先把已批准关键帧标 required，并沿 `root_ids` 继承其人物/场景根；不要重复把所有卡片都塞进本次 list。
- 若单个资产同时承载双角色：由 root 选择唯一合适的源再标 required，不要为了覆盖角色把整个库都标 required。


## 网络边界

- 远端参考图：单文件 64 MiB 上限。先看 `Content-Length`，超限不读正文；没有长度时按流式累计，超过上限立即中止，不会先整份读入内存再判断。
- 生成结果下载：128 MiB 上限，同样有界。

## 能力对比

| 能力 | GPT（TeamoRouter） | MiniMax H3-Image |
|---|---|---|
| 文生图 | ✅ `/images/generations` | ✅ `/images/generations` |
| 单图编辑 | ✅ `/images/edits` | ✅ `/images/edits` |
| 多参考图合成 | ✅ 1–16 张 | ✅ 1–16 张（按 Picture 1..N 顺序理解） |
| 单次张数 `n` | 1–4 | 1–10 |
| 画质档 | `auto/low/medium/high` | 无；标准版/极速版是两档模型 |
| 4K 实际输出 | 最长边 ≤3840，≤8,294,400 px；1:1 为 2880²，16:9 为 3840×2160 | 4K 面积档 4096²（16.8MP）；16:9 为 5472×3072 |
| 自定义尺寸 | 两边 16 的倍数，最长 ≤3840，0.66–8.29MP；>2048 需 `allow_4k` | 0.66–20MP，比例 1:3–3:1，无 16 倍数要求 |
| 输出格式 | 请求 png/jpeg/webp；2.6 实测忽略 jpeg 返回 PNG | png/jpeg/webp 按请求返回（原生默认 jpeg） |
| Prompt 增强 | 无此参数 | 默认开启；增强文本 token 计入费用 |
| 计费方式 | 按张；档位看实际最长边 | 按 token：文本输入 + 参考图输入 + 图片输出 |

## 价格

> 快照日期 **2026-11-15**。GPT 单价按**用户告知的账户实扣**口径（1K/2K ¥0.18、4K ¥0.60）；
> TeamoRouter 模型页/价格接口仍标 `$0.02/张` 全档，与实扣不一致——以账单为准，插件按实扣给估算。
> MiniMax 为中国区文档价。两家都可能随时调价/结束促销；大批量前请重新核对文末来源。

### GPT（人民币/张）

| 模型 | 1K | 2K | 4K |
|---|---:|---:|---:|
| `gpt-image-2.6-sunburst`（默认）/ `-flare` | 0.18 | 0.18 | 0.60 |
| `gpt-image-2.5-sunburst` / `-flare` / `gpt-image-2` | 0.18 | 0.18 | 0.60 |
| 五个 `*-4k-upscale` 变体 | — | — | 0.60（只出 4K） |
| `gemini-3-pro-image` | token：输入 $1/M，输出 $60/M | | |
| `gemini-3.1-flash-image` | token：输入 $0.25/M，输出 $30/M | | |

GPT 图片按**实际交付图的最长边**判档：≤1024 为 1K，≤2048 为 2K，>2048 为 4K；
判定依据不是请求参数。所有按张 GPT 模型共用同一张档位价表，模型差异主要体现在画质/速度；
旧代模型（2.5/2）的公开档位价可能有两三分钱差异，以账单为准。

两个容易忽略的档位差：

- **`2560x1440` 按 4K 计费**（最长边 2560）。这是最常见的「我以为要 2K」翻车点。
- `1k` + `16:9`/`9:16` 在 GPT 的 655,360 像素下限下无法保持 1024 以内，插件会输出
  `1088x608` / `608x1088`，实际最长边超过 1024，**按 2K 计费**；因为 1K/2K 同价，没有多花钱。
- `quality` 不改变尺寸档位，但官方按 quality 另有分档价；本表按账户当前常见档位实扣，未单列 quality 差价。

### MiniMax（人民币/张，标准版）

| 场景 | 1K | 2K | 4K 原价 | 4K 限时 5 折 |
|---|---:|---:|---:|---:|
| 文生图 | 0.1430 | 0.1531 | 0.4522 | **0.2261** |
| 图生图，1 张参考图 | 0.1744 | 0.1747 | 0.4809 | **0.2404** |
| 图生图，3 张参考图 | 0.2346 | 0.2746 | 0.5211 | **0.2605** |

### MiniMax（人民币/张，极速版）

| 场景 | 1K | 2K | 4K 原价 | 4K 限时 5 折 |
|---|---:|---:|---:|---:|
| 文生图 | 0.2319 | 0.2380 | 0.8550 | **0.4275** |
| 图生图，1 张参考图 | 0.2978 | 0.3011 | 0.8998 | **0.4499** |
| 图生图，3 张参考图 | 0.3982 | 0.4003 | 1.0146 | **0.5073** |

MiniMax token 单价：

| 模型 | 文本输入 | 图片输入 | 图片输出 |
|---|---:|---:|---:|
| `MiniMax-H3-Image` 标准版 | ¥15/M | ¥10/M | ¥25/M |
| `MiniMax-H3-Image-Highspeed` 极速版 | ¥15/M | ¥20/M | ¥50/M |

- 4K 限时 5 折：最终交付图宽×高 **≥ 16.6MP** 时整次请求 5 折；截至 **2026-11-18 00:00（北京时间）**。
- 上表是官方单张参考值；实际费用随 prompt 增强文本、参考图数量和图片 token 浮动，不是固定单价。
- 图生图始终开启 prompt 增强；参考图越多、越大，图片输入 token 越多，费用越高。
- 参考图数量对价格的影响不同：GPT（TeamoRouter）按交付张数计费，参考图多少不改变每张价；
  MiniMax 按 token，1K 参考图约 +¥0.03/张（标准）、+¥0.06/张（极速），实际随参考图分辨率浮动。
- 极速版约 1.5–2 倍标准版价格，官方定位是更快（标准版/极速版参数与限制相同）。
- 官方还把 `image-01` / `image-01-live` 列为历史模型（¥0.025/张，旧接口 `/v1/image_generation`）；
  本插件只接 H3-Image，因为 4K、1–16 张参考图和统一的 Images API 都在 H3 上。

### 怎么选

- **默认**：GPT `2k`。¥0.18，和 1K 同价；不要选 1K。
- **要真正 16.8MP 的 4K**：MiniMax 标准版 `4k`，促销期 ¥0.2261/张，比 GPT 4K 的 ¥0.60 便宜。
- **要画质档位/反复微调**：GPT 2.6 `2k` + `quality`（插件对编辑固定开 `input_fidelity: high`）。
- **要快**：GPT 2.6 Flare 或 MiniMax 极速版。
- **不要**：GPT `4k`（除非确实需要 8.29MP 以内的 4K）、任何 `*-4k-upscale` 变体（只出 4K）、
  `2560x1440` 当 2K 用。

## 尺寸与档位

### GPT

- `size: "1k"`：最长边 1024；`1:1` 1024²，`4:3` 1024×768，`3:2` 1024×688；
  `16:9`/`9:16` 因像素下限输出 1088×608 / 608×1088，按 2K 计费（同价）。
- `size: "2k"`（默认）：最长边 2048；`16:9` 2048×1152，`1:1` 2048²。
- `size: "4k"`：最长边 3840；`16:9` 3840×2160（8.29MP 上限正好用满），
  `1:1` 受 8.29MP 限制为 2880²，`4:3` 为 3312×2480。
- 显式 `WIDTHxHEIGHT`：两边 16 的倍数，最长边 ≤3840，总像素 655,360–8,294,400；越界直接报错，
  不自动缩放。**最长边 >2048 的显式尺寸会被拒绝**，除非传 `allow_4k: true`（按 4K 收费）；
  要 2K 请改传 `size: "2k"` + `aspect`。
- 输出格式：TeamoRouter 的 GPT 2.6 实测忽略 `output_format`（请求 jpeg 仍返回 PNG）；插件按字节嗅探并保存为 `.png`，
  返回值 `format` 为 `png`。要稳定拿到 jpeg/webp，用 MiniMax。

### MiniMax

- `size: "1k"/"2k"/"4k"` 映射成 API 的 `area: 1K/2K/4K` + `aspect_ratio`，由服务端算宽高：
  1K 16:9 → 1360×768（实测），2K 16:9 → 2720×1536，4K 16:9 → 5472×3072，4K 1:1 → 4096×4096。
- API 原生默认 `area=4K`；插件默认 `size: "1k"`，避免调用者没写尺寸时被按 4K 计费。要 4K 请显式传 `size: "4k"`。
- 显式 `WIDTHxHEIGHT`：总像素 655,360–20,000,000，宽高比 1:3–3:1；不要求 16 的倍数，也不会自动取整。
- 输出格式原生默认 `jpeg`；插件默认 `png`。同尺寸下 png 文件明显更大，但不影响 token 计费。
- 参考图：1–16 张，单文件 ≤64MiB，整个请求 ≤64MiB，宽高 128–8192，长宽比 ≤4:1；支持 JPG/PNG/WEBP/HEIC/HEIF。
- `aspect` 目前开放 7 种常用比例；MiniMax 上游本身支持 1:3–3:1 的任意整数比（如 21:9），插件暂未加入枚举。
- 不支持：mask/局部编辑、透明背景、预览图。

### 4K 口径不同

GPT 的 4K 是「最长边 3840」，受 8.29MP 上限，约 ¥0.60/张；MiniMax 的 4K 是「面积档 4096²」，
约 16.8MP，促销价 ¥0.2261/张。同样是 `size: "4k"`，MiniMax 出的像素约为 GPT 的两倍、价格约为三分之一。
要 4K 优先 MiniMax；GPT 4K 只在需要 GPT 的画质/指令遵循且 8.29MP 够用时才用。

## 配置

插件默认值（`apply` 内）：

```js
{
  defaultProvider: 'gpt',
  baseURL: 'https://api.teamorouter.com/v1',
  keyRef: 'TEAMOROUTER_API_KEY',
  defaultModel: 'gpt-image-2.6-sunburst',
  minimaxBaseURL: 'https://api.minimax.cn/v1',
  minimaxKeyRef: 'MINIMAX_API_KEY',
  minimaxDefaultModel: 'MiniMax-H3-Image',
}
```

profile 的挂载行只需要覆盖要改的项，例如：

```yaml
- insert:
    - id: image-gen
      name: dsh-image-gen
      config:
        defaultProvider: gpt
        baseURL: https://api.teamorouter.com/v1
        minimaxBaseURL: https://api.minimax.cn/v1
```

密钥解析顺序（**只解析本次选中的后端**）：

1. 凭据存储里的 `TEAMOROUTER_API_KEY` / `MINIMAX_API_KEY`；
2. 默认 dotenv：`$DSH_HOME/secrets/teamorouter.env` / `$DSH_HOME/secrets/minimax.env`；
   宿主进程没有 `DSH_HOME` 时回退到 `~/.dsh/secrets/`（用 `HOME`/`homedir()` 拼 `.dsh`）；
3. 都没有则报错，并在错误里给出缺失的变量名和文件路径。

> Desktop 宿主进程通常只继承 `HOME`，不会继承 shell 里的 `DSH_HOME`。如果 key 明明放在
> `~/.dsh/secrets/minimax.env` 却报 `MINIMAX_API_KEY is not available`，先检查错误里打印的路径是不是
> 相对路径 `secrets/minimax.env`；插件现在按 `DSH_HOME` → `~/.dsh` 回退，不会再依赖 shell 环境。

本机 `MINIMAX_API_KEY` 在 `~/.dsh/secrets/minimax.env`（中国区），`TEAMOROUTER_API_KEY`
在凭据库或 `~/.dsh/secrets/teamorouter.env`。MiniMax 全球区账号把 `minimaxBaseURL`
改成 `https://api.minimax.io`（本机密钥未验证该区）。

## 安装

由 `plugin_manager` 的 `install_bundle` 托管安装，target 用本目录的绝对路径
（本机是 `~/DSH_ZONE/Projects/DSH-Plugins/plugins/dsh-image-gen`，把 `~` 展开后再传）。

当前 profile `web` 已用 `link:` 指向本仓；改宿主半边（`index.js` / `lib/`）后需重启
dsh-web 才会装载新工具定义（`systemctl --user restart dsh-web`）。

## 自检

```sh
node --check index.js
node --check lib/catalog.js
node scripts/verify.mjs
```

仓根再跑一次：

```sh
npm run verify
```

自检全程离线 mock：不发真实请求、不读真实凭据。覆盖工具注册与输出 schema、档位/尺寸规划、
`2560x1440` 4K 拒绝、4K-only 变体、字节嗅探与真实宽高解析、URL/错误脱敏、
生成收据在请求前落盘、dry_run 不取密钥/不联网、远端参考图有界读取与本地副本、独占写入不会覆盖既有文件/收据、同一 prompt 同一秒两次调用产出不同文件且首个交付字节不变、required 引用缺失/hash 漂移在取凭据与联网前阻断、未标 required 的 approved 资产不强制传入、
清单 sha256 校验与哈希固化、身份根硬门（拒绝/保留措辞/新角色概念/已声明根放行）、
复用警告、失败收据，以及 `n` 张的估价求和。2026-11-14 曾用真实密钥跑过 MiniMax/GPT 多档位生图与编辑；
此后改档位/价格/收据逻辑均**没有重跑真实生图**（避免产生费用）。

## 价格来源与维护

- **GPT 实扣价**：2026-11-15 用户告知的账户账单口径，1K/2K ¥0.18、4K ¥0.60。TeamoRouter 模型页与
  `GET https://api.teamorouter.com/v1/models/pricing` 仍标 GPT Image 2.6 全档 `$0.02`
  （1 折、官方 $0.20），与实扣不符；改价时**以账单为准**，同时保留这条差异说明。
- MiniMax 定价：<https://platform.minimax.cn/docs/pricing/overview>
  （H3-Image 标准/极速、1K/2K/4K 单张参考、4K 限时 5 折）。
- MiniMax 图片 API：<https://platform.minimax.cn/docs/guides/image-generation>
  （尺寸、参考图 1–16、n 1–10、jpeg/png/webp、prompt 增强）。
- 改价时同步更新 `lib/catalog.js` 的 `PRICE_AS_OF`、`GPT_TIER_PRICES_CNY`、`MODELS` 和本 README；
  跑完自检再重启。不要把临时促销写成永久价：MiniMax 表里同时保留 list 与 promo 两列。
