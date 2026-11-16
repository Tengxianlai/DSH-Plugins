# dsh-minimax-video

MiniMax H3（Hailuo 3 / Hailuo-03 / 海螺 H3）视频工具。一个插件覆盖四档模型、480P/768P/2K、
文生视频、首尾帧、图/视频/音频参考、官方 768P→2K 再生成通道、跨调用预算与一个可直接加载的
`minimax-video` skill（提示词结构、运镜、类型配方、生产流程、API 限制）。

> H3 一次调用只产出一段 **4–15 秒、带原生声音** 的片段，不是时间线编辑器。更长的片子要分镜生成，
> 用上一段尾帧做下一段首帧，再在外部拼接。

**付费保护默认开启，没有“安全模式关闭”开关。** 每次提交都会先做离线预检与算价，再写持久
intent，然后才联网；拿到 `task_id` 立即原子落盘后才开始轮询；同请求重复/结果未知不会静默重提；
`max_cost` 与命名预算在凭据解析和任何网络请求之前校验。所有网络调用在自测里都是 mock，不产生费用。

## 为什么

- **参数自解释**：`video_generate` 的每个参数都写清楚「传什么、产生什么效果、和谁互斥」。
- **提交前算价，不是提交后**：估价在 `client.create` 之前完成，并显式标注
  `complete` / `partial` / `unknown`；未知成本不冒充完整估算。
- **硬上限先于付费调用**：`max_cost` 是单次硬上限，`budget_id`（或项目 manifest 的
  `budget:{id,limit,currency}`）是跨调用累计上限；都先于网络校验。
- **提交前持久化容灾**：intent（指纹、脱敏请求、素材 registry、原 prompt、估价）在网络前落盘；
  `task_id` 拿到后立即原子写单，再轮询；轮询/下载失败可用同一单恢复。
- **未知提交结果阻止静默重复**：网络中断、超时、5xx、非 JSON 等可能已被接受的提交会记为
  `unknown`，同指纹再次提交会被拒绝，直到人工检查后用 `allow_duplicate_risk` + `override_reason`
  + `prior_record_id` 显式接受重复计费风险。
- **一次确认计划**：`video_prepare` / `dry_run:true` 只做离线预检并返回 `plan_id`；
  执行时重传相同参数，原子 claim 一次，参数/素材/预算漂移即拒绝。
- **再生成原输入可核验**：记录原 prompt、素材 hash、本地快照和下载文件 hash；
  `video_regenerate` 的 `original_task_id` 会核对 prompt/素材/源片是否漂移。
- **指定台词、参考角色与来源不是只写文档**：`dialogue` 必须逐字进 prompt；`reference_roles`、
  `source_declarations`、`approved_sources` 返回明确诊断；有项目登记时接入
  `production/project.js` 的审批/血缘/关键帧/QC 校验。
- **视频落盘为文件**：返回值只有路径和任务信息，不把几 MB 的 base64 塞进上下文。

## 工具

| 工具 | 作用 | 是否联网/计费 |
|---|---|---|
| `video_models` | 档位、分辨率、时长、价格、输入限制、再生成规则 | 否 |
| `video_prepare` | 离线预检 + 算价 + 一次性 `plan_id`；不读凭据 | 否 |
| `video_generate` | 创建生成任务；默认等待并下载 MP4 | 是 |
| `video_task` | 查询/等待/下载/取消/删除；自动找回本地记录 | 查询免费；取消排队任务不计费 |
| `video_regenerate` | 官方 768P→2K 再生成 | 是 |
| `video_prompt_enhance` | 官方 H3-Context-IR 提示词增强，只返回 prompt | 是（按 token，无法预提交封顶） |
| `video_budget` | 跨调用预算：status / create / amend / release（审计） | 否 |

### `video_prepare`

参数是生成/再生成/Context-IR 的参数并集，加 `kind:"generate"|"regenerate"|"prompt_enhance"`
（默认 generate）与预算/契约字段。返回 `plan_id`、估价、`cost_status`、`budget`、诊断、
`requested_duration` / `source_actual_duration` / `estimated_speech_seconds`（后者是 heuristic）。
**不解析 API 凭据、不发网络、不写任务单**，只写短期 plan（默认 30 分钟）。

### `video_generate`

| 参数 | 效果 |
|---|---|
| `prompt` | 必填，≤7000 字符。H3 的完整提示词；推荐三字段结构（见 skill）。 |
| `model` | 档位。`MiniMax-H3`（默认，画质优先，768P/2K，4–15s）、`MiniMax-H3-Highspeed`（均衡，480P/768P，4–15s）、`MiniMax-H3-Lite`（最便宜，480P/768P，4–15s）、`MiniMax-H3-Max`（多素材参考+提示词扩写，480P/768P，5–15s）。 |
| `resolution` | `480P` / `768P` / `2K`。默认 768P。**直接生成 2K 只有标准 H3 支持**；480P 只有 Highspeed/Lite/Max 支持。 |
| `duration` | 整数秒。H3/Highspeed/Lite 为 4–15；Max 为 5–15。默认 5。对白按启发式语速估算，不宣称精确。 |
| `ratio` | `adaptive` / `21:9` / `16:9` / `4:3` / `1:1` / `3:4` / `9:16`。文生视频必须给具体比例（默认 16:9，不能 adaptive）；图生视频由首帧决定，恒为 adaptive；参考生视频默认 adaptive，Lite 必须给具体比例。 |
| `first_frame` | 首帧图（本地路径或 URL）。传空串/全空白等同未提供；非空但不可读会点名 `first_frame`。 |
| `last_frame` | 尾帧图。必须同时给 `first_frame`；用来锁定结束画面。 |
| `reference_images` | ≤9 张参考图。参考人物、服装、道具、场景或风格；在 prompt 里用 `<Picture 1>`… 指定用途。与首/尾帧互斥。 |
| `reference_videos` | ≤3 段参考视频，每段 2–15s、总计 ≤15s、单文件 ≤50MB。用 `<Video 1>`… 指定。 |
| `reference_audio` | ≤3 段参考音频，每段 2–15s、总计 ≤15s、单文件 ≤15MB。用 `<Audio 1>`… 指定；与首/尾帧互斥。 |
| `prompt_expansion` | `MiniMax-H3-Max` 支持 `disabled` / `balanced`（API 默认）/ `quality`。非 Max 档位的 `disabled` 是 no-op：接受但剥离，不送 API；非 Max 的 `balanced`/`quality` 明确拒绝。 |
| `dialogue` | `[{speaker, line}]`。`line` 必须逐字出现在 prompt，否则提交前报 `dialogue_missing`；语速/容纳估算只做启发式，只有“不可能装下”才是硬错误，紧凑只警告，**不机械裁已验收的短源尾字**。 |
| `reference_roles` | 与参考素材顺序对齐（图→视频→音频）的角色/身份名；未提供时明确标记为 **declared only / unverified**，不写成 verified。 |
| `source_declarations` | 与全部媒体提交顺序对齐（first_frame, last_frame, ref_images…, ref_videos…, ref_audio…, base_video）的来源标签。 |
| `approved_sources` | 来源标签白名单；设置后每个 `source_declarations` 值必须命中，否则拒绝。若插件配置已有 `approvedSources`，配置是上限：调用只能收窄不能替换/扩大，越界报 `approved_sources_scope`；声明照记，但不会因此变成已验证。 |
| `shot_id` | 项目登记里的镜头 id；有 shots 的登记项目必填。 |
| `project_manifest` | 显式覆盖 `cwd/.ai-video/project.json` 自动发现。 |
| `keyframe_override_reason` | 未用同镜批准关键帧、或使用视频截图时的具体理由（≥12 字）；由项目登记校验强制。 |
| `max_cost` | 单次硬上限，按区域币种（.cn=CNY/.io=USD）。complete 比估算额；partial 比最坏情形上界；unknown 拒绝。与预算一起存在时两者都校验。 |
| `budget_id` | 命名累计预算；项目 manifest 声明预算时自动绑定，调用不能换预算或抬上限。 |
| `dry_run` | 只预检并返回 `plan_id` 与估价，不提交；同样不读凭据。 |
| `plan_id` | 执行已确认 plan；必须重传相同参数，单次 claim，参数/素材/cap/budget 漂移即拒绝。运行控制 `wait`/`wait_seconds`/`download`/`out_dir` 不参与 plan 指纹。 |
| `allow_duplicate` | 放行同一请求在重复窗口内再次提交（会审计）。 |
| `allow_duplicate_risk` | 放行“上次结果未知”的同请求，**必须**同时给 `override_reason` 和正确的 `prior_record_id`，并写入审计；默认阻止静默重提。 |
| `allow_unbounded_cost` | 仅在无硬上限/预算时用于 Context-IR 这类 token 计价操作，**必须**给 `override_reason`；与 `max_cost`/`budget_id` 同用直接报错，不能把硬 cap 变软。 |
| `wait` | 默认 true：等到完成并下载。false 则立即返回 `task_id`。 |
| `wait_seconds` | wait=true 时的最长等待，默认 900s。超时不报错，返回运行中的 `task_id`。 |
| `download` | 默认 true。结果 URL 有时效，建议保持开启。 |
| `out_dir` | MP4 保存目录，相对会话工作目录，默认 `generated-videos`。 |

示例：

```json
{
  "prompt": "integrated_multimodal_description: [Shot 1] ...\n\noverall_soundscape: ...\n\nnon_diegetic_music: ...",
  "model": "MiniMax-H3",
  "resolution": "2K",
  "duration": 8,
  "ratio": "16:9",
  "max_cost": 8
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
| `download` | 成功时下载 MP4，默认 true；同一单已有下载文件时核验后复用。 |
| `out_dir` | 下载目录，默认记录里的目录或 `generated-videos`。 |

远端查询失败但本地有单时返回 `status:"unknown"` + `record_id` + 恢复提示，不丢 `task_id`；
查询/轮询结果会回写记录，并据此结算/保留预算预约。

### `video_regenerate`

两种二选一模式：

1. `source_task_id`：已成功的 `/v2/video_generation` 任务 id。**需要白名单权限**；任务须属于当前账号、
   状态 succeeded、在 7 天查询窗口内；此模式不要再传 prompt/素材。可加 `original_task_id` 做本地一致性核对；
   未给 `original_task_id` 时会自动用 `source_task_id` 找本地 generation record；登记项目还需
   `source_asset_id` 且其 sha 与本地下载 hash 一致。找不到记录时
   `original_inputs_unknown=true`：floor 不冒充原素材，upper 按 API 最大 15s 原 reference video + 9 张图
   （5 张免费）计入，低于该上界的硬 cap/预算会被拒绝。
2. `video` + `prompt` + 原始素材：传 768P 源片（本地路径或 URL，作为 `base_video`），并**原样重发**
   生成该 768P 视频时实际使用的最终 prompt 和全部原始素材。加 `original_task_id` 会核对
   prompt sha256、每个素材 sha256、以及源片与记录中下载文件的 sha256，漂移即拒。
3. `source_duration_seconds`：外部 request CLI 的**声明**时长，只用于显示与交叉核对。本地可解析容器或
   可信下载记录优先作为实测；声明与实测不符会报 `source_duration_mismatch` 并拒绝。没有实测时估价
   仍为 partial（按 15s 上界预约），声明值不会把估价升级为 complete，也不能用来压低 cap/预算。
   `0` 表示“序列化时的未提供”（真实源最少 4s），按 unknown 处理；正数低报仍走上述拒绝/上界机制。

源片必须符合 H3 768P 输出规格：有音轨、24fps、宽高都能被 32 整除、面积在 768×768 与 768×1344 之间、
帧数 107–362 且步长 17（约 4–15s）。官方再生成接口支持 **任意 H3 家族档位的 768P 成片**
（标准 H3、Highspeed、Lite）；直接生成 2K 仍然只有标准 H3 支持。

### `video_prompt_enhance`

固定走 `MiniMax-H3` + Context-IR，返回 `content.prompt`。Context-IR 按 token 计价，**输出 token
无法在提交前封顶**：估价恒为 `unknown`；带 `max_cost`、`budget_id` 会被拒绝；只有显式
`allow_unbounded_cost:true` + `override_reason` 才会在无硬上限的情况下继续。

### `video_budget`

- `action:"create"`：`budget_id` + 正数 `limit` + `CNY|USD` + 可选 `note`。
- `action:"amend"`：改上限必须给 `reason`，写审计；不能低于已 held/settled 金额。
- `action:"release"`：按 `record_id` 释放 held 预约，必须给 `reason`；只用于对账
  （明确排队取消、服务明确未接单，或人工核对后）。
- `action:"status"`：查看剩余、held、settled 与最近预约。

成功任务按跟单列表价估算 settle；排队取消释放；**终态 failed 不保证 0 扣费，预约继续 held 等对账**；
unknown 永不自动释放。项目 manifest 的 `budget:{id,limit,currency}` 自动建账，调用参数不能换 id 或抬上限。

## 成本模型

| `cost_status` | 含义 | 硬上限比较 |
|---|---|---|
| `complete` | 所有计费输入已知（本地图/可解析视频时长完整） | 估算额 |
| `partial` | 有未知项（URL 参考视频/远端源片时长，或再生成的 base 计费口径未确认），给出 floor 与最坏上界 | **最坏上界**，不用已知额蒙混 |
| `unknown` | token 计价（Context-IR），无预提交上界 | 拒绝 `max_cost`/预算；只能显式 unbounded |

生成估价 = 输出秒 × 分辨率单价 + 超出免费额度的图片 + 参考视频输入秒。再生成估价 =
输出视频秒 × 再生成单价 + **原任务参考视频秒 × 输入视频单价** + 超出免费额度的图片，
并额外给出**可能存在的 base_video 输入费**作为上界。官方“视频再生成”说明原任务输入素材重新计费、
视频按原输入时长；授权只读的 10s 样例 usage 为 `input_seconds:0`，但无法证明 base 一定免费，
因此再生成始终是 **partial floor/upper，不宣称 complete 或实际账单**。价格是 2026-11-16
列表价快照；官方调价后需更新 `lib/catalog.js`。

## 生产保护（默认开启）

1. **离线预检**：参数/模式/时长/素材限制、prompt 标签与媒体数量、台词逐字存在、参考角色/来源契约、
   项目登记（审批、血缘、关键帧、QC、预算）全部在联网前完成。
2. **算价与硬上限**：`max_cost`、预算余额/预约都在凭据解析与 fetch 之前校验。
3. **intent 落盘**：`stateDir/journal/pending-<request_fingerprint>.json`，用独占安装防同指纹并发；
   内容含**付费请求指纹**、plan 指纹、脱敏请求、素材 registry（hash、大小、mime、时长、本地快照）、
   原 prompt、估价/上限/诊断；URL 只保留 origin+pathname+hash，**签名 query token 不落盘**，也不写 API key。
   请求指纹只覆盖会改变 API body 的字段（prompt/模型/时长/素材 hash/source_task_id 等）；只改
   `max_cost`、`budget_id`、台词/角色/来源声明不会绕开未知单防重复。plan 指纹额外绑定 cap、预算与契约，
   由 prepare/plan 执行核对。
4. **`task_id` 立即原子写**：拿到就用 temp→rename 写 `task-<id>.json`，再轮询；崩溃也丢不了 id。
5. **未知结果防重提**：可能已被接受的失败记为 `unknown`，同**请求指纹**被拦；人工检查后需
   `allow_duplicate_risk:true` + `override_reason` + 正确 `prior_record_id`，旧单写审计。
   若 `task_id` 已返回但 journal 写失败，立即返回 `CRITICAL` + task id，**不进入 900s 等待**；
   只有 journal 成功但预算关联失败时继续等待并给 `budget_attach_failed` 诊断。
6. **一次性 plan**：`video_prepare`/`dry_run` 生成短期 plan；执行前 ingest 参数指纹一致才 claim，
   claim 失败或预算不足不会产生任何付费调用；凭据缺失等本地错误发生在 claim/预约之前，可重试。
7. **下载命名**：`task_id + 毫秒 + 随机段 + slug`，独占创建，避免并发覆盖；同一单重试下载先核
   MP4/hash 再复用已有文件。

`stateDir` 默认 `$DSH_HOME/state/dsh-minimax-video/`，包含 `journal/`、`plans/`、`budgets/`、
`records/<record_id>/inputs/`。目录名只用随机 record_id，不含 prompt/URL。

**持久化精度**：文档用同目录 temp→fsync→rename，独占安装用 hard link（EEXIST 即已存在），
关键 rename/link 后尽量 fsync 父目录；这是本地文件系统能力内的 best-effort，不是数据库事务。
锁文件内容为 `{pid,host,nonce,created_at}`：只有本机且 pid 可证明 ESRCH 的死锁会被自动回收；
活进程、EPERM、其他主机或不可读锁绝不按“超时/年龄”抢占，release 只删自己 nonce 的文件，
否则给出含 holder 信息的明确超时诊断。

### 覆盖参数审计

`allow_duplicate_risk` 与 `allow_unbounded_cost` 都需要 `override_reason`；前者还要求
`prior_record_id` 精确等于被拦单。覆盖写入新单 `overrides[]`，并给被拦旧单写审计。`allow_unbounded_cost`
不能与 `max_cost`/预算同用。

## 项目登记（`production/`）

插件内置 `production/project.js` 的同步 `validateProductionInputs({cwd,args,prompt})`，由仓根统一维护，
本插件只消费它的结果：

- 自动发现 `cwd/.ai-video/project.json`（或显式 `project_manifest`）；schema 为
  `dsh.ai-video-project/1`，返回 `{project, shot, issues, warnings, assets, coverage}`。
- 有 shots 时 `shot_id` 必填；批准素材必须本地、hash 可核验；关键帧优先实际使用，截图/替代需
  `keyframe_override_reason`；角色/场景 root lineage 必须覆盖；指定台词必须逐字进 prompt。
- 2K 再生成要求登记源片的 `qc.{frame_scan,motion_review,有对白时 asr}` 为 pass、evidence 文件存在、
  `qc.*.evidence_sha256` 与 evidence 字节匹配、`source_sha256` 与源片一致。
- 项目有 `budget:{id,limit,currency}` 时自动绑定；调用不能换预算/抬上限。
- 工具显式提供 `asset_ids`（槽位→注册资产 id；数组槽位传数组）与 `source_asset_id`（`source_task_id`
  再生成的已登记 768P 源）。二者只进入 plan 指纹，不进入 API body/request 指纹。
  原生工具接口会序列化所有字段：未用槽位的空串/`[]` 视为未提供并由共享 normalizer 归一化；
  真实非空 ID 无媒体、数组长度错位/空项/类型错误、未知槽位仍严格报错，归一化从不 filter 已用 ID 数组。
  可选 `budget_id`/`project_manifest`/`shot_id`/`source_asset_id`/`original_task_id`/`source_task_id`
  的空串同样视为未提供；`prompt`、`max_cost=0` 语义不变。
  **native 工具调用不要发 null**：严格 SDK 在 handler 前拒绝 null；CLI/direct validator 的 null 由
  normalizer 兼容。`__proto__` 等未知槽位不会被吞掉，仍交给 validator 报错。
- 登记项目的 `source_task_id` 再生成必须能用本地 `journal.download.sha256` 证明 `source_asset_id`
  与该远端 task 的下载对应；无本地记录、无下载 hash、hash 不符或 task_id 不符都会拒绝，并建议改用
  `video` 模式。普通无 registry 的 API 用途不受此限制，仍走 worst-case 预算。
- 有登记但输入是 URL/data URI 时由登记校验 **fail closed**。validator 是本插件打包的一部分：
  缺失/损坏/未导出时**任何** prepare/付费调用都直接拒绝，不再依赖 cwd 恰好是项目根目录（验证器自身
  向上查找祖先 manifest）；没有登记时继续一般用途，但仍强制 journal/预算/预检。
- 预算是声明/审计，不是支付认证；不要因此给每个镜头新增人工审批步骤。

`production/test/` 下全部 `*.test.mjs` 已纳入插件自测（`scripts/verify.mjs` 用显式 readdir 列表 spawn `node --test`，红即失败）。

## 模式与互斥

```
无媒体                  → 文生视频
first_frame/last_frame  → 图生视频
reference_*             → 参考生视频
```

- 首/尾帧与 `reference_*` **不能混用**，插件会在发请求前报错。
- `last_frame` 必须和 `first_frame` 成对。
- 可选媒体传空串/全空白视为未提供；reference 数组内空项会被丢弃。但 prompt 里出现
  `<Picture N>` / `<Video N>` / `<Audio N>` 而实际没有对应媒体时会阻止提交，不会变成无参考付费调用。
- 参考素材总数上限 12 个文件（图 ≤9、视频 ≤3、音频 ≤3）。
- 整个请求体 ≤64MB；本地文件会内联为 data URI，超过单文件限制会提示改用公网 URL。
  登记项目要求本地 hash 可核验素材，URL/data URI 会被登记校验拦下。

### 多段连续与角色音色

H3 一次只出 4–15 秒，长片要分镜。两种连续性会打架：

- **画面无缝**：上一段尾帧 → 下一段 `first_frame`。
- **音色一致**：`reference_audio` + `<Audio 1>`。但 `reference_audio` 属于 reference 角色，**不能和 `first_frame` 同时出现**。

所以三选一：参考模式、帧链模式、单段对话。完整决策表见
[continuity-and-voice.md](skill/references/continuity-and-voice.md)。

## 768P→2K 通道：什么时候值得用

官方定价（2026-11-16 快照；再生成单价：输出 ¥0.30/s、输入视频 ¥0.30/s、超出 5 张图片 ¥0.15/张）：

| 方案 | 5 秒成本（CNY，列表价估计） |
|---|---|
| 直接生成 2K（仅标准 H3） | 5 × ¥0.80 = **¥4.00** |
| 生成 768P + 再生成 2K | 生成 5 × ¥0.50 = **¥2.50**；再生成 floor 5 × ¥0.30 = **¥1.50**（输出视频）；若 base 片段也按输入视频计费，upper +5 × ¥0.30 = **¥3.00**；合计约 **¥4.00–¥5.50** |

旧文案“再生成一定比直出贵”不成立：按官方表，5s 标准 H3 768P + 再生成的下界与直接 2K 都是
¥4.00，上界约 ¥5.50，取决于 base_video 是否另计输入视频。若原任务还有 reference video，官方规则是
按原输入时长重新计费，按当前再生成输入视频单价约 ¥0.30/s，floor/upper 都会增加；这不是账单承诺。
再生成的价值仍在于先在低成本档位迭代、验收后再 2K，而不是默认省钱。原 reference video 的重计费
按官方再生成“输入视频”单价 ¥0.30/s 估算；若实际账单改用原任务模型单价，floor/upper 会偏离，
因此估价始终标注 partial/假设，不冒充账单。

## skill

- `skill/SKILL.md`：H3 路由、硬约束、档位选择、三字段提示词、声音、参考素材、2K 流程、提交前检查。
- `skill/references/*.md`：提示词、运镜、类型配方、示例、API 备注、连续性与音色。
- 若存在 `skill/production-workflow.md`，会额外注册 `ai-video-production` skill（同一目录 base，
  provider 的 `get(candidate)` 按候选 locator 读取）。

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
| `stateDir` | `$DSH_HOME/state/dsh-minimax-video` | journal/plans/budgets/records 根目录。 |
| `planTtlSeconds` | `1800` | prepare 计划有效期。 |
| `duplicateWindowSeconds` | `600` | 同请求重复保护窗口。 |
| `inputSnapshotMaxBytes` | `67108864` | 本地素材快照总上限；超出的仍提交但记录不保留副本。 |
| `budgetId` | 未设置 | 未显式传参且项目未声明时的默认预算 id。 |
| `approvedSources` | 未设置 | 默认来源标签白名单。 |
| `approvedHosts` | 未设置 | URL 素材 host 白名单（支持 `*.example.com`）。 |
| `requireSourced` | `false` | 强制要求 `source_declarations`。 |
| `productionModule` | 插件内 `production/project.js` | 项目登记校验模块路径。 |

密钥解析顺序：`ctx.credentials.resolve(keyRef)` → `$DSH_HOME/secrets/minimax.env` 里的同名键。

## 安装

```sh
# 托管安装（推荐）：把插件目录绝对路径作为 target
# plugin_manager action=install_bundle target=/.../plugins/dsh-minimax-video
```

Host 半边（`index.js`/`lib/`）改动需要重启 dsh；skill 与工具在启动时装入。

## 验证

```sh
node --check plugins/dsh-minimax-video/index.js
node plugins/dsh-minimax-video/scripts/verify.mjs
npm run verify
```

自测覆盖：7 个工具注册与参数 schema、档位/价格矩阵、请求体形状、媒体/素材 registry 与脱敏、
prompt/台词/参考角色/来源契约、complete/partial/unknown 估价与 `max_cost`、跨调用预算与
跨进程原子预约、durable journal（含跨进程同指纹竞争与未知态拦截）、一次性 plan、mock 网络下的
ID 先落盘/轮询失败恢复/重复保护、下载命名与复用、再生成漂移核对、项目登记 fixture、skill provider，
并额外 spawn `production/test/` 下全部 `*.test.mjs`（显式 readdir 文件列表，不依赖 shell glob；
当前为 `project.test.mjs` + `local-qa.test.mjs`，本地 QA 里的真实 ASR 两项在缺少环境时由测试自身 skip）。
production 测试红就是红，不会降级为 warning。
**全部网络 mock，不发真实请求、不产生费用。**

真实付费冒烟测试（2026-11-15）：`MiniMax-H3-Lite` / 480P / 4s / 16:9，任务 `463362638545526`，
产出 864×480、24fps、H.264 + AAC、4.46s，约 ¥0.64；下载落盘已验证。

## 已知限制

- 一次只生成一段 4–15s；没有续写/拼接接口。长片请分镜生成后外部拼接。
- `first_frame` 与 `reference_audio` 不能同时传；角色音色一致性和逐帧视觉连续性不能在同一次调用里同时拿到。
- 本地视频/音频只做扩展名、体积与 MP4 时长探测；编码、帧率、音轨由 API 判定。
- 对白时长估算是 heuristic（中文按字、其他按词），只拦“不可能装下”，紧凑只警告；
  真实可用时长以实测/ASR 为准，ASR 时间戳也不是精确剪辑边界。
- 成功单按列表价估算 settle，不是对账单；终态 failed 是否扣费不确定，预约保留等人工对账。
- 预算创建竞态失败方会复核 `budget_id/limit/currency`，不会因为 id 相同而静默接受另一个更高 cap。
- `source_task_id` 再生成依赖白名单，且本地没有源片时无法核对 QC/源字节；没有权限时用 `video` 模式。
- Context-IR 是 token 计价，无法预提交封顶，也不能挂预算；必须显式 `allow_unbounded_cost` 才可无上限调用。
- 项目登记要求本地可核验素材；远端 URL/data URI 在登记项目会被拒绝，这是有意 fail closed。
- 价格是 2026-11-15 的列表价快照；官方调价后需更新 `lib/catalog.js` 与 skill 的 `api-notes.md`。
- 未暴露 `callback_url`、`response_format`、`aigc_watermark`：本地会话用不上，且区域 schema 有差异。

## 文件

```
index.js                 工具与 skill 注册
lib/catalog.js           档位/价格/校验/成本估算
lib/request.js           生成/再生成/Context-IR 请求体
lib/media.js             本地文件 → data URI、64MB 上限、空参数归一
lib/assets.js            素材 registry、hash/时长、脱敏请求、plan 指纹
lib/preflight.js         台词/参考/来源契约、估价、硬上限
lib/journal.js           intent/任务持久化、重复与未知态防护
lib/plans.js             一次性 prepared plan
lib/budget.js            跨调用预算 ledger 与原子预约
lib/mp4.js               MP4/MOV 时长探测
lib/store.js             原子写、锁、hash
lib/api.js               HTTP 客户端、轮询、下载（独占命名/复用）
production/              项目登记校验与本地 CLI（仓根统一维护）
skill/                   minimax-video / ai-video-production（若存在）skill 与参考文档
scripts/verify.mjs       离线自测（含 production 测试）
docs/DETAIL.md           Plugin Manager 详情页
```
