// Local patch-set behavior config: reply chunking / sticker auto-collect / proactive messages.
//
// One file for every runtime knob so tuning never needs a rebuild:
//   <DSH_HOME>/integrations/dsh-im/behavior.json
//
// Everything here is optional; a missing or malformed file falls back to the
// defaults below, and individual sections merge over them (partial files work).
// Read on each use with an mtime cache, so edits apply to the next message.
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const BEHAVIOR_FILE_NAME = 'behavior.json';

export function behaviorConfigPath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(home, 'integrations', 'dsh-im', BEHAVIOR_FILE_NAME);
}

/**
 * Defaults mirror the operator's policy: short chat replies split into at most
 * three messages, only GIF/WebP/PNG stickers auto-collected from groups, and
 * three proactive windows (morning / lunch / dinner) that are off by default
 * until a bot + target list is configured.
 */
export const BEHAVIOR_DEFAULTS = Object.freeze({
  version: 1,
  replyChunking: Object.freeze({
    enabled: true,
    maxChars: 40,
    maxSegments: 3,
    gapMinMs: 400,
    gapMaxMs: 900,
  }),
  stickerCollect: Object.freeze({
    enabled: true,
    scope: 'group',
    extensions: Object.freeze(['.gif', '.webp', '.png']),
    minBytes: 2048,
    maxBytes: 3 * 1024 * 1024,
    groups: Object.freeze([]),
    autoTag: true,
    maxTags: 2,
    perMinute: 1,
    perHour: 10,
    perDay: 40,
    maxLibrary: 800,
  }),
  watch: Object.freeze({
    enabled: false,
    groups: Object.freeze([]),
    direct: false,
    textOnly: true,
    minChars: 6,
    botIds: Object.freeze([]),
    minIntervalMs: 30000,
    maxPerHour: 6,
    instruction: '',
  }),
  proactive: Object.freeze({
    enabled: false,
    dailyTimes: Object.freeze(['07:45', '11:45', '17:45']),
    jitterMinutes: 25,
    windowMinutes: 90,
    quietMinutes: 30,
    minIntervalMinutes: 120,
    maxPerDay: 3,
    probability: 0.85,
    bots: Object.freeze({}),
  }),
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Deep-merge a partial document over a defaults object (arrays replace). */
export function mergeBehavior(defaults, patch) {
  if (!isPlainObject(patch)) return defaults;
  const out = { ...defaults };
  for (const [key, value] of Object.entries(patch)) {
    const base = defaults?.[key];
    out[key] = isPlainObject(value) && isPlainObject(base) ? mergeBehavior(base, value) : value;
  }
  return out;
}

let cache = null;
let cacheAt = 0;
let cacheMtime = null;

/** Effective behavior config (defaults + behavior.json). Cached by mtime. */
export function readBehaviorConfig({ refresh = false } = {}) {
  const path = behaviorConfigPath();
  let mtimeMs = null;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    cache = null;
    cacheMtime = null;
    return structuredClone(BEHAVIOR_DEFAULTS);
  }
  if (!refresh && cache && cacheMtime === mtimeMs) return cache;
  let document = null;
  try {
    document = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    document = null;
  }
  cache = isPlainObject(document)
    ? mergeBehavior(BEHAVIOR_DEFAULTS, document)
    : structuredClone(BEHAVIOR_DEFAULTS);
  cacheMtime = mtimeMs;
  cacheAt = Date.now();
  return cache;
}

/** Last successful read time (diagnostics only). */
export function behaviorCacheAt() {
  return cache ? cacheAt : 0;
}
