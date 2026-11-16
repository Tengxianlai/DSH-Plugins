# 00 · 会话时间索引（TanLu-CJU75th）

## 数据面

| 项 | 实测值 |
|---|---|
| 主存储 | `~/.dsh-wsl/sessions/--home-tengxlper-DSH_ZONE-VideoStudio-Projects-TanLu-CJU75th--/` |
| 会话数 | **65 个**（审计开始时；收尾时 68 个，新增 3 个是本次审计派出的子代理会话，见 `06_GAPS.md` G5）。每目录一份 `session.v4.jsonl.zstd`，均含 `session.lock` |
| 其中历史会话 | 63 个（2026-11-11 23:49 → 2026-11-16 16:47） |
| 其中本次审计会话 | 2 个：`63a534ab…`（本会话，18:15:31 创建）、`0101f477…`（并行审计会话，同秒创建） |
| 旧 home 副本 | `~/.dsh/sessions/--home-tengxlper-DSH_ZONE-VideoStudio-Projects-TanLu-CJU75th--/` 仅 3 个目录，会话 ID 为 `session-0f6eac2a` / `session-3baf3ca6` / `session-463b745b`，与主存储同 ID 同 cwd，属迁移前副本 |
| 全部会话 `cwd` | 均为 `/home/tengxlper/DSH_ZONE/VideoStudio/Projects/TanLu-CJU75th`（首行 `session` 记录核实） |

## 索引表

列说明：**用户记录** = `user/message` 记录条数（去掉 system-reminder 与定时器，**仍包含子代理汇报、后台任务回执**），因此不是「真人说了几句话」。四个大会话的真人发言数另测：`3baf3ca6`=25、`9e5b4806`=19、`213b3228`=20、`78b8ee8a`=11。**vgen/regen** = `video_generate`+`video_regenerate` 调用次数（不代表成功）；**image** = `image_generate`；**gemini** = `gemini` 工具调用；**错误** = `turn/end` 或 `assistant/attempt` 里的 error 事件数；**重试** = `llm/retry`。**主模型**按 `model/selection` 事件出现顺序；只有子代理会话没有该事件时写 `(inherit)` 并用 `request/header` 还原。

| # | 创建 | 会话 ID | 标题（首条） | 主模型（按 model 事件顺序） | 用户记录 | turn | 工具调用 | vgen/regen | image | gemini | 错误 | 重试 | 子代理 |
|---|------|---------|--------------|------------------------------|-------|------|---------|-----------|-------|--------|------|------|--------|
| 1 | 11-11 23:49 | `session-3baf3ca6-0dd7-4b1a-9069-031b97de1dac` | 请你完整读 E:\Document\ClaudeDeskto | teamorouter-responses/gpt-6.1-sol → opendesign/deepseek-v4.1-flash | 33 | 19 | 682 | 0 | 0 | 0 | 1 | 3 | 0 |
| 2 | 11-12 18:50 | `session-0f6eac2a-0660-4292-983d-14846dcfb7ef` | 请你看一下这份剧本。我认为 | opencode-go-gemini/gemini-4-argon → teamorouter-gemini/gemini-4-argon | 12 | 10 | 85 | 0 | 0 | 0 | 0 | 3 | 0 |
| 3 | 11-12 21:17 | `session-463b745b-075c-413a-a8fd-060b436b37a5` | 现在来完善资产卡，其中穰明 | (inherit) teamorouter-gemini/gemini-4-argon | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 4 | 11-13 01:39 | `session-08abaa6c-96d6-4904-8075-63cb8aa4165a` | 现在来完善资产卡，其中穰明 | magpie/auto/deepseek-v4.1-flash → magpie/teamorouter/gemini-4-carbon | 7 | 2 | 22 | 0 | 0 | 0 | 0 | 0 | 0 |
| 5 | 11-13 03:47 | `session-48280ea4-a3ca-46c7-a7c0-766f02ec8b35` | 现在来完善资产卡，其中穰明 | (inherit) magpie/teamorouter/gemini-4-carbon | 1 | 1 | 3 | 0 | 0 | 0 | 0 | 0 | 5 |
| 6 | 11-13 03:53 | `86f2ff69-8335-4b5e-bc8d-c592a5c1b9a1` | Character design, female, energetic, ear | (inherit) magpie/teamorouter/gemini-4-carbon | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 7 | 11-13 03:53 | `9214a4db-9790-499b-bc96-bc2e9d8b8074` | Character design, middle-aged male, smar | (inherit) magpie/teamorouter/gemini-4-carbon | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 8 | 11-13 03:53 | `aa392910-1d43-470a-9013-390c0b4b1f52` | Professional character design, young mal | (inherit) magpie/teamorouter/gemini-4-carbon | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 9 | 11-13 03:53 | `6127b327-a7bd-427d-a8ec-3335cb6fec28` | Generate a character design based | (inherit) magpie/teamorouter/gemini-4-carbon | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 10 | 11-13 03:53 | `35eb05f7-e757-4096-8f72-5fe85526b2c9` | Professional character design, young mal | (inherit) magpie/teamorouter/gemini-4-carbon | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 11 | 11-13 03:56 | `session-3e52374e-381e-4c52-a346-a46b1a991c1d` | 现在来完善资产卡，其中穰明 | deepseek-official/deepseek-flash | 7 | 3 | 250 | 0 | 0 | 0 | 0 | 0 | 0 |
| 12 | 11-13 05:15 | `session-8ead16cd-661e-4560-b303-556fce037c97` | 现在场景卡已经做出来了，但 | magpie/teamorouter/gemini-4-carbon | 5 | 6 | 12 | 0 | 0 | 0 | 1 | 0 | 1 |
| 13 | 11-13 05:48 | `56376d5b-e1c1-43fe-b4ed-b8dd9e038307` | 请查找 1950 年代川藏公路抢修 | (inherit) magpie/teamorouter/gemini-4-carbon | 1 | 1 | 2 | 0 | 0 | 0 | 0 | 0 | 0 |
| 14 | 11-13 06:05 | `session-71b7af9a-57a3-441e-bd83-7eff23e19bea` | 现在场景卡已经做出来了，但 | magpie/opencode-go/gemini-4-argon → magpie/teamorouter/gemini-4-argon → teamorouter-gemini/gemini-4-carbon → teamorouter-gemini/gemini-4-argon | 6 | 4 | 85 | 0 | 0 | 0 | 3 | 1 | 1 |
| 15 | 11-13 06:08 | `09c280aa-8a3e-482f-80fd-21d4d8a9e3b5` | 你是一名严谨的历史与交通工 | (inherit) deepseek-official/deepseek-flash | 1 | 1 | 56 | 0 | 0 | 0 | 0 | 0 | 0 |
| 16 | 11-13 06:44 | `session-05141dcc-3e25-444b-b3af-cefa8cc7bf73` | 请你继续会话session-71b7af9a-57a3- | teamorouter-gemini/gemini-3.8-flash → teamorouter-gemini/gemini-4-carbon | 7 | 6 | 10 | 0 | 0 | 0 | 0 | 0 | 0 |
| 17 | 11-13 07:03 | `session-3e5104b4-ecf9-43df-8bea-cfd223890a00` | 现在场景卡已经做出来了，但 | teamorouter-gemini/gemini-4-argon | 1 | 1 | 1 | 0 | 0 | 0 | 1 | 0 | 0 |
| 18 | 11-13 07:04 | `session-b57d1453-ec11-4993-ab23-7d7c2a8b9d31` | 现在场景卡已经做出来了，但 | magpie/teamorouter/claude-opus-5-5 | 5 | 2 | 192 | 0 | 0 | 0 | 1 | 3 | 4 |
| 19 | 11-13 07:06 | `session-37945a1c-048f-494b-9747-b2fcdb0ff226` | 列出当前目录第一层的条目， | (inherit) teamorouter-gemini/gemini-4-argon | 1 | 1 | 2 | 0 | 0 | 0 | 0 | 0 | 0 |
| 20 | 11-13 07:06 | `session-55836155-17b8-4ee7-b239-ed107b396361` | 用 ls 列出当前目录第一层，然 | teamorouter-gemini/gemini-4-argon | 1 | 1 | 2 | 0 | 0 | 0 | 0 | 0 | 0 |
| 21 | 11-13 07:22 | `0904cd09-424e-4e85-ae63-af662a250315` | 你是史料核查员，服务于一部 | (inherit) deepseek-official/deepseek-flash | 1 | 1 | 38 | 0 | 0 | 0 | 0 | 0 | 0 |
| 22 | 11-13 07:22 | `478660b3-e714-413d-aebd-eb65c6264d73` | 你是年代道具考据员，服务于 | (inherit) deepseek-official/deepseek-flash | 1 | 1 | 9 | 0 | 0 | 0 | 0 | 0 | 0 |
| 23 | 11-13 07:23 | `97fd85d7-9363-4bd4-a485-c31500cfaca0` | 你是校史与年代考据员，服务 | (inherit) deepseek-official/deepseek-flash | 1 | 1 | 36 | 0 | 0 | 0 | 0 | 0 | 0 |
| 24 | 11-13 07:23 | `c1754590-871a-421f-aa51-ef7c4d7c0927` | 你是工程与场景考据员，服务 | (inherit) deepseek-official/deepseek-flash | 1 | 1 | 16 | 0 | 0 | 0 | 0 | 0 | 0 |
| 25 | 11-13 12:28 | `session-9d9dc49e-0e43-47a1-bda3-7fd42e292c80` | 接着这个会话做：session-b57d1453 | (inherit) deepseek-official/deepseek-flash | 2 | 2 | 152 | 0 | 0 | 0 | 0 | 0 | 0 |
| 26 | 11-13 15:26 | `session-f7787f3c-19b9-4665-8dbe-e4a02ebd2995` | 我们之前的那个片子的旁白， | (inherit) deepseek-official/deepseek-flash | 2 | 2 | 52 | 0 | 0 | 0 | 0 | 0 | 0 |
| 27 | 11-15 17:13 | `session-9e5b4806-6544-483d-a17a-0ad97f3cfaa8` | 请继续担任《探路》总导演， | magpie/codex/gpt-6.1-sol → deepseek-official/deepseek-flash | 66 | 18 | 779 | 7 | 4 | 31 | 2 | 4 | 7 |
| 28 | 11-15 17:24 | `a2dc12c7-905c-4216-bf84-9891da225fcb` | 你协助《探路》总导演进行 Mac | (inherit) magpie/auto/deepseek-v4.1-flash | 4 | 4 | 83 | 0 | 0 | 0 | 0 | 0 | 0 |
| 29 | 11-15 17:25 | `7a429f12-2f44-4444-91fa-93ad5a9d8dfe` | 请按团队任务 list/get/claim 领取 | (inherit) magpie/auto/deepseek-v4.1-flash | 3 | 1 | 106 | 0 | 0 | 0 | 0 | 0 | 0 |
| 30 | 11-15 18:30 | `session-ccc82002-21cb-411d-a3c4-b440ed944ab0` | 探路静演v2我看完了，有不少 | deepseek-official/deepseek-flash | 8 | 4 | 251 | 0 | 91 | 10 | 0 | 0 | 4 |
| 31 | 11-15 18:56 | `785bfa8f-c3e0-462b-bde0-ef09c09d77e0` | 你在 WSL 项目 /home/tengxlper/DSH_ZO | (inherit) magpie/auto/deepseek-v4.1-flash | 1 | 1 | 87 | 0 | 0 | 0 | 0 | 0 | 0 |
| 32 | 11-15 19:13 | `session-45e00082-cc5c-4d71-80df-c5b70d5bb631` | 测试Windows端的达芬奇。我已经 | (inherit) deepseek-official/deepseek-flash | 2 | 2 | 193 | 0 | 0 | 0 | 0 | 0 | 0 |
| 33 | 11-15 19:55 | `58f74479-4639-465e-bf36-b14db474421e` | 你在 WSL 项目 /home/tengxlper/DSH_ZO | (inherit) magpie/auto/deepseek-v4.1-flash | 1 | 1 | 30 | 0 | 0 | 17 | 0 | 0 | 0 |
| 34 | 11-15 19:55 | `1acf9d78-9339-4d1f-9377-a5f5a21da427` | 你在 WSL 项目 /home/tengxlper/DSH_ZO | (inherit) magpie/auto/deepseek-v4.1-flash | 1 | 1 | 39 | 0 | 0 | 11 | 0 | 0 | 0 |
| 35 | 11-15 19:55 | `6d3edcfa-0e4f-4a1b-bffc-f48527760009` | 你在 WSL 项目 /home/tengxlper/DSH_ZO | (inherit) magpie/auto/deepseek-v4.1-flash | 1 | 1 | 54 | 0 | 0 | 18 | 0 | 0 | 0 |
| 36 | 11-15 20:26 | `session-e30b52ee-ab8f-4c5d-9f3d-8ecdcc37ddc2` | session-9e5b4806-6544-483d-a17a-0ad97f3c | (inherit) deepseek-official/deepseek-flash | 3 | 2 | 135 | 0 | 0 | 0 | 0 | 0 | 0 |
| 37 | 11-15 20:51 | `5119fd9b-37bd-4d41-9015-2ab9d8299f1c` | 当前用户时间紧，停止自动生 | (inherit) magpie/auto/deepseek-v4.1-flash | 5 | 1 | 31 | 0 | 0 | 0 | 0 | 0 | 0 |
| 38 | 11-15 22:31 | `24bf9ea6-1013-4523-a21c-349f1089d4cd` | 请立即接共享任务task-5（先get/ | (inherit) magpie/auto/deepseek-v4.1-flash | 2 | 1 | 37 | 0 | 0 | 2 | 0 | 0 | 0 |
| 39 | 11-15 23:27 | `d542e866-b9c8-42fc-ab9c-7654b9359a92` | 接task-6：先get/claim，严格只写t | (inherit) magpie/auto/deepseek-v4.1-flash | 7 | 5 | 87 | 0 | 0 | 0 | 0 | 0 | 0 |
| 40 | 11-15 23:43 | `1118193a-7c19-4e8e-bdae-a9d5abe349a7` | 接task-7先get/claim。用户明确授 | (inherit) magpie/auto/deepseek-v4.1-flash | 8 | 6 | 167 | 18 | 0 | 0 | 0 | 0 | 0 |
| 41 | 11-16 00:19 | `session-d111fc54-7565-4586-bfab-0deda3e7e29a` | /home/tengxlper/DSH_ZONE/VideoStudio/Pro | (inherit) deepseek-official/deepseek-flash | 13 | 11 | 273 | 0 | 0 | 11 | 0 | 0 | 0 |
| 42 | 11-16 00:21 | `2f08495b-7b51-47e8-b696-de7ed73bfb02` | 先get/claim task-8，只负责只读核 | (inherit) magpie/auto/deepseek-v4.1-flash | 1 | 1 | 27 | 0 | 0 | 0 | 0 | 0 | 0 |
| 43 | 11-16 02:43 | `session-213b3228-c953-4935-b9fc-d240a2cd1650` | 你是探路的导演，请你继续对 | magpie/codex/gpt-6.1-sol → deepseek-official/deepseek-flash | 124 | 11 | 863 | 27 | 6 | 17 | 1 | 4 | 11 |
| 44 | 11-16 02:47 | `9c310d73-35db-40c1-b3fa-b3e2fca41a85` | 你只读调查，不修改任何既有 | (inherit) magpie/auto/deepseek-v4.1-flash | 9 | 6 | 102 | 7 | 0 | 0 | 0 | 0 | 0 |
| 45 | 11-16 03:32 | `0cc5a5c5-945e-49e4-9ceb-72237c4e36b2` | 用户已接受新周原/甘城道声音 | (inherit) magpie/auto/deepseek-v4.1-flash | 17 | 6 | 160 | 0 | 0 | 0 | 0 | 0 | 0 |
| 46 | 11-16 03:44 | `eb4d95d0-2ca8-43f3-9f49-0fb4674b4b89` | 用户已在本会话明确选择：批 | (inherit) magpie/auto/deepseek-v4.1-flash | 5 | 3 | 154 | 26 | 0 | 6 | 0 | 0 | 0 |
| 47 | 11-16 03:44 | `adfd085d-5aad-45ef-939d-4af303e09468` | 用户明确批准新增视频¥195直 | (inherit) magpie/auto/deepseek-v4.1-flash | 7 | 4 | 248 | 50 | 0 | 6 | 0 | 0 | 0 |
| 48 | 11-16 05:42 | `7d98f1c1-6a30-4486-b4ed-4f0a2dd935e6` | 请get/claim task9。只写docs/review/F | (inherit) magpie/auto/deepseek-v4.1-flash | 6 | 2 | 91 | 0 | 0 | 3 | 0 | 0 | 0 |
| 49 | 11-16 05:42 | `0d354a67-5423-48ab-9420-c66fa85a33f5` | 请get/claim task-8。用户对完整v01 | (inherit) magpie/auto/deepseek-v4.1-flash | 5 | 1 | 107 | 0 | 0 | 1 | 0 | 0 | 0 |
| 50 | 11-16 05:52 | `afa0cf1c-40f1-437d-8d1c-514e1c0ff0d9` | 请get/claim task-10直接执行已获 | (inherit) magpie/auto/deepseek-v4.1-flash | 10 | 5 | 275 | 36 | 6 | 15 | 0 | 1 | 0 |
| 51 | 11-16 07:23 | `d89a8dee-722e-4a03-8c52-cadfbaae3a57` | get/claim task14，先读AGENTS/PROJECT/ | (inherit) magpie/auto/deepseek-v4.1-flash | 7 | 4 | 235 | 0 | 2 | 8 | 0 | 0 | 0 |
| 52 | 11-16 07:23 | `a5a2ff07-30bd-4c95-9012-d2196aa4d3eb` | get/claim task11，全部项目规则先 | (inherit) magpie/auto/deepseek-v4.1-flash | 6 | 5 | 227 | 0 | 0 | 11 | 0 | 0 | 0 |
| 53 | 11-16 07:23 | `aefe4a81-841d-4d0b-915b-df34e2f3b6b2` | get/claim task13。用户认当前片头 | (inherit) magpie/auto/deepseek-v4.1-flash | 5 | 4 | 228 | 27 | 0 | 4 | 0 | 0 | 0 |
| 54 | 11-16 07:23 | `7cb9c746-3b6f-416f-ad96-c0b5d7d4d8b6` | get/claim task12。只做read-only inven | (inherit) magpie/auto/deepseek-v4.1-flash | 8 | 7 | 153 | 3 | 0 | 4 | 0 | 0 | 0 |
| 55 | 11-16 10:46 | `session-19ae8c03-885a-466e-9476-abdf58df291f` | 我们来给这个探路设计海报， | (inherit) deepseek-official/deepseek-flash | 7 | 6 | 188 | 0 | 18 | 0 | 0 | 0 | 0 |
| 56 | 11-16 11:06 | `session-78b8ee8a-92db-4049-a894-a3db68187ad3` | session-213b3228-c953-4935-b9fc-d240a2cd | magpie/codex/gpt-6.1-sol | 35 | 9 | 466 | 0 | 0 | 3 | 1 | 2 | 7 |
| 57 | 11-16 11:17 | `66209cdc-40a5-4052-adbd-642740639c7b` | 请在共享任务板读取并claim task | (inherit) magpie/auto/deepseek-v4.1-flash | 3 | 1 | 85 | 0 | 0 | 0 | 0 | 0 | 0 |
| 58 | 11-16 11:17 | `eb99a563-1f32-4cd5-a20a-3d92c0ce03d6` | 请在共享任务板读取并claim task | (inherit) magpie/auto/deepseek-v4.1-flash | 5 | 3 | 98 | 2 | 0 | 0 | 0 | 0 | 0 |
| 59 | 11-16 11:26 | `session-830fa7d5-27e4-4667-8a2f-75477906feb2` | session-19ae8c03-885a-466e-9476-abdf58df | (inherit) magpie/codex/gpt-6.1-sol | 9 | 8 | 161 | 0 | 5 | 13 | 0 | 0 | 0 |
| 60 | 11-16 11:48 | `session-51d4af5c-e97e-472f-8133-cbd1f4b42884` |  | magpie/codex/gpt-6.1-sol | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 61 | 11-16 11:50 | `1b8435f1-848c-4735-9076-32e1ddc62aef` | 请get并claim task-4，尽快核实旧 | (inherit) magpie/auto/deepseek-v4.1-flash | 3 | 1 | 39 | 0 | 0 | 0 | 0 | 0 | 0 |
| 62 | 11-16 16:47 | `55b0ec4d-4f26-4488-ab6e-edcc296cd00e` | 请get/claim task-7。用户要收尾最 | (inherit) magpie/auto/deepseek-v4.1-flash | 2 | 1 | 104 | 0 | 0 | 0 | 0 | 0 | 0 |
| 63 | 11-16 16:47 | `29f79112-f222-492a-b3b0-3468744ba28d` | 请get/claim task-6。用户现明确验 | (inherit) magpie/auto/deepseek-v4.1-flash | 1 | 1 | 92 | 0 | 0 | 0 | 0 | 0 | 0 |
| 64 | 11-16 18:15 | `0101f477-5461-4029-a0f7-745bd2d45205` | 请先读插件仓AGENTS.md，再team_ta | (inherit) magpie/auto/deepseek-v4.1-flash | 2 | 1 | 27 | 0 | 0 | 0 | 0 | 0 | 0 |
| 65 | 11-16 18:15 | `63a534ab-713c-41ca-b70b-8f7df818defd` | 请先读当前插件仓AGENTS.md，使 | (inherit) magpie/auto/deepseek-v4.1-flash | 2 | 1 | 18 | 0 | 0 | 0 | 0 | 0 | 0 |

## 读表要点

1. **主模型链不是全程**：`session-3baf3ca6`、`session-9e5b4806`、`session-213b3228` 三个大会话都中途换过主模型，归因必须按 turn 看（见 `02_MODEL_PHASES.md`）。
2. **大量 `(inherit) magpie/auto/deepseek-v4.1-flash`** 是项目 AGENTS.md 规定的「子代理一律用 magpie 的 deepseek flash」——这些是子代理会话，不是用户主会话，不能把它们的措辞当成主模型行为。
3. 第 4–8 行那种「主模型 3–5 条、真人轮 1–2 条、工具 0」的极小会话，多数是一次性的生图提示词会话或消息投递残留（例如 `aa392910…`、`86f2ff69…`、`51d4af5c…`），不承载决策。
4. 第 64/65 行是本次审计自身（`history-auditor` 与并行任务），**不计入历史**。

## 与「Codex 阶段」的关系（先给结论，细节见 02）

- 会话内 `magpie/codex/gpt-6.1-sol` = **Codex 模型挂在 DSH 里跑**（不是 Codex CLI）。
- 真正的 Codex CLI 时代（2026-11-11 之前，Windows `E:\Document\ClaudeDesktop\探路修改稿`、`E:\Videos\《探路》交付_20261107`）**没有留在本 DSH 会话库里**，只能从 DSH 首个会话的引用与交接单间接确认（见 `06_GAPS.md`）。
- 本机另有一个 `--mnt-c-Users-Tengxlper-Documents-Codex-2026-11-12-session-4b9cf203…--` 会话目录，其内容是 `DEEPSEEK FLASH TEST OK` 冒烟测试，**不是** 《探路》项目正文，故不纳入。
