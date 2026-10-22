// Kokoro-82M Chinese voice engine (CPU, in-process, offline).
//
// Why Kokoro: it is the most popular open lightweight TTS of 2025-2026
// (GitHub: hexgrad/kokoro, MIT-ish, 82M params) and its zh voices (zf_*) sound
// young and anime-adjacent. sherpa-onnx runs the ONNX graph in-process through
// a native node addon, so there is no Python, no server, and no network.
//
// Latency on this machine (i7-13650HX, fp32, 8 threads): RTF ~0.33, so a 3 s
// line takes ~1 s to synthesize. int8 is slower here (RTF ~1.1) and is unused.

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const KOKORO_VOICES = Object.freeze([
  { alias: 'xiaobei', name: 'zf_xiaobei', sid: 45, hint: 'zh-CN 少女音（默认）' },
  { alias: 'xiaoni', name: 'zf_xiaoni', sid: 46, hint: 'zh-CN 少女音（偏软）' },
  { alias: 'xiaoxiao', name: 'zf_xiaoxiao', sid: 47, hint: 'zh-CN 少女音（偏甜）' },
  { alias: 'xiaoyi', name: 'zf_xiaoyi', sid: 48, hint: 'zh-CN 少女音（偏冷）' },
]);

const DEFAULT_THREADS = 8;
const DEFAULT_SPEED = 1;

export function kokoroBaseDir() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return process.env.DSH_KOKORO_DIR ?? join(home, 'integrations', 'dsh-im', 'tts');
}

export function kokoroModelDir() {
  return join(kokoroBaseDir(), 'models', 'kokoro-multi-lang-v1_0');
}

export function kokoroDataDir() {
  return join(kokoroBaseDir(), 'models', 'kokoro-int8-multi-lang-v1_1', 'espeak-ng-data');
}

export function voiceSid(voice) {
  const id = typeof voice === 'string' ? voice.trim().toLowerCase() : '';
  const entry = KOKORO_VOICES.find((item) => item.alias === id || item.name === id);
  return entry ? entry.sid : undefined;
}

export function resolveKokoroVoice(value) {
  const id = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return KOKORO_VOICES.find((item) => item.alias === id || item.name === id) ?? null;
}

class KokoroUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = 'KokoroUnavailable';
    this.code = 'kokoro-unavailable';
  }
}

let enginePromise;

function loadModule(baseDir) {
  const packagePath = join(baseDir, 'package.json');
  if (!existsSync(packagePath)) {
    throw new KokoroUnavailable(`Kokoro package not installed at ${baseDir}`);
  }
  const require = createRequire(packagePath);
  return require('sherpa-onnx-node');
}

function buildEngine() {
  const baseDir = kokoroBaseDir();
  const sherpa = loadModule(baseDir);
  const modelDir = kokoroModelDir();
  const dataDir = kokoroDataDir();
  const model = join(modelDir, 'model.onnx');
  if (!existsSync(model)) throw new KokoroUnavailable(`Kokoro model missing: ${model}`);
  if (!existsSync(dataDir)) throw new KokoroUnavailable(`Kokoro espeak data missing: ${dataDir}`);
  const tts = new sherpa.OfflineTts({
    model: {
      numThreads: Number(process.env.DSH_KOKORO_THREADS ?? DEFAULT_THREADS) || DEFAULT_THREADS,
      kokoro: {
        model,
        voices: join(modelDir, 'voices.bin'),
        tokens: join(modelDir, 'tokens.txt'),
        dataDir,
        lexicon: [join(modelDir, 'lexicon-us-en.txt'), join(modelDir, 'lexicon-zh.txt')].join(','),
        lang: 'zh',
      },
    },
    ruleFsts: [
      join(modelDir, 'phone-zh.fst'),
      join(modelDir, 'date-zh.fst'),
      join(modelDir, 'number-zh.fst'),
    ].join(','),
    maxNumSentences: 1,
    provider: 'cpu',
  });
  return { sherpa, tts };
}

/** Load (once) and return the native OfflineTts instance. */
export async function loadKokoro() {
  enginePromise ??= Promise.resolve().then(buildEngine).catch((error) => {
    enginePromise = undefined;
    throw error;
  });
  return enginePromise;
}

export function isKokoroAvailable() {
  try {
    return existsSync(join(kokoroBaseDir(), 'package.json')) && existsSync(join(kokoroModelDir(), 'model.onnx'));
  } catch {
    return false;
  }
}

function pcmToWav(samples, sampleRate) {
  const pcm = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.max(-1, Math.min(1, Number(samples[index]) || 0));
    pcm.writeInt16LE(Math.round(value * 32767), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Synthesize a line with Kokoro and return a 16-bit mono WAV buffer.
 * @returns {Promise<{wav: Buffer, sampleRate: number, durationMs: number, sid: number}>}
 */
export async function synthesizeKokoroWav(text, { voice, speed } = {}) {
  const { tts } = await loadKokoro();
  const entry = resolveKokoroVoice(voice) ?? KOKORO_VOICES[0];
  const say = typeof text === 'string' ? text.trim() : '';
  if (!say) throw new Error('Empty text');
  const rate = Number.isFinite(Number(speed)) && Number(speed) > 0
    ? Math.min(2, Math.max(0.5, Number(speed)))
    : DEFAULT_SPEED;
  const audio = tts.generate({ text: say, sid: entry.sid, speed: rate });
  const sampleRate = audio.sampleRate || tts.sampleRate;
  const samples = audio.samples;
  const durationMs = Math.round((samples.length / sampleRate) * 1000);
  return { wav: pcmToWav(samples, sampleRate), sampleRate, durationMs, sid: entry.sid };
}
