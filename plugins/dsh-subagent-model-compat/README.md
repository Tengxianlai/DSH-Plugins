# 子智能体模型兼容

修复模型调用 `list_subagent_models` / `subagent` 时把可选路由字段填成空字符串，导致清单查询或委派失败的问题。插件沿用官方工具实现，在同一 preset 作用域内、首次注册前适配参数，不改 DSH 发行文件，不需要在全局 AGENTS 中硬编码模型。

## 行为

| 输入 | 行为 |
|---|---|
| 查询 `{}` 或 `{"provider":"","model":""}` | 列出当前会话授权的 provider |
| 查询 `{"provider":"magpie","model":""}` | 列出该 provider 下授权的模型 |
| 查询完整 provider/model | 显示该模型及推理强度 |
| 委派的 provider/model/reasoning_effort 都为 `""` | 按原生省略逻辑使用子级默认值，未配置则继承兼容父值 |
| 委派完整路由，reasoning_effort 为 `""` | 使用所选模型的默认推理强度 |
| 委派不完整或未授权的路由 | 继续由官方实现拒绝 |

只处理严格等于空字符串的目标字段；不 trim ID，不把 null、错误类型或未知字段当作省略。日志与审批保留模型原始实参，归一化只发生在工具内部的局部副本。输入验证、会话授权、模型预检、超时、取消、深度限制、结果渲染与 provider 卸载继续由官方实现负责。工具定义保留对象身份，以维持原生委派和深度提示。

模型清单是**显式选择的授权范围**，并非默认模型或强制名单。`subagent_fork` 保持官方实现，仍继承父模型。工具提示要求显式选模型前先查清单，不猜 provider，也不以 fork 绕过查询失败。

## 安装与生效

通过 DSH 的托管 `install_bundle` 安装本插件目录的绝对路径，或在插件页面添加本地目录。无需构建脚本或新增运行时依赖。

此包按官方支持的 composition 覆盖方式，为 Web 的 `standard`、`ptc`、`cordis`（Creator）preset 替换 spawn 工具；Minimal 没有此工具，不受影响。补丁保留 `@deepseek-ai/dsh-web-app@0.2.2-rc.3` 的三个 preset 配置，替换 spawn 工具包名，并将原有官方技能目录表达式的解析锚点固定为运行中的 DSH 安装，避免本地 bundle 的 baseUrl 改变技能查找位置。安装前应确认用户补丁没有覆盖这些 preset；有定制时需先合并定制内容。

新会话使用新 preset 代际；已经运行的 Agent 保留旧代际，刷新页面不保证切换。已有会话应在工作保存后重启 DSH，再恢复。已有模型授权记录不变；更改界面中的授权名单仍只影响新会话。

兼容版本固定为 **0.2.2-rc.3**：manifest 的 `engines.dsh` 与运行时版本校验共同防止升级后静默沿用旧 preset。升级 DSH 前先卸载或停用本 bundle，再对照新版本更新并验证。

## 验证与回滚

运行 `node --check index.js`、`node --check lib/compat.js`、`node --test test/*.test.mjs`，再从仓根执行 `npm run verify`。集成测试通过 `DSH_INSTALL_DIR` 解析实际运行版本，不联网、不调用付费模型。

卸载或停用本 bundle 可恢复原生 preset；活动 Agent 仍保留其旧代际，完整回滚需重启 DSH。不要直接删除目录，以免破坏托管安装的软链。

## 本机安装验证（2026-11-17）

已通过托管通道安装到当前 `web` profile，返回 `application: applied`、`warnings: []`；三个 preset 声明均为 active。已核对 `link:` 依赖、bundle 选择、软链正本及用户补丁无重复挂载。14 项真实官方工具栈回归全部通过，插件正本目录的全仓体检（10 个插件）通过。

安装前已创建的本次 Agent 仍使用旧代际，空参数查询仍报原错误；这是预设租约的实际验证，不应将 applied 解释成所有旧会话立即换版。新会话使用新预设；已有会话应在任务结束后重启 DSH 再恢复。浏览器停在认证页，未完成运行界面的视觉验收，也未通过真实模型请求验收新建 Web 会话。

预设配置来源：`@deepseek-ai/dsh-web-app@0.2.2-rc.3`，MIT 许可，见 [UPSTREAM-LICENSE](UPSTREAM-LICENSE)。
