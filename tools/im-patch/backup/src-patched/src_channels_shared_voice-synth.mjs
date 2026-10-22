// Text-to-speech + SILK encoding for QQ voice messages.
//
// Two local providers, no network and no API key:
//   - onecore: Windows.Media.SpeechSynthesis (WinRT). Exposes the OneCore voice
//     set, which includes the younger zh-CN voice "Microsoft Yaoyao" alongside
//     Huihui/Kangkang and the Japanese voices.
//   - sapi: System.Speech (classic SAPI). Fallback when WinRT is unavailable.
//
// Both render SSML, so pitch/rate can be tuned per user preference. The WAV is
// encoded to Tencent SILK with silk-wasm (no ffmpeg).

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  KOKORO_VOICES,
  isKokoroAvailable,
  resolveKokoroVoice,
  synthesizeKokoroWav,
} from './kokoro-tts.mjs';
import {
  gpuTtsAvailable,
  synthesizeGpuWav,
} from './gpu-tts.mjs';
import {
  isGsvAvailable,
  synthesizeGsvWav,
} from './gsv-tts.mjs';

const MAX_TEXT_CODE_POINTS = 300;
const MAX_VOICE_DURATION_MS = 60_000;
const DEFAULT_TTS_TIMEOUT_MS = 25_000;
const SAMPLE_RATE = 24_000;

export const DEFAULT_VOICE_SETTINGS = Object.freeze({
  version: 1,
  provider: 'kokoro',
  voice: 'zf_xiaobei',
  character: 'default',
  steps: 16,
  speed: 1,
  pitch: 15,
  rate: 0,
});

const GPU_VOICE_ALIASES = Object.freeze([
  { alias: 'gsv', name: 'gsv', hint: 'GPT-SoVITS 微调音色（最贴角色）' },
  { alias: 'gpu', name: 'f5', hint: 'GPU 克隆音色（F5-TTS，贴角色）' },
  { alias: 'f5', name: 'f5', hint: 'GPU 克隆音色（F5-TTS，贴角色）' },
]);

const VOICE_ALIASES = Object.freeze([
  ...KOKORO_VOICES.map((entry) => ({ alias: entry.alias, name: entry.name, hint: entry.hint })),
  ...GPU_VOICE_ALIASES,
  { alias: 'yaoyao', name: 'Microsoft Yaoyao', hint: 'zh-CN 少女音（Windows 本机）' },
  { alias: 'huihui', name: 'Microsoft Huihui', hint: 'zh-CN 成熟女声' },
  { alias: 'kangkang', name: 'Microsoft Kangkang', hint: 'zh-CN 男声' },
  { alias: 'ayumi', name: 'Microsoft Ayumi', hint: 'ja-JP 女声' },
  { alias: 'haruka', name: 'Microsoft Haruka', hint: 'ja-JP 女声' },
  { alias: 'ichiro', name: 'Microsoft Ichiro', hint: 'ja-JP 男声' },
  { alias: 'zira', name: 'Microsoft Zira', hint: 'en-US 女声（仅 sapi）' },
]);

export class VoiceError extends Error {
  constructor(code, message, userMessage, options = {}) {
    super(message, options);
    this.name = 'VoiceError';
    this.code = code;
    this.userMessage = userMessage;
  }
}

const AWAIT_HELPER = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}
`;

const ONECORE_SCRIPT = `${AWAIT_HELPER}
[Windows.Media.SpeechSynthesis.SpeechSynthesizer,Windows.Media,ContentType=WindowsRuntime] | Out-Null
$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
$wanted = $env:DSH_TTS_VOICE
if ($wanted) {
  $match = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices |
    Where-Object { $_.DisplayName -eq $wanted -or $_.Id -eq $wanted -or $_.DisplayName -like ('*' + $wanted + '*') } |
    Select-Object -First 1
  if ($match) { $synth.Voice = $match }
}
$ssml = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:DSH_TTS_SSML_B64))
$stream = Await ($synth.SynthesizeSsmlToStreamAsync($ssml)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
$reader = New-Object Windows.Storage.Streams.DataReader($stream)
$size = [uint32]$stream.Size
Await ($reader.LoadAsync($size)) ([uint32]) | Out-Null
$buffer = New-Object 'byte[]' $size
$reader.ReadBytes($buffer)
[IO.File]::WriteAllBytes($env:DSH_TTS_OUT, $buffer)
`;

const SAPI_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$wanted = $env:DSH_TTS_VOICE
if ($wanted) {
  try { $synth.SelectVoice($wanted) } catch {
    foreach ($name in @('Microsoft Huihui Desktop','Microsoft Huihui')) {
      try { $synth.SelectVoice($name); break } catch { }
    }
  }
}
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(24000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$synth.SetOutputToWaveFile($env:DSH_TTS_OUT, $fmt)
$ssml = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:DSH_TTS_SSML_B64))
$synth.SpeakSsml($ssml)
$synth.Dispose()
`;

const LIST_SCRIPT = `${AWAIT_HELPER}
[Windows.Media.SpeechSynthesis.SpeechSynthesizer,Windows.Media,ContentType=WindowsRuntime] | Out-Null
[Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | ForEach-Object { '{0}|{1}|{2}' -f $_.DisplayName, $_.Language, $_.Gender }
`;

function encodedPowerShell(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function runPowerShell(script, { env, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', encodedPowerShell(script),
    ], {
      env: { ...process.env, ...env },
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      ...(signal ? { signal } : {}),
    }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stderrText: String(stderr ?? '') }));
        return;
      }
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

/** `<`/`&` must not break the SSML document; quotes stay literal text. */
function escapeXml(text) {
  return text.replace(/[<>&'"]/g, (character) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '\'': '&apos;', '"': '&quot;',
  })[character]);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function numbered(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : fallback;
}

export function voiceSettingsPath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(home, 'integrations', 'dsh-im', 'voice.json');
}

/** Read persisted voice settings; malformed or missing files fall back to defaults. */
export async function readVoiceSettings() {
  try {
    const raw = await readFile(voiceSettingsPath(), 'utf8');
    const document = JSON.parse(raw);
    if (!document || typeof document !== 'object') return { ...DEFAULT_VOICE_SETTINGS };
    const provider = document.provider === 'sapi' || document.provider === 'onecore'
      || document.provider === 'kokoro' || document.provider === 'f5' || document.provider === 'gsv'
      ? document.provider : 'kokoro';
    const voice = typeof document.voice === 'string' ? document.voice.trim() : DEFAULT_VOICE_SETTINGS.voice;
    const character = typeof document.character === 'string' && document.character.trim()
      ? document.character.trim() : DEFAULT_VOICE_SETTINGS.character;
    return {
      version: 1,
      provider,
      voice: voice || DEFAULT_VOICE_SETTINGS.voice,
      character,
      steps: Math.min(48, Math.max(8, numbered(document.steps, DEFAULT_VOICE_SETTINGS.steps))),
      speed: Math.min(2, Math.max(0.5, Number(document.speed) || DEFAULT_VOICE_SETTINGS.speed)),
      pitch: clamp(numbered(document.pitch, DEFAULT_VOICE_SETTINGS.pitch), -50, 50),
      rate: clamp(numbered(document.rate, DEFAULT_VOICE_SETTINGS.rate), -30, 30),
    };
  } catch {
    return { ...DEFAULT_VOICE_SETTINGS };
  }
}

/** Persist settings atomically (write tmp + rename). */
export async function writeVoiceSettings(patch) {
  const current = await readVoiceSettings();
  const next = {
    version: 1,
    provider: ['sapi', 'onecore', 'kokoro', 'f5', 'gsv'].includes(patch.provider)
      ? patch.provider : current.provider,
    voice: typeof patch.voice === 'string' && patch.voice.trim() ? patch.voice.trim() : current.voice,
    character: typeof patch.character === 'string' && patch.character.trim()
      ? patch.character.trim().slice(0, 60) : current.character,
    steps: patch.steps === undefined
      ? current.steps : Math.min(48, Math.max(8, numbered(patch.steps, current.steps))),
    speed: patch.speed === undefined
      ? current.speed : Math.min(2, Math.max(0.5, Number(patch.speed) || current.speed)),
    pitch: patch.pitch === undefined ? current.pitch : clamp(numbered(patch.pitch, current.pitch), -50, 50),
    rate: patch.rate === undefined ? current.rate : clamp(numbered(patch.rate, current.rate), -30, 30),
  };
  const path = voiceSettingsPath();
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
  return next;
}

export function resolveVoiceAlias(input) {
  const key = typeof input === 'string' ? input.trim().toLowerCase() : '';
  if (!key) return null;
  const alias = VOICE_ALIASES.find((entry) => entry.alias === key
    || entry.name.toLowerCase() === key
    || entry.name.toLowerCase().includes(key));
  return alias ? alias.name : null;
}

/** Resolve an alias to `{provider, voice}` so the provider follows the voice. */
export function resolveVoiceChoice(input) {
  const key = typeof input === 'string' ? input.trim().toLowerCase() : '';
  if (key === 'gpu' || key === 'f5') return { provider: 'f5', voice: 'f5' };
  if (key === 'gsv' || key === '角色' || key === 'gpt-sovits') return { provider: 'gsv', voice: 'gsv' };
  const name = resolveVoiceAlias(input);
  if (!name) return null;
  const kokoro = resolveKokoroVoice(name);
  if (kokoro) return { provider: 'kokoro', voice: kokoro.name };
  return { provider: 'onecore', voice: name };
}

export function voiceAliasTable() {
  return VOICE_ALIASES.map((entry) => ({ ...entry }));
}

/** Installed voices as `{ name, language, gender }`; sorted by locale. */
export async function listInstalledVoices({ timeoutMs = 15_000 } = {}) {
  try {
    const { stdout } = await runPowerShell(LIST_SCRIPT, { env: {}, timeoutMs });
    const voices = [];
    for (const line of stdout.split(/\r?\n/)) {
      const [name, language, gender] = line.trim().split('|');
      if (!name) continue;
      voices.push({ name, language: language ?? '', gender: gender ?? '' });
    }
    if (voices.length > 0) return voices;
  } catch {
    // Fall through to SAPI enumeration.
  }
  const { stdout } = await runPowerShell(`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.GetInstalledVoices() | ForEach-Object { '{0}|{1}|{2}' -f $_.VoiceInfo.Name, $_.VoiceInfo.Culture.Name, $_.VoiceInfo.Gender }
`, { env: {}, timeoutMs });
  return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [name, language, gender] = line.split('|');
    return { name, language: language ?? '', gender: gender ?? '' };
  });
}

function buildSsml(text, settings) {
  const pitch = clamp(settings.pitch, -50, 50);
  const rate = clamp(settings.rate, -30, 30);
  return '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN">'
    + `<prosody pitch="${pitch >= 0 ? '+' : ''}${pitch}%" rate="${rate >= 0 ? '+' : ''}${rate}%">`
    + `${escapeXml(text)}`
    + '</prosody></speak>';
}

function friendlyTtsError(error, provider) {
  if (error instanceof VoiceError) return error;
  const detail = error?.stderrText ? ` ${error.stderrText.slice(0, 200)}` : '';
  return new VoiceError(
    'voice-tts-failed',
    `${provider} synthesis failed: ${error?.message ?? String(error)}${detail}`,
    '语音合成失败（本机 TTS）。可以先用文字回复，或检查 Windows 语音包。',
    { cause: error },
  );
}

/**
 * Synthesize speech into a WAV buffer with the configured voice.
 * @returns {Promise<{wav: Buffer, settings: object, provider: string}>}
 */
export async function synthesizeSpeechWav(text, {
  timeoutMs = DEFAULT_TTS_TIMEOUT_MS,
  signal,
  settings,
} = {}) {
  const say = typeof text === 'string' ? text.trim() : '';
  if (!say) {
    throw new VoiceError('voice-empty-text', 'Empty voice text', '要说什么？用法：/voice 要说的话');
  }
  if ([...say].length > MAX_TEXT_CODE_POINTS) {
    throw new VoiceError(
      'voice-text-too-long',
      `Voice text is ${[...say].length} code points; the limit is ${MAX_TEXT_CODE_POINTS}`,
      `太长了，语音文本最长 ${MAX_TEXT_CODE_POINTS} 字，短一点再试。`,
    );
  }
  const current = settings ?? await readVoiceSettings();
  let lastError = null;
  // GPU sidecar (F5-TTS) gives the closest character timbre; Kokoro is the
  // offline fallback, Windows voices the last resort.
  if (current.provider === 'gsv' && isGsvAvailable()) {
    try {
      signal?.throwIfAborted();
      const result = await synthesizeGsvWav(say, {
        character: current.character,
        speed: current.speed,
      });
      signal?.throwIfAborted();
      return { wav: result.wav, settings: current, provider: 'gsv' };
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
    }
  }
  if (current.provider === 'f5' && gpuTtsAvailable()) {
    try {
      signal?.throwIfAborted();
      const result = await synthesizeGpuWav(say, {
        character: current.character,
        speed: current.speed,
        steps: current.steps,
      });
      signal?.throwIfAborted();
      return { wav: result.wav, settings: current, provider: 'f5' };
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
    }
  }
  if ((current.provider === 'kokoro' || current.provider === 'f5' || current.provider === 'gsv') && isKokoroAvailable()) {
    try {
      signal?.throwIfAborted();
      const result = await synthesizeKokoroWav(say, {
        voice: current.voice,
        speed: current.speed,
      });
      signal?.throwIfAborted();
      return { wav: result.wav, settings: current, provider: 'kokoro' };
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
    }
  }
  const directory = await mkdtemp(join(tmpdir(), 'dsh-tts-'));
  const wavPath = join(directory, 'voice.wav');
  const ssml = buildSsml(say, current);
  const env = {
    DSH_TTS_VOICE: current.voice,
    DSH_TTS_SSML_B64: Buffer.from(ssml, 'utf8').toString('base64'),
    DSH_TTS_OUT: wavPath,
  };
  try {
    const providers = current.provider === 'sapi' ? ['sapi'] : ['onecore', 'sapi'];
    for (const provider of providers) {
      try {
        await runPowerShell(provider === 'onecore' ? ONECORE_SCRIPT : SAPI_SCRIPT, {
          env, timeoutMs, signal,
        });
        const wav = await readFile(wavPath);
        if (wav.length > 44) return { wav, settings: current, provider };
        lastError = new VoiceError('voice-tts-empty', `${provider} produced an empty wav`,
          '语音合成没有出声，可能本机缺少语音包。');
      } catch (error) {
        if (signal?.aborted) throw error;
        lastError = friendlyTtsError(error, provider);
      }
    }
    throw lastError;
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

let silkPromise;
async function loadSilk() {
  silkPromise ??= import('silk-wasm').catch(() => null);
  return silkPromise;
}

/**
 * Encode a WAV (any sample rate the decoder accepts) into Tencent SILK.
 * @returns {Promise<{silk: Buffer, durationMs: number}>}
 */
export async function encodeWavToSilk(wav) {
  const bytes = Buffer.isBuffer(wav) ? wav : Buffer.from(wav ?? []);
  if (bytes.length === 0) {
    throw new VoiceError('voice-empty-audio', 'Empty wav input', '音频是空的，生成失败。');
  }
  const silk = await loadSilk();
  if (!silk) {
    throw new VoiceError(
      'silk-encoder-unavailable',
      'silk-wasm is not installed',
      '缺少 SILK 编码器（silk-wasm 没装到插件依赖里），语音发不出去。',
    );
  }
  try {
    const encoded = await silk.encode(bytes, 0);
    const silkBytes = Buffer.from(encoded.data);
    const durationMs = Math.max(0, Math.round(Number(encoded.duration) || 0));
    if (silkBytes.length === 0) {
      throw new VoiceError('silk-encode-failed', 'SILK encoder returned no data', '语音编码失败。');
    }
    if (durationMs > MAX_VOICE_DURATION_MS) {
      throw new VoiceError(
        'voice-too-long',
        `Voice is ${durationMs} ms; QQ allows ${MAX_VOICE_DURATION_MS} ms`,
        '语音超过 60 秒了，QQ 发不了，短一点再试。',
      );
    }
    return { silk: silkBytes, durationMs };
  } catch (error) {
    if (error instanceof VoiceError) throw error;
    throw new VoiceError(
      'silk-encode-failed',
      `SILK encoding failed: ${error?.message ?? String(error)}`,
      '语音编码失败，请稍后再试。',
      { cause: error },
    );
  }
}

/**
 * One-shot: text -> SILK buffer ready for `bot.sendVoice`.
 * @returns {Promise<{silk: Buffer, durationMs: number, wavBytes: number, provider: string, settings: object}>}
 */
export async function synthesizeSpeechSilk(text, { timeoutMs, signal, settings } = {}) {
  const spoken = await synthesizeSpeechWav(text, { timeoutMs, signal, settings });
  const { silk, durationMs } = await encodeWavToSilk(spoken.wav);
  return {
    silk,
    durationMs,
    wavBytes: spoken.wav.length,
    provider: spoken.provider,
    settings: spoken.settings,
  };
}

export const VOICE_LIMITS = Object.freeze({
  maxTextCodePoints: MAX_TEXT_CODE_POINTS,
  maxDurationMs: MAX_VOICE_DURATION_MS,
  sampleRate: SAMPLE_RATE,
});

/** User-facing one-liner for a failed voice attempt. */
export function voiceFailureMessage(error) {
  if (error instanceof VoiceError) return error.userMessage;
  const fallback = error?.message ? `语音发送失败：${error.message}` : '语音发送失败。';
  return fallback;
}
