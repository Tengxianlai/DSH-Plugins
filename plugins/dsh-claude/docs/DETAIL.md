# Claude Opus 5.5 外场专家

`claude` 是一条**外场专家线**，不是通用聊天窗。调用方把问题、已经试过的方案、报错原文、
相关材料和约束一起交给它；它开启扩展推理，以独立专家身份给出判断、依据和下一步。回答
只有文本，它不执行代码，也不读写工作区。

## 为什么要“外场”

在局中的 agent 容易陷入三种盲区：自己的假设没被检验、被同一类错误反复打回、卡住后在
同一组操作之间循环。外场专家的价值不是“多一个模型”，而是**换一套不在局中的判断**。

技能 `external-expert` 把请它的条件写死为四类：

1. 专业难度明显偏高，或一步错代价很大；
2. 多次被反驳、反复出错；
3. 迷茫，不知道下一步；
4. 用户点名要 Claude / 外场专家 / 第二意见。

同时写了“不要用”的边界：简单查询、用户禁止外部调用、材料不允许外发、只是想把活外包
出去。避免这条线变成装饰性调用。

## 请求形状

```jsonc
{
  "model": "claude-opus-5-5",
  "max_tokens": 24576,
  "thinking": { "type": "enabled", "budget_tokens": 16384 },
  "system": [
    {
      "type": "text",
      "text": "You are an outside expert consulted by another AI agent ...",
      "cache_control": { "type": "ephemeral", "ttl": "1h" }
    }
  ],
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "（source：目标、已试方案、报错、约束）" },
        { "type": "text", "text": "文件 1：logs/upload-timeout.log" },
        { "type": "text", "text": "（文本附件内容）" },
        { "type": "text", "text": "文件 2：diagrams/flow.png" },
        { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "..." } },
        { "type": "text", "text": "文件 3：docs/storage-design.pdf" },
        { "type": "document", "source": { "type": "base64", "media_type": "application/pdf", "data": "..." } },
        {
          "type": "text",
          "text": "以上是本次咨询的固定背景。",
          "cache_control": { "type": "ephemeral", "ttl": "1h" }
        },
        { "type": "text", "text": "（task：要判断什么、成功标准、约束）" }
      ]
    }
  ]
}
```

要点：

- **推理始终开启。** `thinking.type = "enabled"`，`budget_tokens` 由 `reasoning` 映射：
  low 2048 / medium 8192 / high 16384。没有 temperature 参数；思考型请求不混采样参数。
- **思考 token 与正文共享 `max_tokens`。** 因此 `max_tokens` 必须大于思考预算；默认
  预算 + 8192。若首轮只剩思考没有正文且 `stop_reason = max_tokens`，自动放大一次再重试。
- **两个缓存断点。** system 指令是第一断点；有 `source`/附件时，在固定背景末尾再加一个
  文本标记块作为第二断点。`task` 放在标记之后，换问题时缓存前缀不变。
- **多模态块顺序稳定。** 附件按调用方给的顺序排列，每个附件前有“文件 N：路径”标签；
  图片 `image`、PDF `document`、文本直接 `text`。顺序稳定才能让缓存命中。

## 缓存的经济账

Anthropic 的 prompt cache 按“断点前的前缀”缓存：

- 5 分钟 TTL：写入约为普通输入的 1.25 倍，读取约为 0.1 倍；
- 1 小时 TTL：写入约为普通输入的 2 倍，读取约为 0.1 倍。

外场专家通常会被追问，所以默认 1h：同一份 brief 问第二次时，已经接近回本；问第三次
开始明显省。确定只问一次时传 `cache_ttl: "5m"`，把首次写入成本降下来。

`usage` 里的字段映射到返回：

| Anthropic 字段 | 返回字段 |
|---|---|
| `usage.input_tokens` | `uncached_input_tokens`（API 的未缓存输入） |
| `usage.input_tokens + cache_creation + cache_read` | `input_tokens`（完整输入） |
| `usage.output_tokens` | `output_tokens` |
| `usage.cache_creation_input_tokens` | `cache_write_tokens` |
| `usage.cache_read_input_tokens` | `cache_read_tokens` |

`cache_hit` 是 `cache_read_tokens > 0`。工具正文末尾附一行调用信息，模型和用户都能看到
这次是写缓存还是读缓存，例如 `in 31577 (new 2) / out 73 · cache write 31575 / read 0`。

实测（2026-11-14，TeamoRouter，`claude-opus-5-5`）：

```
第一次: cache_creation_input_tokens=31575, cache_read_input_tokens=0
第二次: cache_creation_input_tokens=16,   cache_read_input_tokens=31559
```

第二次只新增了 task 的 16 token，说明背景前缀确实被复用。

## 多模态

Anthropic Messages API 的图片与 PDF 都走 base64 source：

- 图片块：`{"type":"image","source":{"type":"base64","media_type":"image/png","data":"..."}}`；
- PDF 块：`{"type":"document","source":{"type":"base64","media_type":"application/pdf","data":"..."}}`。

实测同一请求里同时放图片和 PDF，模型能正确读出图片里的字母和 PDF 里的口令。音频/视频
不在 Anthropic 原生输入类型里，插件明确拒绝，并提示先转文字或抽帧。

## 与 `dsh-gemini` 的分工

| | `dsh-gemini` | `dsh-claude` |
|---|---|---|
| 定位 | 多模态合作者：写、看、读、对照 | 外场专家：难题、被反驳、卡住、第二意见 |
| 模型 | Gemini 4 Argon | Claude Opus 5.5 |
| 推理 | `thinkingLevel` low/medium/high | `thinking.budget_tokens` 2048/8192/16384 |
| 缓存 | 无 | 双层断点，默认 1h |
| 触发 | 创作、长文、素材对照 | 技能定义的四类升级条件 |

两者不互斥：日常读写找 Gemini，判断卡住或风险高时找外场专家。

## 限制与边界

- 一次调用是一个独立请求，不续接会话；多轮追问要重新给上一轮结论。
- 它看不到工作区，不执行命令；事实只能来自 `source`/`files`。
- 回答是第二意见，不是裁决；调用方仍需核对材料引用、做本地验证。
- 缓存前缀太短时不会写入缓存，读写都可能是 0。
- 上游是 TeamoRouter；本插件只保证请求里不含 Harness 身份段，不控制它的转发路径。
