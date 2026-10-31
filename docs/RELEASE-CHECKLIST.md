# 公开发布前检查清单

> 建立于 2026-10-28，用于"发 B 站 / 对外开源"前的自查。
> 每次准备公开（视频、贴子、给陌生人仓库链接）之前，从头跑一遍第 4 节的命令。

## 1. 当前事实（别自我安慰）

- 仓库 `yuuki64/dsh-im-bot-kit` 是 **public**，2026-10-22 起已推送，171 个提交。
- 因此下面这些信息**已经出现在公开的 git 历史里**（不是"即将泄露"，是"曾经泄露"）：
  - 两个 bot 的主人 openid（qq 官方的用户标识，非密钥）
  - 本机 QQ 号
  - 两个 bot 的 appId（3d15542）
  - 三个真实 botId
  - `behavior.json.bak-*`（含会话 key `c2c:<openid>`）
  - 本机路径 `D:\tools`、`<QQ_DATA_ROOT>\qq`、`C:\Users\<用户名>\OneDrive`
- 风险评级：**低**（AppID / openid 不是密钥，泄露不能直接登录或操作 bot），但 QQ 号属于个人信息，会被爬虫抓。
- `0 star / 0 fork`，实际上大概率没人看过。

> 2026-10-31 更新：已用 `git filter-repo` 重写历史并强推（任务 H），上面第 1、3 节列的
> 主人身份标识、QQ 号、appId、真实 botId、本机路径都已在历史里替换成占位值；原值本身仍需按第 4 节每次自查。

## 2. 本轮已清理（工作树）

| 项 | 处理 |
|---|---|
| 人设卡里的主人 openid（`configs/personas/小鲸鱼.md`、`configs/persona.example.md`、`tools/im-patch/README.md`） | 换成 `<MASTER_OPENID>` |
| `docs/features.md` 的两个 appId | 换成 `<APP_ID>` |
| `tools/im-patch/sticker-qq-import.py` 里的 QQ 号 + 绝对路径 | 改成 `QQ_DATA` / `STICKER_IMPORT_OUT` 环境变量 |
| `tools/im-patch/test-bot-wake.mjs` 的三个真实 botId | 改成 `BOT_ID_HIRO` / `BOT_ID_YURI` 环境变量，未设置时 skip |
| `tools/im-patch/backup/behavior.json.bak-*` | `git rm --cached`（仓库移除，本地保留），并加入 `.gitignore` |
| `docs/CURRENT-STATE.md` 的 OneDrive 用户名路径 | 换成"本地 OneDrive 桌面" |

**注意**：以上只清理了当前工作树。历史提交里仍然有，见第 3 节。

## 3. 需要用户拍板的（本 agent 没有直接做）

1. **要不要重写历史**（`git filter-repo` / BFG + force push）？
   - 收益：后来的人翻不到这些信息。
   - 代价：改写后 171 个 commit 的 hash 全变；如果已经有人 clone 过（目前 0 fork，风险小），对方会冲突。
   - 结论：0 fork 的情况下值得做，但**必须先备份**，且要在推送前确认 `.github-token` 没有残留。
2. **要不要把仓库暂时转 private**，等清理完再公开？
   - 最稳的做法：转 private → 重写历史 → 再 public。
3. **B 站视频里要不要出现真实 bot**（群号、机器人名）？
   - 出现就必须接受"有人会去搜这个仓库和这个群"。

## 4. 发布前必做（每次都要跑）

```powershell
cd <WORKSPACE>\im-bot-kit

# 4.1 凭据 / 身份扫描（应为空；把 <...> 换成你自己的值再跑）
git grep -n -I -E '<你的openid前缀>|<你的QQ号>|ghp_|sk-[A-Za-z0-9]{16,}' -- .

# 4.2 绝对路径（应只出现在占位符说明里）
git grep -n -I -E 'C:\\\\Users\\\\[a-z]|D:\\\\yuuki|OneDrive' -- .

# 4.3 大资产 / 音频 / 权重（应为空）
git ls-files | Select-String -Pattern '\.(wav|mp3|ogg|pth|ckpt|onnx|safetensors|db|sqlite|gif|png|jpg)$'

# 4.4 token 文件（必须显示 ignored）
git status --porcelain --ignored | Select-String 'github-token'

# 4.5 本地个人值文件确实被忽略（应显示 config.local.json 在 ignored 列表里）
git status --porcelain --ignored | Select-String 'config.local.json'
```

## 5. 永远不要进仓库的东西

- `.github-token` / `AppSecret` / 任何 `*token*` 真实值
- `integrations/` 下的运行时数据：`persona.md`、`voice.json`、`bots/`、`group-history.sqlite`、`stickers.json`
- 模型权重：`*.pth` `*.ckpt` `*.onnx` `*.safetensors`、`weights/`、`characters/`、`dataset/`
- 音色参考音：`*.wav`（含从游戏/动画提取的语音）
- 表情图片：QQ 收藏/商城表情属于他人版权
- 真实 openid、botId、appId、QQ 号、群号、AppSecret

## 6. 开源定位（写视频文案时别跑偏）

- **别卖"能接 QQ"**：腾讯官方已经有 [`tencent-connect/dsh-qqbot`](https://github.com/tencent-connect/dsh-qqbot)，2026-08 官宣。
- **卖"接上之后像个人"**：音色、语调、表情、接话判断、人设卡——这些是官方插件没有的。
- 视频素材优先级：**同一句话的语音对比 > 群聊接话片段 > 架构讲解**。代码没人看。
- 试玩形态受平台限制：个人认证机器人只能加"自己是群主"的群，且不能公开使用——所以是"进我的群试"，不是"给你一个 bot 自己玩"。
