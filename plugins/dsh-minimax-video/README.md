# dsh-minimax-video

MiniMax H3（Hailuo 3 / Hailuo-03 / 海螺 H3）视频工具。一个插件覆盖四档模型、480P/768P/2K、
文生视频、首尾帧、图/视频/音频参考、官方 768P→2K 再生成通道，以及一个可直接加载的
`minimax-video` skill（提示词结构、运镜、类型配方、API 限制）。

> H3 一次调用只产出一段 **4–15 秒、带原生声音** 的片段，不是时间线编辑器。更长的片子要分镜生成，
> 用上一段尾帧做下一段首帧，再在外部拼接。

## 为什么

- **参数自解释**：`video_generate` 的每个参数都写清楚「传什么、产生什么效果、和谁互斥」，
  调用方不需要先读一遍官方文档。
- **档位/清晰度矩阵内建**：`video_models` 直接给出四档模型 × 分辨率 × 时长 × 价格 × 输入限制，
  选型前先看它，避免提交 `H3 + 480P`、`Lite + 2K`、`Max + 4s` 这类必然失败的组合。
- **768P→2K 是官方再生成，不是超分**：插件把「必须原样重发原始 prompt/素材」「source_task_id 需要白名单」
  「源片必须 24fps、有音轨、尺寸整除 32」写进参数说明和校验。
- **声音是提示词的一部分**：H3 原生出声，skill 把对白、旁白、环境声、配乐拆成三个字段，
  并给出语速/时长换算，避免「话没说完就切」。
- **视频落盘为文件**：返回值只有路径和任务信息，不把几 MB 的 base64 塞进上下文。

## 工具

| 工具 | 作用 | 是否联网/计费 |
|---|---|---|
| `video_models` | 档位、分辨率、时长、价格、输入限制、再生成规则 | 否 |
| `video_generate` | 创建生成任务；默认等待并下载 MP4 | 是 |
| `video_task` | 查询/等待/下载/取消/删除任务 | 查询免费；取消排队任务不计费 |
| `video_regenerate` | 官方 768P→2K 再生成 | 是 |
| `video_prompt_enhance` | 官方 H3-Context-IR 提示词增强，只返回 prompt | 是（按 token） |

### `video_generate`

| 参数 | 效果 |
|---|---|
| `prompt` | 必填，≤7000 字符。H3 的完整提示词；推荐三字段结构（见 skill）。写清主体、动作、镜头、光线和声音。 |
| `model` | 档位。`MiniMax-H3`（默认，画质优先，768P/2K，4–15s）、`MiniMax-H3-Highspeed`（均衡，480P/768P，4–15s）、`MiniMax-H3-Lite`（最便宜，480P/768P，4–15s）、`MiniMax-H3-Max`（多素材参考+提示词扩写，480P/768P，5–15s）。 |
| `resolution` | `480P` / `768P` / `2K`。默认 768P。2K 只有 H3 支持；480P 只有 Highspeed/Lite/Max 支持；分辨率越高每秒越贵。 |
| `duration` | 整数秒。H3/Highspeed/Lite 为 4–15；Max 为 5–15。默认 5。对白按约 3.3 词/秒、语音占片段约 57% 估算。 |
| `ratio` | `adaptive` / `21:9` / `16:9` / `4:3` / `1:1` / `3:4` / `9:16`。文生视频必须给具体比例（默认 16:9，不能 adaptive）；图生视频由首帧决定，恒为 adaptive；参考生视频默认 adaptive，Lite 必须给具体比例。 |
| `first_frame` | 首帧图（本地路径或 URL）。传入即进入图生视频；画幅跟随该图。 |
| `last_frame` | 尾帧图。必须同时给 `first_frame`；用来锁定结束画面。描述从首帧到尾帧的可见路径，而不是复述两张图。 |
| `reference_images` | ≤9 张参考图。参考人物、服装、道具、场景或风格；在 prompt 里用 `<Picture 1>`… 指定用途。与首/尾帧互斥。 |
| `reference_videos` | ≤3 段参考视频，每段 2–15s、总计 ≤15s、单文件 ≤50MB。参考运动、运镜或剪辑节奏；用 `<Video 1>`… 指定。与首/尾帧互斥。 |
| `reference_audio` | ≤3 段参考音频，每段 2–15s、总计 ≤15s、单文件 ≤15MB。参考音色、音乐、节奏或音效质感；用 `<Audio 1>`… 指定。与 `first_frame`/`last_frame` 互斥；要同时保画面和音色，见「多段连续与角色音色」。 |
| `prompt_expansion` | 仅 `MiniMax-H3-Max`：`disabled` / `balanced`（API 默认）/ `quality`。其他档位传了会报错。 |
| `wait` | 默认 true：等到完成并下载。false 则立即返回 `task_id`。 |
| `wait_seconds` | wait=true 时的最长等待，默认 900s，上限由插件 `maxWaitSeconds` 决定。超时不报错，返回运行中的 `task_id`。 |
| `download` | 默认 true。结果 URL 有时效，建议保持开启。 |
| `out_dir` | MP4 保存目录，相对会话工作目录，默认 `generated-videos`。 |

示例：

```json
{
  "prompt": "integrated_multimodal_description: [Shot 1] ...\n\noverall_soundscape: ...\n\nnon_diegetic_music: ...",
  "model": "MiniMax-H3",
  "resolution": "2K",
  "duration": 8,
  "ratio": "16:9"
}
```

图生视频（首尾帧）：

```json
{
  "prompt": "How the reference pictures align ... \n\nintegrated_multimodal_description: ...",
  "first_frame": "shots/open.png",
  "last_frame": "shots/end.png",
  "duration": 8
}
```

### `video_task`

| 参数 | 效果 |
|---|---|
| `task_id` | 必填。生成、再生成或 Context-IR 返回的任务 id。 |
| `action` | `status`（默认）查询/等待；`cancel` 取消排队任务或删除已成功/失败的任务记录。running 状态不能取消。 |
| `wait` | 默认 false；true 时阻塞到终态。 |
| `wait_seconds` | 等待上限，默认 900s。 |
| `download` | 成功时下载 MP4，默认 true。 |
| `out_dir` | 下载目录，默认 `generated-videos`。 |

### `video_regenerate`

两种二选一模式：

1. `source_task_id`：传一个已成功的 `/v2/video_generation` 任务 id。**需要白名单权限**，任务须属于当前账号、
   状态 succeeded、且在 7 天查询窗口内；此模式不要再传 prompt/素材。
2. `video` + `prompt` + 原始素材：传 768P 源片（本地路径或 URL，作为 `base_video`），并**原样重发**
   生成该 768P 视频时实际使用的最终 prompt 和全部参考素材。

源片必须符合 H3 768P 输出规格：有音轨、24fps、宽高都能被 32 整除、面积在 768×768 与 768×1344 之间、
帧数 107–362 且步长 17（约 4–15s）。这是官方再生成接口，不是任意视频超分。

`wait` / `wait_seconds` / `download` / `out_dir` 与生成工具相同。

### `video_prompt_enhance`

参数与生成相同，但没有 `model`/`resolution`：固定走 `MiniMax-H3` + Context-IR，返回 `content.prompt`。
适合把一句模糊描述、或一组需要分配角色的参考素材，整理成可复用的结构化 prompt。它只产 prompt，不产视频。

## 模式与互斥

```
无媒体                  → 文生视频
first_frame/last_frame  → 图生视频
reference_*             → 参考生视频
```

- 首/尾帧与 `reference_*` **不能混用**，插件会在发请求前报错。
- `last_frame` 必须和 `first_frame` 成对。
- 参考素材总数上限 12 个文件（图 ≤9、视频 ≤3、音频 ≤3）。
- 整个请求体 ≤64MB；本地文件会内联为 data URI，超过单文件限制会提示改用公网 URL。

### 多段连续与角色音色

H3 一次只出 4–15 秒，长片要分镜。两种连续性会打架：

- **画面无缝**：上一段尾帧 → 下一段 `first_frame`。
- **音色一致**：`reference_audio` + `<Audio 1>`。但 `reference_audio` 属于 reference 角色，**不能和 `first_frame` 同时出现**。

所以三选一：

1. **参考模式**：`<Picture 1>` 角色图 + `<Audio 1>` 音色样本，每段都带。脸和声音稳，接缝处接受小幅跳变。
2. **帧链模式**：尾帧接首帧，画面无缝；H3 每段会重新生成声音， recurring 角色需要后期统一配音。
3. **单段对话**：对白能塞进 15 秒就一段拍完，通常是性价比最高的做法。

完整决策表、音色样本要求和提示词模板见 [continuity-and-voice.md](skill/references/continuity-and-voice.md)。

## 768P→2K 通道：什么时候值得用

官方定价（2026-11-15 快照）：

| 方案 | 5 秒成本（CNY，列表价） |
|---|---|
| 直接生成 2K | 5 × ¥0.80 = **¥4.00** |
| 生成 768P + 再生成 2K | 5 × ¥0.50 + 5 × (¥0.30 输出 + ¥0.30 输入视频) = **¥5.50** |

所以再生成不是省钱手段，而是**质量/流程手段**：先在 768P 上低成本迭代，选定后再 2K；
或者手里已有合格的 H3 768P 成片，需要 2K 交付。直接 2K 更便宜，但每次重抽都按 2K 计费。

## skill：`minimax-video`

插件注册了一个 bundled skill，调用方可按需加载：

- `skill/SKILL.md`：路由、硬约束、档位选择、三字段提示词、声音、参考素材、2K 流程、提交前检查。
- `skill/references/prompt-guide.md`：三字段写法、镜头时间线、对白/旁白标签、参考标签、对齐句、保留标记、
  语速换算、正面措辞。
- `skill/references/camera.md`：推/拉/摇/移/升降/环绕/跟随/固定/主观/旋转，幅度与速度，镜头时长，常见错误。
- `skill/references/video-types.md`：故事型、演绎型、叙述型、产品、品牌、动作、蒙太奇、动画、UI/游戏，
  九种配方各自的镜头计划、骨架、声音和坑。
- `skill/references/examples.md`：文生、首尾帧、表演、旁白、参考产品片、2K 工具调用示例。
- `skill/references/api-notes.md`：端点、字段、限制、错误码、计费快照。

skill 里的「故事型/演绎型/叙述型」是提示词配方，不是 API 参数；插件不会把它们伪装成接口字段。

## 配置与凭据

`cordis.patch.yml` 默认：

```yaml
- insert:
    - id: minimax-video
      name: dsh-minimax-video
      config:
        baseURL: https://api.minimax.cn
```

| 配置 | 默认 | 说明 |
|---|---|---|
| `baseURL` | `https://api.minimax.cn` | 决定区域与计价：`.cn` 用 ¥，`.io` 用 $。 |
| `keyRef` | `MINIMAX_API_KEY` | 凭据存储里的键名。 |
| `keyFile` | `$DSH_HOME/secrets/minimax.env` | 凭据存储取不到时的 dotenv 回退。 |
| `defaultModel` | `MiniMax-H3` | 未传 `model` 时使用。 |
| `maxWaitSeconds` | `900` | 工具等待上限。 |
| `pollIntervalMs` | `10000` | 轮询间隔。 |

密钥解析顺序：`ctx.credentials.resolve(keyRef)` → `$DSH_HOME/secrets/minimax.env` 里的同名键。
本机已有 `MINIMAX_REGION=cn` 与 `MINIMAX_API_KEY`，默认配置可直接用。

## 安装

```sh
# 托管安装（推荐）：把插件目录绝对路径作为 target
# plugin_manager action=install_bundle target=/.../plugins/dsh-minimax-video
```

或在 Plugins 页面「添加插件」选择本目录。Host 半边改动需要重启 dsh；skill 与工具在启动时装入。

## 验证

```sh
node --check plugins/dsh-minimax-video/index.js
node plugins/dsh-minimax-video/scripts/verify.mjs
npm run verify
```

自测覆盖：5 个工具注册、参数 schema、档位/分辨率/时长矩阵、比例规则、首尾帧与参考互斥、
请求体形状（含 `base_video`）、成本估算、媒体内联、skill provider 与 6 份 skill 文档章节。
**不发网络请求、不产生费用。**

真实付费冒烟测试（2026-11-15）：`MiniMax-H3-Lite` / 480P / 4s / 16:9，任务 `463362638545526`，
产出 864×480、24fps、H.264 + AAC、4.46s，约 ¥0.64；下载落盘已验证。

## 已知限制

- 一次只生成一段 4–15s；没有续写/拼接接口。长片请分镜生成后外部拼接。
- `first_frame` 与 `reference_audio` 不能同时传；角色音色一致性和逐帧视觉连续性不能在同一次调用里同时拿到，需在参考模式、帧链+后期配音、单段对话之间取舍。
- 本地视频/音频只做扩展名与体积校验；时长、编码、帧率、音轨由 API 判定。
- 再生成的源片规格（24fps、音轨、帧数）无法在本地可靠探测，需调用方保证。
- `source_task_id` 再生成依赖白名单；没有权限时用 `video` 模式。
- 价格是 2026-11-15 的列表价快照；官方调价后需更新 `lib/catalog.js` 与 skill 的 `api-notes.md`。
- 未暴露 `callback_url`、`response_format`、`aigc_watermark`：本地会话用不上，且区域 schema 有差异。

## 文件

```
index.js                 工具与 skill 注册
lib/catalog.js           档位/价格/校验/成本估算
lib/request.js           生成/再生成/Context-IR 请求体
lib/media.js             本地文件 → data URI、64MB 上限
lib/api.js               HTTP 客户端、轮询、下载
skill/                   minimax-video skill 与 5 份参考文档
scripts/verify.mjs       离线自测
docs/DETAIL.md           Plugin Manager 详情页
```
