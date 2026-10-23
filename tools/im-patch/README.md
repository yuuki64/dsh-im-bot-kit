# dsh-im 5.2.0 本地补丁：引用图片 + QQ 语音

> 本补丁集合并了两个会话的成果：
> - **引用消息取图（群归档）**：`bot-workspace` 会话完成 —— `group-history-store.mjs` 的
>   `imagesForPlatformMessage()` + `image-prompt.mjs` 导出 `DEFAULT_MAX_IMAGES`，本补丁集原样收录。
> - **引用消息取图（私聊缓存 / 微信）+ QQ 语音**：本会话新增，见下。
>
> `bot-session-im-patches`（原 `bot-workspace\im-patches\`，2026-10-22 已归档到 `reference/`）那套只改 `src/`、不重新打包，**单独使用不会生效**，已由本目录的
> `apply.mjs` 取代（保留作历史参考）。

对象：`@xmanrui/dsh-im` 5.2.0（安装位置 `<DSH_HOME>\profiles\desktop\node_modules\@xmanrui\dsh-im`）
补丁日期：2026-10-22
状态：**代码已改、已重新打包、已离线自测**；生效需要重启 DSH（插件在启动时加载 `lib/index.js`）。

## 接手速查（新对话从这里开始，2026-10-22 21:57 更新）

- **权威文件（最新，先读这两个）**：
  1. 本文件 —— 补丁集每一轮改了什么、怎么恢复、怎么排查；
  2. `<DSH_HOME>\AGENTS.md` 里的「IM 机器双开关」和「群聊与第三方请求边界」章节 —— 行为规则（人设、权限、语音/表情规则都在这）。
- **代码 vs 运行数据**：代码在本目录 + 已安装插件；运行数据在 `<DSH_HOME>\integrations\dsh-im\`（`switches.json` / `paused` / `voice.json` / `persona.md` / `group-history.sqlite` / `stickers.json`），QQ 凭据与工作区映射在 `integrations\dsh-qq\`。
- **插件安装位置**：`<DSH_HOME>\profiles\desktop\node_modules\@xmanrui\dsh-im`；运行的是 `lib\index.js`，改了 `src/` 或 `plugin-src/` 必须重新打包并重启 DSH。
- **开源镜像**：`<WORKSPACE>\im-bot-kit`（= <https://github.com/yuuki64/dsh-im-bot-kit>），是本目录 + 语音服务 + 配置 + 维护手册的副本。**镜像可能落后于本目录，排障一律以本目录和实际安装的插件为准**；镜像由 `im-bot-kit` 仓库单独提交/推送。
- **路径占位符**：文中 `<DSH_HOME>`（= `C:\Users\<你>\.dsh`）、`<WORKSPACE>`、`<BOT_WORKSPACE>`、`<TOOLS>`（语音/模型安装目录，如 `D:\tools`）、`<QQ_DATA>`（QQ 数据目录）、`<DSH_HOME_DATA>`、`<DESKTOP>` 都是占位符，按自己机器的实际路径替换。
- **日常操作**：
  - 私聊/群聊开关：<http://127.0.0.1:17863/>（桌面 `IM开关.url`）；命令行 `node im-switch.mjs status | direct on|off | group on|off | all on|off`；
  - 全局暂停：`node im-pause.mjs on|off|status`；
  - 当前状态以 `switches.json` / `paused` 文件为准，用 `node im-switch.mjs status` 一条命令看清。
- **会话为什么显示在「未分组」**：`<DSH_HOME>\im` 是 bot-workspace 的 junction，插件曾因此把新会话建成裸 cwd、不进工作区注册表；第 15 轮已修，见第 15 节。

## 0. 一句话恢复

插件重装/升级后补丁被冲掉时：

```powershell
cd "<WORKSPACE>\tools\im-patch"
node apply.mjs --check   # 先看缺什么
node apply.mjs           # 按 manifest.mjs 的清单复制补丁 + 补 silk-wasm + 重新打包
```

然后完全退出 DSH 再打开。注意补丁集按 5.2.0 的文件内容制作，插件版本不是 5.2.0 时脚本会拒绝（`--force` 等于把那几个文件降级，不推荐）。

## 当前状态与核对命令（唯一入口，2026-10-23 建立）

**当前事实只看这三处，不要从下面各轮历史记录里反推现状**（那些是当时的实验与改动说明）：

1. **状态文档**：`<WORKSPACE>\im-bot-kit\docs\CURRENT-STATE.md` —— 适配版本、权威位置、恢复入口、功能限制、已验证/未验证项、最后核验日期；
2. **实测命令**（文件数/哈希都从 `manifest.mjs` 与构建清单生成，不在文档里手抄）：

```powershell
cd "<WORKSPACE>\tools\im-patch"
node status.mjs                       # 在跑的是哪份源码/产物、通道开关、核对结论
node verify-build.mjs                 # 四道门：补丁清单 / 源码已同步 / 产物已构建 / 进程已重启
node verify-build.mjs --self-test     # 用临时副本跑负例，不碰生产目录
node test-weixin-outbound-tags.mjs    # 微信出站标签清理回归（语音转文本、表情标签丢弃、只有标签不空投递）
node build-im.mjs --adopt             # 旧安装没有清单时：先比哈希、只建基线，不覆盖产物
```

3. `verify-build.mjs` 退出码：`0` OK、`2` 版本不符、`3` 未建立基线、`4` 源码漂移、`5` 产物漂移、`6` 产物改了没重启、`7` 运行实例未确认、`8` 清单损坏、`9` 权威补丁被改。

**构建证据的口径（别夸大）**：`build-manifest.json` 记录上游版本、补丁逐文件哈希、`plugin-src/host + src` 全树哈希、产物哈希、Node/esbuild 版本与锁文件哈希，能证明「源码 → 产物」；它**不**覆盖 profile 里以 external 方式留在产物外的运行期依赖，也**不**证明运行行为。运行时是否加载了这份产物，看 `进程已重启` 这道门（找监听开关页端口的进程，比启动时间与产物 mtime）。


---

## 1. 改了什么

### 1.1 引用（回复）消息里的图片/文件 → 现在能看到了

问题：QQ/微信的引用消息只带"作者 + 文字 + 附件名"，没有下载地址；旧代码在 QQ 群聊里只会去查群归档，私聊完全拿不到，微信也拿不到。

改动：

| 文件 | 内容 |
| --- | --- |
| `src/channels/shared/quoted-media.mjs`（新增） | 进程内图片缓存（按会话 + 平台消息 id 索引，48 条 / 48 MB / 6 小时 TTL）。**不额外下载**：图片本来就要给模型，缓存顺手截留同一份字节。 |
| `src/channels/qq/qq-bridge.mjs` | ① 入站图片套上缓存包装；② 引用图片先查群归档、再查缓存，命中后以 `引用-xxx` 的名字并入本次 prompt 的图片列表（20 张上限内）。 |
| `src/channels/weixin/weixin-api.mjs` | 引用快照里如果还带媒体 key，直接生成可下载的图片源；没有 key 时退回缓存。 |
| `src/channels/weixin/weixin-bridge.mjs` | 同 QQ：入站图片缓存 + 引用图片附加。 |

效果：先正常发一张图，再"回复这张图"问它，模型能看到原图；群里也能用（前提是那张图当初推送给了机器人）。

### 1.2 QQ 语音消息

问题：QQ 语音只能发 SILK；插件只有 `sendImage`/`sendFile`，没接 SDK 里现成的 `bot.sendVoice`。

改动：

| 文件 | 内容 |
| --- | --- |
| `src/channels/shared/voice-synth.mjs`（新增） | 离线 TTS（Windows SAPI，中文女声 Huihui，24 kHz 单声道）+ wav→SILK（`silk-wasm`，纯 wasm，不需要 ffmpeg/联网）。限制：文本 ≤300 字、时长 ≤60 秒。 |
| `src/channels/qq/qq-bridge.mjs` | ① 新增 `/voice 要说的话`、`/语音 要说的话` 指令（**仅主人 openid 可用**）；② 新增 `sendQqVoice` 与音频产物转语音（`sendQqVoiceArtifact`）；③ 产物投递接上 `sendVoice`。 |
| `src/channels/shared/semantic/artifact.mjs` | 补上 `.wav/.mp3/.silk/.amr/.m4a/.ogg` 的 MIME，音频产物才会被识别成 voice 候选。 |
| `src/channels/shared/semantic/artifact-delivery.mjs` | 投递顺序变为 音频→voice（失败回退文件）、图片→图片、其余→文件。 |

效果：私聊里发 `/voice 你好呀` 会直接收到一条 QQ 语音；模型如果通过文件工具产出了 `.wav`，投递时也会自动转成语音（转不了就按文件发，不会丢）。

微信：**平台侧没有发送语音的接口**（iLink 只有文本/图片/文件；收到的语音会带转写文本），所以微信这边没做，也做不了。补丁（2026-10-22）：`weixin-bridge.mjs` 新增 `sanitizeOutboundText()`，出站前把 `<dsh_im_voice>…</dsh_im_voice>` 剥成普通文本、把 `<dsh_im_sticker>` 整段丢弃（微信没有表情包投递路径），标签不会再原样漏给用户。

---

## 2. 依赖变化

- `silk-wasm@3.7.1` 直接放进了插件自己的 `node_modules`：
  `<DSH_HOME>\profiles\desktop\node_modules\@xmanrui\dsh-im\node_modules\silk-wasm`
  （插件 profile 由 pnpm 管理，下次重装插件时这个目录可能被删掉，删了语音就会提示"缺少 SILK 编码器"）
- 构建用的 esbuild/依赖只在本目录 `node_modules`，不污染 profile。

---

## 3. 重新打包

```powershell
cd "<WORKSPACE>\tools\im-patch"
node build-im.mjs
```

会从插件 `plugin-src/host/index.mjs` + `src/` 重新生成 `lib/index.js`（弹幕式：esbuild 打包 + minify，`silk-wasm` 保持 external）。

校验（已经跑过）：

```powershell
node --check <每个改过的 .mjs>        # 全部 exit 0
node -e "await import('file:///.../dsh-im/lib/index.js')"   # Node 22 下导出 apply/createImHostPlugin/inject/name
```

打包保真校验：用 `pristine/package`（npm 上 5.2.0 原包）按同一套 esbuild 参数重建，和线上 `lib/index.js` 对比中文字面量集合——**3184 条对 3184 条，零差异**，说明仓库里的 `src` 与发布包是同一版本；重新打包不会回退线上行为（体积差 0.2% 只是压缩后标识符长度差异）。

`build-im.mjs` 用到的 devDependencies（`@larksuiteoapi/node-sdk`、`@whiskeysockets/baileys`、`react`、`react-dom`）只装在 `tools/im-patch/node_modules`，通过 esbuild `nodePaths` 解析，不进 profile。

离线自测结果（2026-10-22）：

- TTS→SILK：`'你好，我是小鱼…'` → 4.86 s / 16 KB SILK，头部 `#!SILK_V3`，耗时 ~0.7 s
- `sendQqVoice` 用 mock bot：参数与返回值正确；bot 没有 `sendVoice` 时抛 `artifact-provider-unavailable`
- 引用缓存：load 包装后能按 (scope, messageId) 取回同一份字节；miss 返回空
- 微信引用图：带 media 的快照能生成图片源；只有元数据的快照不会伪造图片
- 真机端到端（QQ 发语音/回复图片）**还没验证**——要重启 DSH 后由你在 QQ 里试

---

## 4. 回滚

备份目录：`tools/im-patch/backup/`

- `lib-index.js.orig` —— 打补丁前的发布包产物（回滚运行时用这个）
- `src-orig/` —— npm 原包里的原始源码（未改过的版本）
- `src-patched/` —— 当前打补丁后的源码副本
- `pristine/package/` —— 完整解包的 5.2.0 原包（含 lib/src/client）

```powershell
# 只回滚运行时代码（最常用）
Copy-Item "<WORKSPACE>\tools\im-patch\backup\lib-index.js.orig" `
  "<DSH_HOME>\profiles\desktop\node_modules\@xmanrui\dsh-im\lib\index.js" -Force

# 连源码一起回滚
Copy-Item "<WORKSPACE>\tools\im-patch\pristine\package\src\*" `
  "<DSH_HOME>\profiles\desktop\node_modules\@xmanrui\dsh-im\src\" -Recurse -Force
```

回滚后同样要重启 DSH。

---

## 5. 使用与已知限制

- 语音：私聊 `/voice 你好`（主人 openid `00000000000000000000000000000001`）；群里要先 @ 机器人，且只对主人生效。
- 引用图：先发图，再回复那张图提问；引用超过 6 小时/48 张之前的图会退回"只有文件名"。
- 仍然是限制的部分：
  - 单张图给模型的副本上限 5 MB（GIF 不能压）、总量 20 MB —— 想放宽去「通用设置 → 附件 → 图片输入」。
  - 群里没 @ 机器人的消息不会被投递（QQ 平台行为），只能进群归档。
  - 微信发语音：平台不支持。
  - 语音只支持中文 SAPI 音色；`/voice` 不做权限外的 TTS 滥用防护（主人限定 + 60 秒已限）。

---

## 6. 与另一个会话补丁包的关系（2026-10-22 审计）

`reference/bot-session-im-patches/`（原 `<BOT_WORKSPACE>\im-patches\`，2026-10-22 归档）是另一个会话（QQ 私聊）做的引用图补丁，结论：

| 项 | 状态 |
| --- | --- |
| 它的 3 处源码改动（`qq-bridge` 引用图、`group-history-store.imagesForPlatformMessage`、`image-prompt` 导出） | **已包含**在当前补丁集里（我的 `#attachQuotedImages` 是在它的版本上扩展的，归档取图路径保留） |
| 它的 `apply.mjs` | 只改 `src/`，**不重新打包 `lib/index.js`** → 单独跑不生效；对本目录的 `apply.mjs` 来说它是被取代的 |
| 它的 `test-apply.mjs` | 依赖它自己的替换片段，当前会输出 `bridge identical : false`（因为方法已被扩展版替换），属预期，不代表坏了 |
| 它的 `test-quoted-images.mjs` | 仍有效，跑过：BY ID 取到 1 张 163574 B，按文件名回退取到，无匹配返回 0 |
| 它的 README 里「私聊 c2c 引用图仍不行」 | **已过时**：本补丁集用私聊图片缓存补上了 |
| 它的 README 里「插件更新后跑 apply.mjs 即可」 | **不完整**：必须重新打包，见本文件第 0 节 |

结论：不需要再跑 `reference/bot-session-im-patches/apply.mjs`；维护只认本目录。它的包保留作历史证据，不要删除前先确认没有别的引用。

---

## 7. 第二轮补丁（2026-10-22 下午：音色 / 引用文件 / 群推理上限）

### 7.1 QQ 语音音色可换
- TTS 改成优先走 WinRT OneCore（`Windows.Media.SpeechSynthesis`），可用音色：**Yaoyao（zh-CN 少女音，默认）**、Huihui、Kangkang、Ayumi/Haruka/Ichiro（日语）、Zira（英语，仅 SAPI）。默认 pitch +15%，比原来的 Huihui 更年轻。
- 指令（仅主人）：`/voice list`、`/voice set yaoyao`、`/voice pitch +15`、`/voice rate +5`、`/voice reset`、`/voice test`、`/voice 要说的话`。
- 设置持久化到 `<DSH_HOME>\integrations\dsh-im\voice.json`。
- 实现文件：`shared/voice-synth.mjs`（重写）。SAPI 仍作后备。Edge TTS（在线神经音色）本机 403 连不上，未采用。

### 7.2 引用里的文件也能读
- `group-history-store.mjs` 新增 `filesForPlatformMessage()`（按平台消息 id / 附件名查归档里的非图片附件）。
- `qq-bridge.mjs` 的引用附件处理从「只处理图片」扩展为图片+文件：引用图走原有路径，引用文件以 `引用-xxx` 名字加入本次 prompt 的 files，由 Host 落盘后交给模型读取。
- `quoted-media.mjs` 缓存加上 `kind` 区分，私聊/群里先收到过的文件也能被后续引用命中。
- 限制不变：归档里没有的消息（机器人没实际收到的）仍然取不到。

### 7.3 群聊推理上限：主人可改
- 新增 `shared/group-reasoning.mjs`：群聊推理上限默认 `low`，存 `integrations/dsh-im/group-reasoning.json`。
- `bot-workspace-store.mjs` 创建会话时按上限钳制（`clampReasoningForGroup`）。
- 指令（仅主人）：`/effort` 查看，`/effort low|medium|high|...` 设置；非主人使用会被拒绝。
- 生效范围：**之后创建/重建的会话**；已存在的群会话要 `/new` 或换新会话才吃到新上限。

### 7.4 其他
- `qq-bridge.mjs` 失败时会往 `<DSH_HOME>\logs\dsh-im\YYYY-MM-DD.log` 追加一行 JSON 诊断（含 referenceId、错误码、message、stage），用于追查 `INTERNAL_UNKNOWN` 这类只有参考号的错误。
- 本目录 `apply.mjs` 的文件清单已同步到 13 个文件（新增 `bot-workspace-store.mjs`、`group-reasoning.mjs`、`kokoro-tts.mjs`）。
- 仍需要重启 DSH 才会加载新 bundle。

---

## 8. 第三轮补丁（2026-10-22 傍晚：Kokoro 二次元音色 + 自然语言语音）

### 8.1 音色换成本地 Kokoro-82M（二次元女声）
- 选型：**Kokoro-82M**（GitHub 2025-2026 最火的开源轻量 TTS 之一，82M 参数、MIT 系许可），中文音色 `zf_xiaobei / zf_xiaoni / zf_xiaoxiao / zf_xiaoyi`（少女音）。通过 `sherpa-onnx-node` 在 Node 进程内跑 ONNX，**不需要 Python、不需要服务器、离线**。
- 模型/运行时放在 `<DSH_HOME>\integrations\dsh-im\tts\`（约 400 MB：`kokoro-multi-lang-v1_0` fp32 模型 + espeak 数据 + `node_modules/sherpa-onnx-node`）。
- 实测延迟（i7-13650HX，8 线程 fp32）：RTF ≈ 0.33；3 秒语音约 1.1 s 出 SILK（进程首次调用多 ~1.5 s 加载模型）。int8 在这台机器上反而更慢（RTF 1.1），已弃用。
- 兜底链：Kokoro → WinRT OneCore（Yaoyao/Huihui/日语）→ SAPI；Kokoro 不可用时自动降级，不影响发语音。
- 指令：`/voice list`、`/voice set xiaobei|xiaoni|xiaoxiao|xiaoyi`（也支持 yaoyao/huihui/…）、`/voice speed 1.1`（仅 Kokoro）、`/voice test`、`/voice reset`。
- 实现：新增 `shared/kokoro-tts.mjs`；`shared/voice-synth.mjs` 增加 `kokoro` provider，默认值改为 `kokoro / zf_xiaobei / speed 1`。

### 8.2 自然语言发语音（不用 /voice 指令）
- 模型把要说的话包进 `<dsh_im_voice>…</dsh_im_voice>` 输出，插件在发送最终回答前解析：合成 Kokoro 语音并用 `bot.sendVoice` 发出，标签本身不展示给用户；剩余文字照常发送。
- 任何人（主人、群友、陌生人）要求“用语音说/发个语音”都会照做（AGENTS 已写死规则）；`/voice 文字` 仍可用。
- 实现：`qq-bridge.mjs` 的 `extractVoiceIntent()` + 最终投递前合成；AGENTS.md 增加“语音消息规则”。

### 8.3 局限
- Kokoro 是逐句同步合成，会占用 DSH 主进程约 1 s（语音消息频率低，可接受）；不阻塞普通文字回复。
- 想要**角色级/克隆音色**（更贴二次元角色）需要 GPU 方案（GPT-SoVITS / IndexTTS2 / CosyVoice2），本次未装：GitHub 下载在本机被墙、需 Python+torch（~3 GB），属于下一阶段可选升级。
- 模型目录在 DSH_HOME 下，重装插件不会丢；重装 `tools/im-patch` 补丁集也不会动它。


---

## 9. 第四轮补丁（2026-10-22：QQ 表情包）

### 9.1 表情库
- 新增 `shared/sticker-library.mjs`：扫描并缓存可用表情图片（gif/png/jpg/webp/bmp，≤8 MB）。
- 默认三个来源（只读，不复制、不改动 QQ 文件）：
  1. `<DSH_HOME>/integrations/dsh-im/stickers`（自己往里丢图就能用）
  2. QQ 收藏表情：`<QQ_DATA>/Tencent Files/<QQ号>/nt_qq/nt_data/Emoji/personal_emoji`（含 Ori 原图与 Thumb 缩略图）
  3. QQ 商城表情缓存：`.../Emoji/marketface`
- 实测扫描出 **4884** 张（jpg 2351 / png 2497 / gif 36），首次扫描约 0.9 s，缓存 10 分钟。
- 配置：`<DSH_HOME>/integrations/dsh-im/stickers.json`（可改 dirs / maxBytes）。

### 9.2 发表情的方式
- 自然语言：模型输出 `<dsh_im_sticker>关键词</dsh_im_sticker>`，插件解析后从库里挑一张（有关键词按文件名匹配，没有就随机，近期不重复），用 `bot.sendImage` 发出；标签不展示给用户。群里/私聊任何发送者都能要求。
- 指令：`/sticker` 或 `/sticker 可爱`（任何人可用，群里需 @）。
- 失败会回一句“表情包没发出去：原因”。

### 9.3 平台限制（重要）
- QQ 机器人 API **没有“表情/收藏表情”消息类型**，所以只能作为**图片消息**发出：对方看到的是图片，不是可点击的表情气泡，也不会进对方表情包抽屉。
- 动态表情：QQ 收藏表情里的 **GIF 原图**能保持动图（实测 `personal_emoji/Ori` 里有 GIF）；商城表情（marketface）本地只有静态缩略图，发出去是静态图。
- 想发“自己画/生成”的图：把图片路径用文件工具的图片回传（图片会按图片消息发出），或丢进上面的自定义 stickers 目录再让它发。

---

## 10. GPU 角色音色（F5-TTS，2026-10-22 安装）

### 10.1 装了什么
| 组件 | 位置 | 说明 |
| --- | --- | --- |
| Python 3.11.9 | `<TOOLS>\Python311` | 独立安装，不污染系统 |
| PyTorch 2.6.0+cu124 / torchaudio | 同上 site-packages | 2.4 GB 轮子从南大镜像分块下载后本地安装；`torch.cuda.is_available()=True`（RTX 4060 Laptop） |
| f5-tts 1.1.22 + 依赖 | 同上 | 官方 PyPI 包（清华镜像） |
| F5-TTS v1 Base 模型 | `<TOOLS>\tts-gpu\models\F5TTS_v1_Base` | 1.29 GB，从 hf-mirror 下载 |
| 服务端 | `<TOOLS>\tts-gpu\server.py` | 本地 17861，模型常驻显存，`POST /tts` 返回 WAV |
| 角色参考 | `<TOOLS>\tts-gpu\characters\<名字>.wav` + `<名字>.txt` | `default` 为占位（Kokoro 克隆）；换成角色素材即可 |

### 10.2 实测延迟（RTX 4060 Laptop 8G）
- 模型加载（冷启动，进程内一次）：约 30 s（插件会自动拉起 sidecar，第一次发语音会等这一下）
- 热推理（16 steps）：1.1–1.2 s / 句；8 steps：约 0.6 s
- 插件链路（F5 → SILK）：热 1.19 s 出 2.36 s 音频

### 10.3 插件用法
- `/voice set gpu` 切到 F5（用当前 `character`，默认 `default`）
- `/voice char <名字>` 切角色（自动切到 F5 并记住）
- `/voice test` 试听；`/voice speed` 有效；失败自动回退 Kokoro
- 实现：`shared/gpu-tts.mjs`（健康检查/自动拉起/HTTP 调用）、`voice-synth.mjs` 的 `f5` provider、`qq-bridge.mjs` 的 `/voice char`

### 10.4 怎么换成“某个角色”
1. 找一个 5–15 秒、干净、只有该角色人声的片段（wav/mp3）
2. 写下这段音频的原话
3. 保存为 `<TOOLS>\tts-gpu\characters\<名字>.wav` 和同名 `.txt`
4. QQ 里 `/voice char <名字>` → `/voice test`

### 10.5 许可与边界（重要）
- F5-TTS **模型权重是 CC-BY-NC 4.0（仅非商用）**，代码 MIT。个人/自用没问题；**商用（闲鱼交付、收费内容）不能用这套权重**，要换许可更宽松的模型（如 CosyVoice 系列，需自行核对许可）。
- 角色音色属于他人声音/角色形象，二次元角色克隆用于公开传播有侵权风险；自己玩可以，别拿去卖。
- sidecar 占用显存约 1.5–2 GB；打游戏前可关掉进程（下次用语音会自动拉起）。

### 10.6 换上「大肥鱼」音色（2026-10-22）

- 数据源：ModelScope `YinZilu/da-fei-yu-girl-voice-zh`（CC-BY-NC 4.0，56 条 / 9 分 53 秒，B 站 UP 主尹紫鹭幻想社自调少女音色）。
- 取了第 1 条（13.9 s，44100 Hz mp3）→ 用 `soundfile + torchaudio` 转成 24 kHz 单声道 WAV，转录文本取自 `metadata.csv`：
  - `<TOOLS>\tts-gpu\characters\dafeiyu.wav`（13.9 s）
  - `<TOOLS>\tts-gpu\characters\dafeiyu.txt`
- 默认音色已切到 `f5 / dafeiyu`（`<DSH_HOME>\integrations\dsh-im\voice.json`）。
- 实测（RTX 4060，热推理）：16 步 **0.81 s**，8 步 **0.36 s**；语音服务冷启动 ~30 s（模型加载）。
- 切换：`/voice char dafeiyu`；回 Kokoro：`/voice set xiaobei`；回 Windows 音色：`/voice set yaoyao`。

### 10.7 几个候选模型的许可（2026-10-22 核对）

| 模型 | 代码许可 | 权重许可 | 本机状态 |
| --- | --- | --- | --- |
| F5-TTS | MIT | **CC-BY-NC 4.0（非商用）** | 已装，热 0.8 s/句 |
| CosyVoice2 | Apache-2.0 | ModelScope 卡未标 license，README 宣称模型 Apache-2.0（需自行确认） | 未装 |
| GPT-SoVITS | MIT | 权重发布页未统一标注，常见为非商用/自用约束 | 未装 |
| IndexTTS2 | NOASSERTION（GitHub 未识别） | ModelScope 卡未标 license | 未装 |

结论：**F5-TTS 不是许可最好的**（权重非商用）。要商用优先 CosyVoice2（Apache，需再核权重条款）；纯自用/角色克隆，GPT-SoVITS 的二次元相似度通常比 F5 更好，但部署更重（需参考音频 1 分钟以上更稳）。

---

## 11. GPT-SoVITS 微调音色（2026-10-22 晚，主力音色）

### 11.1 装了什么
- 代码：GitHub API zipball 下载（GitHub 网页/Release 被墙，`api.github.com/repos/.../zipball` 可用）→ `<TOOLS>\gpt-sovits\RVC-Boss-GPT-SoVITS-b4570b8`
- 环境：独立 venv `<TOOLS>\gpt-sovits\venv`（Python 3.11 + torch 2.6.0+cu124 + transformers 4.57 + gradio 4 + tensorboard + funasr 等）
  - 补丁：`jieba_fast`→`jieba`（3 个文件）；ffmpeg 用 `imageio-ffmpeg` 提供的二进制复制到 `<TOOLS>\bin\ffmpeg.exe`
- 预训练权重（hf-mirror `lj1995/GPT-SoVITS` + `XXXXRT/GPT-SoVITS-Pretrained`）：
  - `chinese-hubert-base` 180MB、`chinese-roberta-wwm-ext-large` 621MB
  - `gsv-v2final-pretrained`：s1 148MB、s2G 101MB、s2D 89MB
  - `fast_langdetect/lid.176.{bin,ftz}`（Facebook CDN 下载）
  - `G2PWModel`（561MB zip）、`nltk_data`
- 数据：ModelScope `YinZilu/da-fei-yu-girl-voice-zh`（CC-BY-NC 4.0；56 条，实际下载 51 条有效）
  - 转 32k 单声道 wav → `dataset\wav32k`，清单 `dataset\dafeiyu.list`
- 预处理（3 步全部跑通）：`logs\dafeiyu\{2-name2text.txt, 3-bert, 4-cnhubert, 5-wav32k, 6-name2semantic-0.tsv}`
- 微调：s2（SoVITS）在 4060 上训练；8 epoch 的最终权重落在 `logs\dafeiyu\logs_s2_v2\G_233333333333.pth`（585MB），用 `process_ckpt.savee` 转成推理格式 `weights\dafeiyu_e4_s16.pth`（81MB，fp16）

### 11.2 推理服务
- `<TOOLS>\gpt-sovits\server.py`，端口 **17862**，`POST /tts` 返回 WAV；默认读 `tts_infer_finetuned.yaml`（custom 块指向微调权重）
- 启动：`<TOOLS>\gpt-sovits\venv\Scripts\python.exe server.py --port 17862 --preload`
- 参考音：`characters\dafeiyu.wav`（4.47s）+ `.txt`；换角色放同名文件即可

### 11.3 实测延迟（RTX 4060 Laptop）
- 模型加载：约 2–3 s（常驻显存）
- 热推理：**0.89–1.2 s / 句**（1.7–3.2 s 音频），首次调用 7 s 左右预热
- 插件全链路（GSV → SILK）：**1.48 s** 出 3.18 s 音频

### 11.4 插件
- `shared/gsv-tts.mjs`：健康检查/按需拉起/HTTP 调用
- `voice-synth.mjs` 增加 `gsv` provider；回退链 **gsv → f5 → kokoro → Windows**
- 指令：`/voice set gsv`（GPT-SoVITS）、`/voice char dafeiyu`、`/voice set gpu`（F5）、`/voice set xiaobei`（Kokoro）
- 默认配置：`integrations/dsh-im/voice.json` → `{provider:"gsv", character:"dafeiyu"}`
- `apply.mjs` 清单同步到 16 个文件（新增 gsv-tts.mjs）

### 11.5 注意
- 显存：GSV 约 1.5–2 GB，F5 约 1.5–2 GB；两个服务同时跑约 4 GB，4060 8G 够用
- GPT-SoVITS 权重许可未统一标注；大肥鱼数据 CC-BY-NC 4.0，自用可以，商用需另核
- 微调耗时：预处理约 3 分钟，s2 训练 8 epoch 约 25 分钟

---

## 12. 语速 / 人设提示词（2026-10-22 晚）

### 12.1 语速
- GPT-SoVITS 默认 `speed_factor` 由 1.0 调成 **0.9**（同一句 3.18s → 3.68s），改 `integrations/dsh-im/voice.json` 的 `speed` 即可，0.5~2.0。
- `/voice speed 0.9` 也能调（Kokoro/F5 同样生效）。

### 12.2 人设提示词（参考 Derpyu520/qq-bridge 的 roles 机制）
- 目录：`<DSH_HOME>\integrations\dsh-im\personas\`，一个角色一个 `.md`，文件名即角色名。
- 当前生效：`integrations/dsh-im\persona.md`（内容 == 某个 personas/*.md 的拷贝）
- 注入方式：`shared/persona.mjs` 把 persona 追加到通道的 `sourceGuidance`，QQ 和微信 bridge 都改成了 `applyPersona(...)`；因此**所有 QQ/微信 bot 会话生效**，本机 DSH 会话不受影响。
- 生效时机：改文件后**下一条消息即生效**，不用重启；persona 为空则完全不注入。
- 已收录：`傲娇助手.md`、`小鲸鱼.md`（来自 Derpyu520/qq-bridge 的 roles，按本插件能力做了少量改写）、`README.md`（格式说明）。

### 12.3 与 Derpyu520/qq-bridge 的差异（简）
- 对方强在：OneBot/SnowLuma 接全量 QQ 消息、控制台、token/花费看板、社会仿真（潜水/主动接话）、黑话学习、表情 CDN 兜底、每会话初始提示词、每会话模型选择、审批转发、长轮询等（v0.2.0-r4，适配 DSH 0.2.0-rc.2）。
- 我们强在：DSH 原生插件（无独立桥接进程/无 OneBot 依赖）、QQ 官方机器人 API + 微信通道、引用图片/文件可读、群历史归档 + 查询工具、语音（GPT-SoVITS 微调/F5/Kokoro）、表情包库、群推理上限、访问边界策略。
- 本轮已吸收：人设提示词机制（personas + 注入）。未吸收（按需再说）：控制台/token 看板、社会仿真、黑话学习、每会话模型选择、表情 CDN。

---

## 13. IM 总开关（暂停 / 恢复，2026-10-22）

- 插件管理页没有“停用机器人”开关，QQ 卡片里的“移除接入”会删凭据，所以自建了暂停机制。
- 标记文件：`<DSH_HOME>\integrations\dsh-im\paused`（存在 = 全部 IM 通道暂停）。
- 命令（任意目录可跑，Node 22 路径见 `~/.dsh/dsh-runtimes`）：
  - `node tools/im-patch/im-pause.mjs on` → 暂停 IM + 停语音 sidecar
  - `node tools/im-patch/im-pause.mjs off` → 恢复 IM（语音按需拉起）
  - `... status` → 当前状态
- 实现：`plugin-src/host/channels/shared/startup.mjs` 每 5 秒轮询标记；暂停时断开 production 连接，恢复时重建，不删凭据。
- 首次上线该功能需要重启 DSH；之后热切换。

---

## 14. 私聊 / 群聊双开关（2026-10-22 晚，点击页面）

### 14.1 需求与做法
用户要「私聊、群聊分开手动点击开关」。全局暂停只能全停，之前的 workaround 是改 `workspaces.json` 的 allowlist（还有主人豁免的残留）。现在做成两侧独立开关：

| 层 | 文件 | 说明 |
| --- | --- | --- |
| 状态 | `<DSH_HOME>\integrations\dsh-im\switches.json` | `{"version":1,"direct":true,"group":true,"updatedAt":"..."}`；`true` = 正常回复，`false` = 该侧入站全部丢弃 |
| 判定 | `src/channels/shared/im-switch.mjs`（新增） | 读写状态文件（mtime 缓存）、`chatSwitchDecision()`、`switchSnapshot()` |
| 门禁 | `src/channels/shared/inbound-access.mjs`（改） | **在访问策略和主人豁免之前**先查开关，命中返回 `{allowed:false, reason:'chat-switch-off'}`；QQ/微信的拒绝分支对该 reason 是静默的（只 markSeen，不回复、不计数为回复） |
| 页面/服务 | `src/channels/shared/im-switch-server.mjs`（新增） | 127.0.0.1:17863（`DSH_IM_SWITCH_PORT` 可改）的点击页面 + JSON API；插件启动时由 `startup.mjs` 拉起（幂等、失败不影响通道） |
| 启动 | `plugin-src/host/channels/shared/startup.mjs`（改） | `installProductionChannel()` 里调 `startImSwitchServer()` |
| CLI | `tools/im-patch/im-switch.mjs`（新增） | `status` / `direct on\|off` / `group on\|off` / `all on\|off` / `open` |

关机状态下那一侧**完全静默**：不回复、不建会话、不显示“没权限”，并把消息标记为已读（避免恢复后补回旧消息）。群历史归档（引用图用）不受影响，仍照常记录。

**两个都关 = 真正离线**（2026-10-22 21:42 补）：`startup.mjs` 的 5 秒轮询除了暂停标记也看开关文件，`isImPaused() || !anyChatEnabled()` 时关闭 production 连接；DSH 左侧工作区的“在线”徽标随 socket 变成离线。只要有一侧打开就保持连接、只按那一侧处理。这样“都关掉”在界面上也是诚实的离线状态。

### 14.2 怎么用
- 桌面快捷方式 `IM开关.url`（`<DESKTOP>\IM开关.url`）→ 浏览器打开 `http://127.0.0.1:17863/`，页面上「私聊」「群聊」两个开关，点一下立即生效。
- 页面轮询 4 秒同步外部改动；底部显示全局暂停状态（暂停时两侧开关不生效）。
- 命令行等价：`node im-switch.mjs direct off` 等，写的是同一个文件，热生效。

### 14.3 安全边界
- 服务只绑 `127.0.0.1`；POST 必须 `application/json`，且 Origin 必须是本机回环（浏览器跨站表单/简单请求会被 415/403 拒绝，防 CSRF）。
- 页面没有账号体系，但只有本机可访问；和 DSH 本身一样，拿到本机访问权就能操作。

### 14.4 自测（离线跑过，2026-10-22）
```powershell
cd "<WORKSPACE>\tools\im-patch"
node test-im-switch.mjs
```
覆盖：默认全开 / 写文件 / mtime 读取 / 共享门禁返回 `chat-switch-off` / 页面 200 / `/api/state` 读写 / 非 JSON 415 / 跨源 403 / 404。全部通过。
运行时 bundle 校验：`lib/index.js` 含 `chat-switch-off`、`switch page ready`、`/api/state`、`switches.json`，导入导出仍为 `apply/createImHostPlugin/inject/name`。

### 14.5 生效条件
- 本轮改了 `lib/index.js`（两次重新打包：双开关 + 两关即离线），**必须完全退出 DSH 再打开**才加载新 bundle。
- 之后开关本身是热生效的（文件/页面/CLI 改完，5 秒内按新状态处理/断连/重连），不用再重启。
- 回滚：
  1. 运行时：`Copy-Item tools\im-patch\backup\lib-index.js.before-offline-20261022 <插件>\lib\index.js -Force`（或更早的 `lib-index.js.before-switch-20261022`），重启 DSH。
  2. 源码：`node apply.mjs --force` 会把 `backup/src-patched` 里的版本重新铺上去（含本轮补丁）。

### 14.6 apply.mjs 同步
`FILES` 现已支持第二基线目录（`plugin-src/host`），并新增 4 个条目：`im-switch.mjs`、`im-switch-server.mjs`、`inbound-access.mjs`、`plugin-src/host/channels/shared/startup.mjs`（最后这个此前只存在于 `backup/src-patched`，`apply.mjs` 没收录，重装插件后会漏掉暂停功能 —— 本轮一并补上）。

---

## 15. 会话进「未分组」的修复（2026-10-22 深夜）

### 15.1 现象
IM 新会话在 DSH 侧栏落到「未分组」，而不是配置的 `bot-workspace` 工作区；`bot-workspace` 分组里只剩早期建的 QQ 会话，微信会话一条都不在里面。

### 15.2 根因（实盘数据已核对）
- `<DSH_HOME>\im` 是 junction → `<BOT_WORKSPACE>`（维护手册第 0 节记的就是这个设计）。
- 插件 `default-workspace.mjs` 把 `<DSH_HOME>\im` 当“未分组默认 IM 工作区”，而 `sameWorkspacePath()` 比的是 **realpath**，于是 **bot-workspace 被判成 ungrouped**（实测 `sameWorkspacePath('D:\...\bot-workspace', 'C:\Users\<你>\.dsh\im') === true`）。
- `harness-client.mjs` 的 `createSession()` 在 ungrouped 时只传 `{ cwd }`、不传 `workspaceId`。DSH 侧栏按**工作区注册表**（`<DSH_HOME>\storages\workspace.json` 里各 workspace 的 `sessionIds`）分组，没进注册表的会话就显示在「未分组」。
- 时间线对得上：junction 建于 14:04:17；之前建的会话（`session-f30da7e5` 13:47 等）带 workspaceId、留在 bot-workspace；之后的（QQ 群 `dfbf8a51` 14:24、QQ 私聊 `8158deef` 21:48、微信 `789b20fe` 22:04）都是裸 cwd，全进未分组。**“只有 QQ”是假象**：留下来在 bot-workspace 的恰好都是 junction 之前建的 QQ 老会话。

### 15.3 改动

| 文件 | 内容 |
| --- | --- |
| `src/channels/shared/harness-client.mjs`（本轮纳入补丁集） | 新增 `registeredWorkspaceId()`（按 realpath 匹配 Host 已注册的工作区）和 `createWorkspaceId()`；`createSession()` 改为：命中已注册工作区 → 传 `workspaceId`；未注册且是未分组默认目录 → 传 `cwd`（旧行为）；其余 → `workspace.create` 后传新 id。`workspaceId()` 复用 `registeredWorkspaceId()`，不再用字符串相等比较。 |
| `apply.mjs` | `FILES` 增加 `harness-client.mjs`；bundle 标记增加 `registeredWorkspaceId`。 |
| `test-workspace-grouping.mjs`（新增） | 6 条离线断言，见 15.4。 |

### 15.4 验证（已跑，2026-10-22）
- `node apply.mjs` → 重打包 `lib/index.js`（约 9.1 MB，标记齐全）。
- `node test-workspace-grouping.mjs` → **6/6 passed**：junction 别名→workspaceId、从 junction 路径一侧 canonical 匹配、未注册未分组→cwd、非未分组→`workspace.create`、`workspace.list` 报错回退 cwd、`workspaceId()` 复用注册不重复建。
- 用 Node 24 runtime（`<DSH_HOME>\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`）import 产物 → 导出 `apply/createImHostPlugin/inject/name` 正常（系统 Node 21 缺 `node:sqlite`，bundle 本身要 Node 22+ 才能 import）。
- **生效仍需完全退出 DSH 再打开**；重启后新 IM 会话应直接出现在 bot-workspace 分组。

### 15.5 已有的未分组会话（本轮决定不迁移）
2026-10-22 选择先不动历史会话。以后想归位，三条路：
- IM 里 `/session <Session ID>`：走 adopt 路径；但 adopt 的“无归属”兜底目前只接受 cwd == 未分组目录，未注册会话会报 `session-not-registered`，**要再给 `harness-session-binding.mjs` 补一条路径匹配才可用**（约 10 行）。
- IM 里 `/new`：新建会话会正确进 bot-workspace，历史留在未分组。
- 关 DSH 后手工把 session id 加进 `workspace.json` 里 bot-workspace 的 `sessionIds`（先备份）。

### 15.6 回滚
1. 把 `backup/src-patched/src_channels_shared_harness-client.mjs` 换回 `pristine/package/src/channels/shared/harness-client.mjs`（原版）；
2. 从 `apply.mjs` 的 `FILES` 删掉 `src_channels_shared_harness-client.mjs` 那行，标记数组里删掉 `registeredWorkspaceId`；
3. `node apply.mjs`（重打包）+ 重启 DSH。
只想回滚运行时也可以直接拷 `backup/pre-apply-<时间戳>/src_channels_shared_harness-client.mjs` 回插件 `src/` 再重打包。

---

## 16. 维护阶段（2026-10-23）：状态文档、镜像同步、构建证据、回归

本轮**没有改运行时代码**（`backup/src-patched/` 内容未变，安装目录与产物 hash 未变），所以没有重新 apply/重启；改的是维护工具、文档与镜像副本。

### 16.1 清单单源化（M1 配套）
- 新增 `manifest.mjs`：上游版本 + 22 个补丁文件的唯一清单。`apply.mjs` / `build-im.mjs` / `verify-build.mjs` / `status.mjs` 全部从它取，文档不再手抄文件数。
- 新增 `status.mjs`：一条命令看"现在跑的是哪份源码/产物 + 通道开关"，并能把实测数字写回 `docs/CURRENT-STATE.md` 的自动块（`--doc <md> --write`）。

### 16.2 构建证据（M3）
- `build-im.mjs` 现在写 `build-manifest.json`：上游版本与 package.json hash、补丁逐文件 hash、`plugin-src/host + src` **全树 hash**（341 个文件）、产物 hash/大小/mtime、Node/esbuild 版本、锁文件与原包 hash，并写明覆盖范围与不覆盖项。
- 新增 `verify-build.mjs`：四道门 + 明确退出码（2 版本不符 / 3 未建立基线 / 4 源码漂移 / 5 产物漂移 / 6 改了没重启 / 7 运行实例未确认 / 8 清单损坏 / 9 权威补丁被改）。`--self-test` 用临时副本跑 10 个正负例。
- 运行实例的证据：找**监听开关页端口（17863）的进程**，比它的启动时间与产物 mtime——启动晚于产物 mtime 才说明加载的是当前 bundle。
- 旧安装没有清单时 `build-im.mjs --adopt` 先"打包到临时文件 + 比 hash"，一致才建立基线（`mode=adopt`），**不覆盖产物**。本轮实测：从当前源码打包结果与线上 `lib/index.js` 逐字节相同（sha256 `55847287…`，9,096,703 B）。

### 16.3 镜像同步（M2）
- 补回镜像缺失的微信出站标签清理：`weixin-bridge.mjs` 的 `sanitizeOutboundText()` + `#send` 里的调用与空文本提前返回（权威 58417 B / 镜像原 57403 B）。
- 新增 `.gitattributes`（`* text=auto eol=lf`），并把仓库里 11 个 CRLF 文件归一为 LF——之前"镜像与权威有差异"里有 4 个纯换行差异，是 `core.autocrlf=true` 造成的假差异。
- 新增 `scripts/check-mirror-sync.mjs`：按 `manifest.mjs` 清单逐项比字节，缺文件/内容差异/镜像多出文件 → 失败；只差换行 → 警告（`--strict-eol` 可升级为失败）；脱敏差异必须走显式 `REDACTIONS` 规则（规则命中记 `REDACTED_OK`，没命中仍算差异）；另外检查 `git ls-files` 里没有 token、node_modules、聊天库、本机音频。`--self-test` 覆盖 9 个用例（含缺文件、内容差异、换行、脱敏命中/未命中、镜像多出文件）。另在镜像的临时副本上删 1 个文件、改 1 个文件做过一次真实数据负例：准确报 `MISSING_IN_MIRROR` + `CONTENT_DIFF`，权威目录未被修改。

### 16.4 回归（M4）
- 新增 `test-weixin-outbound-tags.mjs`：从真实源码抽出 `sanitizeOutboundText` 求值后断言（不复制实现）——语音标签转普通文本、表情标签丢弃、普通文本保持、只有标签时不空投递，10 项。可以 `--file <path>` 指向任意副本，用来证明"镜像是真缺这段逻辑"。
- 复用已有 `test-im-switch.mjs`、`test-workspace-grouping.mjs`（均离线、临时 DSH_HOME）。
- 权限只读审计结论见 `docs/CURRENT-STATE.md`「权限边界」节：**部分隔离**——指令层有代码硬门，工具/会话权限层没有插件级隔离，群内审批可被发起者自批。

### 16.5 本轮没有做的事
- 没有升级插件版本（仍是 5.2.0），没有跨版本迁移。
- 没有修复 `docs/CURRENT-STATE.md` 里记录的 R1～R6 权限风险（本轮是维护 + 只读审计，不扩成权限架构改造）。
- 没有真机端到端验证（QQ 语音/引用图、微信标签清理的实际投递），需要主人指定测试会话与授权。

---

## 17. 多机器人：每个 bot 独立的人设 / 唤醒词 / 音色（2026-10-23）

目标：以后加任意 QQ 机器人，只给它配三样东西（唤醒词、人设、音色），其余功能照旧，不用改代码。

### 17.1 数据布局（缺失就走全局，所以老机器人行为不变）

```
<DSH_HOME>\integrations\dsh-im\
  persona.md                全局人设（yuri 现在用这个）
  voice.json                全局音色（yuri=gsv/dafeiyu）
  personas\<卡名>.md         人设卡库（可被任何 bot 复用）
  bots\<botId>\
    bot.json                名字 + 别名（唤醒词）+ ownerOpenid + 备注
    persona.md              这个 bot 的人设（从 personas\ 复制后自行改）
    voice.json              这个 bot 的音色（结构同全局，额外支持 endpoint）
```

解析规则（`persona.mjs` / `voice-synth.mjs`）：
- 人设：`bots\<botId>\persona.md` → 否则全局 `persona.md`；
- 音色：`bots\<botId>\voice.json` → 否则全局 `voice.json`；
- 身份：`bots\<botId>\bot.json` 的 `name`/`aliases`/`ownerOpenid` 以 `<dsh_im_identity>` 块注入 guidance（放在人设之前，人设仍可覆盖措辞）。
- 没有 `bots\<botId>\` 目录 = 完全走旧路径（yuri 就是这种，行为零变化）。

### 17.2 加一个机器人的完整流程

```powershell
cd "<WORKSPACE>\tools\im-patch"
node bot-profile.mjs list                      # 看现有 bot 及各自来源
node bot-profile.mjs init <botId> --name 名字 --aliases 名字,别名2,别名3 --persona <人设卡> --voice gsv --character <角色>
node bot-profile.mjs check                     # 检查人设/唤醒词/音色是否齐全（含 GSV 参考音）
```

`init` 会自动从 `integrations\dsh-qq\config.json` 带出该 bot 的 `ownerUserOpenid`（每个 appId 下 openid 不同，别手抄）。
改配置**不需要重启**：插件每条消息重新读文件。

### 17.3 音色（GSV 零样本）

GSV server 是**参考音驱动**的：`characters\<角色>.wav`（5~10 秒干净人声）+ `characters\<角色>.txt`（对应文本）。
- 补上这两个文件，`voice.json` 里 `character` 指过去就行，**不用训练**；
- 当前 17862 上是「大肥鱼」微调模型（yuri 在用）。要另一个角色的音色更稳，建议**单独再起一个 GSV 实例**（例如 17864，用基础 v2 配置），并在该 bot 的 `voice.json` 里写 `"endpoint": "http://127.0.0.1:17864"`（本次已支持 per-bot endpoint）；
- 显存只有 8G，两个实例是否同时常驻要实测；跑不动就按 bot 轮换（用到哪个起哪个）。

### 17.4 代码改动（补丁集 23 个文件）

| 文件 | 改动 |
| --- | --- |
| `channels/shared/persona.mjs` | 按 botId 解析人设；注入 `<dsh_im_identity>`（名字/别名/owner openid）；`usePersona(name, {botId})` |
| `channels/shared/voice-synth.mjs` | `voiceSettingsPath(botId)` / `readVoiceSettings({botId})` / `writeVoiceSettings(patch,{botId})`；新增可选 `endpoint` |
| `channels/shared/gsv-tts.mjs` | `gsvUrl(endpoint)`、`synthesizeGsvWav(..., {endpoint})` 支持 per-bot 实例 |
| `channels/qq/qq-bridge.mjs` | 构造参数 `botId`；人设、`/voice` 读写、两处语音合成、sidecar 预热都带上 botId |
| `channels/qq/qq-runtime.mjs` | **新增进补丁集**：把 `config.botId` 传给 bridge |

配套（不在插件里）：`bot-profile.mjs`（配置 CLI）、`test-bot-profiles.mjs`（15 项离线回归，用临时 DSH_HOME + 真实插件模块）。

### 17.5 回滚

- 单个 bot 回滚：`node bot-profile.mjs remove <botId>`（删私有配置，回落到全局）；
- 代码回滚：`backup\pre-apply-<时间戳>\` 里的旧文件拷回插件 `src/`，再 `node build-im.mjs`，重启 DSH。

### 17.6 hiro（二阶堂希罗）音色落地记录（2026-10-23）
环境都在 `D:\tools\gpt-sovits`（不在本仓库，换机要重做）：

| 物件 | 值 |
| --- | --- |
| 参考音 | `characters\shiro.wav`（6.6s，由训练集 `0201Adv03_Hiro007.ogg` 转 32k 单声道） |
| 参考文本 | `characters\shiro.txt` = `驚くことでもない。私と君はルームメイトになった。ただそれだけの話だ。` |
| 参考语言 | `characters\shiro.lang` = `ja`（server.py 新增：prompt_lang 按 `<角色>.lang` 取，缺省 zh） |
| 日语 G2P | venv 里装了 `pyopenjtalk-prebuilt`，并把完整 `open_jtalk_dic_utf_8-1.11` 解压进包目录（pip 包内那份 dic.tar.gz 是截断的；从 ghproxy 下 23MB 官方包才完整） |
| 实例 | **17864** = **v2ProPlus 微调**（`tts_infer_hiro.yaml` = `hiro-e10.ckpt` + `hiro_e8_s2184.pth`），与 17862（大肥鱼微调）并存 |
| v2ProPlus 依赖 | `GPT_SoVITS\pretrained_models\sv\pretrained_eres2netv2w24s4ep4.ckpt`（107.5 MB，2026-10-23 从 HF `lj1995/GPT-SoVITS` 经代理下载） |
| 开机启动 | `D:\tools\gpt-sovits\start-hiro-tts.bat`（默认微调配置；传 `tts_infer_hiro_base.yaml` 可退回零样本） |

实测同一句中文 `今天天气不错，我们出去走走吧。`：大肥鱼中位 f0 **263.4 Hz** / 希罗零样本 **214.8 Hz** / 希罗微调 **207.8 Hz**。微调实例第二次起合成 15 字约 **2.8 秒**。样本：`D:\tools\gpt-sovits\samples\hiro-compare-{dafeiyu,hiro,hiro-finetuned}.wav`、`hiro-pro-sample.wav`。

**没做成的一步（2026-10-23 21:52 已解决）**：v2ProPlus 微调需要 `sv/pretrained_eres2netv2w24s4ep4.ckpt`。用户挂代理后从 HF 下到 107.5 MB 文件放进 `pretrained_models\sv\`，`tts_infer_hiro.yaml` 直接加载成功（`engine ready … v=v2ProPlus`；日志里的 `enc_q.*` missing_keys 是训练用的后验编码器，推理不需要，属正常）。17864 现在跑的就是微调音色。

**姐妹设定**：不写进人设卡（卡要可复用），写进两个 bot 的 `bot.json` 的 `note`，随 `<dsh_im_identity>` 注入：
- yuri：`hiro（二阶堂希罗）是你亲姐姐；你是 yuri，hiro 的妹妹…`
- hiro：`yuri（小鲸鱼）是你亲妹妹；你是 hiro（二阶堂希罗），yuri 的姐姐…`

hiro 的别名最终为 `椎名 / 希罗 / 二阶堂希罗 / hiro`。

### 17.7 推理等级默认 low + 回复不说小作文（2026-10-23）

- **推理默认 low**：新增进补丁集的 `channels/shared/workspace-session.mjs` 在会话绑定后、发 prompt 前执行一次 `/reasoning <ceiling>`——私聊固定 `low`，群聊用 `/effort` 设的上限（默认也是 `low`）。每进程每会话只应用一次，主人之后用 `/reasoning` 改过的会话在本进程内保持；重启后所有会话（含已存在的）首条消息都会重新落回 low。
  群聊原有的模型级 clamp（`bot-workspace-store.mjs` 的 `clampGroupModelSelection`）保持不变。
- **回复要短**：`<DSH_HOME>\AGENTS.md` 新增「所有 IM 机器人回复都要短（不说小作文）」，两个 bot 的 `bot.json` note 也写了「回复一律简短，不说小作文」，两层约束。
- 补丁集 23 → **24 个文件**。生效需要重启 DSH。

### 17.8 群聊「叫名字就唤醒」按 bot 区分（2026-10-23，修 hiro 在群里没反应）

现象：群里发「hiro说句话」hiro 不回复。根因是 `qq-bridge.mjs` 把唤醒名字**写死**成 yuri 那一套：

```js
const NAME_MENTION_PATTERN = /(?:^|[^a-z0-9_])yuri(?:$|[^a-z0-9_])|小鲸鱼|deepseek|大肥鱼/iu;
```

椎名 / hiro / 希罗 都不在里面，所以群里不 @ 就不算叫到它（私聊不受影响——私聊直接回复，所以 hiro 私聊是正常的）。

修复：
- 新增 `nameMentionPatternForNames(names)`：ASCII 名字按整词匹配（`hiro` 不会命中 `hiroshi`），中文名按子串匹配；
- `QqHarnessBridge` 构造时读 `bots/<botId>/bot.json` 的 `name + aliases` 生成这个 bot 自己的匹配器；
- **有 botId 但没有 profile 的机器人不再继承 yuri 的唤醒词**（只认 @），避免多个机器人抢同一句「yuri」；
- 没有 botId 的旧路径继续用 yuri 默认名单（行为不变）；
- yuri 的别名补回 `大肥鱼`，保持原来的唤醒范围。

回归：`node test-bot-wake.mjs`（17 项）——hiro 被 `hiro/椎名/希罗/二阶堂希罗/HIRO` 唤醒、不被 `yuri/小鲸鱼/大肥鱼` 误唤醒；yuri 反之；无 profile 的 bot 匹配器为 null。

### 17.9 希罗人设卡 + 额外音色按需启动（2026-10-23）

**人设卡**：主人最初给的完整卡（`C:\Users\yuuki\OneDrive\桌面\希罗人设卡.md`）动作/心理描写多、回复偏长；2026-10-23 按主人要求换成**精简对话版**（约 900 字符）：
- 安装位置：`integrations\dsh-im\bots\qq_1a3b9ed…\persona.md`；同时 `integrations\dsh-im\personas\希罗.md` 存一份可复用；
- 卡首段硬约束：**只输出角色说的话**，不写动作/表情/心理/旁白、不用括号内心戏；一般 1~3 句、最多 5 句、不写小作文；
- 保留：优等生 + 正义感 + 冷静有距离 + 责任感 + 一本正经的较真、原作初期防剧透、yuri 是妹妹；
- 原长卡仍在 OneDrive 桌面，需要时可换回（`bot-profile.mjs persona <botId> …` 或直接覆盖文件，下一句消息即生效）。

**额外音色按需启动**（主人要求：不在 QQ 用到就不占显存）：
- 新增 `<GSV_ROOT>\instances.json` 注册表（端点 → 配置 yaml / 角色目录），加音色只是改数据；
- `gsv-tts.mjs` 新增 `ensureGsvEndpoint(endpoint)`：`/health` 不通时按注册表 `spawn` 对应端口的 server.py（detached），轮询到就绪；未注册端点返回 null，走原有失败回退；
- `synthesizeGsvWav` 统一走 `ensureGsvEndpoint`（无 endpoint 时等价于原来的 `ensureGsv()`）；
- `qq-bridge` 的 sidecar 预热**跳过带 endpoint 的 bot**，所以重启后不会预先拉起 17864。

实测（先杀 17864）：调用 `ensureGsvEndpoint('http://127.0.0.1:17864')` → 25.8 秒后 `/health` 就绪，`synthesizeGsvWav(..., {endpoint})` 返回 125,484 B 的 `shiro` 音频。**现在 17864 是停止状态**，第一次在 QQ 里让它发语音时自动拉起（冷启动约 25~40 秒，含 CUDA 图编译）。
