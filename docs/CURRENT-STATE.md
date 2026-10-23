# 当前状态（唯一入口）

> 最后核验：2026-10-23（Asia/Shanghai）
>
> 本文件只讲**当前事实**。每次改动的历史记录在 [`tools/im-patch/README.md`](../tools/im-patch/README.md)，那里是当时的实验与说明，**不要当现状读**。
> 下面的自动块由 `node tools/im-patch/status.mjs --doc docs/CURRENT-STATE.md --write` 生成：版本号、文件数、哈希都来自代码清单与实测，不手抄。

## 一句话现状

本机跑的是 `@xmanrui/dsh-im` 5.2.0 + 22 个文件的本地补丁集（引用图片、QQ 语音、表情包、私聊/群聊双开关、群聊接续、人设注入、微信出站标签清理等）。产物 `lib/index.js` 由 `tools/im-patch/build-im.mjs` 重新打包；QQ 行为冻结，维护阶段没有新增 QQ 功能。

<!-- dsh-im-status:begin -->
<!-- 由 node tools/im-patch/status.mjs --doc 生成于 2026-10-23T14:26:26.321Z；数字来自代码清单与实测，不要手改 -->

| 项 | 实测值 |
| --- | --- |
| 上游版本 | @xmanrui/dsh-im 5.2.0（补丁集适配 5.2.0） |
| 补丁文件数 | 24（由 tools/im-patch/manifest.mjs 生成） |
| 构建基线 | build · 2026-10-23T14:13:44.007Z（证据来自本机权威目录，不在本副本内） |
| 构建输入 | 341 个源文件 · sha256 5eb1cfcb494dc255… |
| 产物 bundle | 9,101,625 B · sha256 7af406b1475993d7… |
| 核对结论 | `OK`（`node tools/im-patch/verify-build.mjs`） |
| 运行实例 | 已确认：进程启动时间晚于产物 mtime，加载的就是该 bundle |
| 通道开关 | 私聊=开 群聊=开 |
| 最后核验 | 2026-10-23 |

<!-- dsh-im-status:end -->

## 版本适配范围

- 补丁集只对 `@xmanrui/dsh-im@5.2.0` 有效。版本不符时 `apply.mjs` 默认拒绝；`--force` 等于把补丁文件**降级回 5.2.0**，不是升级方案。
- 跨版本升级的正确顺序：用 `backup/src-orig` 与新版本源码对照重新推导补丁 → `apply` → `build` → 完全退出 DSH 再打开 → `verify-build.mjs`。

## 权威位置（以本地为准）

| 对象 | 位置 | 说明 |
| --- | --- | --- |
| 权威补丁 | `<WORKSPACE>\tools\im-patch` | 真身；`backup/src-patched/` 是补丁源码，`manifest.mjs` 是唯一文件清单 |
| 已安装插件 | `<DSH_HOME>\profiles\desktop\node_modules\@xmanrui\dsh-im` | 实际运行的是 `lib\index.js` |
| 开源镜像 | `<WORKSPACE>\im-bot-kit`（GitHub `yuuki64/dsh-im-bot-kit`） | 副本，可能落后；只单向从权威同步 |
| DSH 行为规则 | `<DSH_HOME>\AGENTS.md` | 人设/群聊/权限的**提示词层**规则，不等于代码强制 |

## 有效构建与恢复入口

```powershell
cd "<WORKSPACE>\tools\im-patch"
node apply.mjs --check     # 只看：22 个补丁文件是否还在安装目录里
node apply.mjs             # 恢复源码 + 补 silk-wasm + 重新打包（之后必须完全退出 DSH 再打开）
node build-im.mjs          # 只重新打包，并写 build-manifest.json（构建证据）
node build-im.mjs --adopt  # 产物已存在但没有清单时：先比哈希，只建立基线，不覆盖产物
node verify-build.mjs      # 四道门 + 明确退出码（见下）
node status.mjs            # 当前状态（源码/产物/运行实例/开关）
```

`verify-build.mjs` 退出码：`0` OK、`2` 版本不符、`3` 未建立基线、`4` 源码漂移、`5` 产物漂移、`6` 产物改了没重启、`7` 运行实例未确认、`8` 清单损坏、`9` 权威补丁被改。

回滚：

- 只回滚运行时：把 `backup\lib-index.js.orig` 复制回插件 `lib\index.js`，重启 DSH；
- 回滚源码：`apply.mjs` 每次会把改动前的文件存到 `backup\pre-apply-<时间戳>\`；
- 上游原包：`pristine\package`（完整的 5.2.0 解包，含 lib/src）。

## 功能限制（当前）

- 微信：平台侧没有语音/表情包投递接口。出站前会清理标签——`<dsh_im_voice>` 变普通文本、`<dsh_im_sticker>` 整段丢弃、只有标签时不发空消息。
- QQ 语音：中文音色链（GPT-SoVITS 微调 → F5-TTS → Kokoro → Windows SAPI），`/voice` 仅主人可用。
- 引用图片：只对"当初推给机器人的图"有效，缓存 48 条 / 48 MB / 6 小时。
- 群聊接续：按发送者的时间窗口（约 8–10 分钟）维护，不是完整的语义"读空气"。
- 群里没 @ 机器人的消息不投递（QQ 平台行为，只能进群归档）。

## 已验证 / 未验证

已验证（2026-10-23 本机实测）：

- 补丁源码与安装目录逐字节一致（期望 22 个文件，`node apply.mjs --check`）；
- 从当前源码重新打包的结果与线上 `lib/index.js` **逐字节相同**（确定性构建，`node build-im.mjs --out <临时文件>` 后比 sha256）；
- 构建基线已建立（`mode=adopt`），`verify-build.mjs` 四道门全部通过：补丁清单 / 源码已同步 / 产物已构建 / 进程已重启；
- 镜像与权威补丁目录逐字节一致（37 个文件，`node scripts/check-mirror-sync.mjs`，`--strict-eol` 也通过）；另用临时副本删 1 个文件、改 1 个文件做真实负例，能准确报「缺文件 + 内容差异」且不动权威目录；
- 微信出站标签清理回归 10 项通过（`node tools/im-patch/test-weixin-outbound-tags.mjs`）；
- 私聊/群聊双开关自测、会话工作区归属自测通过（`test-im-switch.mjs`、`test-workspace-grouping.mjs`）。

未验证 / 不在本轮范围：

- **真机端到端**：QQ 发语音、回复图片、微信标签清理的实际投递效果——需要主人指定的测试会话与明确授权，本维护阶段没有向任何会话发测试消息；
- 普通群成员的工具硬隔离：只做了只读代码审计（见下节），结论不等于"已验证安全"；
- 跨版本升级路径（本轮不升级插件）。

## 通道与暂停状态

- 私聊/群聊开关和全局暂停状态以运行时文件为准：`<DSH_HOME>\integrations\dsh-im\switches.json`、`paused`；一条命令看清：`node tools/im-patch/im-switch.mjs status`。
- 本轮维护**没有改动开关状态**，也没有启动语音服务。

## 已知本机运行期错误（未处理，记录备查）

- 2026-10-23 13:57 出现一条 QQ 群状态写入失败：`STATE_WRITE_FAILED / EPERM`（`<DSH_HOME>\logs\dsh-im\2026-10-23.log`）。属于状态落盘权限问题，不影响本轮补丁一致性结论，但也**没有**在本轮修复。

## 多机器人：每个 bot 独立的人设 / 唤醒词 / 音色（2026-10-23）

- 目录约定：`<DSH_HOME>\integrations\dsh-im\bots\<botId>\` 放 `bot.json`（名字 + 别名 = 唤醒词 + 主人 openid）、`persona.md`、`voice.json`；**没有这个目录就走全局**，所以老机器人行为不变（yuri 就是走全局）。
- 加新机器人：`node tools/im-patch/bot-profile.mjs init <botId> --name 名字 --aliases 名字,别名2 --persona <人设卡> --voice gsv --character <角色>`，然后 `node tools/im-patch/bot-profile.mjs check`。改配置不用重启。
- 当前分布：`qq_9cc39e2…`（yuri）= 全局小鲸鱼人设 + `gsv/dafeiyu`，别名 yuri/小鲸鱼/DeepSeek；`qq_1a3b9ed…` = 名字「椎名」/别名 椎名、希罗、二阶堂希罗、**hiro**，人设暂用 `傲娇助手` 卡，音色 `gsv/shiro`（**endpoint http://127.0.0.1:17864**）；`qq_a9a550…` = 未配置，走全局。
- **希罗音色现状**：17864 跑 **v2ProPlus 微调**（用户提供的 `hiro-e10.ckpt` + `hiro_e8_s2184.pth`，依赖 sv 说话人模型已补齐），与 17862（大肥鱼微调）并存。实测同句中位 f0：大肥鱼 263.4 Hz / 希罗微调 207.8 Hz；微调实例 15 字约 2.8 秒。样本 `D:\tools\gpt-sovits\samples\hiro-compare-{dafeiyu,hiro-finetuned}.wav`。重启后用 `D:\tools\gpt-sovits\start-hiro-tts.bat` 拉起（首次推理有几十秒 CUDA 图编译）。
- **未完成**：无（v2ProPlus 微调已接通）；如需换参考音/重训，数据集仍在 `C:\Users\yuuki\OneDrive\桌面\hiro`。
- **姐妹关系**：写在两个 bot 的 `bot.json` 的 `note` 里（随 `<dsh_im_identity>` 注入），不写进人设卡——yuri 知道 hiro 是亲姐姐，hiro 知道 yuri 是亲妹妹。
- 微信：仍只有全局人设/音色（微信通道没有多 bot 概念，本轮不动）。
- **唤醒词（2026-10-23 修）**：群里不 @ 也能按名字唤醒，匹配器按 `bots/<botId>/bot.json` 的 name+aliases 生成（ASCII 整词、中文子串）。hiro 认 `椎名/希罗/二阶堂希罗/hiro`，yuri 认 `yuri/小鲸鱼/DeepSeek/大肥鱼`；有 botId 但没 profile 的机器人只认 @。回归 `node tools/im-patch/test-bot-wake.mjs`。
- **hiro 人设卡（2026-10-23）**：已换成**精简对话版**（约 900 字符，装到 `bots/qq_1a3b9ed…/persona.md`，另存 `personas/希罗.md`）：只输出角色说的话、不写动作/心理/旁白、1~3 句、不写小作文；保留优等生/正义感/防剧透/yuri 是妹妹。原长卡仍在 OneDrive 桌面，可换回。
- **额外音色按需启动（2026-10-23）**：`D:\tools\gpt-sovits\instances.json` 注册端点（17864 → `tts_infer_hiro.yaml`）。插件只在该 bot 真正发语音时才 spawn 对应实例，重启后不预占显存；实测冷启动约 26 秒。当前 17864 为停止状态。
- **推理等级（2026-10-23）**：所有 IM 会话默认 **low**（`workspace-session.mjs` 在绑定后执行一次 `/reasoning low`；群聊跟随 `/effort` 上限，默认也 low）。每进程每会话一次，重启后旧会话也会在首条消息落回 low。
- **表情包频率（2026-10-23）**：`AGENTS.md` + 两个 bot 人设卡都加了「不用等开口、平均每 2~4 条回复带一张、情绪明显优先、不连续两条」；表情库 465 个文件。纯提示词，立即生效。
- **非主人刷屏静默（2026-10-23）**：2 分钟内重复同一句、10 分钟内第 3 次、或 1 分钟超 8 条，直接不回（主人不受限）；DSH_IM_SPAM_GUARD=0 可临时关闭。回归 `node tools/im-patch/test-spam-guard.mjs`。
- **表情包频率（2026-10-23 调整）**：从每 2~4 条一张下调到 **平均每 15~20 条**带一张。- **群消息投递差异（2026-10-23 实测，平台限制）**：老群（`353D504C…`）会把群内全部消息推给机器人，名字唤醒可用；新群（`38123AF7…`）只推 @ 到机器人的消息，非 @ 的「椎名」根本到不了插件（椎名侧只收到 1 条 @ 消息，对比老群 75 条）。新群要让它回就得每次 @，或由群主给该机器人开「接收群消息」权限。
- **已知运行期错误（未修）**：`STATE_WRITE_FAILED / EPERM` 偶发（22:24、22:28 各一次，scope=group），状态落盘失败；目前未影响回复，但会在会话绑定环节埋隐患。- **主人称呼注入（2026-10-23）**：`bot.json` 的 `ownerName`（当前两个 bot 都是 yuuki）会随身份块注入——「主人是 yuuki，openid …」，并写明 senderId 判定方法与称呼（yuuki／主人）。修复椎名问「还没告诉我该怎么称呼」。
- **推理默认 low（2026-10-23 修）**：之前用 `session.executeCommand('/reasoning low')`，该命令是插件层的、Host 不认，静默失败所以 GUI 仍显示 High。现改为 Host 模型 API（`session.models()` → `session.selectModel({reasoningEffort})`），不支持 low 的模型保持原样；每会话每进程一次。回归 `node tools/im-patch/test-reasoning-default.mjs`。GUI 里你自己开的会话不受影响。
- **回复长度（2026-10-23）**：`AGENTS.md` 与两个 bot 的 note 都写了「回复要短、不说小作文」；默认 1~3 句，私聊最多 5 句。

## 权限边界（只读审计，2026-10-23）

口径：只读代码追踪 + 只读查看运行状态，**未修改任何代码或配置、未重启、未发消息**。结论是「**部分隔离**」，不能描述成「已验证隔离」。

| 层 | 结论 | 最小证据 |
| --- | --- | --- |
| 入站双开关 / 访问策略 / 指令权限 | 已验证隔离（当前落盘策略下） | `channels/shared/inbound-access.mjs:15-47`、`access-policy.mjs:200-208`、`channels/qq/qq-bridge.mjs:924-927,1466-1492` |
| 会话权限（sandbox / approval） | 插件层未隔离 | 插件只传 `workspaceId`/`agentPreset`，不传 `permissionMode`/`autoApprove`/工具白名单（`harness-client.mjs:1368-1393,2058-2066`）；群会话实机为 `standard` + `workspace-write/ask` |
| 工具集合 | 插件层未隔离 | 群聊与私聊共用同一个 bot 级 `agentPreset`（`bot-workspace-store.mjs:1968-1975`）；群会话上下文里 433 个工具，含 `read/write/edit/pwsh/terminal_*` 与 CUA 桌面工具 |
| 群内审批 | 未隔离（可自批） | 审批只校验"发起者"不校验主人（`harness-approval.mjs:193-196,566-578`；`qq-bridge.mjs:2277-2283`） |

普通群成员**能**做的（代码层）：普通聊天、`/sticker`、自然语言要求语音/表情。被代码硬拒绝的：`/voice`、`/effort`、群内 `/batch`、以及 `defaultCanExecuteCommands=false` 下的所有 shared local command（`/permission`、`/preset`、`/workspace`、`/clear`、`/stop` 等）。

`AGENTS.md` 里的「群里最多两句话」「不透露本机信息」「群聊零工具」「一律拒绝」**都是提示词层，没有代码强制**（QQ 出站不做句数截断、不做路径脱敏；微信桥有标签清理，QQ 桥没有对应实现）。

已知风险与触发条件（本轮**未修复**，只记录最小修复方向）：

| # | 风险 | 触发条件 | 最小修复方向 |
| --- | --- | --- | --- |
| R1 | 群成员可以自己批自己的工具审批 | 群成员 prompt 让模型发起需审批的工具调用，该成员随后在群里回「批准」 | 群内审批改为仅主人/privileged 可批 |
| R2 | QQ 群访问策略的**代码默认值**是 `open` + 指令允许，当前 `false` 只是落盘配置 | 策略条目被删除/重建、新建 bot | 群 seed 改为 `defaultCanExecuteCommands:false` |
| R3 | `accessPolicy` provider 缺失时 fail-open | 旧 host、初始化异常 | 缺策略时拒绝并记录，而不是放开 |
| R4 | 群附件会被写进会话工作区，与「读完不落盘」的提示词矛盾 | 任何被处理的群附件 | 群消息不落盘，或写入一次性目录并在回合结束清理 |
| R5 | 群内成员共用一个会话上下文 | 同一群多人对话 | 明确产品边界，或按发送者分会话 |
| R6 | 手动绑定 bot 时 owner 回落为 `*` | 无历史 owner 的手动绑定 | 绑定必须要求显式 owner openid |

结论：普通群成员的**指令**被代码挡住；**文件/Shell/桌面/凭据/外发**没有被插件代码隔离，只靠提示词 + `workspace-write/ask` + 可被发起者自批的审批。要把「群聊零工具」从提示词升级为代码强制，最小改动是「群内审批仅主人 + 群指令 seed 默认拒绝」，更强的是给群会话单独下发受限 agent preset（当前插件不支持按会话过滤工具）。
