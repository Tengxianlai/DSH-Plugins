# dsh-playwright-per-agent

在每个**根 agent** 的上下文里挂一个 Playwright MCP 客户端（streamable-http，默认
`http://127.0.0.1:8931/mcp`），使多 agent 会话里每个根 agent 都能独立使用浏览器工具；
子 agent 不重复挂载，agent 释放时一并 dispose。

- **半边**：仅宿主。
- **依赖**：`@deepseek-ai/dsh-mcp-client`，从 dsh 运行时解析（`createRequire(process.argv[1])`），
  不在本包里声明版本。
- **配置**：`apply(ctx, config)` 支持 `config.url` 覆盖 MCP 地址。
- **挂载**：`cordis.patch.yml` 里一条 `insert`（`id: playwright-per-agent`）。

## 测试

```sh
node --check index.js
node test/host.test.mjs
```
