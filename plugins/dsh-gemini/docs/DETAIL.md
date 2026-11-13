# Gemini 4 Argon 多模态

`gemini` 是一个“能看图的合作者”：写剧本、文案，拿场景图和剧本对照，读 PDF 和长文，比较同一场景的多个版本。一次调用返回一段文本。

## 为什么单独做一个工具

- **请求里没有 Harness 身份段。** 插件自己拼一段很短的中性 system instruction，只有“读材料、直接回答、不确定就说”三句；没有 `DeepSeek Harness` 品牌句，也没有 `@` 文件引用段。上游看到的是一个普通客户端，而不是 agent harness。
- **不预设写作模式。** 没有 `mode`，没有“只准输出正文”的约束。问什么、看什么、要什么格式，全在 `task` 里用自然语言说。
- **多模态。** 图片、PDF、视频/音频片段、文本文件都可以按路径附上；每个附件前有“文件 N：路径”的标签，Gemini 能按路径指认。
- **只回文本。** 思考内容（`thought: true` 的 part）被丢弃，答案直接可用。
- **模型固定 Argon。** 不开放 Carbon/Hydrogen。

## 参数

| 参数 | 说明 |
|---|---|
| `task` | 必填。自然语言的问题或请求：项目背景、材料位置、要比较什么、什么算问题。 |
| `source` | 长文本材料（剧本、访谈、设定、清单）。没有就不传。 |
| `files` | 附件路径或 URL：图片、PDF、片段、文本文件。 |
| `reasoning` | `low` / `medium` / `high`，默认 `medium`。 |
| `max_tokens` | 输出预算，1024–65536，默认 16384（含思考 token；预算被思考耗尽会自动放大一次重试）。 |
| `temperature` | 0–2，默认 0.7。 |

返回：`text`、`model`、`reasoning`、`input_tokens`、`output_tokens`、`total_tokens`，以及可选的 `finish_reason`、`truncated`。

## 附件类型与上限

- 图片：`png/jpg/jpeg/webp/gif/bmp`
- 文档：`pdf`；文本类 `txt/md/csv/json/srt/vtt/yaml/html`
- 视频/音频：`mp4/mov/webm`、`mp3/wav/ogg`
- 合计上限 12MB（原始字节；base64 后约 16MB，给请求留余量）
- 文本附件和返回正文超过 20 万字符会截断
- docx/xlsx 等二进制先抽文本或转 PDF，工具不会解析

## 一次典型的对照请求

```
gemini(
  task="我们现在在做一部雨夜短片。剧本和分镜表在 source 里，场景图在 files 里，按场次命名。请对照检查时间、地点、人物、道具、光线有没有明显对不上的地方；只指出最确定的几处，并说明依据。",
  source="（剧本 + 分镜表）",
  files=["scenes/s01-rain-alley.png", "scenes/s02-doorway.png", "scenes/s03-rooftop.png"],
  reasoning="high",
)
```

## 配置

`cordis.patch.yml` 里默认：

```yaml
baseURL: https://api.teamorouter.com/v1beta
```

密钥按顺序取：

1. 凭据存储里的 `TEAMOROUTER_API_KEY`；
2. `$DSH_HOME/secrets/teamorouter.env` 里的同名变量。

请求走原生 Gemini `generateContent`，先发 `Authorization: Bearer`；遇到 401 再用 `x-goog-api-key` 重试一次。`thinkingLevel` 映射为 `LOW` / `MEDIUM` / `HIGH`。

## 限制

- 一次调用一个独立请求，不续接 Gemini 侧会话；多轮追问要把上一轮结论和材料一起重新给出。
- 只返回文本，不返回文件或工具调用；它不会读写工作区。
- 长材料 + `high` 思考会慢；`max_tokens` 太小可能只剩思考没有正文。
- 上游是 TeamoRouter，是否触发 Google 的提示词指纹取决于它的转发路径；本插件只保证请求里不含 Harness 指纹段。
