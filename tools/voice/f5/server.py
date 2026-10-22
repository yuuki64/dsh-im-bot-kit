"""Local GPU TTS sidecar for the dsh-im QQ/WeChat bot.

Engine: F5-TTS v1 Base (flow matching, zero-shot voice cloning, Chinese + English).
Runs a tiny stdlib HTTP server so the Node plugin can ask for a WAV:

    POST /tts   {"text": "...", "character": "default", "speed": 1.0, "steps": 16}
    GET  /health

Character references live next to this file:

    characters/<name>.wav   (5-15 s clean speech, 16 kHz+ mono preferred)
    characters/<name>.txt   (exact transcript of that clip)

`default` is used when `character` is omitted. Everything stays on this machine.

Run:  python server.py --port 17861
"""

import argparse
import io
import json
import os
import re
import sys
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MODEL_DIR = Path(os.environ.get("F5_MODEL_DIR", ROOT / "models" / "F5TTS_v1_Base"))
CHARACTERS_DIR = Path(os.environ.get("F5_CHARACTERS_DIR", ROOT / "characters"))
MAX_TEXT = 400
DEFAULT_STEPS = 16

_lock = threading.Lock()
_engine = None
_started_at = time.time()


def log(*parts):
    print(time.strftime("[%H:%M:%S]"), *parts, flush=True)


def load_engine():
    global _engine
    if _engine is not None:
        return _engine
    from f5_tts.api import F5TTS

    ckpt = MODEL_DIR / "model_1250000.safetensors"
    vocab = MODEL_DIR / "vocab.txt"
    if not ckpt.exists():
        raise FileNotFoundError(f"missing checkpoint: {ckpt}")
    device = os.environ.get("F5_DEVICE", "cuda")
    log("loading F5-TTS", ckpt.name, "device=", device)
    started = time.time()
    _engine = F5TTS(model="F5TTS_v1_Base", ckpt_file=str(ckpt), vocab_file=str(vocab), device=device)
    log(f"engine ready in {time.time() - started:.1f}s")
    return _engine


def character_reference(name):
    raw = str(name or "default").strip()
    safe = re.sub(r"[^\w\-]+", "_", raw)[:60] or "default"
    wav = CHARACTERS_DIR / f"{safe}.wav"
    txt = CHARACTERS_DIR / f"{safe}.txt"
    if not wav.exists():
        wav = CHARACTERS_DIR / "default.wav"
        txt = CHARACTERS_DIR / "default.txt"
    if not wav.exists():
        raise FileNotFoundError(
            f"no character reference: put {CHARACTERS_DIR / 'default.wav'} (+ .txt) first"
        )
    ref_text = txt.read_text(encoding="utf-8").strip() if txt.exists() else ""
    return safe, str(wav), ref_text


def synthesize(text, character="default", speed=1.0, steps=DEFAULT_STEPS):
    engine = load_engine()
    safe, ref_wav, ref_text = character_reference(character)
    started = time.time()
    wav, sample_rate, _ = engine.infer(
        ref_file=ref_wav,
        ref_text=ref_text,
        gen_text=text,
        nfe_step=int(max(8, min(64, steps))),
        speed=float(max(0.5, min(2.0, speed))),
        remove_silence=True,
        show_info=lambda *args, **kwargs: None,
    )
    elapsed = time.time() - started
    log(f"tts {safe} chars={len(text)} => {len(wav) / sample_rate:.2f}s audio in {elapsed:.2f}s")
    return wav, int(sample_rate), safe, elapsed


def wav_bytes(samples, sample_rate):
    import numpy as np

    pcm = np.clip(samples, -1.0, 1.0)
    pcm = (pcm * 32767.0).astype("<i2").tobytes()
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(pcm)
    return buffer.getvalue()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/health"):
            try:
                import torch

                cuda = bool(torch.cuda.is_available())
                device = torch.cuda.get_device_name(0) if cuda else "cpu"
            except Exception:  # pragma: no cover - diagnostics only
                cuda, device = False, "unavailable"
            refs = sorted({p.stem for p in CHARACTERS_DIR.glob("*.wav")})
            self._json(200, {
                "ok": True,
                "cuda": cuda,
                "device": device,
                "uptime": round(time.time() - _started_at, 1),
                "characters": refs,
                "loaded": _engine is not None,
            })
            return
        self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path.startswith("/shutdown"):
            self._json(200, {"ok": True, "stopping": True})
            import threading as _threading
            _threading.Timer(0.4, self.server.shutdown).start()
            return
        if not self.path.startswith("/tts"):
            self._json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length) or b"{}")
        except Exception as error:  # noqa: BLE001
            self._json(400, {"error": f"bad json: {error}"})
            return
        text = str(payload.get("text", "")).strip()
        if not text:
            self._json(400, {"error": "empty text"})
            return
        if len(text) > MAX_TEXT:
            text = text[:MAX_TEXT]
        try:
            with _lock:
                samples, sample_rate, character, elapsed = synthesize(
                    text,
                    str(payload.get("character", "default")),
                    float(payload.get("speed", 1.0)),
                    int(payload.get("steps", DEFAULT_STEPS)),
                )
            body = wav_bytes(samples, sample_rate)
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-TTS-Character", character)
            self.send_header("X-TTS-Seconds", f"{elapsed:.2f}")
            self.end_headers()
            self.wfile.write(body)
        except Exception as error:  # noqa: BLE001
            log("tts failed:", repr(error))
            self._json(500, {"error": str(error)})

    def log_message(self, *args):  # silence per-request noise
        pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=17861)
    parser.add_argument("--preload", action="store_true", help="load the model before serving")
    args = parser.parse_args()
    CHARACTERS_DIR.mkdir(parents=True, exist_ok=True)
    if args.preload:
        load_engine()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    log(f"listening on http://{args.host}:{args.port} (F5-TTS, model dir {MODEL_DIR})")
    server.serve_forever()


if __name__ == "__main__":
    main()
