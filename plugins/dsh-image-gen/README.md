# dsh-image-gen

用 TeamoRouter 的 OpenAI 兼容 Images API 出图/改图，替代 magpie 的 `magpie-image` MCP。

## 为什么

- MCP 的工具定义常驻上下文（magpie-image 约 1.5k tokens），且一次调用只能串行等待。
- 直连上游能拿到完整参数：任意合法尺寸（1K/2K/4K 档位）、quality、n、多参考图、输出格式，
  以及图生图（`/v1/images/edits`）——保持同一张脸、同一个角色靠的就是它。
- 图片落盘为文件，返回值只有路径；图片字节不进对话上下文。

## 工具

`image_generate`

| 参数 | 说明 |
|---|---|
| `prompt` | 必填。画什么，或怎么改。 |
| `images` | 参考/源图（本地路径或 http(s) URL）。一张=编辑，多张=合成；不传=文生图。 |
| `size` | `1k` / `2k` / `4k` 或 `WIDTHxHEIGHT`（如 `1536x1024`）。默认 `1k`。 |
| `aspect` | 与档位配合的比例：`1:1` `16:9` `9:16` `4:3` `3:4` `3:2` `2:3`。默认 `1:1`。 |
| `quality` | `auto` / `low` / `medium` / `high`。默认 `auto`。 |
| `n` | 1–4，默认 1。 |
| `format` | `png` / `jpeg` / `webp`，默认 `png`。 |
| `model` | 默认 `gpt-image-2.6-sunburst`；4K 细节可用 `*-4k-upscale` 变体。 |
| `out_dir` | 落盘目录，相对会话工作目录，默认 `generated-images`。 |

返回值：`{ files, size, model, quality, revised_prompt? }`。

## 尺寸与计费

上游按张计费，档位由**实际输出图的最长边**决定：≤1024 为 1K，≤2048 为 2K，>2048 为 4K。
尺寸约束：两边都是 16 的倍数、最长边 ≤3840、总像素在 655,360–8,294,400 之间。
插件会把 `1k/2k/4k + aspect` 换算成满足约束的具体尺寸，越界的显式尺寸直接报错。

## 安装

由 `plugin_manager` 的 `install_bundle` 托管安装，target 用本目录绝对路径：

```
/home/tengxlper/DSH_ZONE/Projects/DSH-Plugins/plugins/dsh-image-gen
```

密钥：凭据存储里的 `TEAMOROUTER_API_KEY`（已在 `~/.dsh-wsl/.credentials.yaml`），
缺失时回退读取 `~/.dsh-wsl/secrets/teamorouter.env`。不要在 profile 或本仓写明文。

## 自检

```sh
node --check index.js && node scripts/verify.mjs
```
