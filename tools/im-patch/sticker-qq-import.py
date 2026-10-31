# Stage the newest QQ collected stickers for import: detect real format, copy/compress, build tag batches.
#
# Run with the DSH bundled Python (has Pillow):
#   python sticker-qq-import.py
import hashlib
import json
import os
import shutil

# 个人值不进仓库：环境变量优先，其次仓库根的 config.local.json（已 gitignore，样例见 config.local.example.json）。
#   QQ_DATA            整体覆盖，指向 "Tencent Files\<你的QQ号>"
#   qqDataRoot + qqNumber   config.local.json 里的写法，脚本自己拼上 QQ 号
_HERE = os.path.dirname(os.path.abspath(__file__))
_CONFIG_PATH = os.environ.get("IM_BOT_KIT_CONFIG") or os.path.join(_HERE, "..", "..", "config.local.json")


def _local_config():
    try:
        with open(_CONFIG_PATH, "rb") as handle:
            return json.load(handle)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _local_value(key, env_name, default):
    value = os.environ.get(env_name)
    if value and value.strip():
        return value.strip()
    value = _local_config().get(key)
    if isinstance(value, str) and value.strip():
        return value.strip()
    return default


_QQ_DATA_ENV = (os.environ.get("QQ_DATA") or "").strip()
if _QQ_DATA_ENV:
    QQ_DATA = _QQ_DATA_ENV
else:
    _ROOT = _local_value("qqDataRoot", "", "")
    _NUMBER = _local_value("qqNumber", "", "")
    QQ_DATA = os.path.join(_ROOT, _NUMBER) if _ROOT and _NUMBER else os.path.join(os.getcwd(), "Tencent Files", "<QQ号>")
ORI = os.path.join(QQ_DATA, r"nt_qq\nt_data\Emoji\personal_emoji\Ori")
THUMB = os.path.join(QQ_DATA, r"nt_qq\nt_data\Emoji\personal_emoji\Thumb")
OUT = _local_value("stickerImportOut", "STICKER_IMPORT_OUT", r".\_sticker-import")
LIMIT = 500
MAX_BYTES = 3 * 1024 * 1024 - 4096
BATCH_SIZE = 34

from PIL import Image, ImageSequence  # noqa: E402


def detect(path):
    with open(path, "rb") as handle:
        head = handle.read(16)
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    if head[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if head[:3] == b"\xff\xd8\xff":
        return "jpg"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    return None


def save_static(img, path, ext):
    if ext == "png":
        img.save(path, "PNG", optimize=True)
    elif ext == "webp":
        img.save(path, "WEBP", quality=88)
    else:
        img.convert("RGB").save(path, "JPEG", quality=88, optimize=True)


def compress_gif(path, target):
    img = Image.open(path)
    frames = [frame.convert("P", palette=Image.ADAPTIVE) for frame in ImageSequence.Iterator(img)]
    duration = img.info.get("duration", 80)
    loop = img.info.get("loop", 0)
    scale = 1.0
    while True:
        current = frames if scale == 1.0 else [frame.resize((max(16, int(frame.width * scale)), max(16, int(frame.height * scale))), Image.LANCZOS) for frame in frames]
        current[0].save(target, "GIF", save_all=True, append_images=current[1:], duration=duration, loop=loop, optimize=True)
        if os.path.getsize(target) <= MAX_BYTES or scale <= 0.35:
            return
        scale *= 0.8


def compress_static(path, target, ext):
    img = Image.open(path)
    scale = 1.0
    while True:
        work = img
        if scale != 1.0:
            work = img.resize((max(16, int(img.width * scale)), max(16, int(img.height * scale))), Image.LANCZOS)
        if ext == "gif":
            save_static(work, target, "png")
        else:
            save_static(work, target, ext)
        if os.path.getsize(target) <= MAX_BYTES or scale <= 0.3:
            return
        scale *= 0.8


def main():
    os.makedirs(OUT, exist_ok=True)
    fdir = os.path.join(OUT, "files")
    bdir = os.path.join(OUT, "batches")
    shutil.rmtree(fdir, ignore_errors=True)
    shutil.rmtree(bdir, ignore_errors=True)
    os.makedirs(fdir)
    os.makedirs(bdir)

    files = []
    for name in os.listdir(ORI):
        path = os.path.join(ORI, name)
        if os.path.isfile(path):
            files.append((os.path.getmtime(path), name))
    files.sort(reverse=True)
    selected = files[:LIMIT]

    candidates = []
    for _, name in selected:
        md5 = os.path.splitext(name)[0].upper()
        src = os.path.join(ORI, name)
        real = detect(src) or "jpg"
        target_name = f"{md5}.{real}"
        target = os.path.join(fdir, target_name)
        size = os.path.getsize(src)
        compressed = False
        if size <= MAX_BYTES:
            shutil.copyfile(src, target)
        else:
            if real == "gif":
                compress_gif(src, target)
            elif real == "gif":
                compress_static(src, target, "gif")
            else:
                compress_static(src, target, real)
            compressed = True
        thumb = os.path.join(THUMB, f"{md5}.png")
        candidates.append({
            "md5": md5,
            "file": os.path.basename(target),
            "path": target,
            "real": real,
            "source": src,
            "thumb": thumb if os.path.exists(thumb) else target,
            "bytes": os.path.getsize(target),
            "compressed": compressed,
        })

    with open(os.path.join(OUT, "candidates.json"), "w", encoding="utf-8") as handle:
        json.dump(candidates, handle, ensure_ascii=False, indent=1)

    for index in range(0, len(candidates), BATCH_SIZE):
        batch = candidates[index:index + BATCH_SIZE]
        payload = [{"md5": item["md5"], "path": item["thumb"]} for item in batch]
        with open(os.path.join(bdir, f"batch-{index // BATCH_SIZE:02d}.json"), "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=1)

    total = sum(item["bytes"] for item in candidates)
    gifs = sum(1 for item in candidates if item["real"] == "gif")
    print(f"selected={len(candidates)} gifs={gifs} total={total / 1048576:.1f}MB compressed={sum(1 for item in candidates if item['compressed'])}")
    print(f"batches={len(os.listdir(bdir))} out={OUT}")


if __name__ == "__main__":
    main()
