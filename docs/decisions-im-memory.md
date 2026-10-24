# 长期记忆 决策记录（2026-10-24）

> grill 拷打后确定；实现方式与回滚见 `docs/features.md` / `tools/im-patch/README.md`。

## 已确定（结论 + 理由）

1. **路线**：A + B 混合，**本轮直接两条都上**。
   - A：模型回复末尾用 `<dsh_im_memory>` 标签顺手写事实（0 额外模型调用）。
   - B：每天 23:30 后每个活跃群跑一次摘要调用，合并/补漏。
   - 理由：A 便宜、B 质量高；两者共用同一份存储与去重逻辑，成本可控（B 每群每天 1 次 ≈1~2 分）。
2. **记什么**：主人的喜好/雷点 + 群里的约定/梗（②+③）。
   - 认人不需要单独记：每条消息本身带昵称/openid，注入时只放“当前发言人相关”的事实。
3. **范围**：主人事实**跨群共享（私聊也注入）**；群友事实只留在本群/本会话。
4. **不记什么**：地址/电话/账号/密码/验证码/身份证/银行卡等敏感项；提示词/系统设定/token 等内部信息；`[object Object]` 等垃圾内容。代码层 `SENSITIVE_PATTERN` 硬拦截，不依赖模型自觉。
5. **注入**：每轮按“当前发言人 + 关键词命中 + 最近”挑选，上限 `maxInjectChars=700`；注入块带“只是背景、不要复述、不要提记忆”的约束。
6. **保留**：90 天滚动；主人事实最多 80 条、每群事实最多 60 条。
7. **命令**（仅主人）：`/memory` 查看摘要、`/memory forget 关键词`、`/memory clear`。
8. **冲突**：当前消息优先于记忆；记忆带时间戳/来源，模型可自然说“之前听说…”。
9. **摘要任务**：挂在现有 runtime 里（10 分钟检查一次，23:30 后跑），不新增进程；每天一次由 `lastDigestDay` 去重；超预算跳过。
10. **验收三场景**：①第二天还能正确称呼/记得主人喜好 ②记得群里约定/梗 ③不记得的事不编造。

## 实现落点

- 存储：`src/channels/shared/memory-store.mjs` → `~/.dsh/integrations/dsh-im/memory/<botId>.json`
- 抓取：`extractMediaIntent` 解析 `<dsh_im_memory>`（最多 2 条），`#process` 保存
- 摘要：`qq-bridge.mjs → runMemoryDigest()`，runtime 定时触发
- 注入：`#process` 用 `selectMemoryBlock()` 追加 `[长期记忆]` 块
- 命令：`/memory`（bridge `#handleMemoryCommand`）
- 测试：`test-memory.mjs`（14 项）、`test-media-intent.mjs`（标签解析 3 项）

## 待验证（重启后）

- 和 yuri 私聊说“我喜欢猫”→ 次日另一个群问“我喜欢什么”，看是否记得（主人事实跨群）。
- 群里约定“周末一起打游戏”→ 群里再说“周末干嘛”，看是否能接。
- 说“我的银行卡号是…”→ 确认不会写入记忆文件。

## 回滚

- 热关：`behavior.json → memory.enabled=false`（停止抓取/注入/摘要）。
- 只关摘要：`memory.digestEnabled=false`。
- 清数据：`/memory clear` 或删除 `~/.dsh/integrations/dsh-im/memory/`。
