"""Local GPT-SoVITS inference sidecar for the dsh-im bot.

Zero-shot (and later fine-tuned) voice cloning, served over a tiny stdlib HTTP
server so the Node plugin can request WAVs:

    POST /tts   {"text": "...", "character": "dafeiyu", "speed": 1.0, "language": "zh"}
    GET  /health

References: D:\\tools\\gpt-sovits\\characters\\<name>.wav + <name>.txt
Model: GPT-SoVITS v2 (pretrained_models/gsv-v2final-pretrained), CUDA, fp16.

Run:  venv\\Scripts\\python.exe server.py --port 17862
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
REPO = Path(os.environ.get("GSV_REPO", ROOT / "RVC-Boss-GPT-SoVITS-b4570b8")).resolve()
CHARACTERS = Path(os.environ.get("GSV_CHARACTERS", ROOT / "characters")).resolve()
DEFAULT_CHARACTER = "dafeiyu"
MAX_TEXT = 400

os.chdir(REPO)
sys.path.insert(0, str(REPO))
sys.path.insert(0, str(REPO / "GPT_SoVITS"))

_lock = threading.Lock()
_tts = None
_started_at = time.time()


def log(*parts):
    print(time.strftime("[%H:%M:%S]"), *parts, flush=True)


def load_tts():
    global _tts
    if _tts is not None:
        return _tts
    from TTS_infer_pack.TTS import TTS, TTS_Config

    config_path = os.environ.get("GSV_CONFIG", "")
    if not config_path:
        finetuned = ROOT / "tts_infer_finetuned.yaml"
        config_path = str(finetuned) if finetuned.exists() else "GPT_SoVITS/configs/tts_infer.yaml"
    started = time.time()
    log("loading GPT-SoVITS", config_path)
    config = TTS_Config(config_path)
    _tts = TTS(config)
    log(f"engine ready in {time.time() - started:.1f}s device={config.device} v={config.version}")
    return _tts


def character(name):
    raw = str(name or DEFAULT_CHARACTER).strip()
    safe = re.sub(r"[^\w\-]+", "_", raw)[:60] or DEFAULT_CHARACTER
    wav = CHARACTERS / f"{safe}.wav"
    txt = CHARACTERS / f"{safe}.txt"
    if not wav.exists():
        wav = CHARACTERS / f"{DEFAULT_CHARACTER}.wav"
        txt = CHARACTERS / f"{DEFAULT_CHARACTER}.txt"
    if not wav.exists():
        raise FileNotFoundError(f"missing reference: {CHARACTERS / (DEFAULT_CHARACTER + '.wav')}")
    prompt = txt.read_text(encoding="utf-8").strip() if txt.exists() else ""
    return safe, str(wav), prompt


def wav_bytes(samples, sample_rate):
    import numpy as np

    # GPT-SoVITS may hand back int16-scaled audio; clipping that straight to
    # [-1, 1] saturates most samples and sounds like a harsh tremolo.
    array = np.asarray(samples)
    if array.dtype.kind in "iu":
        array = array.astype(np.float32) / 32768.0
    else:
        array = array.astype(np.float32)
    peak = float(np.max(np.abs(array))) if array.size else 0.0
    if peak > 1.0:
        array = array / peak
    if peak > 0:
        array = array * min(1.0, 0.95 / max(float(np.max(np.abs(array))), 1e-9))
    pcm = np.clip(array, -1.0, 1.0)
    pcm = (pcm * 32767.0).astype("<i2").tobytes()
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(int(sample_rate))
        handle.writeframes(pcm)
    return buffer.getvalue()


def synthesize(text, name, speed, language):
    tts = load_tts()
    safe, ref_wav, prompt_text = character(name)
    started = time.time()
    inputs = {
        "text": text,
        "text_lang": language,
        "ref_audio_path": ref_wav,
        "prompt_text": prompt_text,
        "prompt_lang": "zh",
        "text_split_method": "cut5",
        "batch_size": 1,
        "speed_factor": float(max(0.5, min(2.0, speed or 1.0))),
        "return_fragment": False,
        "streaming_mode": False,
        "seed": -1,
    }
    audio = None
    sample_rate = 32000
    for sr, chunk in tts.run(inputs):
        sample_rate = sr
        audio = chunk if audio is None else audio + chunk
    if audio is None:
        raise RuntimeError("no audio generated")
    elapsed = time.time() - started
    log(f"tts {safe} chars={len(text)} => {len(audio) / sample_rate:.2f}s in {elapsed:.2f}s")
    return audio, sample_rate, safe, elapsed


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
        if not self.path.startswith("/health"):
            self._json(404, {"error": "not found"})
            return
        import torch

        self._json(200, {
            "ok": True,
            "engine": "gpt-sovits",
            "cuda": bool(torch.cuda.is_available()),
            "device": torch.cuda.get_device_name(0) if torch.cuda.is_available() else "cpu",
            "uptime": round(time.time() - _started_at, 1),
            "loaded": _tts is not None,
            "characters": sorted({p.stem for p in CHARACTERS.glob("*.wav")}),
        })

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
        text = text[:MAX_TEXT]
        try:
            with _lock:
                audio, sample_rate, safe, elapsed = synthesize(
                    text,
                    payload.get("character", DEFAULT_CHARACTER),
                    payload.get("speed", 1.0),
                    str(payload.get("language", "zh")),
                )
            body = wav_bytes(audio, sample_rate)
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-TTS-Character", safe)
            self.send_header("X-TTS-Seconds", f"{elapsed:.2f}")
            self.end_headers()
            self.wfile.write(body)
        except Exception as error:  # noqa: BLE001
            log("tts failed:", repr(error))
            self._json(500, {"error": str(error)})

    def log_message(self, *args):
        pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=17862)
    parser.add_argument("--preload", action="store_true")
    args = parser.parse_args()
    CHARACTERS.mkdir(parents=True, exist_ok=True)
    if args.preload:
        load_tts()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    log(f"listening on http://{args.host}:{args.port} (GPT-SoVITS, repo {REPO})")
    server.serve_forever()


if __name__ == "__main__":
    main()
