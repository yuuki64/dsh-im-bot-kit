# 线程窗口 / 提醒漏回 / 群聊人称 决策记录（2026-10-25）

> 触发案例：蓝莓在群里连发旅行+猫砂盆话题 → 主人问「yuri你觉得呢」→ yuri 答了 → 蓝莓接「唔诶 / 好不卫生 / [嫌弃]」→ yuri 没回；k 问「你怎么不回蓝莓」也被小时上限挡掉。
> 决策日志证据：`sender-cooldown` 把蓝莓 16:57–16:58 的三条接话全部硬跳过（根本没交给模型）；17:03 k 的提醒是 `hour-cap`。

## 已确定（grill 结论 + 理由）

1. **Q1 线程窗口定义**：机器人发言后 **120 秒**内，非机器人消息进入线程窗口（A），引用机器人的消息无条件进入（C）；**是否真的接由模型判断语义**（不硬回）。
   - 理由：既覆盖“不同发送者接话”，又避免机械抢话。
2. **Q2 冷却**：线程窗口内绕过 per-sender 冷却；窗口外冷却从 60 秒降到 **20 秒**；连发仍由 `replyCoalesce` 合并。
   - 理由：冷却是为了防刷屏，不该把“同一人的连续对话”整段吞掉。
3. **Q3 上限**：`watch.maxPerHour` 6→**12**、`maxPerDay` 30→**40**；**线程窗口/提醒漏回不受小时/日上限限制**，只受每日预算兜底。
   - 理由：聊天热时上限太容易被刷满；预算已经是硬安全阀。
4. **Q4 提醒漏回**：识别「你怎么不回 X / 为什么不理人家」类消息 → 触发一次补偿判断，且**必须结合上下文判断是不是在跟自己说话**，不是就静默。
5. **Q5 不抢话**：线程窗口内放宽“引用别人/两人对话”的限制（机器人已是参与者），但“明显两人私下聊、收尾语、换话题”仍然退出。
6. **Q6 限次**：每个发送者在线程窗口内最多触发 **2 次**判断（防刷屏/控成本），消息本身都进上下文。
7. **Q7 结束条件**：120 秒无新消息 / 收尾语 / 模型连续 2 次沉默 / 明确换话题，任一即退出。
8. **Q8 多机器人**：线程窗口只对开启 watch 的 bot 生效（当前只有 yuri）；椎名维持“被叫才回”。
9. **Q9 成本**：接受线程窗口带来的额外判断（每小时约 4~6 次 ≈ 2~3 分），仍受 3 元/天预算限制；超预算时窗口内也只回点名/引用。
10. **群聊定时消息人称**：模板主动消息按目标类型分开——群里用「大家/你们」等复数/群体人称，私聊保留原来的单人称；AI 冒泡在群聊 prompt 里也要求“对大家说、不要只对一个人、不要@人”。
    - 理由：群里发「在忙什么？」会被所有人当成只问某个人，既尴尬又容易引战。

## 实现落点

- 线程窗口状态：`#threadWindows`、`#openThreadWindow/#threadWindow/#threadTriggerAllowed/#noteThreadTrigger/#noteThreadSilence/#noteThreadReply`；
- 触发开关窗口：`#process` 群聊发送成功后、`noteOwnMessage()`（AI 冒泡）；
- 决策：`#decideInbound` 增加 `nudge` / `thread-window` 分支；`#watchDecision({force, thread})` 绕过冷却/上限；
- 提醒检测：`isNudgeMessage()`（导出可测）；
- 群聊人称：`pickProactiveText(texts, slot, random, kind)` 支持 `group/direct` 池；`behavior.json → proactive.bots.<id>.texts` 已拆分；AI 冒泡 prompt 加群聊人称说明；
- 配置：`threadWindow {enabled, seconds, maxPerSender, nudgeEnabled}`。

## 验收（重启后）

1. 群里说话 → 机器人回 → 120 秒内另一个人接话（非点名）→ 应至少被“看一眼”并判断是否接；
2. 同一人连发 3 条 → 不再被 60 秒冷却整段吞掉；
3. 有人说「你怎么不回 X」→ 应触发补偿判断（该回就补一句，不该回就静默）；
4. 群里的定时模板消息 → 人称是“大家/你们”，不是单个人；
5. `/why` 能看到新原因：`thread-window`、`nudge`、`thread-quota`。

## 回滚

- 热关线程窗口：`behavior.json → threadWindow.enabled=false`；
- 只关提醒补偿：`threadWindow.nudgeEnabled=false`；
- 模板人称：恢复 `proactive.bots.<id>.texts` 为单一数组即可（旧逻辑兼容 list）。
