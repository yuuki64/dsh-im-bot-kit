# Resize sticker library images to sticker-like dimensions (max edge 200px), keeping GIF animation.
# Originals stay in the import staging folder, so this is reversible.
#
#   python sticker-resize-library.py [--max-edge 200]
import os
import sys

from PIL import Image, ImageSequence

LIB = r"C:\Users\yuuki\.dsh\integrations\dsh-im\stickers"
MAX_EDGE = 200


def resize_frames(img, size):
    return [frame.convert("RGBA").resize(size, Image.LANCZOS) for frame in ImageSequence.Iterator(img)]


def fit_size(width, height, limit):
    if max(width, height) <= limit:
        return (width, height)
    scale = limit / max(width, height)
    return (max(8, int(width * scale)), max(8, int(height * scale)))


def process_gif(path):
    img = Image.open(path)
    width, height = img.size
    size = fit_size(width, height, MAX_EDGE)
    frames = [frame.convert("RGBA").resize(size, Image.LANCZOS) for frame in ImageSequence.Iterator(img)]
    duration = img.info.get("duration", 80)
    loop = img.info.get("loop", 0)
    paletted = [frame.convert("P", palette=Image.ADAPTIVE) for frame in frames]
    paletted[0].save(path, "GIF", save_all=True, append_images=paletted[1:], duration=duration, loop=loop, optimize=True)
    return (width, height), size


def process_png(path):
    img = Image.open(path)
    width, height = img.size
    size = fit_size(width, height, MAX_EDGE)
    if size == (width, height):
        return (width, height), size
    out = img.convert("RGBA").resize(size, Image.LANCZOS)
    out.save(path, "PNG", optimize=True)
    return (width, height), size


def process_jpg(path):
    img = Image.open(path)
    width, height = img.size
    size = fit_size(width, height, MAX_EDGE)
    if size == (width, height):
        return (width, height), size
    out = img.convert("RGB").resize(size, Image.LANCZOS)
    out.save(path, "JPEG", quality=85, optimize=True)
    return (width, height), size


def main():
    limit = MAX_EDGE
    if "--max-edge" in sys.argv:
        limit = int(sys.argv[sys.argv.index("--max-edge") + 1])
    globals()["MAX_EDGE"] = limit
    count = 0
    for name in os.listdir(LIB):
        path = os.path.join(LIB, name)
        if not os.path.isfile(path):
            continue
        ext = os.path.splitext(name)[1].lower()
        try:
            if ext == ".gif":
                before, after = process_gif(path)
            elif ext == ".png":
                before, after = process_png(path)
            elif ext in (".jpg", ".jpeg"):
                before, after = process_jpg(path)
            else:
                continue
            count += 1
            if count % 100 == 0:
                print(f"{count} processed, last {name} {before}->{after}")
        except Exception as error:  # noqa: BLE001
            print("skip", name, error)
    print(f"done: {count} files resized to max edge {limit}")


if __name__ == "__main__":
    main()
