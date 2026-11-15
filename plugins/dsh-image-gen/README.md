# dsh-image-gen

一个 `image_generate` 工具，接两个生图后端，调用者用 `provider` 任意切换：

- **GPT**：TeamoRouter 的 OpenAI 兼容 Images API（GPT Image 2.x；`gemini-3-pro-image` / `gemini-3.1-flash-image` 也走这个后端）。
- **MiniMax**：MiniMax H3-Image 标准版 / 极速版（`MiniMax-H3-Image`、`MiniMax-H3-Image-Highspeed`）。

两个后端都支持文生图、单图编辑、多参考图合成；都返回文件路径，图片字节不进对话上下文。
选型或算价前先调用 `image_models`，它输出下面这张档位/价格快照的英文版。

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
| `out_dir` | 落盘目录，相对会话工作目录，默认 `generated-images`。 |

返回值：

```json
{
  "files": ["/abs/path/....png"],
  "provider": "gpt",
  "size": "2048x1152",
  "model": "gpt-image-2.6-sunburst",
  "format": "png",
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

### `image_models`

无参数，返回模型清单、能力、**GPT 档位表**、MiniMax 面积档价格和 token 单价，以及快照日期。
它是模型调用时可直接读取的英文版本；档位表放在最前面，先看档位再看模型。

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

自检不发起网络请求，覆盖：工具注册、档位/尺寸规划、`2560x1440` 拒绝规则、4K-only 变体规则、
GPT 档位价和 `cost_cny` 估算。2026-11-14 曾用真实密钥跑过 MiniMax/GPT 的多档位生图与编辑；
2026-11-15 改档位/价格后**没有重跑真实生图**（避免产生费用），请求体格式未变，仅校验/报价逻辑变化。

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
