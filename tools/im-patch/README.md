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

### 17.10 互相认识 + 「不说话」确认语随机化（2026-10-23）

**两人不认识的原因**：关系只写在各自 `bot.json` 的 `note` 里，但 yuri 的 note 里写的是「hiro（二阶堂希罗）」，**没写群里显示名「椎名」**；hiro 的 note 里也没写对方显示名「yuri」。模型在群里看到的是显示名，自然对不上号。已把双方显示名写进 note（立即生效，无需重启）：
- yuri：`群里那个显示名叫「椎名」的机器人（也叫 hiro / 二阶堂希罗）是你亲姐姐…`
- hiro：`群里那个显示名叫「yuri」的机器人（也叫 小鲸鱼）是你亲妹妹…`

**「不说话」时的固定回复**：原来 `qq-bridge.mjs` 里硬编码一句 `行，那我先不打扰了。`（`t()` 文案），每次都是它，确实僵硬。改成 `DISMISS_ACKS` 16 句随机、且不连续重复（行/好/嗯 开头，8~10 字，符合短回复规则）。回归：`node test-dismiss-acks.mjs`（7 项）。**这是代码改动，需要重启 DSH 生效。**
### 17.11 提高表情包频率（2026-10-23，prompt 层，无需重启）

原来只有人开口要才会发。改法（纯提示词，两条都指向同一份规则）：
- `<DSH_HOME>\AGENTS.md` 新增「主动发表情的频率」：**平均每 2~4 条回复带一张**；情绪明显（被夸/被怼/无语/开心/摆烂）优先；不每条都带、不连续两条都带；表情包单独发，群里私聊都适用。
- 两个 bot 的人设卡各加一节「表情包」：yuri（`persona.md` / `personas\小鲸鱼.md`，两份保持同哈希）、hiro（`bots\qq_1a3b9ed…\persona.md` / `personas\希罗.md`）。hiro 的卡明确写了「表情包标签不算动作描写」，避免和「只输出台词」冲突。
- 本地表情库 465 个文件，够随机；发送侧没有节流，模型输出 `<dsh_im_sticker>` 就会发。
### 17.12 非主人刷屏/重复消息静默忽略（2026-10-23，全局）

规则（QQ，所有 bot 通用）：**主人不受限**；非主人（非 bot）出现以下情况时**直接不回**（静默，连“行”都不说）：
- 2 分钟内重复同一句（归一化后比较：去多余空白/转小写）→ 忽略；
- 10 分钟内同一句第 3 次 → 忽略；
- 1 分钟内超过 8 条（刷屏，不看内容）→ 忽略。

实现：`qq-bridge.mjs` 新增纯函数 `spamCheck(history, text, now)`（可单测）+ `#shouldIgnoreSpam()`；`#process` 在唤醒判断之前拦下并标记已读。历史按「会话+发送者」分开存，上限 40 条/人，最多 500 个键。临时关闭：环境变量 `DSH_IM_SPAM_GUARD=0`。
回归：`node test-spam-guard.mjs`（8 项：首次不拦、2 分钟内重复拦、4 分钟后第二遍不拦、第 3 次拦、刷屏第 9 条起拦、纯图片不判重、历史上限、结构可复用）。

### 17.13 表情包频率下调（2026-10-23，主人要求）

最初改成每 2~4 条一张，主人觉得太密；改成 **平均每 15~20 条回复带一张**（`AGENTS.md` + yuri 人设 `persona.md`/`小鲸鱼.md` + hiro 人设）。纯提示词，立即生效。
### 17.14 主人称呼注入（2026-10-23，修「椎名认不得主人」）

原因：身份块只注入了主人的 **openid**，模型不知道主人叫什么，所以椎名问「还没告诉我该怎么称呼」。主人 openid 本身是对的（群里实测 sender_id `9D0C02EB…` = 配置 owner，yuri 侧 `A051E01D…` 一致）。

修复：`bot.json` 新增 `ownerName`（`bot-profile.mjs name <botId> --owner-name yuuki`），身份块升级为：
- 「这个机器人的主人是 yuuki，openid：…」
- 明写判别方法：消息开头 `<dsh_im_source>` 的 senderId 与该 openid 精确相等 → 主人；称呼用「yuuki」或「主人」
- 提示可用源块里的 senderName 对照，但以 openid 为准

两个 bot 都已设 `ownerName: yuuki`；回归 `test-bot-profiles.mjs` 增加「主人称呼注入」断言。
### 17.15 修「推理等级还是 high」：改用 Host 模型 API（2026-10-23）

原因：17.7 的实现用 `session.executeCommand('/reasoning low')`。`/reasoning` 是**插件层命令**（`model-command.mjs`），Host 不认这个 slash，所以调用失败被我 catch 掉，会话一直停在模型默认档（GUI 显示 High）。

修复（`workspace-session.mjs`）：`ensureReasoningDefault()` 改成走 Host 模型 API——
1. `session.models()` 读当前 provider/model 与可选等级；
2. 目标档不在列表里 → `unsupported`，保持原样（不乱设未知值）；
3. 已经是目标档 → `already`；
4. 否则 `session.selectModel({ provider, model, reasoningEffort })`，并校验返回值。

每会话每进程只应用一次（进程内 `/reasoning` 改过的保持）。回归：`node test-reasoning-default.mjs`（5 项：high→low、只应用一次、已低则跳过、不支持则不动、无 API 安全跳过）。

**注意**：这只影响 IM 触发的会话；DSH Web GUI 里你自己开的会话，推理等级由右下角模型选择器决定，插件不碰。
### 17.16 放宽机器人互相接话（2026-10-23，主人要求）

现象：椎名点名 yuri（「yuri，别以为没人看着就能乱来」），yuri 不接。原因两层：
1. 代码层节流太紧：另一个机器人的消息，**15 秒才允许回 1 次、5 分钟最多 8 次**；
2. 提示词层：AGENTS 有「别人互相怼时别抢话、不确定就不回」，模型可能判断这句不用接。

改法：
- 节流放宽为 **3 秒 1 次 / 5 分钟 20 次**（`botReplyAllowed()` 纯函数，可用 `DSH_IM_BOT_REPLY_MIN_MS` / `DSH_IM_BOT_REPLY_MAX` 覆盖），仍然防止两个机器人无限对刷；
- `AGENTS.md` 新增：**被另一个机器人点名必须回一句**（1~2 句就收）。
- 回归：`node test-bot-reply-throttle.mjs`（6 项）。
### 17.17 主人说暧昧称呼时全员吃醋（2026-10-23，主人要求）

规则：**主人**（各 bot 自己的 ownerUserOpenid）发的消息里出现「宝宝 / 宝贝 / 亲爱的 / 老公 / 老婆 / 达令 / darling / honey / babes / 小可爱 / 亲亲 / 么么 / my love」时：
- 即使没点名、@ 的是别人，**每个机器人都会接话**（代码层把它当作被叫到）；
- 语气由提示词约束：吃醋、嘴硬、宣示主权，1~2 句，不骂人、不说教；叫的是自己时嘴上不承认但别否认关系。

实现：`qq-bridge.mjs` 新增 `OWNER_AFFECTION_PATTERN` + 导出纯函数 `isOwnerAffectionText(text)`；`#shouldReply()` 在 dismiss 判定之后、mention-other 清除之前，对 `isOwnerSender(...) && isOwnerAffectionText(text)` 直接返回 true 并标记 engaged。非主人发同样的词不触发。
回归：`node test-owner-affection.mjs`（23 项：14 种称呼命中、普通消息不误触发、空/空白/非字符串安全）。
### 17.18 修 STATE_WRITE_FAILED / EPERM（2026-10-23，椎名反复报 INTERNAL_UNKNOWN）

现象：椎名在群里回复时报「任务未完成…INTERNAL_UNKNOWN；参考号 MF-…」，日志里对应 `STATE_WRITE_FAILED / EPERM`（22:24、22:28、23:12、23:13 各一次，越来越频繁）。`state.json` 的 mtime 却在正常更新。

根因：`channels/qq/state-store.mjs` 的持久化是「写 `.tmp` → `rename` 覆盖目标」。Windows 上如果目标文件刚好被杀毒/索引服务短暂打开（或用 `fs.open` 读），`rename` 会抛 `EPERM/EACCES/EBUSY`，整个消息处理就失败 → 回一条 INTERNAL_UNKNOWN 给群里。

修复：新增 `writeSnapshotAtomically(fs, path, snapshot)`（本次进入补丁集，manifest 第 25 个文件）：
- `.tmp` + `rename` 失败且错误码属于 EPERM/EACCES/EBUSY/ENOTEMPTY/EAGAIN/EMFILE 时**退避重试**（最多 6 次，40ms 起线性递增）；
- 6 次仍失败则**退化为直接覆盖目标文件**（非原子但不丢状态）；
- 其他错误（磁盘满等）照常抛出，不掩盖。

回归：`node test-state-write-retry.mjs`（6 项：正常 rename、EPERM 重试成功、一直失败退化直写、非锁错误不重试、先写 .tmp）。
### 17.19 叫停识别放宽 + 真静默（2026-10-23）

现象：「我没在跟你两说话！」之后两个机器人还是回了「行。」，之后再接话；另一张图里椎名把「（此处不回复）」当正文发了出去。

原因：
1. `DISMISS_PATTERN` 只认「没跟你说话 / 没跟你聊」，中间夹个「在」「俩」就不匹配 → 消息被当成普通对话，机器人正常回了「行。」并建立接话窗口；
2. 模型想表达「不说话」时写了「（此处不回复）」，插件没有对应机制，原样发出。

修复：
- `DISMISS_PATTERN` 放宽为 `(?:没|不是)(?:有)?(?:在)?(?:跟|和|与)你(?:俩|两|俩个|们)?(?:说|聊)|(?:别|不要)说话了?|…`，导出 `isDismissText()` 供测试；
- 新增静默标记：`<dsh_im_silent/>` 和 `[不回复]` / `【不回复】` / `（此处不回复）` / `(不回复)`，`extractMediaIntent()` 识别后返回 `silent: true`，投递阶段直接跳过（日志 `model chose silence`），一个字都不发；
- `AGENTS.md` 写明：不想说话时只输出 `<dsh_im_silent/>`，不要写「（此处不回复）」。
- 回归：`node test-dismiss-silence.mjs`（24 项）。
### 17.20 重启提示不再发进群（2026-10-23）

现象：DSH 重启后，椎名在群里发「排队中的消息在服务重启时被中断。为避免重复执行，未自动重放…」。这是插件的内部提示（`PENDING_RESTART_NOTICE`），群里所有人都会看到，很出戏。

原因：`#recoverPendingMessages()` 对「已提交但没跑完」的队列消息会调 `#notifyInterruptedPending(entry)`，原来不区分会话类型，有投递目标就直接发。

修复：新增纯函数 `shouldNotifyInterruptedPending(entry)`——**群聊一律不发**（只写一条 warn 日志），**私聊保留**（只有主人看得到，提示重新发送是有用的）。回归：`node test-pending-notice.mjs`（5 项）。

---

## 18. 行为配置：长句拆条 / 表情自动收藏 / 定时主动消息（2026-10-24）

新增统一配置文件 `<DSH_HOME>\integrations\dsh-im\behavior.json`。**只改 behavior.json / 人设卡不用重启**（下一条消息生效）；改了代码必须 `node apply.mjs` + 完全退出重开 DSH。默认值在 `src/channels/shared/behavior-config.mjs` 的 `BEHAVIOR_DEFAULTS`，文件缺失或字段缺失都会回落默认；部分字段可只写要改的。

### 18.1 长句拆条（replyChunking）

- 旧行为：一次回复 = 一条 QQ 消息（`sendMarkdownReply` → `chunkMarkdownParts`，**4500 字**才按换行/代码块切）。
- 新行为：聊天型回复先由 `channels/qq/chat-segments.mjs` 按**句末标点（。！？…；）和换行**切段（不按逗号），再由 `channels/qq/markdown-reply.mjs` 的 `segments` 逐段发送，段间随机 `gapMinMs~gapMaxMs`。
- 默认：单段 ≤60 字、最多 3 段（硬上限 4 段，受被动回复上限 群 5 / 私聊 4 约束）。
- **不拆**：总长 ≤60 字、单个长句、代码块、表格、含 URL 的回复——仍按原来的单条/长文路径走。
- 配置键：`replyChunking.enabled / maxChars / maxSegments / gapMinMs / gapMaxMs`。
- 回归：`node test-chat-segments.mjs`（14 项）。

### 18.2 表情自动收藏（stickerCollect）

- 入站消息里的 GIF/WebP/PNG 小图（2KB~3MB）自动存进表情库 `stickers\`，文件名 `auto_<sha1前16>.gif`；同图去重。
- 只收图片附件；QQ face 标签在插件里早被转成文本，收不到；照片（jpg、大图）默认不收。
- 限速/限量：默认每分钟 1、每小时 10、每天 40，自动收藏总量上限 800；超限删最早的 `auto_` 文件，**不动手动放进库的图**。
- 可选 `groups: []` 白名单（空 = 所有群）。
- 配置键：`stickerCollect.enabled / scope / extensions / minBytes / maxBytes / groups / perMinute / perHour / perDay / maxLibrary`。
- 回归：`node test-sticker-collect.mjs`（18 项）。

### 18.3 定时主动消息（proactive）

- 之前插件**没有主动发消息能力**。现在每个 bot 可配每天固定时间点（默认 07:45 / 11:45 / 17:45，±25 分钟抖动），满足条件后发一条模板文本（**不调模型，0 token**）。
- 触发条件：到点且在窗口内（默认 90 分钟）、群安静 ≥30 分钟、距上次主动 ≥120 分钟、当天 ≤3 条、概率 0.85。
- 状态：`<DSH_HOME>\integrations\dsh-im\proactive-state.json`，按天记录已发时段，重启不会重复发；IM 总暂停或对应开关（群聊/私聊）关闭时不发。
- 文案按 `bots[botId].texts` 的时段配置（`"07:45": [...]` 或 `default: [...]`），当前 yuri / 椎名各写了早/中/晚三条。
- 这是**模板版**；AI 生成版（`askInWorkspaceSession` 生成后发）留作二期，见 `_analysis/impl-notes.md`。
- 配置键：`proactive.enabled / dailyTimes / jitterMinutes / windowMinutes / quietMinutes / minIntervalMinutes / maxPerDay / probability / bots[botId].enabled|targets|texts`。
- 回归：`node test-proactive-scheduler.mjs`（24 项，含真实调度一次、去重、日上限、状态落盘）。

### 18.4 补丁集变化（25 → 29）

新增 4 个补丁文件：`channels/qq/markdown-reply.mjs`、`channels/qq/chat-segments.mjs`、`channels/qq/qq-proactive.mjs`、`channels/shared/behavior-config.mjs`；改动 3 个既有文件：`qq-bridge.mjs`（入站收藏 hook + 出站拆条）、`qq-runtime.mjs`（调度器生命周期 + 活跃时间）、`sticker-library.mjs`（`saveSticker` / 限速 / 容量）。`manifest.mjs` 与 `apply.mjs` 的产物标记同步更新。

测试：`test-*.mjs` 由 13 个变 16 个（新增 3 个）；`verify-build --self-test` 仍是 10 例。

### 18.5 验收顺序

```powershell
cd "<WORKSPACE>\tools\im-patch"
node apply.mjs
node test-chat-segments.mjs
node test-sticker-collect.mjs
node test-proactive-scheduler.mjs
node test-media-intent.mjs
# 其余回归
Get-ChildItem -Filter "test-*.mjs" | ForEach-Object { node $_.FullName }
node verify-build.mjs   # 重启前 exit 6(RUNTIME_NOT_RESTARTED)，完全退出重开 DSH 后 exit 0
```

### 18.6 语音连发与表情心情匹配（2026-10-24 第二轮）

- **连发语音**：一次回复里可以放 **1~3 个独立的** `<dsh_im_voice>短句</dsh_im_voice>`（被逼急时用）。`extractMediaIntent()` 改为全量提取（超过 3 条只取前 3），插件按顺序合成并发送，条间随机 250~700ms；某条失败就停下并回一条失败提示。`voiceText` 字段保留第一条，兼容旧调用点；有语音/表情时不再判定为「静默」。
- **表情按场景/心情挑**：`<dsh_im_sticker>无语</dsh_im_sticker>` 先做同义词扩展（开心≈乐/哈哈/笑/赞；无语≈离谱/难绷/服/逆天…），再按文件名匹配。自动收藏的图会用消息文字推断情绪词写进文件名（`auto_<sha1>_无语-乐.gif`），所以「收藏 → 下次按心情发」能对上；推断不出来时标 `随机`。
- 配置新增：`stickerCollect.autoTag`（默认 true）、`stickerCollect.maxTags`（默认 2）。
- 回归：新增 `test-media-intent.mjs`（8 项，含单条/三条/超限/表情+语音混合/静默）；`test-sticker-collect.mjs` 增补标签推断、同义词、去重、命名检查。测试总数 **17 个 `test-*.mjs`**。

### 18.7 表情识图打标签 / 拒收（2026-10-24 第三轮）

- 机器人看到群里的图片/表情（多模态上下文里有图）时，可以顺手判一次：
  - 合人设：输出 `<dsh_im_sticker_tag>情绪词1,情绪词2</dsh_im_sticker_tag>` → `tagSticker()` 给该会话**最近自动收藏**的那张换文件名补标签；
  - 不合人设：输出 `<dsh_im_sticker_reject/>` → `removeSticker()` 删掉那张自动收藏，不进库。
- 两个标签只做动作、不算说话（`silent=false` 但无文字），不配解释；没把握时不输出，图保持 `随机` 标签。
- 实现：`sticker-library.mjs` 新增 `tagSticker/removeSticker`（只允许操作 `auto_` 开头且位于配置目录内的文件）；`qq-bridge.mjs` 新增 `#recentStickers`（每会话最近 5 张）与 `#applyStickerVerdict()`。
- 回归：`test-media-intent.mjs` 增补 4 项（标签/拒收/动作+静默/标签与发图并存）；`test-sticker-collect.mjs` 增补 5 项（改名、去重、删除、重复删除）。

## 19. 轻量 agent preset `qq-bot`（2026-10-24，给机器人省 90k+ tokens/轮）

**问题**：机器人会话在 bot-workspace 里跑，但继承整个 desktop profile 的 MCP 工具（blender / blender_agent / comfy / unity / cua / ego 浏览器…）。实测 `toolsTokens = 109,722`，其中 91.6k 与 QQ 无关；每次请求都背（prompt cache 命中也要付缓存价）。

**做法**：在 desktop profile 的 `cordis.patch.yml` 末尾追加一个 `@deepseek-ai/dsh-agent-preset` 行（id `qq-bot`），它只挂：
- `tool-web`（search/fetch）、`tool-ask-user`（提问转发）
- `qq-bot-restrict.mjs`（profile 根目录）：v2 用 `ctx.tools.restrict({ allow: [] })` 隐藏**全部继承的全局工具**；失败则用探测错误里的 `known global tools:` 清单改走 deny 名单，并在 5s/15s 补两轮（防 MCP 晚注册）。**v1 教训**：`allow` 里写 `web_search`/`ask_user_question` 会因「未知全局工具」整条抛错 → 一条都没藏住（103k 只降到 103k）。
- compaction 组（compaction-basic / command-compact / tool-result-pruner）

**落地文件**：
- 权威源（仓库内）：`tools\im-patch\qq-bot-preset\qq-bot-restrict.mjs` + `cordis.patch.append.yml`
- 实际安装：`%USERPROFILE%\.dsh\profiles\desktop\qq-bot-restrict.mjs`（+ `cordis.patch.yml` 末尾追加 preset 行）
- 备份：`cordis.patch.yml.bak-before-qq-bot-preset-20261024`
- 一键回滚：`tools\im-patch\回滚-qq-bot-preset.bat`（还原 patch + 删插件，然后重启 DSH）
- 运行日志：`%USERPROFILE%\.dsh\logs\qq-bot-restrict.log`（每次启动写 initial / retry 结果）

**启用步骤**（DSH 重启后；preset 只在新建会话生效，旧会话不变）：
1. 用主人 QQ 私聊机器人：`/presetlist` → 找到「QQ 聊天机器人（qq-bot）」的序号；
2. `/preset <序号>`（或 `/preset qq-bot`）；
3. 对每个想换的群/私聊发 `/new` 重建会话（**会清空该会话上下文**，介意就等它自然新建）；
4. 新会话的 `contextBreakdown.toolsTokens` 从 ~110k 降到 1k 左右，可用会话投影核对。

**实测（2026-10-24 14:35，DSH 0.2.1-rc.2）**：
- 旧会话（standard）：`toolsTokens 109,722` / `system 7,232` / 单轮 cacheRead ≈ 159k；
- 新会话（qq-bot）：`toolsTokens 1,207` / `system 6,470` / 首轮 `uncachedInput 10,549 + cacheRead 11,008`，**工具面 -98.9%**；机器人回复正常（「什么事？说吧」）。
- `~/.dsh/logs/qq-bot-restrict.log` 三行都是 `ok allow=[]`。

**风险与回滚**：`tools.restrict` 若在当前 DSH 版本报错，插件只打印日志、不阻塞启动（退化为不省 token）；若 preset 行导致 DSH 起不来，双击回滚 .bat 后重启即可。

### 18.8 watch 模式（每句都先看一眼，自己决定回不回）+ 标签误当工具的修复（2026-10-24 第四轮）

**watch 模式**（`behavior.json → watch`，**默认关**；2026-10-24 收紧过一次）：
- 群里没人叫机器人时，插件把这条**文本**消息递给 AI 看一眼（轻量 preset 下每轮约 10k 上下文）。
- prompt 末尾追加「【群消息观察】…判定要严格：只有明显在叫你/回复你/直接与你有关才接；别人之间的对话、片段/梗/表情包配文、带「你/你就是」但没指向你的、拿不准的，一律只输出 `<dsh_im_silent/>`」。
- 拦在代码层的碎片过滤：`minChars`（默认 6，`你就是`/`？`/`草` 这类直接不 watch）、纯符号消息、图片/文件/引用（`textOnly`）。
- 限速：`minIntervalMs`（默认 30000）、`maxPerHour`（默认 6）、`groups`（空=全部群）、`direct`（默认 false）、`botIds`（空=所有 bot；**同一个群两个 bot 都 watch 会一起接话**，想避免就只填一个 botId）。
- 开关：`behavior.json → watch.enabled: true` 才启用（热生效，不用重启）。
- 实现：`qq-bridge.mjs` 的 `#allowWatch()`；`#accept` 在 `!addressed` 时若允许就按 watch 模式入队，`#process` 跳过「必须被点名」闸门并追加指令。

**2026-10-24 事故记录**：开启 watch 后，群友之间一句 3 字的「你就是」被两个 bot 都看了，模型脑补成在说自己，于是 yuri 和椎名同时接话（「我什么时候变 ukino 了」「我就是什么」）。原因=① 模型把别人的「你」当成自己 ② 同群两个 bot 同时 watch。修复=上面的碎片过滤 + 严格判定提示 + 默认关闭 + `botIds` 限制。

**标签误当工具的修复**（群里出现「工具调用「dsh_im_silent」未成功」）：
- 现象：模型偶尔把 `<dsh_im_silent/>` 当成工具名去调用；DSH 返回 unknown tool 错误，插件把错误当正文发进群。
- 修复：`onUpdate` 里识别 `dsh_im_*` 虚拟标签名（silent/sticker/voice/sticker_tag/sticker_reject）→ 不报错、只记日志；`dsh_im_silent` 视为静默（不发消息）。同时在全局 `AGENTS.md` 增加「这些标签是正文，不是工具」的硬提示。

**回归**：17 个 `test-*.mjs` 仍全绿；本轮产物 9,126,xxx B（见 build-manifest）。**代码改动需再重启 DSH 一次**；`behavior.json` 的开关/参数热生效。

### 18.9 不抢话（2026-10-24 第五轮）

- **提示词（热生效）**：全局 `AGENTS.md` 新增「不抢话（硬规则）」——宁可漏接不插别人的话；别人互聊/引用回复别人/句子里有「你」但没指向你/拿不准，一律不接或只输出 `<dsh_im_silent/>`；接话窗口里对方转向别人时立刻停。两个 bot 人设卡同步加了一条。
- **代码（下次重启生效）**：`qq-bridge.mjs` 的 `#shouldReply()` 增加一条——**非主人**发来的消息如果带「引用/回复」且没有明确叫到机器人，就不再走接话窗口（直接不接），避免插进别人引用对话。主人不受影响。
- 与 watch 的关系：watch 已默认关闭；即使重新打开，`watch.minChars=6` + 严格判定提示 + 这条引用过滤都会同时生效。

### 18.10 被激将时要真的发语音（2026-10-24 第六轮）

- **现象**：群友用表情/文字激将（「这也不生气」），yuri 只回了文字「谁说不生气」，没有连发语音。
- **原因**：① 原规则写的是「**可以**连发 2~3 条语音」，模型当成可选项；② 单条调侃不够触发，模型选了更省事的文字；③ 代码里没有强制/提醒，TTS 本身是正常的（17862 `/health` ok，gpt-sovits + cuda + 两个音色已加载）。
- **修复（提示词，热生效）**：全局 `AGENTS.md` 与两张人设卡改成**硬规则**——被连续怼/被激将（「这也不生气」「你急了」「敢不敢」「别怂」「就这」）或被反复阴阳时，**必须优先用语音回应**，输出 1~3 个 `<dsh_im_voice>`，不能只发文字顶嘴。
- **修复（代码，下次重启生效）**：`qq-bridge.mjs` 新增 `PROVOKE_PATTERN` + 提示注入——命中激将词时，在 prompt 末尾追加「对方在激你/怼你，这次优先用语音回应」。
- 17 个测试全绿；TTS 健康检查通过。

### 18.11 群 @ 识别补强 + 拆条阈值降到 20（2026-10-24 第七轮）

- **现象**：群友用 QQ 的 @ 真名点到 yuri，连发三条都没有回复；而纯文字里带「yuri/大肥鱼」的消息能正常回。
- **原因**：群消息走的是全量 `GROUP_MESSAGE_CREATE`；正文里的 @ 标记是**群成员 openid**（如 `<@6FA4CEB7…>`），不是 appId，也不是 `mentions[].is_you`。`qq-mention.mjs` 只认「事件类型=GROUP_AT_MESSAGE_CREATE / mentions.is_you / `<@appId>`」三种，于是 @ 被当成普通消息丢掉。之前能回多半是「名字命中/接话窗口」，不是真的认出了 @。
- **修复（代码，下次重启生效）**：`qq-bridge.mjs` 新增导出 `mentionsBotByName()`——`mentions[]` 里的 `nickname/username/name/card` 命中机器人自己的名字/别名（来自 `bot.json`）就算被叫到；`#shouldReply()` 的 `explicit` 与 `mentionsSelf` 都用它。认不出的 @ 会往 `~/.dsh/logs/dsh-im/` 写一条一次性诊断（rawEventType + mentions + 内容片段），方便继续校准。
- **拆条阈值**：不是没拆，是原来的 `maxChars=60`；截图那条回复只有 52 字（两句话）所以没拆。现按主人要求改为 **20**：`behavior.json → replyChunking.maxChars = 20`（热生效，不用重启），`behavior-config.mjs` 默认值同步改 20。超过 20 字且 ≥2 句 → 拆成多条（实测 52 字回复拆成 2 条）。
- 回归：`test-chat-segments.mjs` 增补 52 字两句话拆条用例；`test-media-intent.mjs` 增补 nickname 命中/不命中 3 项；17 个测试全绿。

### 18.12 组合词唤醒 + watch 重新开启（带话题白名单，2026-10-24 第八轮）

**组合词唤醒**：yuri 的 `bot.json` 别名改为 `yuri / 小鲸鱼 / 鲸鱼片 / 吃鲸鱼 / DeepSeek / 大肥鱼`——单独的「鲸鱼」不再直接唤醒（避免群里随便聊鲸鱼都被它插话），但「鲸鱼片」「吃鲸鱼」「小鲸鱼」会直接叫醒。

**watch 重新开启（默认关 → 这次按主人要求开）**，新增限制把抢话风险压到很低：
- **话题白名单** `watch.topics[<botId>]`：只有消息里出现和机器人相关的关键词才进入「看一眼」流程。当前配置：yuri = 鲸鱼 / 鱼片 / 吃鱼 / 大肥鱼；椎名 = 姐姐 / 希罗 / hiro。其他消息不 watch。
- **频率**：`minIntervalMs=60000`（同会话 1 分钟一次）、`maxPerHour=4`、新增 `maxPerDay=30`。
- **不抢话过滤**：别人 @ 别人（mentions 里没有自己）→ 不 watch；图片/文件/引用回复 → 不 watch；纯符号/少于 6 字 → 不 watch；`/` 开头命令 → 不 watch。
- 判定提示仍是严格版：只有明显在叫你/回复你/直接与你有关才接，其余只输出 `<dsh_im_silent/>`。
- 实现：`#allowWatch()` 增加 `topics` 与 mentions-other 过滤、日限速；`behavior-config.mjs` 默认值同步（`minIntervalMs 60000 / maxPerHour 4 / maxPerDay 30 / topics {}`）。
- 生活示例：群友说「那么我要吃鲸鱼片」→ 直接唤醒 yuri（连发前会按人设接）；群友说「今天聊到鲸鱼」→ 落入 watch 看一眼，AI 觉得不相关就不回。

### 18.13 主动消息只发一个群 / 私聊收不到（2026-10-24 第九轮）

**现象**：yuri 的「该吃饭了」只在 1 个群出现；私聊没有；椎名一条都没有。

**原因**：
1. **私聊从来没配目标**：`behavior.json → proactive.bots[botId].targets` 原来只有两个 `group:`，没有 `c2c:`，所以私聊永远发不到（不是失败，是没配置）。
2. **一个群发过，其他群被全局冷却挡住**：旧 `tick()` 把 `record.lastSentAt`（整个 bot 上一次发送时间）传给每个目标做 120 分钟冷却判断。第一个目标发出去后 `record.lastSentAt = now`，**同一次检查里后面的目标全部被判 `cooldown`**；而 30 秒后的下一次 tick 依然被这个冷却挡住 → 一天下来基本只有第一个目标能收到。
3. **重启后 30 分钟内不算“安静”**：`lastActivityMs` 的兜底值是 `#startedAt`，DSH 刚重启就进入窗口的话会被当成“刚有人说话”，一直跳过。
4. **椎名**：两个目标都被上面 1/2/3 挡掉（state 里连记录都没建），加上它那段时间可能连接不可用，所以一条都没发。

**修复**：
- 每个目标独立预算与冷却：`minIntervalMinutesPerTarget`（默认 120）、`maxPerDayPerTarget`（默认 3）；全局 `maxPerDay` 提到 9 当安全阀。发过群 A 不再影响群 B / 私聊。
- `lastActivityMs` 兜底改为 0：没有真实活动记录 = 安静（重启后也能正常发）。
- 目标之间间隔 1 秒，避免同一秒连发。
- 新增私聊目标：yuri → `c2c:主人 openid`；椎名 → `c2c:椎名主人 openid`。
- `proactive-state.json` 现在记录 `counts` / `lastSentByTarget`（每目标计数与时间），方便排查。
- 回归：`test-proactive-scheduler.mjs` 新增「同一 tick 三个目标各发一条」「每目标 slot 不重复」；并修复测试里 `behavior.json` 同毫秒重写导致 mtime 缓存不刷新的 flaky（写入后强制递增 mtime）。17 个测试全绿。

### 18.14 语音消息转文字 + 私聊主动消息不打散（2026-10-24 第十轮）

**语音读不了（模型回「没转码工具，也听不到声音」）**：
- 原因：`qqInboundMessage()` 把音频附件（`.amr`/`.silk`）当普通文件塞进 `files`，模型收到的是文件路径，不能播放。
- 修复：音频附件改为读 QQ 自带的 `asr_refer_text`，作为正文 `[语音] …` 注入；不再进 `files`、也不再保存到 `.dsh-im/inbound/`。没有转写文字时显示 `[语音消息（没有可用的转写文字）]`，模型就不会再假装能放音。
- 回归：`test-media-intent.mjs` 增补「有 asr → 转成正文」「无 asr → 提示而不是文件」两项。

**椎名私聊没收到主动消息**：
- 椎名本身在线（19:11 还在群里回话），只是它今天的私聊目标被 ±25 分钟 jitter 排到了 17:2x，90 分钟窗口在 19:09 重启前就过期了 → 错过。
- 修复：**c2c（私聊）目标不打散**，固定按整点发（07:45 / 11:45 / 17:45），窗口 90 分钟，重启晚到也能发。群目标仍保留 ±25 分钟打散 + 30 分钟安静要求（避免打扰聊天）。

**注意**：这两个修复都是代码改动，需要重启一次 DSH 生效。

### 18.15 AI 主动冒泡（群安静时模型自己开口，2026-10-24 第十一轮）

**需求**：模板主动消息太机械、频率低；要像真人一样「群里安静时自己冒个泡」。

**设计**（`behavior.json → proactive.aiBubbles`）：
- 每个群独立计时：每 `checkIntervalMinutes`（45）± `jitterMinutes`（20）检查一次；
- 条件：群安静 ≥ `quietMinutes`（15）、落在 `hours`（08:00–23:00）、概率 `probability`（0.35）、距上次冒泡 ≥ `minIntervalMinutes`（60）、每群每天 ≤ `maxPerDayPerTarget`（6）、全局每天 ≤ `maxPerDay`（12）；
- 触发时由 `QqHarnessBridge.generateProactiveBubble(key)` 在该群**现有会话**里跑一轮模型：prompt 要求「像平时一样短（1~2 句、≤40 字），结合上下文自然开口，不要提主动机会/系统提示；不想说就输出 `<dsh_im_silent/>`」；返回 null（沉默/失败）则本次不发；
- 实现链路：`qq-proactive.mjs`（bubble 调度 + 状态 `bubbleCounts/bubbleLastAt/bubbleNextAt`）→ `qq-runtime.mjs`（`onBubble` 回调 + 发送）→ `qq-bridge.mjs`（生成）。
- 模板主动消息同时回落到每天 3 个时段（07:45/11:45/17:45，概率 0.7、每目标每天 3 条），把频率空间让给 AI 冒泡。

**成本**：每次冒泡约 1 万 token（≈0.2~0.4 分），按上面上限预计每群每天 2~5 条、每 bot 约 1~3 分钱/天；对话活跃时 `quietMinutes` 会自动跳过。

**回归**：`test-proactive-scheduler.mjs` 增补「安静 + 概率 1 时冒泡一次」「遵守下次检查间隔」两项；17 个测试全绿。**代码改动需重启一次 DSH。**

### 18.16 活跃群接话 + 复读接龙 + 提示词话题不接（2026-10-24 第十二轮）

**A+B 一起开**（`behavior.json → watch`）：
- `topics` 清空 = 所有**文字**消息都可能被“看一眼”；
- **活跃群模式**：最近 `activityWindowMinutes`（5 分钟）内至少 `activityMinMessages`（3 条）才进入 watch——冷场不打扰、热闹时自己判断；
- 限制：`minChars 8`、`minIntervalMs 120000`、`maxPerHour 4`、`maxPerDay 20`；
- **只给 yuri 先开**（`botIds: [yuri]`），避免两个 bot 同时接话；观察后再决定椎名。

**新规则 1：别人聊你的提示词/人设时不接**
- 代码层：`PROMPT_TALK_PATTERN`（提示词/系统提示/人设卡/设定/system prompt…）命中时 watch 与复读都不触发；
- 提示词层：全局 `AGENTS.md` + 两个人设卡都写了「讨论你的设定时静默，不承认不否认、这是内部信息」。

**新规则 2：复读接龙要跟上**
- 检测：同一段文字（去 @/空白/标点后）在 `repeatChainWindowMinutes`（5 分钟）内被 ≥`repeatChainMinSenders`（2）个**不同的人**复读；
- 命中后按普通接话流程回复，prompt 追加「大家在复读玩梗，跟上接一句很短的（复读/+1/吐槽），别长篇」；
- 独立冷却 `repeatReplyCooldownMinutes`（10 分钟），同一条接龙只接一次；
- 实现：`isRepeatChain()` 纯函数（可测）+ bridge 每会话最近聊天缓存（30 分钟/40 条）。

**回滚**：配置类全部热生效——把 `behavior.json` 里 `watch.enabled` 改 `false`（或整段恢复备份）即可，不用重启；备份在 `tools/im-patch/backup/behavior.json.bak-2026-10-24-before-watch-lively`。代码层若需回退，按 git 历史 revert 后重新 apply+重启。

**回归**：`test-media-intent.mjs` 增补复读检测 3 项（第三人命中/单人不算/过期不算）；17 个测试全绿。**代码改动需重启一次 DSH。**

### 18.17 引用机器人算点名 + 主人图片也能触发（2026-10-24 第十三轮）

**事故**：群友 WuKino 引用 yuri 自己的话「他就发个表情，我接啥」说「人家发表情你就回张表情呗」——明显在对 yuri 说话，但 yuri 没回；另外主人发的「大肥鱼照片」也没回。

**原因**：
1. 「不抢话」守卫写的是「非主人 + 带引用 → 不接」，**没区分引用的是谁**，于是引用机器人自己也被误杀；
2. watch 的 `textOnly: true` 会跳过所有图片/文件；`minChars: 8` 又会挡住短文字；活跃群门槛还要求 3 条消息——主人单发一张图永远进不了 AI。

**修复**：
- 新增 `#botTexts`（每会话最近 60 分钟自己的 20 条文字）+ `matchesOwnText()` 纯函数：**引用的内容是自己说过的 → 视为点名**（`explicit=true`），不再被不抢话守卫拦掉；每次发文字后 `#rememberBotText()` 记录。
- watch 增加 **owner media bypass**：主人发的图片即使没文字也进入“看一眼”（跳过 `textOnly`/`minChars`/活跃群门槛），让视觉模型自己判断要不要接。普通群友的图片/文件仍然跳过。
- 局限：`#botTexts` 是内存态，**重启前发过的消息被引用时认不出来**（重启后新发的可以）。

**回归**：`test-media-intent.mjs` 增补引用匹配 3 项（原文命中/标点不同命中/别人内容不命中）；17 个测试全绿。**代码改动需重启一次 DSH。**

### 18.18 引用兜底 + 主人短消息上下文判断 + 点名不许装死（2026-10-24 第十四轮）

**事故**：又一条引用 yuri 的话（「又沉默了，你在干嘛」）没回；主人单发「不理我」表情没回；群友发「yuuki喊的是yuri啦」没回。

**原因与修复**：
1. **引用兜底**：`#botTexts` 只记内存，引用重启前的旧消息认不出来。现在**引用消息一律进入 watch**（由 AI 判断引用的是不是它自己，`#process` 追加引用判断指令），不再依赖内存匹配；内存命中仍优先走“点名”快速路径。
2. **主人单独消息要看上下文**：watch 对**主人消息完全放开**（短文本、表情/图片、无文字都看），prompt 追加「这条是主人单独发的，结合上下文判断是不是在叫你——像『不理我』『在吗』这类就是要回」；其他群友的短碎片/图片仍按原限制。
3. **被点名却装死**：查会话记录发现「yuuki喊的是yuri啦」**已经进过模型**（turn 61），模型自己输出 `<dsh_im_silent/>`——它把「不抢话」规则过度套用了。现在给**被点名（名字/@/引用）的群消息**加系统提示：「明确叫到你，不要拿不抢话当理由装死，正常回一句」；同时排除“提示词/人设讨论”话题（那类仍静默）。

**回归**：17 个测试全绿；`verify-build` 待重启。**代码改动需重启一次 DSH。**

### 18.19 watch 所有人模式（含其他机器人，2026-10-24 第十五轮）

**需求**：不只主人，其他人（包括另一个机器人）发的消息都要“看一眼”并结合上下文判断是不是在跟 yuri 说话。

**实现**：
- 新配置 `watch.everyone`（默认 false，当前 **true**）：开启后所有人的消息（含 `senderIsBot=true`）都进入 watch；
- 放开该模式下原有的三道门：`minChars`、图片/文件跳过、活跃群门槛——AI 结合上下文自己判断；仍保留 `/` 命令过滤、话题白名单、mention-other 过滤（别人被 @ 时不看）；
- 其他机器人消息此前在 `#accept` 顶部被直接丢弃，现改为：`senderIsBot && 非点名 && 未接话` 时，只要 watch.everyone 打开就继续进入 watch；机器人互刷仍受 `#allowBotReply` 节流；
- prompt 追加：「这条消息可能来自任何人（包括其他机器人）：是否在跟你说话/与你有关，自己判断；别人在讨论你的设定/提示词时不接」；
- 限制：仍是每会话 1 分钟 1 次、每小时 6 次、每天 30 次（当前配置），yuri 先开（`botIds`），椎名未加。

**成本**：每条“看一眼”≈1 万 token（0.2~0.4 分），按上限每会话每天 30 次 ≈ 6 分；两个群约 12 分/天最坏值，实际远低。

**回滚**：`behavior.json → watch.everyone = false` 即恢复成“只有主人放宽”，热生效不用重启；或整段 `watch.enabled=false`。

### 18.20 接话窗口 / 判定集中化 / 决策日志 / 成本预算（2026-10-24 第十六轮，一次性打包）

> 详细决策与理由见 `docs/decisions-im-autonomy.md`（镜像仓）。

**接话窗口**
- 被点名/@ → 10 分钟；watch 触发的接话 → 5 分钟（`behavior.json → engagement`）。
- 窗口内每条消息追加“轻量判断”提示；模型连续沉默 `irrelevantMissLimit=2` 次 → 自动退出窗口。
- 收尾语（晚安/睡了/不聊了/拜拜…）→ 回最后一句后窗口 60 秒结束。
- 免打扰 `quietHours`（01:00–07:00）：只回点名/@；watch、复读、窗口续聊都不触发。
- 其他机器人不进接话窗口。

**引用判断**：引用不再直接算点名，引用后的正文交给模型判断（引用自己的话会加提示）；符合 Q1“引用要判断引用后发的消息是不是跟机器人说的”。

**判定集中化**：`#accept` 入口统一调用 `#decideInbound()` → `reply / watch / repeat / skip`，skip 与 watch 都带原因；watch 限速改为**按发送者**（同会话每个人各自 1 分钟 1 次，小时/日上限仍按会话）。

**决策日志 + /why**
- 每条消息的判定与结果写 `~/.dsh/integrations/dsh-im/decision-log/YYYY-MM-DD.jsonl`（消息前 24 字 + 原因，**保留 30 天**）。
- 主人发 `/why [N]` 查看最近 N 条判定和今日估算花费。

**成本预算**
- `behavior.json → budget`：每 bot 每天 **3 元**上限；回复/看一眼/冒泡分别估算 0.006/0.004/0.006 元。
- 超限后：只回点名/@、引用、复读接龙；watch 与 AI 冒泡停掉；记录在 `cost-budget.json`。

**测试**：新增 `test-decision-budget.mjs`（预算累计/上限、决策日志读写过滤、收尾语、免打扰跨午夜）——测试总数 **18 个全绿**。**本轮代码需重启一次 DSH。**
> 功能总览与实现索引见 [docs/features.md](../../../../im-bot-kit/docs/features.md)（镜像仓）；决策记录见 [docs/decisions-im-autonomy.md](../../../../im-bot-kit/docs/decisions-im-autonomy.md)。

### 18.21 引用内容结构化 + 最近群聊上下文（2026-10-24 第十七/十八轮）

**Bug 1：引用消息的 prompt 变成 `[object Object],[object Object]`**
- 原因：引用消息的模型内容 `content` 是结构化数组（`[{type:'text'},…]`），追加系统提示时用模板字符串拼接，数组被 `String()` 成 `[object Object]`；模型看不到引用和正文，只能沉默。
- 修复：新增 `appendPromptPart()`——string 拼接、数组追加 `{type:'text'}` part；6 处提示追加全部改用；上下文增强也跳过非字符串内容。回归测试 3 项。

**Bug 2：「才不是！」看起来完全没结合上下文**
- 原因：这条是普通文字/表情（没有 QQ 引用信息），模型看不到前一条「猫娘yuuki」，把「才不是」当成孤立一句话回答「啥才不是」。
- 修复：群消息每轮注入 **【最近群聊（按时间顺序）】**——同会话最近 15 分钟最多 8 条（带发言人，机器人标注 `(机器人)`，排除当前消息），让模型能推断「这句话在回谁」；同时区分「被点名」与「接话窗口」两种提示（不再给接话续聊加错提示）。

**测试**：18 个测试全绿。**代码改动需重启一次 DSH。**

### 18.22 连发消息合并回复（2026-10-24 第十九轮）

**现象**：同一人短时间内连发两句，机器人抢先回第一句、再回第二句——真人不会这样，应该等都看完再一起回。

**修复**：
- 新增 `behavior.json → replyCoalesce`（默认 `enabled:true, settleMs:2500, maxMessages:6`）；
- 走 `reply` 路径的普通聊天消息先进每会话的合并缓冲：`settleMs` 内再来的同人消息一起合并；命令、待回答问题/审批、批量输入、菜单不合并；
- 合并成一条模型 prompt（文本按行拼接、附件/mentions 合并，`messageId` 带 `#coalesced`），只回一次；原消息全部标记已读；
- 若上一轮还在生成，缓冲会等它结束后再一起处理（期间新消息继续并入），不会出现“两连答”；
- 回归测试：`mergeCoalescedMessages()` 文本/附件/mentions 合并、空列表返回 null。

**代价**：回复会晚 `settleMs`（默认 2.5 秒），换来“一次看完再回”的自然节奏。

### 18.22 最近群聊包含机器人自己 + 当前条之后的消息（2026-10-24 第十九轮）

- **自己发的话也要进上下文**：`#rememberOwnChat()` 把机器人刚发出的文字记进最近群聊，摘要里显示为 `你: …`；否则模型会误判“上一个说话的人是谁”。（语音/表情回复暂不记录。）
- **当前条用 `▶` 标出，并且带上它之后已经到达的消息**（连发/排队时最多 4 条）：摘要格式为「历史（最多 25 条）→ ▶ 当前 → 之后（最多 4 条）」，模型能知道「我在回哪句、后面别人又说了什么」。
- 时间窗仍为 15 分钟；`#recentChatBlock` 的窗口为「前 25 + 当前 + 后 4」。
- 回归测试：`formatChatDigest()` 覆盖自己消息标 `你`、其他机器人标 `(机器人)`、`▶` 当前条、前后顺序、过期过滤。

**测试**：18 个测试全绿。**代码改动需重启一次 DSH。**

