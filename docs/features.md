# 功能地图（Features Map）

> 本文件是项目**功能与实现方式**的单一索引：有什么功能、在哪实现、怎么配置、怎么验证、怎么回滚。
> 状态/待办放在 `交接.md`，补丁细节放在 `tools/im-patch/README.md`，关键决策放在 `docs/decisions-im-autonomy.md`。

## 1. 运行形态

| 项 | 说明 |
|---|---|
| 宿主 | DSH（desktop profile，`0.2.1-rc.2`） |
| 通道插件 | `@xmanrui/dsh-im 5.2.0` + 本地补丁集（31 个文件，见 `tools/im-patch/manifest.mjs`） |
| 机器人 | yuri（appId 1905883205）、椎名/希罗（appId 1905911599） |
| 会话工作区 | 每个 bot 独立 workspace（`integrations/dsh-qq/workspaces.json`） |
| 工具面 | 轻量 preset `qq-bot`（工具 schema 109,722 → ~1,200 tokens，-98.9%） |
| 配置热加载 | `behavior.json`（mtime 缓存，改完即生效）；人设/AGENTS 也热加载 |

## 2. 唤醒与「要不要回」

| 功能 | 规则 | 实现位置 |
|---|---|---|
| 被叫名字/别名 | `yuri / 小鲸鱼 / 鲸鱼片 / 吃鲸鱼 / DeepSeek / 大肥鱼`（CJK 子串、ASCII 单词边界） | `qq-bridge.mjs` `nameMentionPatternForNames`、`isNameMentioned` |
| 被 @ | 事件类型 / mentions / 群成员 openid / mention 昵称匹配 | `qq-bridge.mjs` `isQqMessageAddressed`、`mentionsBotByName` |
| 引用/回复 | 引用内容的正文由模型判断「是不是在跟它说话」；引用它自己的话会额外提示 | `#shouldReply`（不再直接算点名）、`#watchDecision`（quote-review）、`#process` 引用提示 |
| 接话窗口 | 点名/@ → 10 分钟；watch 触发 → 5 分钟；窗口内每条轻量判断；连续 2 条沉默/收尾语 → 退出 | `#engagementTtlMs`、`#markEngaged`、`#noteEngagementMiss`、`isClosingMessage` |
| 所有人「看一眼」 | `watch.everyone=true`：群友/主人/其他机器人都进入 watch；AI 判断是否相关 | `#watchDecision`、`#decideInbound` |
| 复读接龙 | 5 分钟内 ≥2 个不同的人复读同一句 → 跟一句（10 分钟冷却） | `isRepeatChain`、`#shouldJoinRepeat` |
| 不抢话 | 别人 @ 别人、别人之间的引用、提示词/人设讨论 → 不接 | `#shouldReply`、`PROMPT_TALK_PATTERN`、#watchDecision |
| 被点名不许装死 | 被名字/@ 叫到时追加系统提示，禁止用「不抢话」当理由沉默 | `#process` 点名提示 |
| 免打扰 | 01:00–07:00 只回点名/@；watch/复读/窗口续聊不触发 | `inQuietHours` |
| 拒绝/被叫停 | 命中「别说话/没叫你…」→ 回一句短确认后沉默 | `DISMISS_PATTERN`、`DISMISS_ACKS` |
| 决策预算 | 预算超限后只回点名/@、引用、复读 | `#watchDecision`、`cost-budget.mjs` |

## 3. 消息发送形态

| 功能 | 说明 | 实现位置 |
|---|---|---|
| 分条发送 | 超过 20 字且 ≥2 句 → 拆成 2~3 条（单句过长不硬切） | `chat-segments.mjs`、`markdown-reply.mjs` |
| 表情包 | `<dsh_im_sticker>标签</dsh_im_sticker>`：同义词扩展 + 标签匹配；自动收藏群友表情（文件名带情绪标签） | `sticker-library.mjs`、`pickSticker/expandStickerTokens/saveSticker` |
| 表情识图打标签/拒收 | `<dsh_im_sticker_tag>词</dsh_im_sticker_tag>` 补标签；`<dsh_im_sticker_reject/>` 删除不合人设的收藏 | `tagSticker/removeSticker`、`#applyStickerVerdict`、`#recentStickers` |
| 语音 | `<dsh_im_voice>短句</dsh_im_voice>`，最多 3 条连发（条间 250~700ms）；TTS 走 gsv/GPU | `extractMediaIntent`、`voice-synth.mjs`、`gsv-tts.mjs` |
| 被激将优先语音 | 命中激将词（这也不生气/你急了/敢不敢…）→ prompt 提示优先发语音 | `PROVOKE_PATTERN`、`#process` |
| 语音转文字 | 入站语音用 QQ `asr_refer_text` 转成 `[语音] …`（不再当 .amr 文件） | `qqInboundMessage` |
| 静默 | `<dsh_im_silent/>`：什么都不发；标签不是工具调用（`dsh_im_*` 工具错误被吞） | `extractMediaIntent`、`onUpdate` 虚拟标签处理 |
| 图片/文件 | 图片走多模态；主人发的图片即使无文字也进入判断 | `qqInboundMessage`、`#watchDecision` ownerImage |

## 4. 主动消息

| 功能 | 说明 | 实现位置 |
|---|---|---|
| 模板定时消息 | 07:45/11:45/17:45，±25 分钟打散，群需安静 20 分钟；每目标 120 分钟冷却、每天 3 条 | `qq-proactive.mjs`、`behavior.json → proactive` |
| 私聊目标 | `c2c:<owner openid>`，整数点发不打散，窗口 90 分钟 | 同上 |
| AI 主动冒泡 | 群安静 ≥15 分钟时，模型结合上下文自己说一句；45±20 分钟检查、概率 35%、每群每天 6 条、08–23 点 | `#generateProactiveBubble`、`qq-proactive.mjs` aiBubbles |
| 预算联动 | 超预算后冒泡自动停 | `generateProactiveBubble` 开头预算检查 |

## 5. 成本与性能

| 功能 | 说明 | 实现位置 |
|---|---|---|
| 轻量 preset | `qq-bot`：只保留搜索/提问/压缩；MCP 工具全部隐藏 | `.dsh/profiles/desktop/qq-bot-restrict.mjs`、`cordis.patch.yml` |
| 每日预算 | 每 bot 3 元/天（估算：回复 0.006、watch 0.004、冒泡 0.006 元/次） | `cost-budget.mjs`、`chargeBudget/isBudgetExhausted` |
| 推理强度 | 群里默认 low，主人 `/effort` 调整 | `group-reasoning.mjs` |
| 历史保留 | 群历史 14 天、决策日志 30 天、表情库上限 800 | `group-history-store.mjs`、`decision-log.mjs`、`sticker-library.mjs` |

## 5.1 长期记忆（2026-10-24）

| 功能 | 说明 | 实现位置 |
|---|---|---|
| 抓取（A） | 模型回复末尾 `<dsh_im_memory>事实</dsh_im_memory>`（最多 2 条，插件吞标签） | `extractMediaIntent`、`#process`、`captureFacts` |
| 每日摘要（B） | 23:30 后每个活跃群一次模型调用，提炼新事实；`lastDigestDay` 去重 | `runMemoryDigest()`、runtime `#startMemoryDigestTimer` |
| 存储 | `~/.dsh/integrations/dsh-im/memory/<botId>.json`；主人事实跨群共享、群事实按会话隔离 | `memory-store.mjs` |
| 注入 | 按“当前发言人 + 关键词命中 + 最近”选 ≤700 字，带“不要复述/不要提记忆”约束 | `selectMemoryBlock()`、`#process` |
| 隐私保护 | 地址/电话/账号/密码/提示词/系统设定硬拦截；90 天滚动；主人事实 ≤80、每群 ≤60 | `SENSITIVE_PATTERN`、`pruneMemory` |
| 命令（主人） | `/memory` 查看、`/memory forget 关键词`、`/memory clear` | `#handleMemoryCommand` |
| 测试 | `test-memory.mjs`（14 项）+ 标签解析 3 项 | `tools/im-patch/test-memory.mjs` |

## 6. 可观测与排障

| 功能 | 说明 | 实现位置 |
|---|---|---|
| 决策日志 | 每条群消息的 reply/watch/repeat/skip/silent + 原因，jsonl 按天 | `decision-log.mjs`、`#logDecision/#logOutcome` |
| `/why [N]` | 主人查最近 N 条判定 + 今日估算花费 | `#handleWhyCommand` |
| `/status` `/new` `/compact` 等 | 内置命令 | 上游 dsh-im + 补丁 |
| 构建校验 | `apply.mjs` / `verify-build.mjs`（源码/产物/进程三方一致） | `tools/im-patch/*.mjs` |
| 测试 | 19 个 `test-*.mjs` 离线测试 | `tools/im-patch/test-*.mjs` |

## 7. 权限与安全

| 功能 | 说明 | 实现位置 |
|---|---|---|
| 主人识别 | 私聊 openid；群聊只认 `<dsh_im_source>` 的 senderId | `AGENTS.md`、`isOwnerSender` |
| 群权限 | 可聊天、查公开资料；文件/设备/账号一律拒绝 | 人设卡 + AGENTS.md |
| 提示词保护 | 聊提示词/人设时静默；群里不承认也不否认 | `PROMPT_TALK_PATTERN` + prompt 规则 |
| 工具裁剪 | 机器人会话看不到本地/MCP 工具 | qq-bot preset + `tools.restrict({allow:[]})` |
| 双开关 | 私聊/群聊独立开关，热生效（17863 页面/文件） | `im-switch.mjs` |
| 总暂停 | `paused` 标记文件，断开通道 | `im-pause.mjs` |

## 8. 配置文件索引

| 文件 | 内容 | 是否热加载 |
|---|---|---|
| `~/.dsh/integrations/dsh-im/behavior.json` | 分条/表情/主动消息/预算/watch/接话窗口/决策日志 | 是（mtime） |
| `~/.dsh/integrations/dsh-im/bots/<botId>/bot.json` | 名字/别名/主人 openid/备注 | 否（启动时） |
| `~/.dsh/integrations/dsh-im/bots/<botId>/persona.md` | 人设卡 | 是 |
| `~/.dsh/integrations/dsh-im/persona.md`（yuri） | 全局人设 | 是 |
| `~/.dsh/AGENTS.md` | 全局协作规则（IM 段） | 是 |
| `~/.dsh/profiles/desktop/cordis.patch.yml` | qq-bot preset 行、MCP 行 | 否（重启） |
| `~/.dsh/profiles/desktop/qq-bot-restrict.mjs` | 工具裁剪插件 | 否（重启） |
| `~/.dsh/integrations/dsh-im/switches.json` | 私聊/群聊开关 | 是 |
| `~/.dsh/integrations/dsh-im/proactive-state.json` | 主动消息状态 | 插件写 |
| `~/.dsh/integrations/dsh-im/cost-budget.json` | 每日预算计数 | 插件写 |
| `~/.dsh/integrations/dsh-im/decision-log/` | 决策日志（30 天） | 插件写 |
| `~/.dsh/integrations/dsh-im/memory/<botId>.json` | 长期记忆（90 天；主人事实跨群） | 插件写 |

## 9. 已知限制

- 群 @ 的识别依赖平台给的 mention 结构；认不出时会写一条 warn 诊断（`logs/dsh-im`）。
- `#botTexts`（引用识别内存态）重启后清空——现在引用走模型判断兜底。
- 群历史只有机器人实际收到的消息；未被投递的消息无法回忆。
- 群聊「安静 20 分钟」才发模板主动消息；群热闹时不会发（防打扰）。
- 表情标签依赖消息文字/识图判断，推断不出时标 `随机`。
- AI 冒泡与 watch 都会消耗 token，受每日 3 元预算硬限制。

## 10. 回滚速查

| 想关掉 | 操作 |
|---|---|
| 所有主动接话 | `behavior.json → watch.enabled=false` |
| 所有人模式 | `watch.everyone=false`（只保留主人放宽） |
| AI 冒泡 | `proactive.aiBubbles.enabled=false` |
| 模板主动消息 | `proactive.enabled=false` |
| 预算限制 | `budget.dailyLimitCny=0`（0=不限） |
| 决策日志 | `decisionLog.enabled=false` |
| 长期记忆 | `memory.enabled=false`（热生效）；清数据用 `/memory clear` |
| 工具裁剪 | 跑 `回滚-qq-bot-preset.bat` 并重启 |
| 整个补丁集 | git tag `backup-before-engagement-20261024` / `manual-backup-20261024-2037.zip` |

