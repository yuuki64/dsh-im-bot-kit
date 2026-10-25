# B 站视频内容 决策记录（2026-10-25）

## 背景

群里有人发 B 站链接（截图里是「token之王」视频），yuri 回“视频我打不开，讲啥的”。原因不是没工具，而是：
1. AGENTS 群聊链接规则写着“只做静态判断，绝不访问原链接”；
2. 即使能抓，B 站视频页是 JS 渲染，`web_fetch` 拿不到视频内容；
3. B 站字幕接口现在登录才能取（匿名返回空字幕列表）。

## 已确定（主人确认）

- **A+B（默认）**：链接先做静态判断 + `web_search` 识别标题/UP主；B 站链接例外允许读公开元数据（官方 view API，游客可用）。
- **C（真看视频，暂时只对 B 站开放，其他人也可用）**：
  1. **字幕优先**：用 SESSDATA（只存本机、不写日志、不外发）生成 cookies 文件，yt-dlp 取 AI 字幕；
  2. **ASR 兜底**：无字幕时 yt-dlp 下音频 → faster-whisper 本地转写（GPU/CUDA 自动，CPU 兜底），不调用云端 API、不产生费用；
  3. 只取**音频内容**，画面不获取；prompt 明确“没看画面，不要编造画面细节”；
  4. 结果缓存 7 天；单视频时长上限 30 分钟；转写截断 6000 字。
- 后续可把白名单扩展到其他站点（需主人逐个确认）。

## 已落地

- 新模块 `src/channels/shared/video-helper.mjs`：
  - 识别 BV / av / b23 短链；
  - B 站 view API 取元数据；
  - yt-dlp 取字幕/音频（依赖：`~/.dsh/integrations/dsh-im/video/venv` 里的 yt-dlp + faster-whisper）；
  - faster-whisper 转写（medium 模型，CUDA 优先）；
  - 本地缓存 + 截断 + prompt 块生成。
- `qq-bridge.mjs`：消息里检测到 B 站链接时，把视频内容块注入 prompt（群里所有人可用）。
- 配置 `behavior.json → video`：`enabled / subtitleEnabled / asrEnabled / sessdata / whisperModel / whisperDevice / maxDurationSeconds / maxTranscriptChars / cacheDays`。
- `AGENTS.md`：链接规则增加 B 站例外；明确“只按音频/字幕回答，没看画面不描述画面”。
- 测试：`test-video-helper.mjs` 12 项；总测试 20 个全绿。

## 验证

- 无 cookie、无字幕的 40 秒视频：元数据 0.2s，ASR 兜底约 14.7s（medium + CUDA），转写成功；二次访问缓存 0.0s。
- **字幕路径已验证**（2026-10-25，小号 cookie）：`BV1YydJBJEuF` 能取到 `ai-zh` 字幕，插件端到端返回 `source=subtitle`，转写内容准确、走缓存 0.0s。
- 字幕获取：cookies 文件只存本机 `~/.dsh/integrations/dsh-im/video/cookies.txt`（已用主人的**小号** SESSDATA，主号未使用）；不进 git、不回显、不外发。
- 仍待首轮真机：重启后在群里发有字幕的视频，确认回复内容与字幕一致。

## 安全说明（SESSDATA）

- SESSDATA 等价“已登录态”，不是密码；泄露可被操作网页功能，但改密码/退出所有设备可立即失效。
- 降低风险的做法：用**小号** cookie；只在本地 yt-dlp 调用时读取；低频使用；不碰付费/充电视频；不用于自动评论/互动。
- 一旦怀疑泄露：B 站「退出所有设备」或改密码 → 该 cookie 立即失效（字幕功能会失效，可换新 cookie，或退回本地 ASR）。


## 回滚

- 热关：`behavior.json → video.enabled=false`（不再处理 B 站链接）。
- 只关 ASR：`video.asrEnabled=false`（只取字幕/元数据）。
- 删缓存：`~/.dsh/integrations/dsh-im/video/cache/`。
- 删依赖：删 `~/.dsh/integrations/dsh-im/video/venv`（约 1.5~2 GB 含模型缓存）。
