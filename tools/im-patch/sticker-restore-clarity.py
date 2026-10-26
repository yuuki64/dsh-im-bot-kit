# Rebuild sticker library from the staged originals with higher resolution (default 320px) to restore clarity.
# - static images: LANCZOS resize, PNG stays lossless, JPEG/WebP at high quality
# - GIF: keep original bytes when already <= MAX_EDGE and <= 3MB (no palette re-quantization); otherwise resize frames
# Tags come from merged-tags.json (same as the first import).
#
#   python sticker-restore-clarity.py [--max-edge 320]
import json
import os
import shutil
import sys

from PIL import Image, ImageSequence

STAGE = r"D:\project for deepseekharness\default-workspace\tools\im-patch\_sticker-import"
LIB = r"C:\Users\yuuki\.dsh\integrations\dsh-im\stickers"
import time
ARCHIVE = os.path.join(
    r"C:\Users\yuuki\.dsh\integrations\dsh-im\_archive",
    f"stickers-rebuild-{time.strftime('%Y%m%d-%H%M%S')}",
)
MAX_EDGE = 320
MAX_BYTES = 3 * 1024 * 1024 - 8192


def fit_size(width, height, limit):
    if max(width, height) <= limit:
        return (width, height)
    scale = limit / max(width, height)
    return (max(8, int(round(width * scale))), max(8, int(round(height * scale))))


def resize_static(src, dst, limit):
    img = Image.open(src)
    size = fit_size(img.width, img.height, limit)
    work = img if size == img.size else img.resize(size, Image.LANCZOS)
    # 小尺寸下 PNG 无损比 JPEG 明显清楚（没有压缩噪点/糊边）。
    work.save(dst, "PNG", optimize=True)


def resize_gif(src, dst, limit):
    img = Image.open(src)
    frames = [frame.convert("RGBA") for frame in ImageSequence.Iterator(img)]
    duration = img.info.get("duration", 80)
    loop = img.info.get("loop", 0)
    size = fit_size(img.width, img.height, limit)
    if size != img.size:
        frames = [frame.resize(size, Image.LANCZOS) for frame in frames]
    paletted = [frame.convert("P", palette=Image.ADAPTIVE, colors=256) for frame in frames]
    paletted[0].save(dst, "GIF", save_all=True, append_images=paletted[1:], duration=duration, loop=loop, optimize=True, disposal=2)


def main():
    limit = MAX_EDGE
    if "--max-edge" in sys.argv:
        limit = int(sys.argv[sys.argv.index("--max-edge") + 1])
    candidates = json.load(open(os.path.join(STAGE, "candidates.json"), encoding="utf-8"))
    tags = json.load(open(os.path.join(STAGE, "merged-tags.json"), encoding="utf-8"))
    os.makedirs(ARCHIVE, exist_ok=True)
    # Archive current (128px) files once, then clear the library.
    for name in os.listdir(LIB):
        path = os.path.join(LIB, name)
        if os.path.isfile(path):
            shutil.move(path, os.path.join(ARCHIVE, name))
    kept = 0
    rebuilt = 0
    skipped = 0
    total = 0
    for item in candidates:
        src = item["path"]
        real = item["real"]
        clean_tags = (tags.get(item["md5"]) or ["随机"])[:2]
        suffix = f"_{'-'.join(clean_tags)}" if clean_tags else ""
        import hashlib
        digest = hashlib.sha1(open(src, "rb").read()).hexdigest()[:16]
        out_ext = "gif" if real == "gif" else "png"
        dst = os.path.join(LIB, f"auto_{digest}{suffix}.{out_ext}")
        try:
            if real == "gif":
                img = Image.open(src)
                frames = getattr(img, "n_frames", 1)
                if img.width <= limit and img.height <= limit and os.path.getsize(src) <= MAX_BYTES and frames > 1:
                    shutil.copyfile(src, dst)  # keep original bytes: no palette loss
                    kept += 1
                else:
                    resize_gif(src, dst, limit)
                    rebuilt += 1
            else:
                resize_static(src, dst, limit)
                rebuilt += 1
            if os.path.getsize(dst) > MAX_BYTES:
                os.remove(dst)
                skipped += 1
                continue
            total += os.path.getsize(dst)
        except Exception as error:  # noqa: BLE001
            skipped += 1
            print("skip", os.path.basename(src), error)
    print(f"done: kept-original {kept}, rebuilt {rebuilt}, skipped {skipped}, total {total / 1048576:.1f} MB, max edge {limit}")
    print(f"archived previous 128px library to {ARCHIVE}")


if __name__ == "__main__":
    main()
