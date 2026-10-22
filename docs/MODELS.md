# 模型与运行时文件清单（不在仓库/备份里，需要时重新下载）

这些文件体积大（合计约 4–6 GB），可从公网重新获取，因此没有放进 git 仓库和默认备份 zip。
换电脑或恢复时按此表放回对应位置。

## GPT-SoVITS（`D:\tools\gpt-sovits`）

| 文件 | 大小 | 来源 |
| --- | --- | --- |
| `RVC-Boss-GPT-SoVITS-<hash>\` 源码 | ~7 MB | `https://api.github.com/repos/RVC-Boss/GPT-SoVITS/zipball`（网页被墙时可用） |
| `GPT_SoVITS\pretrained_models\chinese-hubert-base\` | 180 MB | hf-mirror `lj1995/GPT-SoVITS` |
| `GPT_SoVITS\pretrained_models\chinese-roberta-wwm-ext-large\` | 621 MB | 同上 |
| `GPT_SoVITS\pretrained_models\gsv-v2final-pretrained\` | 340 MB | 同上（s1 ckpt + s2G + s2D） |
| `GPT_SoVITS\pretrained_models\fast_langdetect\{lid.176.bin,lid.176.ftz}` | 126 MB | `https://dl.fbaipublicfiles.com/fasttext/supervised-models/` |
| `GPT_SoVITS\text\G2PWModel\` | 561 MB | hf-mirror `XXXXRT/GPT-SoVITS-Pretrained` 的 `G2PWModel.zip` |
| `venv\` | ~6 GB | 见 `tools/voice/gpt-sovits/README.md`，用官方 wheel 重建 |
| `models\F5TTS_v1_Base\` | 1.29 GB | hf-mirror `SWivid/F5-TTS`（F5 服务用） |

微调产物（**已在备份里**，81 MB）：`weights\dafeiyu_e4_s16.pth`
参考音（**已在备份里**）：`characters\dafeiyu.{wav,txt}`
数据集清单（**已在备份里**）：`dataset\metadata.csv`、`dataset\dafeiyu.list`

## F5-TTS（`D:\tools\tts-gpu`）

| 文件 | 大小 | 来源 |
| --- | --- | --- |
| `node_modules\sherpa-onnx-node` | 40 MB | npm |
| `models\kokoro-multi-lang-v1_0\` | 346 MB | hf-mirror `csukuangfj/kokoro-multi-lang-v1_0` |
| `models\kokoro-int8-multi-lang-v1_1\espeak-ng-data\` | 31 MB | hf-mirror `csukuangfj/kokoro-int8-multi-lang-v1_1` |
| `models\F5TTS_v1_Base\` | 1.29 GB | hf-mirror `SWivid/F5-TTS` |
| `characters\` | 小 | 自备参考音（已在备份里） |

## Python 运行时

- `D:\tools\Python311`（3.11.9，安装包 26 MB，可重新安装）
- `D:\tools\gpt-sovits\venv`（torch 2.6+cu124、f5-tts、funasr 等，重建见 README）
- `D:\tools\bin\ffmpeg.exe`（`pip install imageio-ffmpeg` 后复制）

## 校验方式

恢复后跑一遍：

```powershell
# 语音服务健康
Invoke-RestMethod http://127.0.0.1:17862/health
# 插件补丁是否在 bundle 里
Select-String "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@xmanrui\dsh-im\lib\index.js" -Pattern "dsh_im_voice","17862" -SimpleMatch
```
