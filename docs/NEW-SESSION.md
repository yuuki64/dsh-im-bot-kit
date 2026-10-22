# 新会话开场白（接手这个项目）

新开一个 DSH 会话继续维护时，把下面「复制这段」整段粘进去，末尾补一句具体任务就行。
**不需要贴 token、日志、截图**——文档和命令都在本机，让新会话自己读。
凭据只放本机（例如 `<WORKSPACE>/im-bot-kit/.github-token`，已在 `.gitignore` 里），不要进聊天。

## 复制这段

```text
项目：DSH QQ/微信机器人（@xmanrui/dsh-im 5.2.0 本地补丁集 + 语音服务 + 配置）
工作区：<WORKSPACE>

先按顺序读，再动手：
1. <WORKSPACE>\tools\im-patch\README.md
   （补丁集全记录，开头「接手速查」有全部路径 / 恢复 / 开关命令）
2. <DSH_HOME>\AGENTS.md
   （重点「IM 机器双开关」「群聊与第三方请求边界」两章，是行为规则）
3. 需要运行数据时再读：<DSH_HOME>\integrations\dsh-im\
   （switches.json / paused / voice.json / persona.md / group-history.sqlite）
   和 <DSH_HOME>\integrations\dsh-qq\
4. GitHub 镜像 https://github.com/yuuki64/dsh-im-bot-kit 只作参考，可能落后；
   排障一律以第 1、2 条和已安装插件为准。

铁律：
- 插件装在 <DSH_HOME>\profiles\desktop\node_modules\@xmanrui\dsh-im，跑的是 lib\index.js；
  改了 src/ 或 plugin-src/ 必须重新打包（node tools/im-patch/apply.mjs 或 build-im.mjs）
  并重启 DSH 才生效。重启前不要说"已生效"。
- 开关：node tools/im-patch/im-switch.mjs status | direct on|off | group on|off | all on|off
  页面 http://127.0.0.1:17863/；全局暂停：node tools/im-patch/im-pause.mjs on|off|status
- 改完先 node tools/im-patch/test-im-switch.mjs 或 node --check，再打包重启。
- 任何 token / 密码 / Cookie 不要写进仓库、不要出现在回复里。
- 读不到或没验证过的东西必须明说，不许装懂。

开工前先跑一次基线自检，把结果贴给我：
node tools/im-patch/im-switch.mjs status
node tools/im-patch/apply.mjs --check

我这次要做的事：<在这里写一句>
```

## 极简版

```text
维护 <WORKSPACE> 的 DSH QQ/微信机器人项目：先读 tools/im-patch/README.md 的「接手速查」
和 <DSH_HOME>\AGENTS.md 的「IM 机器双开关」「群聊与第三方请求边界」两章；
改 src/plugin-src 后必须 apply/build + 重启 DSH 才算生效。任务：<一句话>
```

## 为什么要给这几样

| 给什么 | 为什么 |
| --- | --- |
| 项目名 + 工作区路径 | 新窗口默认工作区可能不同；给绝对路径最稳 |
| 两个必读文件 | `tools/im-patch/README.md` 是唯一完整的改动记录；`AGENTS.md` 是行为规则唯一来源 |
| 「镜像可能落后」 | 防止它照 GitHub 上的旧副本改，改完白干 |
| 「改 src 必须重新打包 + 重启」 | 最常见的坑：只改源码不打包，看起来改了其实没生效 |
| 开关 / 暂停命令 | 排障第一步就是确认是不是自己关了通道 |
| 两条基线自检 | 先确认"当前装的是什么、和备份是否一致"，避免拿着过期认知干活 |

## 不需要给的信息

- 历史对话、截图、日志：让它自己读文件 / 跑命令。
- 当前私聊/群聊开关状态：一条 `im-switch.mjs status` 就有。
- 语音模型细节：`tools/im-patch/README.md` 第 7–12 节全有（音色、延迟、许可限制）。
