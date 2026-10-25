// 本地补丁（2026-10-25）：B 站视频内容获取。
//
// 目标：群里/私聊出现 B 站链接时，让机器人真的能回答「视频讲什么」：
//  1. 元数据（标题/UP主/时长/简介）走 B 站公开 API（游客可用）；
//  2. 字幕优先：有 SESSDATA 时用 yt-dlp 取 AI 字幕（B 站字幕现在登录才能拿）；
//  3. 无字幕时本地 ASR 兜底：yt-dlp 下音频 → faster-whisper 转写（全本地，不花钱）；
//  4. 结果缓存 7 天，避免重复下载/转写。
//
// 只取「音频内容」，画面信息不获取，prompt 里会明确告诉模型不要编造画面。
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BVID_PATTERN = /BV[0-9A-Za-z]{10}/u;
const AV_PATTERN = /(?:^|[/=])(av\d{6,})/iu;
const BILI_URL_PATTERN = /https?:\/\/(?:www\.|m\.)?bilibili\.com\/video\/(?:BV[0-9A-Za-z]{10}|av\d{6,})[^\s"'<>]*/iu;
const SHORT_URL_PATTERN = /https?:\/\/b23\.tv\/([0-9A-Za-z]+)/iu;
const MAX_TRANSCRIPT_LINES = 400;

export function videoStateDir() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(home, 'integrations', 'dsh-im', 'video');
}

export function videoCacheDir() {
  return join(videoStateDir(), 'cache');
}

/** 从消息文本里找 B 站链接（BV / av / b23 短链），去重。 */
export function extractBilibiliRefs(text) {
  const value = String(text ?? '');
  const refs = [];
  const seen = new Set();
  const push = (ref) => {
    const key = ref.bvid ?? ref.shortCode;
    if (!key || seen.has(key)) return;
    seen.add(key);
    refs.push(ref);
  };
  for (const match of value.matchAll(new RegExp(BILI_URL_PATTERN.source, 'giu'))) {
    const url = match[0];
    const bvid = BVID_PATTERN.exec(url)?.[0];
    const av = AV_PATTERN.exec(url)?.[1]?.toLowerCase();
    if (bvid) push({ bvid, url });
    else if (av) push({ av, url });
  }
  for (const match of value.matchAll(new RegExp(SHORT_URL_PATTERN.source, 'giu'))) {
    push({ shortCode: match[1], url: match[0] });
  }
  // 纯 BV 号（没有完整链接）也认：只扫描去掉 URL 后的文本，避免把别的域名里的串当 B 站。
  const withoutUrls = value.replace(/https?:\/\/\S+/gu, ' ');
  for (const match of withoutUrls.matchAll(/BV[0-9A-Za-z]{10}/gu)) {
    push({ bvid: match[0], url: `https://www.bilibili.com/video/${match[0]}` });
  }
  return refs;
}

/** 把 SESSDATA 写成本地 Netscape cookies 文件（只写本机，不打印）。 */
export function writeCookieFile(sessdata, { path = join(videoStateDir(), 'cookies.txt'), now = Date.now() } = {}) {
  const value = String(sessdata ?? '').trim();
  if (!value || /[\r\n\t]/u.test(value)) return false;
  mkdirSync(videoStateDir(), { recursive: true });
  const expires = Math.floor(now / 1000) + 180 * 24 * 60 * 60;
  const lines = [
    '# Netscape HTTP Cookie File',
    `# Generated locally by dsh-im video helper. Do not share.`,
    `.bilibili.com\tTRUE\t/\tTRUE\t${expires}\tSESSDATA\t${value}`,
    '',
  ];
  writeFileSync(path, lines.join('\n'), 'utf8');
  return true;
}

function videoConfigDefaults(config = {}) {
  const stateDir = videoStateDir();
  return {
    enabled: true,
    subtitleEnabled: true,
    asrEnabled: true,
    sessdata: '',
    cookieFile: join(stateDir, 'cookies.txt'),
    cacheDays: 7,
    maxDurationSeconds: Number(config.maxDurationSeconds) || 1800,
    maxTranscriptChars: Number(config.maxTranscriptChars) || 6000,
    whisperModel: typeof config.whisperModel === 'string' ? config.whisperModel : 'medium',
    whisperDevice: typeof config.whisperDevice === 'string' ? config.whisperDevice : 'cpu',
    pythonPath: typeof config.pythonPath === 'string' && config.pythonPath
      ? config.pythonPath
      : join(stateDir, 'venv', process.platform === 'win32' ? 'Scripts' : 'bin',
        process.platform === 'win32' ? 'python.exe' : 'python'),
    downloadTimeoutMs: Number(config.downloadTimeoutMs) || 180_000,
    subtitleTimeoutMs: Number(config.subtitleTimeoutMs) || 120_000,
    asrTimeoutMs: Number(config.asrTimeoutMs) || 600_000,
  };
}

function run(command, args, { timeoutMs = 120_000, env = {}, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', ...env },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      if (code === 0) finish(null, { stdout, stderr });
      else finish(new Error(`${command} exited ${code}: ${stderr.slice(-400) || stdout.slice(-400)}`));
    });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
  });
}

function timestampLabel(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(value / 60);
  return `${minutes}:${String(value % 60).padStart(2, '0')}`;
}

/** 解析 B 站字幕 json（{"body":[{"from":0,"to":1,"content":"..."}]}）。 */
export function parseBilibiliSubtitleJson(raw) {
  let data;
  try { data = JSON.parse(raw); } catch { return ''; }
  const body = Array.isArray(data?.body) ? data.body : Array.isArray(data) ? data : null;
  if (!body) return '';
  const lines = [];
  for (const item of body.slice(0, MAX_TRANSCRIPT_LINES)) {
    const text = typeof item?.content === 'string' ? item.content.trim() : '';
    if (!text) continue;
    lines.push(`[${timestampLabel(item.from)}] ${text}`);
  }
  return lines.join('\n');
}

/** 解析 srt / vtt 文本为带时间戳的纯文本。 */
export function parseSubtitleText(raw) {
  const value = String(raw ?? '');
  if (value.trim().startsWith('{') || value.trim().startsWith('[')) return parseBilibiliSubtitleJson(value);
  const lines = [];
  for (const line of value.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || /^WEBVTT/u.test(trimmed)) continue;
    if (/^\d+$/u.test(trimmed) || /-->/u.test(trimmed)) continue;
    lines.push(trimmed);
  }
  return lines.join('\n');
}

function readAnySubtitle(dir) {
  let entries = [];
  try { entries = readdirSync(dir); } catch { return ''; }
  const candidate = entries
    .filter((name) => /\.(?:json|srt|vtt)$/iu.test(name))
    .sort((left, right) => {
      const score = (name) => (/ai-zh|zh-Hans|zh-CN|zh\./iu.test(name) ? 10 : 0) - (name.endsWith('.json') ? 0 : 1);
      return score(right) - score(left);
    })[0];
  if (!candidate) return '';
  try { return parseSubtitleText(readFileSync(join(dir, candidate), 'utf8')); } catch { return ''; }
}

async function fetchMetadata(ref) {
  const query = ref.bvid ? `bvid=${encodeURIComponent(ref.bvid)}` : `aid=${encodeURIComponent(ref.av)}`;
  const headers = {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    referer: 'https://www.bilibili.com/',
  };
  const response = await fetch(`https://api.bilibili.com/x/web-interface/view?${query}`, { headers });
  if (!response.ok) throw new Error(`bilibili api ${response.status}`);
  const payload = await response.json();
  const data = payload?.data;
  if (!data || payload.code !== 0) throw new Error(`bilibili api code ${payload?.code ?? 'unknown'}`);
  return {
    bvid: data.bvid ?? ref.bvid,
    av: data.aid ? `av${data.aid}` : ref.av,
    title: String(data.title ?? '').trim(),
    owner: String(data.owner?.name ?? '').trim(),
    duration: Number(data.duration) || 0,
    desc: String(data.desc ?? '').trim(),
    cid: Number(data.pages?.[0]?.cid) || Number(data.cid) || 0,
    view: Number(data.stat?.view) || 0,
    url: `https://www.bilibili.com/video/${data.bvid ?? ref.bvid}`,
  };
}

async function resolveShortLink(url) {
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    return response.url || url;
  } catch {
    return url;
  }
}

async function fetchSubtitles(meta, settings) {
  if (!settings.subtitleEnabled) return { transcript: '', source: 'none' };
  if (settings.sessdata) writeCookieFile(settings.sessdata, { path: settings.cookieFile });
  if (!existsSync(settings.cookieFile)) return { transcript: '', source: 'none' };
  const work = join(videoStateDir(), 'tmp', `subs-${createHash('sha1').update(meta.bvid).digest('hex').slice(0, 12)}`);
  mkdirSync(work, { recursive: true });
  try {
    await run(settings.pythonPath, [
      '-m', 'yt_dlp',
      '--skip-download',
      '--write-subs',
      '--sub-langs', 'ai-zh,zh-Hans,zh-CN,zh',
      '--cookies', settings.cookieFile,
      '--no-warnings',
      '-o', join(work, '%(id)s'),
      meta.url,
    ], { timeoutMs: settings.subtitleTimeoutMs });
    const transcript = readAnySubtitle(work);
    return { transcript, source: transcript ? 'subtitle' : 'none' };
  } finally {
    try { rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function downloadAudio(meta, settings) {
  const work = join(videoStateDir(), 'tmp', `audio-${createHash('sha1').update(meta.bvid).digest('hex').slice(0, 12)}`);
  mkdirSync(work, { recursive: true });
  const args = [
    '-m', 'yt_dlp',
    '-f', 'bestaudio[ext=m4a]/bestaudio[ext=mp3]/bestaudio',
    '--no-warnings',
    '-o', join(work, 'audio.%(ext)s'),
  ];
  if (existsSync(settings.cookieFile)) args.push('--cookies', settings.cookieFile);
  args.push(meta.url);
  try {
    await run(settings.pythonPath, args, { timeoutMs: settings.downloadTimeoutMs });
    const audio = readdirSync(work).find((name) => /^audio\./u.test(name));
    return audio ? join(work, audio) : '';
  } catch {
    return '';
  }
}

const ASR_SCRIPT = `# -*- coding: utf-8 -*-
# Local ASR helper generated by dsh-im video-helper. Do not edit manually.
import json
import sys
import time

import av

_original_open = av.open


def _open_patched(file, mode="r", **kwargs):
    # faster-whisper passes metadata_errors; some PyAV builds do not accept it.
    kwargs.pop("metadata_errors", None)
    return _original_open(file, mode=mode, **kwargs)


av.open = _open_patched

from faster_whisper import WhisperModel  # noqa: E402

audio_path, result_path, model_name, device = sys.argv[1:5]
started = time.time()


def load_model(name, requested):
    if requested == "auto":
        try:
            return WhisperModel(name, device="cuda", compute_type="int8_float16"), "cuda"
        except Exception:  # noqa: BLE001
            return WhisperModel(name, device="cpu", compute_type="int8"), "cpu"
    compute = "int8_float16" if requested == "cuda" else "int8"
    return WhisperModel(name, device=requested, compute_type=compute), requested


try:
    whisper, used_device = load_model(model_name, device)
    segments, info = whisper.transcribe(
        audio_path,
        language="zh",
        vad_filter=True,
        beam_size=5,
        condition_on_previous_text=False,
    )
    lines = []
    for segment in segments:
        text = (segment.text or "").strip()
        if not text:
            continue
        minutes = int(segment.start) // 60
        seconds = int(segment.start) % 60
        lines.append("[%d:%02d] %s" % (minutes, seconds, text))
    payload = {
        "ok": True,
        "text": "\\n".join(lines),
        "language": getattr(info, "language", "zh"),
        "duration": round(float(getattr(info, "duration", 0) or 0), 1),
        "elapsed": round(time.time() - started, 1),
        "device": used_device,
    }
except Exception as error:  # noqa: BLE001
    payload = {"ok": False, "error": str(error)[:500]}
with open(result_path, "w", encoding="utf-8") as handle:
    json.dump(payload, handle, ensure_ascii=False)
`;

function ensureAsrScript() {
  const path = join(videoStateDir(), 'asr_transcribe.py');
  mkdirSync(videoStateDir(), { recursive: true });
  writeFileSync(path, ASR_SCRIPT, 'utf8');
  return path;
}

async function transcribe(audioPath, settings) {
  const script = ensureAsrScript();
  const resultPath = join(videoStateDir(), 'tmp', `asr-${Date.now()}.json`);
  await run(settings.pythonPath, [
    script, audioPath, resultPath, settings.whisperModel, settings.whisperDevice,
  ], {
    timeoutMs: settings.asrTimeoutMs,
    env: { HF_ENDPOINT: process.env.HF_ENDPOINT ?? 'https://hf-mirror.com' },
  });
  try {
    const payload = JSON.parse(readFileSync(resultPath, 'utf8'));
    if (!payload?.ok) return '';
    return String(payload.text ?? '').trim();
  } catch {
    return '';
  } finally {
    try { rmSync(resultPath, { force: true }); } catch { /* ignore */ }
  }
}

/** 截断转写文本（保留头尾），限制 prompt 体积。 */
export function trimTranscript(transcript, maxChars = 6000) {
  const value = String(transcript ?? '').trim();
  const limit = Math.max(500, Number(maxChars) || 6000);
  if (value.length <= limit) return value;
  const head = value.slice(0, Math.floor(limit * 0.7));
  const tail = value.slice(-Math.floor(limit * 0.25));
  return `${head}\n…（中间省略）…\n${tail}`;
}

function cachePath(bvid) {
  return join(videoCacheDir(), `${String(bvid ?? '').replace(/[^A-Za-z0-9]/gu, '')}.json`);
}

function readCache(bvid, cacheDays) {
  try {
    const file = cachePath(bvid);
    const payload = JSON.parse(readFileSync(file, 'utf8'));
    const ageDays = (Date.now() - Number(payload.at ?? 0)) / (24 * 60 * 60 * 1000);
    if (ageDays > Math.max(1, Number(cacheDays) || 7)) return null;
    return payload;
  } catch {
    return null;
  }
}

function writeCache(bvid, payload) {
  try {
    mkdirSync(videoCacheDir(), { recursive: true });
    const file = cachePath(bvid);
    writeFileSync(file, JSON.stringify(payload), 'utf8');
    statSync(file);
  } catch {
    // cache is best-effort
  }
}

/** 生成注入 prompt 的视频内容块。 */
export function buildVideoPromptBlock(meta, transcript, { maxChars = 6000, source = 'none' } = {}) {
  const minutes = Math.max(0, Math.round(Number(meta.duration) / 60));
  const seconds = Math.max(0, Math.round(Number(meta.duration) % 60));
  const duration = `${minutes}分${String(seconds).padStart(2, '0')}秒`;
  const desc = String(meta.desc ?? '').replace(/\s+/gu, ' ').trim().slice(0, 200);
  const lines = [
    '',
    '',
    '[B站视频] 如果有人问到这条视频，按下面的内容回答（只掌握了音频/字幕，没看画面，不要编造画面细节）：',
    `标题：${meta.title || '(未知)'}`,
    `UP主：${meta.owner || '(未知)'} ｜ 时长：${duration}`,
  ];
  if (desc) lines.push(`简介：${desc}`);
  const trimmed = trimTranscript(transcript, maxChars);
  if (trimmed) {
    const label = source === 'asr' ? '音频转写' : '字幕';
    lines.push(`视频内容（${label}）：`, trimmed);
  } else {
    lines.push('（没有拿到字幕或转写，只能根据标题/简介回答；不知道就直说没看到内容。）');
  }
  return lines.join('\n');
}

/**
 * B 站链接 → 视频内容上下文。
 * @returns {Promise<null | {block: string, meta: object, source: string}>}
 */
export async function buildBilibiliContext(text, { config = {}, onStage } = {}) {
  const settings = videoConfigDefaults(config);
  if (!settings.enabled) return null;
  const refs = extractBilibiliRefs(text);
  if (refs.length === 0) return null;
  let ref = refs[0];
  if (ref.shortCode) {
    const resolved = await resolveShortLink(ref.url);
    const bvid = BVID_PATTERN.exec(resolved)?.[0];
    const av = AV_PATTERN.exec(resolved)?.[1]?.toLowerCase();
    if (bvid) ref = { bvid, url: `https://www.bilibili.com/video/${bvid}` };
    else if (av) ref = { av, url: resolved };
    else return null;
  }
  const cacheKey = ref.bvid ?? ref.av;
  const cached = readCache(cacheKey, settings.cacheDays);
  if (cached?.block) {
    onStage?.('cache');
    return { block: cached.block, meta: cached.meta, source: cached.source ?? 'cache' };
  }
  onStage?.('meta');
  const meta = await fetchMetadata(ref);
  let transcript = '';
  let source = 'none';
  if (meta.duration <= settings.maxDurationSeconds) {
    onStage?.('subtitle');
    transcript = (await fetchSubtitles(meta, settings)).transcript;
    source = transcript ? 'subtitle' : 'none';
    if (!transcript && settings.asrEnabled) {
      onStage?.('asr');
      const audio = await downloadAudio(meta, settings);
      if (audio) {
        transcript = await transcribe(audio, settings);
        source = transcript ? 'asr' : 'none';
        try { rmSync(audio, { force: true }); } catch { /* ignore */ }
      }
    }
  }
  const block = buildVideoPromptBlock(meta, transcript, { maxChars: settings.maxTranscriptChars, source });
  writeCache(cacheKey, { at: Date.now(), meta, source, transcript, block });
  return { block, meta, source };
}
