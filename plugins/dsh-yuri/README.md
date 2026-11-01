# dsh-yuri

最小闭环插件：QQ 群里 @ 机器人 → 受限 Agent 生成文字 → 回发群聊（只做群 @ 文本，无工具、无人设、无语音）。

安装：把本目录用 `dsh plugin --profile <profile> add <本目录>` 装进 profile，再把 `config.example.json` 复制成 `<DSH_HOME>/integrations/dsh-yuri/config.json` 并填好本机值（`enabled: true` 才会生效）。

⚠️ 警告：`enabled: true` 一旦跑起来，插件会通过 `consumeInbound` 把该机器人写成 `external-consumer` 模式，**这个模式不会自动回滚**——卸载插件、重启 DSH 都不恢复；要恢复必须手工删掉 `<DSH_HOME>/integrations/dsh-qq/config.json` 里该机器人的 `consumerMode` 字段（或删掉机器人重新绑定），否则该机器人会一直"在线但不回复"。
