// Local sticker library for QQ image messages.
//
// Sources, in order: a user-managed folder under DSH_HOME, then the user's own
// QQ "collected stickers" and marketplace-sticker cache (read-only, never
// copied). QQ's bot API has no "sticker/face" message type, so a sticker is
// sent as a normal image message; animated GIFs stay animated.

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';

const IMAGE_EXTENSIONS = new Set(['.gif', '.png', '.jpg', '.jpeg', '.webp', '.bmp']);
const MAX_FILES = 6000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

// Optional: local QQ "collected stickers" cache root (…/nt_qq/nt_data/Emoji).
// Set DSH_IM_QQ_EMOJI_ROOT, or list explicit dirs in stickers.json instead.
const QQ_EMOJI_ROOT = (process.env.DSH_IM_QQ_EMOJI_ROOT ?? '').replace(/[\\/]+$/, '');

export function stickerConfigPath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(home, 'integrations', 'dsh-im', 'stickers.json');
}

export function defaultStickerDirs() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const dirs = [join(home, 'integrations', 'dsh-im', 'stickers')];
  if (QQ_EMOJI_ROOT) dirs.push(join(QQ_EMOJI_ROOT, 'personal_emoji'), join(QQ_EMOJI_ROOT, 'marketface'));
  return dirs;
}

/** Read `stickers.json`; missing or malformed files fall back to defaults. */
export async function readStickerConfig() {
  const defaults = { version: 1, dirs: defaultStickerDirs(), maxBytes: DEFAULT_MAX_BYTES };
  try {
    const document = JSON.parse(await readFile(stickerConfigPath(), 'utf8'));
    const dirs = Array.isArray(document?.dirs) && document.dirs.length > 0
      ? document.dirs.filter((dir) => typeof dir === 'string' && dir.trim())
      : defaults.dirs;
    const maxBytes = Number(document?.maxBytes);
    return {
      version: 1,
      dirs,
      maxBytes: Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : defaults.maxBytes,
    };
  } catch {
    return defaults;
  }
}

let cache = null;
let cacheAt = 0;
const recent = [];

async function scanDirectory(directory, maxBytes, out) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) return;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      await scanDirectory(full, maxBytes, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const extension = extname(entry.name).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(extension)) continue;
    try {
      const info = await stat(full);
      if (!info.isFile() || info.size === 0 || info.size > maxBytes) continue;
      out.push({ path: full, name: entry.name, mediaType: mediaTypeFor(extension), size: info.size });
    } catch {
      // Unreadable cache entries are skipped silently.
    }
  }
}

function mediaTypeFor(extension) {
  switch (extension) {
    case '.gif': return 'image/gif';
    case '.png': return 'image/png';
    case '.webp': return 'image/webp';
    case '.bmp': return 'image/bmp';
    default: return 'image/jpeg';
  }
}

/** All usable stickers across configured directories (cached briefly). */
export async function listStickers({ refresh = false } = {}) {
  const now = Date.now();
  if (!refresh && cache && now - cacheAt < CACHE_TTL_MS) return cache;
  const config = await readStickerConfig();
  const stickers = [];
  for (const directory of config.dirs) {
    await scanDirectory(directory, config.maxBytes, stickers);
  }
  cache = stickers;
  cacheAt = now;
  return stickers;
}

/** Rough keyword match over file names; unknown words fall back to random. */
function score(sticker, tokens) {
  const name = sticker.name.toLowerCase();
  let total = 0;
  for (const token of tokens) {
    if (name.includes(token)) total += 2;
  }
  return total;
}

/**
 * Pick one sticker, avoiding the most recent picks. `query` may be empty.
 * @returns {Promise<{path: string, name: string, mediaType: string, bytes: Buffer}|null>}
 */
export async function pickSticker(query = '') {
  const stickers = await listStickers();
  if (stickers.length === 0) return null;
  const tokens = String(query ?? '')
    .toLowerCase()
    .split(/[\s,，。!！?？、/|]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 1 && token.length <= 12);
  const scored = tokens.length > 0
    ? stickers.map((sticker) => ({ sticker, score: score(sticker, tokens) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
    : [];
  const pool = scored.length > 0 ? scored.slice(0, 24).map((entry) => entry.sticker) : stickers;
  const fresh = pool.filter((sticker) => !recent.includes(sticker.path));
  const candidates = fresh.length > 0 ? fresh : pool;
  const chosen = candidates[Math.floor(Math.random() * candidates.length)];
  recent.push(chosen.path);
  while (recent.length > 24) recent.shift();
  const bytes = await readFile(chosen.path);
  return { ...chosen, bytes };
}

export function stickerCount(stickers) {
  return Array.isArray(stickers) ? stickers.length : 0;
}

// ---------------------------------------------------------------------------
// 本地补丁（2026-10-24）：入站表情自动收藏
//
// 只收 GIF/WebP/PNG 小图（照片通常是更大的 jpg，天然避开），按内容 sha1
// 去重存进用户表情库，并限制每分钟/每小时/每天数量与自动收藏总量，超过
// 上限时删最早的自动收藏（不动用户自己放进去的图）。
// ---------------------------------------------------------------------------

const AUTO_PREFIX = 'auto_';
const COLLECTABLE_EXTENSIONS = new Set(['.gif', '.webp', '.png']);
export const MIN_COLLECT_BYTES = 2 * 1024;
export const MAX_COLLECT_BYTES = 3 * 1024 * 1024;

function sniffImageExtension(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 6) return null;
  const head = buffer.subarray(0, 6).toString('latin1');
  if (head === 'GIF87a' || head === 'GIF89a') return '.gif';
  if (buffer.length >= 8
    && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
    && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a) return '.png';
  if (buffer.length >= 12
    && buffer.subarray(0, 4).toString('latin1') === 'RIFF'
    && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return '.webp';
  return null;
}

/** Whether one inbound attachment looks like a collectable sticker. */
export function isCollectableSticker({
  name = '',
  mediaType = '',
  size = null,
  extensions = COLLECTABLE_EXTENSIONS,
} = {}) {
  const type = String(mediaType ?? '').toLowerCase();
  const extension = extname(String(name ?? '')).toLowerCase();
  const allowed = extensions instanceof Set ? extensions : new Set(extensions ?? COLLECTABLE_EXTENSIONS);
  const typeAccepted = type
    ? (type === 'image/gif' || type === 'image/webp' || type === 'image/png')
    : allowed.has(extension);
  if (!typeAccepted) return false;
  if (type && allowed.size > 0 && !allowed.has(extension) && extension) return false;
  const bytes = Number(size);
  if (Number.isFinite(bytes) && (bytes < MIN_COLLECT_BYTES || bytes > MAX_COLLECT_BYTES)) return false;
  return true;
}

const collectLog = [];

/** Sliding window rate limit for auto collection (shared process-wide). */
export function allowStickerCollection({ perMinute = 1, perHour = 10, perDay = 40 } = {}, now = Date.now()) {
  while (collectLog.length > 0 && now - collectLog[0] > 24 * 60 * 60 * 1000) collectLog.shift();
  const minute = collectLog.filter((at) => now - at < 60_000).length;
  const hour = collectLog.filter((at) => now - at < 60 * 60 * 1000).length;
  const day = collectLog.length;
  if (minute >= Number(perMinute)) return false;
  if (hour >= Number(perHour)) return false;
  if (day >= Number(perDay)) return false;
  collectLog.push(now);
  return true;
}

export function resetStickerCollectLog() {
  collectLog.length = 0;
}

async function countAutoStickers(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return { entries: [], total: 0 };
  }
  const auto = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(AUTO_PREFIX)) continue;
    const extension = extname(entry.name).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(extension)) continue;
    try {
      auto.push({ name: entry.name, path: join(directory, entry.name), mtimeMs: (await stat(join(directory, entry.name))).mtimeMs });
    } catch {
      // ignore unreadable entries
    }
  }
  return { entries: auto, total: auto.length };
}

async function enforceAutoCap(directory, maxLibrary) {
  const limit = Number.isFinite(Number(maxLibrary)) && Number(maxLibrary) > 0 ? Math.floor(Number(maxLibrary)) : 800;
  const { entries, total } = await countAutoStickers(directory);
  if (total <= limit) return 0;
  entries.sort((left, right) => left.mtimeMs - right.mtimeMs);
  let removed = 0;
  for (const entry of entries.slice(0, total - limit)) {
    try {
      await unlink(entry.path);
      removed += 1;
    } catch {
      // ignore
    }
  }
  return removed;
}

/**
 * Save one sticker into the first configured library directory.
 * @returns {Promise<{saved: boolean, reason?: string, path?: string}>}
 */
export async function saveSticker({ bytes, name = '', maxLibrary = 800, dir = null } = {}) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  if (buffer.length < MIN_COLLECT_BYTES) return { saved: false, reason: 'too-small' };
  if (buffer.length > MAX_COLLECT_BYTES) return { saved: false, reason: 'too-large' };
  const declared = extname(String(name ?? '')).toLowerCase();
  const extension = COLLECTABLE_EXTENSIONS.has(declared) ? declared : sniffImageExtension(buffer);
  if (!extension) return { saved: false, reason: 'type' };
  const directory = dir ?? (await readStickerConfig()).dirs[0];
  if (!directory) return { saved: false, reason: 'no-library' };
  await mkdir(directory, { recursive: true });
  const digest = createHash('sha1').update(buffer).digest('hex').slice(0, 16);
  const target = join(directory, `${AUTO_PREFIX}${digest}${extension}`);
  try {
    await stat(target);
    return { saved: false, reason: 'duplicate', path: target };
  } catch {
    // not collected yet
  }
  await writeFile(target, buffer);
  cache = null; // force the next pick to rescan
  await enforceAutoCap(directory, maxLibrary);
  return { saved: true, path: target };
}

/** Auto-collected sticker count/bytes (status helpers). */
export async function autoStickerStats({ dir = null } = {}) {
  const directory = dir ?? (await readStickerConfig()).dirs[0];
  if (!directory) return { count: 0, bytes: 0 };
  const { entries } = await countAutoStickers(directory);
  let bytes = 0;
  for (const entry of entries) {
    try {
      bytes += (await stat(entry.path)).size;
    } catch {
      // ignore
    }
  }
  return { count: entries.length, bytes };
}
