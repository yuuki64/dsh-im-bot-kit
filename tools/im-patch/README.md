# dsh-im 5.2.0 本地补丁：引用图片 + QQ 语音

> 本补丁集合并了两个会话的成果：
> - **引用消息取图（群归档）**：`bot-workspace` 会话完成 —— `group-history-store.mjs` 的
>   `imagesForPlatformMessage()` + `image-prompt.mjs` 导出 `DEFAULT_MAX_IMAGES`，本补丁集原样收录。
> - **引用消息取图（私聊缓存 / 微信）+ QQ 语音**：本会话新增，见下。
>
> `bot-session-im-patches`（原 `bot-workspace\im-patches\`，2026-10-22 已归档到 `reference/`）那套只改 `src/`、不重新打包，**单独使用不会生效**，已由本目录的
> `apply.mjs` 取代（保留作历史参考）。

对象：`@xmanrui/dsh-im` 5.2.0（安装位置 `C:\Users\yuuki\.dsh\profiles\desktop\node_modules\@xmanrui\dsh-im`）
补丁日期：2026-10-22
状态：**代码已改、已重新打包、已离线自测**；生效需要重启 DSH（插件在启动时加载 `lib/index.js`）。

## 0. 一句话恢复

插件重装/升级后补丁被冲掉时：

```powershell
cd "D:\project for deepseekharness\default-workspace\tools\im-patch"
node apply.mjs --check   # 先看缺什么
node apply.mjs           # 复制 9 个文件 + 补 silk-wasm + 重新打包
```

然后完全退出 DSH 再打开。注意补丁集按 5.2.0 的文件内容制作，插件版本不是 5.2.0 时脚本会拒绝（`--force` 等于把那几个文件降级，不推荐）。


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

微信：**平台侧没有发送语音的接口**（iLink 只有文本/图片/文件；收到的语音会带转写文本），所以微信这边没做，也做不了。

---

## 2. 依赖变化

- `silk-wasm@3.7.1` 直接放进了插件自己的 `node_modules`：
  `C:\Users\yuuki\.dsh\profiles\desktop\node_modules\@xmanrui\dsh-im\node_modules\silk-wasm`
  （插件 profile 由 pnpm 管理，下次重装插件时这个目录可能被删掉，删了语音就会提示"缺少 SILK 编码器"）
- 构建用的 esbuild/依赖只在本目录 `node_modules`，不污染 profile。

---

## 3. 重新打包

```powershell
cd "D:\project for deepseekharness\default-workspace\tools\im-patch"
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
Copy-Item "D:\project for deepseekharness\default-workspace\tools\im-patch\backup\lib-index.js.orig" `
  "C:\Users\yuuki\.dsh\profiles\desktop\node_modules\@xmanrui\dsh-im\lib\index.js" -Force

# 连源码一起回滚
Copy-Item "D:\project for deepseekharness\default-workspace\tools\im-patch\pristine\package\src\*" `
  "C:\Users\yuuki\.dsh\profiles\desktop\node_modules\@xmanrui\dsh-im\src\" -Recurse -Force
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

`reference/bot-session-im-patches/`（原 `D:\project for deepseekharness\bot-workspace\im-patches\`，2026-10-22 归档）是另一个会话（QQ 私聊）做的引用图补丁，结论：

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
- 设置持久化到 `C:\Users\yuuki\.dsh\integrations\dsh-im\voice.json`。
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
- `qq-bridge.mjs` 失败时会往 `C:\Users\yuuki\.dsh\logs\dsh-im\YYYY-MM-DD.log` 追加一行 JSON 诊断（含 referenceId、错误码、message、stage），用于追查 `INTERNAL_UNKNOWN` 这类只有参考号的错误。
- 本目录 `apply.mjs` 的文件清单已同步到 13 个文件（新增 `bot-workspace-store.mjs`、`group-reasoning.mjs`、`kokoro-tts.mjs`）。
- 仍需要重启 DSH 才会加载新 bundle。

---

## 8. 第三轮补丁（2026-10-22 傍晚：Kokoro 二次元音色 + 自然语言语音）

### 8.1 音色换成本地 Kokoro-82M（二次元女声）
- 选型：**Kokoro-82M**（GitHub 2025-2026 最火的开源轻量 TTS 之一，82M 参数、MIT 系许可），中文音色 `zf_xiaobei / zf_xiaoni / zf_xiaoxiao / zf_xiaoyi`（少女音）。通过 `sherpa-onnx-node` 在 Node 进程内跑 ONNX，**不需要 Python、不需要服务器、离线**。
- 模型/运行时放在 `C:\Users\yuuki\.dsh\integrations\dsh-im\tts\`（约 400 MB：`kokoro-multi-lang-v1_0` fp32 模型 + espeak 数据 + `node_modules/sherpa-onnx-node`）。
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
  1. `C:/Users/yuuki/.dsh/integrations/dsh-im/stickers`（自己往里丢图就能用）
  2. QQ 收藏表情：`D:/yuuki/qq/Tencent Files/1285567817/nt_qq/nt_data/Emoji/personal_emoji`（含 Ori 原图与 Thumb 缩略图）
  3. QQ 商城表情缓存：`.../Emoji/marketface`
- 实测扫描出 **4884** 张（jpg 2351 / png 2497 / gif 36），首次扫描约 0.9 s，缓存 10 分钟。
- 配置：`C:/Users/yuuki/.dsh/integrations/dsh-im/stickers.json`（可改 dirs / maxBytes）。

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
| Python 3.11.9 | `D:\tools\Python311` | 独立安装，不污染系统 |
| PyTorch 2.6.0+cu124 / torchaudio | 同上 site-packages | 2.4 GB 轮子从南大镜像分块下载后本地安装；`torch.cuda.is_available()=True`（RTX 4060 Laptop） |
| f5-tts 1.1.22 + 依赖 | 同上 | 官方 PyPI 包（清华镜像） |
| F5-TTS v1 Base 模型 | `D:\tools\tts-gpu\models\F5TTS_v1_Base` | 1.29 GB，从 hf-mirror 下载 |
| 服务端 | `D:\tools\tts-gpu\server.py` | 本地 17861，模型常驻显存，`POST /tts` 返回 WAV |
| 角色参考 | `D:\tools\tts-gpu\characters\<名字>.wav` + `<名字>.txt` | `default` 为占位（Kokoro 克隆）；换成角色素材即可 |

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
3. 保存为 `D:\tools\tts-gpu\characters\<名字>.wav` 和同名 `.txt`
4. QQ 里 `/voice char <名字>` → `/voice test`

### 10.5 许可与边界（重要）
- F5-TTS **模型权重是 CC-BY-NC 4.0（仅非商用）**，代码 MIT。个人/自用没问题；**商用（闲鱼交付、收费内容）不能用这套权重**，要换许可更宽松的模型（如 CosyVoice 系列，需自行核对许可）。
- 角色音色属于他人声音/角色形象，二次元角色克隆用于公开传播有侵权风险；自己玩可以，别拿去卖。
- sidecar 占用显存约 1.5–2 GB；打游戏前可关掉进程（下次用语音会自动拉起）。

### 10.6 换上「大肥鱼」音色（2026-10-22）

- 数据源：ModelScope `YinZilu/da-fei-yu-girl-voice-zh`（CC-BY-NC 4.0，56 条 / 9 分 53 秒，B 站 UP 主尹紫鹭幻想社自调少女音色）。
- 取了第 1 条（13.9 s，44100 Hz mp3）→ 用 `soundfile + torchaudio` 转成 24 kHz 单声道 WAV，转录文本取自 `metadata.csv`：
  - `D:\tools\tts-gpu\characters\dafeiyu.wav`（13.9 s）
  - `D:\tools\tts-gpu\characters\dafeiyu.txt`
- 默认音色已切到 `f5 / dafeiyu`（`C:\Users\yuuki\.dsh\integrations\dsh-im\voice.json`）。
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
- 代码：GitHub API zipball 下载（GitHub 网页/Release 被墙，`api.github.com/repos/.../zipball` 可用）→ `D:\tools\gpt-sovits\RVC-Boss-GPT-SoVITS-b4570b8`
- 环境：独立 venv `D:\tools\gpt-sovits\venv`（Python 3.11 + torch 2.6.0+cu124 + transformers 4.57 + gradio 4 + tensorboard + funasr 等）
  - 补丁：`jieba_fast`→`jieba`（3 个文件）；ffmpeg 用 `imageio-ffmpeg` 提供的二进制复制到 `D:\tools\bin\ffmpeg.exe`
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
- `D:\tools\gpt-sovits\server.py`，端口 **17862**，`POST /tts` 返回 WAV；默认读 `tts_infer_finetuned.yaml`（custom 块指向微调权重）
- 启动：`D:\tools\gpt-sovits\venv\Scripts\python.exe server.py --port 17862 --preload`
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
- 目录：`C:\Users\yuuki\.dsh\integrations\dsh-im\personas\`，一个角色一个 `.md`，文件名即角色名。
- 当前生效：`integrations/dsh-im\persona.md`（内容 == 某个 personas/*.md 的拷贝）
- 注入方式：`shared/persona.mjs` 把 persona 追加到通道的 `sourceGuidance`，QQ 和微信 bridge 都改成了 `applyPersona(...)`；因此**所有 QQ/微信 bot 会话生效**，本机 DSH 会话不受影响。
- 生效时机：改文件后**下一条消息即生效**，不用重启；persona 为空则完全不注入。
- 已收录：`傲娇助手.md`、`小鲸鱼.md`（来自 Derpyu520/qq-bridge 的 roles，按本插件能力做了少量改写）、`README.md`（格式说明）。

### 12.3 与 Derpyu520/qq-bridge 的差异（简）
- 对方强在：OneBot/SnowLuma 接全量 QQ 消息、控制台、token/花费看板、社会仿真（潜水/主动接话）、黑话学习、表情 CDN 兜底、每会话初始提示词、每会话模型选择、审批转发、长轮询等（v0.2.0-r4，适配 DSH 0.2.0-rc.2）。
- 我们强在：DSH 原生插件（无独立桥接进程/无 OneBot 依赖）、QQ 官方机器人 API + 微信通道、引用图片/文件可读、群历史归档 + 查询工具、语音（GPT-SoVITS 微调/F5/Kokoro）、表情包库、群推理上限、访问边界策略。
- 本轮已吸收：人设提示词机制（personas + 注入）。未吸收（按需再说）：控制台/token 看板、社会仿真、黑话学习、每会话模型选择、表情 CDN。
