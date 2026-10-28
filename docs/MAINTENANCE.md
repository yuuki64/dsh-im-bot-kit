# 维护手册

这套东西由四层组成：**DSH 桌面端 → dsh-im 插件（已打补丁）→ 语音 sidecar → 配置/人设**。
升级或出问题时，先判断是哪一层。

## 0. 关键路径速查

| 东西 | 位置 |
| --- | --- |
| 已安装插件 | `<DSH_HOME>\profiles\desktop\node_modules\@xmanrui\dsh-im` |
| 插件 bundle | `<插件>\lib\index.js`（改动必须重建） |
| 补丁源文件 | `tools\im-patch\backup\src-patched\` |
| DSH 主目录 | `<DSH_HOME>`（junction → `<DSH_HOME_DATA>`） |
| 机器人工作区 | `<DSH_HOME>\im`（junction → `<BOT_WORKSPACE>`） |
| 音色配置 | `%DSH_HOME%\integrations\dsh-im\voice.json` |
| 表情库配置 | `%DSH_HOME%\integrations\dsh-im\stickers.json` |
| 表情图片库 | `%DSH_HOME%\integrations\dsh-im\stickers\` |
| 人设（生效） | `%DSH_HOME%\integrations\dsh-im\persona.md` |
| 人设库 | `%DSH_HOME%\integrations\dsh-im\personas\` |
| 群聊推理上限 | `%DSH_HOME%\integrations\dsh-im\group-reasoning.json` |
| 群消息归档 | `%DSH_HOME%\integrations\dsh-im\group-history.sqlite` |
| 私聊/群聊开关 | `%DSH_HOME%\integrations\dsh-im\switches.json`（`true`=开） |
| 开关点击页 | `http://127.0.0.1:17863/`（插件启动时自带，桌面 `IM开关.url`） |
| 全局暂停标记 | `%DSH_HOME%\integrations\dsh-im\paused`（存在=全部通道离线） |
| 语音服务日志 | `<TOOLS>\gpt-sovits\server.out.log` / `<TOOLS>\tts-gpu\server.out.log` |
| 会话日志 | `%DSH_HOME%\sessions\<workspace>\<session>\session.v4.jsonl.zstd` |

## 1. 日常维护（不需要重启）

- **换人设**：把 `personas/<名字>.md` 复制成 `persona.md`，下一条消息生效。
- **换音色（已有角色）**：QQ 里 `/voice set gsv|gpu|xiaobei`、`/voice char <名字>`、`/voice speed 0.9`。
- **加表情**：图片丢进 `stickers\`，文件名带关键词（如 `可爱_猫猫.gif`）可被 `/sticker 可爱` 命中。
- **改群规/态度/称呼**：编辑 `%DSH_HOME%\AGENTS.md`，保存即生效（IM 会话每次重建提示词时读取）。
- **调推理上限**：主人在群里 `/effort low|medium|high`（仅主人）。

### 1.1 私聊 / 群聊开关与全局暂停（都不需要重启）

- 点击：桌面 `IM开关.url` 或 <http://127.0.0.1:17863/> → 「私聊」「群聊」两个开关；关掉的一侧完全静默（不回复、不建会话）。
- **两个都关 = 机器人真正离线**（插件断开 QQ/微信连接，DSH 工作区显示离线）；打开任意一侧 5 秒内自动重连。
- 命令行（与页面写同一文件）：
  ```powershell
  node tools/im-patch/im-switch.mjs status
  node tools/im-patch/im-switch.mjs direct on|off
  node tools/im-patch/im-switch.mjs group on|off
  node tools/im-patch/im-switch.mjs all on|off
  ```
- 全局暂停（彻底停所有通道 + 停语音 sidecar，页面此时不生效）：
  ```powershell
  node tools/im-patch/im-pause.mjs on|off|status
  ```
- 排障：开关状态在 `switches.json`，暂停在 `paused`；页面打不开先确认 DSH 是否在运行、17863 是否被占用（`DSH_IM_SWITCH_PORT` 可改端口）。

## 2. 插件升级后如何重打补丁（最常见）

DSH 自动更新或重装插件后，`lib/index.js` 会变回官方版本，补丁全部失效。流程：

```powershell
# 进入本仓库
pwsh scripts/rebuild.ps1
```

脚本做三件事：

1. `node tools/im-patch/apply.mjs` — 把 `backup/src-patched/*.mjs` 还原到已安装插件的 `src/`，并恢复 `node_modules/silk-wasm`
2. `node tools/im-patch/build-im.mjs` — 用 esbuild 把 `plugin-src/host/index.mjs` + `src/channels/**` 重新打成 `lib/index.js`
3. 打印校验结果（补丁文件是否一致、bundle 是否包含关键标记）

然后**完全退出并重开 DSH**。

### 如果 apply.mjs 报错

- `找不到 ...src`：插件版本结构变了，需要先对照新版本重新确认文件清单（`apply.mjs` 里的 `FILES` 数组）。
- `silk-wasm` 缺失：`tools\im-patch\node_modules\silk-wasm` 被清理了，重新 `npm i silk-wasm` 到该目录。
- `npm`/`esbuild` 缺失：在 `tools\im-patch` 里 `npm install`（依赖清单见 package.json）。

### 校验是否生效

```powershell
# 应该能搜到这些补丁标记
Select-String -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@xmanrui\dsh-im\lib\index.js" -Pattern "dsh_im_voice","dsh_im_sticker","17862" -SimpleMatch
```

## 3. 语音服务维护

### 3.1 启动/停止

插件会在启动时读 `voice.json`，**只拉起当前音色的服务**并停掉另一个。手动操作：

```powershell
# GPT-SoVITS（17862）
<TOOLS>\gpt-sovits\venv\Scripts\python.exe <TOOLS>\gpt-sovits\server.py --port 17862 --preload

# F5-TTS（17861）
<TOOLS>\Python311\python.exe <TOOLS>\tts-gpu\server.py --port 17861 --preload

# 关闭
Invoke-RestMethod -Method Post http://127.0.0.1:17862/shutdown
```

### 3.2 常见问题

| 现象 | 处理 |
| --- | --- |
| 语音要等 20 秒 | sidecar 冷启动；插件已加启动预热，重启 DSH 即可 |
| 声音发颤/糊 | 检查 server 是否削波（`wav_bytes` 里归一化逻辑），或换参考音 |
| 没有声音 | 看 `server.out.log`；确认 `voice.json` 的 provider；确认端口健康 `GET /health` |
| 显存不够 | 确认只跑一个 sidecar；`/voice set` 切换会自动停另一个 |
| 参考音要换 | `characters\<名字>.wav` + 同名 `.txt`，`/voice char <名字>` |

### 3.3 重新微调（可选）

GPT-SoVITS 微调产物：`<TOOLS>\gpt-sovits\weights\dafeiyu_e4_s16.pth`，推理配置 `tts_infer_finetuned.yaml`。
重训大致流程（细节见 `tools/voice/gpt-sovits/README` 或上游文档）：

1. 数据放 `dataset\wav32k` + `dafeiyu.list`
2. 跑 `GPT_SoVITS\prepare_datasets\{1,2,3}-*.py`（环境变量见插件 README 历史记录）
3. `s2_train.py --config s2_dafeiyu.json`（4–8 epoch，4060 约 20–30 分钟）
4. 用 `process_ckpt.savee` 把 `logs_s2_v2\G_*.pth` 转成推理格式
5. 改 `tts_infer_finetuned.yaml` 的 `vits_weights_path`，重启 17862

## 4. 配置项

`voice.json`

```json
{ "version": 1, "provider": "gsv", "voice": "gsv", "character": "dafeiyu",
  "steps": 16, "speed": 0.9, "pitch": 15, "rate": 0 }
```

- provider：`gsv`（GPT-SoVITS）/ `f5`（F5）/ `kokoro`（本地 CPU）/ `onecore`、`sapi`（Windows）
- speed：0.5–2.0；character：`characters\<名字>.wav`

`stickers.json`

```json
{ "version": 1, "dirs": ["<DSH_HOME>/integrations/dsh-im/stickers", "<QQ_DATA>/Tencent Files/<QQ号>/nt_qq/nt_data/Emoji/emoji-related/emoji"], "maxBytes": 3145728 }
```

## 5. 群聊行为速查

- 点名：`yuri` / `小鲸鱼` / `DeepSeek` / `大肥鱼`（大肥鱼是雷点，会炸毛）
- 被点名后同一人 10 分钟内继续说话自动接，多人叫互不覆盖
- 说“没跟你说话 / 别插嘴 / 没叫你 / 关你什么事 / 别接话” → 回一句“行，那我先不打扰了。”然后停止
- @ 了别人 → 立即清空接续，不再插话
- 其他机器人点名 → 会回，带节流（15 秒/次，5 分钟最多 8 次）
- 群聊最多两句话、不泄露本机路径/工具/模型信息、推理上限默认 low（主人可改）

## 6. 日志与排错

- 语音服务：`<TOOLS>\gpt-sovits\server.out.log`、`server.err.log`
- 插件失败诊断：`%DSH_HOME%\logs\dsh-im\YYYY-MM-DD.log`（没有该目录说明没触发过失败记录）
- QQ 消息归档：`group-history.sqlite` 的 `messages` 表（能确认消息是否真的推到了机器人）
- 会话内容：`sessions\...\session.v4.jsonl.zstd`（zstd 多帧，按 `28 b5 2f fd` 切帧解码）

### 6.1 IM 会话显示在「未分组」而不是 bot-workspace

**原因**：`<DSH_HOME>\im` 是 `<BOT_WORKSPACE>` 的 junction，插件把 `<DSH_HOME>\im` 当“未分组默认 IM 工作区”，而路径比较走 realpath，于是 bot-workspace 也被判成 ungrouped；旧版 `createSession()` 在这种情况下只传 `cwd`，不传 `workspaceId`，DSH 侧栏按 `%DSH_HOME%\storages\workspace.json` 的工作区成员分组，裸 cwd 会话就落到「未分组」。

**怎么确认**：

```powershell
# 1) junction 是否指向 bot 工作区（LinkType=Junction，Target=bot-workspace）
Get-Item "$env:USERPROFILE\.dsh\im" | Select-Object LinkType,Target

# 2) 某个会话是否在工作区成员里（把 session id 换成要查的）
Select-String -Path "$env:USERPROFILE\.dsh\storages\workspace.json" -Pattern "session-xxxxxxxx" -SimpleMatch
```

**修复**：第 15 轮补丁（`tools/im-patch/README.md` 第 15 节）——`createSession()` 先查已注册工作区（realpath 匹配），命中就传 `workspaceId`。重跑 `scripts/rebuild.ps1`（或 `node tools/im-patch/apply.mjs`）并**完全退出 DSH 再打开**后，新会话直接进 bot-workspace。

**已知限制**：修复前已经建成裸 cwd 的历史会话不会被自动迁移——它们仍留在「未分组」。要归位可选 `/new` 建新会话，或关掉 DSH 后手工把 session id 加进 `workspace.json` 的 bot-workspace `sessionIds`（务必先备份；`/session` 绑定需要再补 adopt 兼容才可用）。

## 7. 备份与回滚

- 每次大改动前：`git add -A && git commit`（本仓库），另外可复制 `backup/src-patched`。
- 插件回滚：`npm i @xmanrui/dsh-im@<旧版本>` 后重新运行 `scripts/rebuild.ps1`。
- DSH 回滚：安装旧版 DSH，再按第 2 节重打补丁。
- 语音权重/模型：`<TOOLS>\gpt-sovits\` 与 `<TOOLS>\tts-gpu\` 不在仓库里，建议单独备份到移动硬盘。

## 7.1 一键备份

```powershell
# 备份到 D:\backups，生成 dsh-im-kit-<时间戳>.zip（约 100 MB）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\backup.ps1 -OutDir D:\backups
```

包含：项目文件、voice/stickers/persona 配置、人设、表情库、两个语音服务源码、微调权重（81 MB）、
参考音、数据集清单、AGENTS.md 副本。**不包含**：GPT-SoVITS/F5 的模型权重（5 GB 级，可重新下载）、
venv、node_modules。恢复时解压后按第 2 节重打补丁、按第 3 节重建环境即可。

## 8. 定期检查清单

- 每周：DSH/插件是否更新 → 更新后重跑 `scripts/rebuild.ps1` 并重启
- 每周：看一次 `server.err.log` 与 `logs\dsh-im` 有无新错误
- 每月：备份 `%DSH_HOME%\integrations\dsh-im`（配置 + 表情 + 人设）和语音权重
- 换电脑：装 DSH + 插件 → clone 本仓库 → 改路径常量 → 放回模型/表情 → 重建

## 9. 版本与发布（GitHub Releases）

仓库的 Releases **不会**因为 `git push` 自动出现：必须「打 tag → 推送 tag → 建 release」（网页或 API）。

```powershell
cd <WORKSPACE>\im-bot-kit

# 1. 打版本标签（示例 v0.2）
git tag -a v0.2 -m "v0.2"

# 2. 推提交 + 标签（token 放仓库外 `~/.dsh/secrets/github-token-im-bot-kit`；脚本自动探测本地代理）
node scripts/push-with-token.mjs main --tags

# 3. 建 release：GitHub 仓库页 → Releases → Create a new release → 选 v0.2 → 写正文 → Publish
```

Release 正文建议只写三行：这版加了什么 / 升级方式（重跑 `scripts/rebuild.ps1` + 重启 DSH）/ 已知限制。
**不要上传二进制**：模型权重、venv、node_modules 都不进仓库。

`Packages` 一栏保持为空是正常的——本项目不发布 npm 包或容器镜像，别人 clone 源码跑脚本就是正确用法。
换机器接手仍按 [NEW-SESSION.md](NEW-SESSION.md) 的开场白走。
