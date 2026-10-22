// Local GPU TTS sidecar client (F5-TTS v1, zero-shot voice cloning).
//
// The sidecar is a small stdlib HTTP server (`D:/tools/tts-gpu/server.py`) that
// keeps the model in VRAM and returns 16-bit mono WAV. This module starts it on
// demand (detached, hidden), then POSTs the line to it.
//
// Why F5-TTS: one pip package, Chinese + English, and 5-15 s of reference audio
// is enough to clone an anime character's timbre. Reference clips live in
// `D:/tools/tts-gpu/characters/<name>.wav` with a matching `<name>.txt`.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_URL = 'http://127.0.0.1:17861';
const DEFAULT_ROOT = 'D:/tools/tts-gpu';
const PYTHON = process.env.DSH_TTS_GPU_PYTHON ?? 'D:/tools/Python311/python.exe';
const HEALTH_TIMEOUT_MS = 1500;
const SYNTH_TIMEOUT_MS = 120_000;
const STARTUP_WAIT_MS = 90_000;

export function gpuTtsUrl() {
  return (process.env.DSH_TTS_GPU_URL ?? DEFAULT_URL).replace(/\/+$/u, '');
}

export function gpuTtsRoot() {
  return process.env.DSH_TTS_GPU_ROOT ?? DEFAULT_ROOT;
}

export function gpuTtsAvailable() {
  try {
    return existsSync(join(gpuTtsRoot(), 'server.py')) && existsSync(PYTHON);
  } catch {
    return false;
  }
}

async function fetchJson(url, { timeoutMs = HEALTH_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Sidecar health (and the character list it exposes). */
export async function gpuTtsHealth({ timeoutMs } = {}) {
  return fetchJson(`${gpuTtsUrl()}/health`, { timeoutMs });
}

let starting = null;

function spawnSidecar() {
  const root = gpuTtsRoot();
  const child = spawn(PYTHON, [join(root, 'server.py'), '--port', '17861', '--preload'], {
    cwd: root,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  child.unref();
}

async function waitForHealth(deadline) {
  while (Date.now() < deadline) {
    const health = await gpuTtsHealth({ timeoutMs: 1200 });
    if (health?.ok) return health;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return null;
}

/** Make sure the sidecar is up; returns health or null. */
export async function ensureGpuTts() {
  const health = await gpuTtsHealth({ timeoutMs: 1200 });
  if (health?.ok) return health;
  if (!gpuTtsAvailable()) return null;
  starting ??= (async () => {
    spawnSidecar();
    const result = await waitForHealth(Date.now() + STARTUP_WAIT_MS);
    starting = null;
    return result;
  })();
  try {
    return await starting;
  } catch {
    starting = null;
    return null;
  }
}

/**
 * Synthesize text with the GPU sidecar.
 * @returns {Promise<{wav: Buffer, character: string, seconds: number}>}
 */
/** Ask the sidecar to shut down (best effort). */
export async function stopGpuTts() {
  try {
    await fetch(`${gpuTtsUrl()}/shutdown`, { method: 'POST', signal: AbortSignal.timeout(3000) });
    return true;
  } catch {
    return false;
  }
}

export async function synthesizeGpuWav(text, { character = 'default', speed = 1, steps } = {}) {
  const say = typeof text === 'string' ? text.trim() : '';
  if (!say) throw new Error('Empty text');
  await ensureGpuTts();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SYNTH_TIMEOUT_MS);
  try {
    const response = await fetch(`${gpuTtsUrl()}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        text: say,
        character: String(character ?? 'default'),
        speed: Number.isFinite(Number(speed)) ? Number(speed) : 1,
        ...(Number.isFinite(Number(steps)) ? { steps: Number(steps) } : {}),
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`gpu-tts HTTP ${response.status}: ${detail.slice(0, 200)}`);
    }
    const wav = Buffer.from(await response.arrayBuffer());
    if (wav.length <= 44) throw new Error('gpu-tts returned empty audio');
    return {
      wav,
      character: response.headers.get('x-tts-character') ?? String(character ?? 'default'),
      seconds: Number(response.headers.get('x-tts-seconds')) || 0,
    };
  } finally {
    clearTimeout(timer);
  }
}
