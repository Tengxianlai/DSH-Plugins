# dsh-gemini

用 Gemini 4 Argon 写、看、读、对照。工具名 `gemini`，直连 TeamoRouter 的原生 Gemini `generateContent`；你可以用自然语言提问，并把剧本、场景图、分镜、PDF、片段一起交给它。

## 为什么

- **请求里没有 Harness 身份段。** 插件自己拼一段很短的中性 system instruction，没有 `DeepSeek Harness` 品牌句，也没有 `@` 文件引用段。上游看到的是一个普通客户端，而不是 agent harness。
- **它是合作者，不是写作模式。** 没有 `mode`、没有“只准写正文”的硬约束；问题怎么问、要它看什么、输出什么格式，都由 `task` 决定。
- **能看图。** 图片、PDF、视频/音频片段按路径内联进请求，每个附件带“文件 N：路径”标签，Gemini 可以按路径指认。
- **模型固定 `gemini-4-argon`**，没有 model 参数，不开放 Carbon/Hydrogen。

## 工具

`gemini`

| 参数 | 说明 |
|---|---|
| `task` | 必填。自然语言的问题或请求：项目背景、材料位置、要比较什么、什么算问题。 |
| `source` | 长文本材料：剧本、访谈、设定、清单。没有就不传。 |
| `files` | 附件路径或 URL：图片、PDF、mp4/mov/webm、mp3/wav/ogg、文本文件。 |
| `reasoning` | `low` / `medium` / `high`，默认 `medium`。密集对照或深度分析用 high。 |
| `max_tokens` | 1024–65536，默认 16384（含思考 token；预算被思考耗尽会自动放大一次重试）。 |
| `temperature` | 0–2，默认 0.7。 |

返回 `{ text, model, reasoning, input_tokens, output_tokens, total_tokens, finish_reason?, truncated? }`。

## 附件

- 支持：`png/jpg/jpeg/webp/gif/bmp`、`pdf`、`mp4/mov/webm`、`mp3/wav/ogg`、`txt/md/csv/json/srt/vtt/yaml/html`。
- 本地路径相对会话工作目录解析，也可以给绝对路径或 http(s) URL。
- 所有附件合计上限 12MB（base64 后会膨胀，留出请求余量）；超了会明确报错。
- 单个文本附件超过 20 万字符会截断；返回正文超过 20 万字符也会截断并标 `[truncated]`。
- 不支持的二进制（docx/xlsx 等）请先抽出文本，或转成 PDF 再传。

## 配置与密钥

`cordis.patch.yml` 默认 `baseURL: https://api.teamorouter.com/v1beta`。密钥取凭据存储的 `TEAMOROUTER_API_KEY`，缺失时回退 `$DSH_HOME/secrets/teamorouter.env`。不要在本仓或 profile 写明文。

## 安装

由 `plugin_manager` 的 `install_bundle` 托管安装，target 用本目录的绝对路径（相对仓根是 `plugins/dsh-gemini`）。

宿主半边改动可通过关/开插件行热加载；工具定义在重新装载时更新。

## 自检

```sh
node --check index.js
node scripts/verify.mjs
```

自测会检查：工具注册、文本 + 图片 + 文本附件组装与路径标签、类型拒绝、默认 medium/0.7、system prompt 不含 Harness 指纹、思考 part 被过滤、401 回退、预算重试。不会发真实网络请求。
