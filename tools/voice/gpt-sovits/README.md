# GPT-SoVITS 微调音色服务

零样本 / 微调克隆音色，跑在本机 4060 上，HTTP `POST /tts` 返回 24k/32k WAV。

## 一次性安装

```powershell
# 1. Python 3.11（独立安装，不污染系统）
#    下载 python-3.11.9-amd64.exe，静默安装到 D:\tools\Python311

# 2. 独立 venv
D:\tools\Python311\python.exe -m venv D:\tools\gpt-sovits\venv
$py = D:\tools\gpt-sovits\venv\Scripts\python.exe

# 3. torch CUDA（用本地 whl 或官方 index）
$py -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124

# 4. 代码（GitHub 网页被墙时用 API zipball）
#    https://api.github.com/repos/RVC-Boss/GPT-SoVITS/zipball -> 解压到 D:\tools\gpt-sovits\
#    目录名以 RVC-Boss-GPT-SoVITS-<hash> 开头

# 5. 依赖（清华镜像）
$py -m pip install numpy<2 scipy librosa==0.10.2 numba pytorch-lightning ffmpeg-python `
  onnxruntime-gpu tqdm funasr cn2an pypinyin g2p_en sentencepiece "transformers>=4.51,<5" `
  "peft<0.18" PyYAML psutil jieba split-lang fast_langdetect wordsegment rotary_embedding_torch `
  opencc fastapi x_transformers "torchmetrics<=1.5" "pydantic<=2.10.6" chardet modelscope `
  gradio<5 tensorboard resampy imageio-ffmpeg

# 6. 预训练权重（hf-mirror，放到 GPT_SoVITS\pretrained_models\）
#    chinese-hubert-base、chinese-roberta-wwm-ext-large、
#    gsv-v2final-pretrained\{s1*.ckpt, s2G2333k.pth, s2D2333k.pth}
#    fast_langdetect\{lid.176.bin,lid.176.ftz}、G2PWModel、nltk_data

# 7. ffmpeg（imageio-ffmpeg 自带，复制成 D:\tools\bin\ffmpeg.exe 并加 PATH）
```

## 启动

```powershell
$py = D:\tools\gpt-sovits\venv\Scripts\python.exe
$env:PATH = "D:\tools\bin;$env:PATH"
$py D:\tools\gpt-sovits\server.py --port 17862 --preload
```

`--preload` 会先加载模型再监听；不预加载则首个请求多等约 30 秒。

## 参考音 / 角色

```text
characters\<名字>.wav   3–10 秒干净人声（16k/24k/32k 单声道均可）
characters\<名字>.txt   这段音频的逐字文本
```

`character` 参数传名字即可；缺失时回退到 `dafeiyu`。

## 微调（可选，效果更稳）

1. 数据：`dataset\wav32k\*.wav` + `dataset\<名字>.list`（`路径|speaker|zh|文本`）
2. 预处理：在仓库根目录设置环境变量后依次运行
   `GPT_SoVITS\prepare_datasets\{1-get-text,2-get-hubert-wav32k,3-get-semantic}.py`
   - `inp_text`、`inp_wav_dir`、`exp_name`、`opt_dir`
   - `bert_pretrained_dir`、`cnhubert_base_dir`、`pretrained_s2G`、`s2config_path`
   - 注意 cwd 必须是仓库根目录（`text` / `tools` 包与 `GPT_SoVITS/text/G2PWModel` 路径都依赖它）
3. 训练：`s2_train.py --config s2_<名字>.json`（4–8 epoch）
4. 导出：用 `process_ckpt.savee` 把 `logs\...\G_*.pth` 转成推理格式
5. 推理：`tts_infer_finetuned.yaml` 的 `custom.vits_weights_path` 指向导出权重，重启服务

## 已知坑

- `jieba_fast` 在 Windows 编不出来 → 把 3 个文件里的 `import jieba_fast as jieba` 改成 `jieba`
- CV2/ffmpeg 缺失 → 用 `imageio-ffmpeg` 提供的二进制
- G2PW 会试图下载 → 本地放好 `GPT_SoVITS/text/G2PWModel`
- 显存：模型常驻约 1.5–2 GB；只保留一个 sidecar
- 输出削波会听起来发颤 → `wav_bytes` 里做 int16→float 缩放与峰值归一化
