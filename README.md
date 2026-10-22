# yuri · DSH IM Bot Kit

把 [DeepSeek Harness](https://github.com/deepseek-ai) 的 IM 插件（`@xmanrui/dsh-im`）改造成一个有**二次元微调音色、表情包、群聊接续、人设提示词**的 QQ / 微信机器人。

> 仓库：https://github.com/yuuki64/dsh-im-bot-kit
> 自有代码 MIT；第三方组件与素材见 [NOTICE.md](NOTICE.md)。

> 本仓库是「补丁 + 配套服务 + 配置 + 维护手册」，不包含 DSH 本体和第三方模型的二进制文件。
> 插件原始代码（`@xmanrui/dsh-im`，MIT）的修改副本保留在 `tools/im-patch/backup/`，版权归原作者。

## 目录

```text
tools/im-patch/          插件补丁集
  build-im.mjs           esbuild 重新打包 lib/index.js
  apply.mjs              把 backup/src-patched 还原进已安装插件并重建
  backup/src-patched/    修改后的插件源码（14 个文件）
  import-qq-stickers.mjs 把 QQ 收藏表情导入本地表情库
  README.md              每一轮补丁改了什么（按时间线）
tools/voice/
  gpt-sovits/server.py   GPT-SoVITS 微调音色 HTTP 服务（17862）
  f5/server.py           F5-TTS 零样本音色 HTTP 服务（17861）
configs/
  voice.example.json     音色配置样例
  stickers.example.json  表情库目录配置样例
  persona.example.md     当前生效人设
  personas/              人设卡（傲娇助手 / 小鲸鱼 / 说明）
docs/MAINTENANCE.md      维护手册（升级、回滚、排错）
scripts/rebuild.ps1      一键：还原补丁 → 重新打包 → 校验
```

## 能力

- **语音**：GPT-SoVITS 微调（大肥鱼）→ F5-TTS → Kokoro → Windows 音色的四级回退；自动拉取/停止服务，只保留当前音色占显存
- **表情包**：QQ 收藏表情导入本地库，模型用 `<dsh_im_sticker>关键词</dsh_im_sticker>` 触发
- **语音标记**：`<dsh_im_voice>要说的话</dsh_im_voice>`，任何人要求都能发
- **群聊接续**：被点名后同一个人 10 分钟内继续说话不用重复叫名字；多人同时叫互不覆盖
- **驳回/转移**：说“没跟你说话 / 别插嘴”回一句“行”并停止；@ 别人也立刻停止；其他机器人点名会回（带节流）
- **人设**：`integrations/dsh-im/persona.md` 注入所有 QQ/微信会话
- **群聊规则**：两句话上限、不泄露本机信息、推理上限 low、主人可 `/effort` 调整

## 快速开始

```powershell
# 1. 安装 DSH 与插件
#    DSH 商店或 npm 安装 @xmanrui/dsh-im，确认能收发 QQ 消息

# 2. 打补丁（会先备份/还原 src，再重建 lib/index.js）
pwsh scripts/rebuild.ps1

# 3. 重启 DSH，让新 bundle 生效
```

语音服务与模型：

- GPT-SoVITS：`D:\tools\gpt-sovits\venv` + `D:\tools\gpt-sovits\server.py`（详见维护手册）
- F5-TTS：`D:\tools\tts-gpu\server.py`
- 模型路径见各 `server.py` 顶部常量与环境变量

## 维护

完整流程见 [docs/MAINTENANCE.md](docs/MAINTENANCE.md)：插件升级后重新打补丁、语音服务启停与重训、配置项、日志位置、常见故障排查、备份与回滚。

## 免责声明

- 人设卡与参考音色来自公开社区资源（Derpyu520/qq-bridge 的 roles 等），版权归原作者；大肥鱼数据集为 CC-BY-NC，仅限非商业使用。
- 语音克隆涉及他人声音权益，请勿用于冒充、诈骗或公开商业用途。
