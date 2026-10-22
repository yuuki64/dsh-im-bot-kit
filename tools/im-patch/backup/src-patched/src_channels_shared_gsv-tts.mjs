// Local GPT-SoVITS sidecar client (fine-tuned / zero-shot anime voice cloning).
//
// Sidecar: D:\tools\gpt-sovits\server.py on 127.0.0.1:17862 (own venv, CUDA,
// model resident). Started on demand, detached and hidden.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_URL = 'http://127.0.0.1:17862';
const DEFAULT_ROOT = 'D:/tools/gpt-sovits';
const PYTHON = process.env.DSH_GSV_PYTHON ?? 'D:/tools/gpt-sovits/venv/Scripts/python.exe';
const HEALTH_TIMEOUT_MS = 1500;
const SYNTH_TIMEOUT_MS = 180_000;
const STARTUP_WAIT_MS = 120_000;

export function gsvUrl() {
  return (process.env.DSH_GSV_URL ?? DEFAULT_URL).replace(/\/+$/u, '');
}

export function gsvRoot() {
  return process.env.DSH_GSV_ROOT ?? DEFAULT_ROOT;
}

export function isGsvAvailable() {
  try {
    return existsSync(join(gsvRoot(), 'server.py')) && existsSync(PYTHON);
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

export async function gsvHealth({ timeoutMs } = {}) {
  return fetchJson(`${gsvUrl()}/health`, { timeoutMs });
}

let starting = null;

async function waitForHealth(deadline) {
  while (Date.now() < deadline) {
    const health = await gsvHealth({ timeoutMs: 1200 });
    if (health?.ok) return health;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return null;
}

/** Start the sidecar if needed; returns its health payload or null. */
export async function ensureGsv() {
  const health = await gsvHealth({ timeoutMs: 1200 });
  if (health?.ok) return health;
  if (!isGsvAvailable()) return null;
  starting ??= (async () => {
    const child = spawn(PYTHON, [join(gsvRoot(), 'server.py'), '--port', '17862', '--preload'], {
      cwd: gsvRoot(),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PATH: `D:/tools/bin;${process.env.PATH ?? ''}` },
    });
    child.unref();
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
 * Synthesize with GPT-SoVITS.
 * @returns {Promise<{wav: Buffer, character: string, seconds: number}>}
 */
/** Ask the sidecar to shut down (best effort). */
export async function stopGsv() {
  try {
    await fetch(`${gsvUrl()}/shutdown`, { method: 'POST', signal: AbortSignal.timeout(3000) });
    return true;
  } catch {
    return false;
  }
}

export async function synthesizeGsvWav(text, { character = 'dafeiyu', speed = 1, language = 'zh' } = {}) {
  const say = typeof text === 'string' ? text.trim() : '';
  if (!say) throw new Error('Empty text');
  await ensureGsv();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SYNTH_TIMEOUT_MS);
  try {
    const response = await fetch(`${gsvUrl()}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        text: say,
        character: String(character ?? 'dafeiyu'),
        speed: Number.isFinite(Number(speed)) ? Number(speed) : 1,
        language,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`gpt-sovits HTTP ${response.status}: ${detail.slice(0, 200)}`);
    }
    const wav = Buffer.from(await response.arrayBuffer());
    if (wav.length <= 44) throw new Error('gpt-sovits returned empty audio');
    return {
      wav,
      character: response.headers.get('x-tts-character') ?? String(character ?? 'dafeiyu'),
      seconds: Number(response.headers.get('x-tts-seconds')) || 0,
    };
  } finally {
    clearTimeout(timer);
  }
}
