# dsh-claude

把 Claude Opus 5.5 当作**外场专家**（场外专家、第二意见）：当问题真的难、你已经多次被反驳、你卡住不知道下一步，
或者用户点名要第二意见时，把完整 brief 交给它，开启扩展推理，拿回一份独立判断。

插件提供一个工具 `claude` 和一个按需加载的技能 `external-expert`。模型固定为
`claude-opus-5-5`，不开放模型切换；支持文本、图片、PDF；提示缓存默认开启。

## 为什么单独一条外场专家线

- **不是通用聊天窗。** 它只在你确实需要“不在局中的脑子”时被请出来：高难度、高风险、
  反复被纠正、卡住、用户指定。技能正文把这些触发条件写清楚了，避免逢事必问。
- **推理默认拉满。** `thinking: { type: 'enabled', budget_tokens }` 始终开启，默认
  `high`（16384 token）。没有“快速回答”模式，因为这条线就是为需要想清楚的问题准备的。
- **请求里没有 Harness 身份段。** system instruction 是插件自己写的中性专家提示，只有
  “读材料、直接回答、区分事实与推断、别编造”几句；没有品牌句和文件引用段。
- **缓存默认开启。** system 指令和 `source`/`files` 组成的固定背景带
  `cache_control` 断点，`task` 在断点之后。第二次用同一份背景提问会读缓存，而不是重新
  付全价。返回里直接给 `cache_write_tokens` / `cache_read_tokens`。
- **能看图。** 图片、PDF、文本文件按路径内联，附件带“文件 N：路径”标签，专家可以按
  路径指认。

## 工具 `claude`

| 参数 | 说明 |
|---|---|
| `task` | 必填。要专家判断/决定/复核什么，成功标准与约束。长材料放 `source`，不要塞这里。 |
| `source` | brief：目标、已试方案、报错/反驳原文、相关代码日志、候选方案、约束。重复咨询时保持逐字一致，缓存才能命中。 |
| `files` | 图片（png/jpg/jpeg/webp/gif）、PDF、文本文件（txt/md/csv/json/srt/vtt/yaml/html/fountain/log）的本地路径或 http(s) URL。 |
| `reasoning` | `low`（2048）/ `medium`（8192）/ `high`（16384，默认）。扩展推理始终开启。 |
| `max_tokens` | 1024–32000，含思考 token，必须大于思考预算；默认 = 预算 + 8192。 |
| `cache_ttl` | `1h`（默认）或 `5m`。同一份背景预计追问多次用 1h；确定只问一次用 5m 降低首次写入成本。 |

返回 `{ text, model, reasoning, thinking_budget, max_tokens, input_tokens,
uncached_input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, cache_ttl,
cache_hit, finish_reason?, truncated? }`。其中 `input_tokens` 是完整输入（未缓存 + 缓存写入 +
缓存读取），`uncached_input_tokens` 是 API 的 `usage.input_tokens`，即真正没命中缓存的部分。
工具正文末尾会附一行调用信息，例如：

```
[claude-opus-5-5 · high · in 31577 (new 2) / out 73 · cache write 31575 / read 0]
```

思考块（`type: "thinking"`）会被丢弃，只返回正文。

## 技能 `external-expert`

模型可见的技能描述覆盖四类触发条件：专业难度大、多次被反驳/反复出错、迷茫不知道下一步、
用户点名要 Claude/外场专家/第二意见。技能正文包括：

- 什么时候请、什么时候不要请；
- 怎么准备 `task` / `source` / `files`；
- 推理档位与缓存 TTL 怎么选；
- 拿到回答后怎么核对材料引用、怎么处理和己方判断的冲突；
- 一个完整的合格调用示例。

技能是 `modelInvocable: true, userInvocable: true`，也可以用 `/external-expert` 主动加载。

## 提示缓存

请求里有两个断点：

1. `system` 块（专家指令）；
2. `source` + 附件后的固定背景标记块（只在有背景时出现）。

`task` 在标记之后，所以换问题不会让缓存前缀失效。默认 1 小时 TTL；1h 需要
`anthropic-beta: extended-cache-ttl-2025-04-11`，插件会自动带上。用 `cache_ttl: '5m'`
时不发 beta 头、不带 `ttl` 字段。

实测（2026-11-14，TeamoRouter + `claude-opus-5-5`）：

- 首次同一份 31k token 背景：`cache_creation_input_tokens: 31575`，`cache_read_input_tokens: 0`；
- 第二次换问题：`cache_read_input_tokens: 31559`，只新增 16 token 缓存写入。

注意：缓存前缀要达到最小长度（约千 token 级）才会真正写入；很短的 system + 很短的问题
可能两次读写都是 0。这不是错误，只是没到阈值。

## 附件

- 图片：`png/jpg/jpeg/webp/gif`，单张上限 5 MB。
- PDF：单份上限 20 MB，作为 Anthropic `document` 块发送。
- 文本：每个附件最多 20 万字符，所有文本合计最多 40 万字符；超出截断并标 `[truncated]`。
- 图片 + PDF 合计上限 20 MB（base64 后会膨胀，给请求留余量）；超了明确报错。
- 不支持音频/视频、docx/xlsx 等二进制；请先转文本或 PDF。
- 本地路径相对会话工作目录解析，也可以给绝对路径或 http(s) URL。

## 配置与密钥

`cordis.patch.yml` 默认：

```yaml
baseURL: https://api.teamorouter.com/v1
```

密钥取凭据存储的 `TEAMOROUTER_API_KEY`，缺失时回退
`$DSH_HOME/secrets/teamorouter.env`。请求走 Anthropic 原生 `POST /v1/messages`；先发
`Authorization: Bearer`，遇到 401/403 再用 `x-api-key` 重试一次。不要在仓或 profile 写明文。

其他可选配置：`keyRef`、`keyFile`、`cacheTTL`（默认 `1h`）、`defaultReasoning`（默认 `high`）。

## 安装

由 `plugin_manager` 的 `install_bundle` 托管安装，target 用本目录的绝对路径（相对仓根是
`plugins/dsh-claude`）。宿主半边改动需重启 dsh-web 生效。

## 自检

```sh
node --check index.js
node scripts/verify.mjs
```

自测不会发真实网络请求，覆盖：工具/技能注册、推理预算、双层缓存断点、文本+图片+PDF
块组装、参数校验、附件拒绝与截断、思考块过滤、缓存用量解析、Bearer 正常路径、401 回退、
预算耗尽重试、拒答/空回答、上游错误透传、渲染页脚、技能正文触发词。

## 限制

- 一次调用是一个独立请求，不续接上一次对话；多轮追问要把上一轮结论和新材料重新给出
  （背景不变时缓存会命中）。
- 它看不到工作区，不执行命令；所有事实要么在 `source`/`files` 里，要么不存在。
- 它是第二意见，不是裁决。最终取舍、改动和验证仍由调用方负责。
