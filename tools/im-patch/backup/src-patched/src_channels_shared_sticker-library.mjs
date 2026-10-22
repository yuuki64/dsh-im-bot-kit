// Local sticker library for QQ image messages.
//
// Sources, in order: a user-managed folder under DSH_HOME, then the user's own
// QQ "collected stickers" and marketplace-sticker cache (read-only, never
// copied). QQ's bot API has no "sticker/face" message type, so a sticker is
// sent as a normal image message; animated GIFs stay animated.

import { readdir, readFile, stat } from 'node:fs/promises';
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
