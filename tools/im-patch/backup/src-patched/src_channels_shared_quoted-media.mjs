// In-memory cache of inbound image bytes keyed by conversation + platform
// message id.
//
// Why this exists: QQ delivers a quoted/replied message only as a snapshot
// (author + text + attachment names) with no download URL, and the group
// archive only covers messages that were actually delivered to the bot. WeChat
// iLink has the same gap for older quoted items. Capturing the bytes the host
// already downloads lets a later reply still see the quoted picture instead of
// answering "I only got a file name".

const MAX_ENTRIES = 48;
const MAX_TOTAL_BYTES = 48 * 1024 * 1024;
const MAX_ITEM_BYTES = 32 * 1024 * 1024;
const TTL_MS = 6 * 60 * 60 * 1000;

/** @typedef {{data: Buffer, name?: string, mediaType?: string}} CachedImage */
/** @type {Map<string, {at: number, bytes: number, items: CachedImage[]}>} */
const entries = new Map();
let totalBytes = 0;

function entryKey(scope, messageId) {
  return `${scope}\u0000${messageId}`;
}

function bytesOf(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  const raw = value?.data ?? value?.buffer;
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof Uint8Array) return Buffer.from(raw);
  return null;
}

function dropOldest() {
  const oldestKey = entries.keys().next().value;
  if (oldestKey === undefined) return false;
  const entry = entries.get(oldestKey);
  if (entry) totalBytes -= entry.bytes;
  entries.delete(oldestKey);
  return true;
}

function prune(now = Date.now()) {
  for (const [key, entry] of entries) {
    if (now - entry.at > TTL_MS) {
      totalBytes -= entry.bytes;
      entries.delete(key);
    }
  }
  while (entries.size > MAX_ENTRIES && dropOldest()) { /* keep evicting */ }
  while (totalBytes > MAX_TOTAL_BYTES && dropOldest()) { /* keep evicting */ }
}

function normalizeItems(items) {
  const captured = [];
  let bytes = 0;
  for (const item of items) {
    const data = bytesOf(item);
    if (!data || data.length === 0) continue;
    if (data.length > MAX_ITEM_BYTES) continue;
    if (bytes + data.length > MAX_TOTAL_BYTES) break;
    bytes += data.length;
    captured.push({
      data,
      ...(item?.kind === 'image' || item?.kind === 'file' ? { kind: item.kind } : {}),
      ...(typeof item?.name === 'string' && item.name.trim() ? { name: item.name.trim() } : {}),
      ...(typeof item?.mediaType === 'string' && item.mediaType.trim()
        ? { mediaType: item.mediaType.trim() }
        : {}),
    });
  }
  return captured;
}

/**
 * Store the image bytes of one inbound message.
 * @param {string} scope conversation scope, e.g. `qq:group:<id>`
 * @param {string} messageId platform message id
 * @param {Array<{name?: string, mediaType?: string, data: Buffer}>} items
 */
export function rememberQuotedMedia(scope, messageId, items) {
  if (!scope || !messageId || !Array.isArray(items)) return;
  const captured = normalizeItems(items);
  if (captured.length === 0) return;
  let bytes = 0;
  for (const item of captured) bytes += item.data.length;
  const key = entryKey(scope, messageId);
  const previous = entries.get(key);
  if (previous) totalBytes -= previous.bytes;
  entries.delete(key);
  entries.set(key, { at: Date.now(), bytes, items: captured });
  totalBytes += bytes;
  prune();
}

/**
 * Read the cached images of a replied message, shaped like ordinary inbound
 * image sources so the existing staging path can consume them.
 */
export function quotedMediaFor(scope, messageId) {
  if (!scope || !messageId) return [];
  const key = entryKey(scope, messageId);
  const entry = entries.get(key);
  if (!entry) return [];
  if (Date.now() - entry.at > TTL_MS) {
    totalBytes -= entry.bytes;
    entries.delete(key);
    return [];
  }
  // Refresh recency without changing the byte accounting.
  entries.delete(key);
  entries.set(key, entry);
  return entry.items.map((item) => ({
    ...(item.kind ? { kind: item.kind } : {}),
    ...(item.name ? { name: item.name } : {}),
    ...(item.mediaType ? { mediaType: item.mediaType } : {}),
    load: async () => item.data,
  }));
}

/**
 * Wrap inbound image sources so that whenever the host loads one (the normal
 * download path), the bytes are also remembered for later quotes. No extra
 * network traffic: only already-downloaded data is captured.
 */
export function captureQuotedMedia(scope, messageId, images, { kind } = {}) {
  if (!scope || !messageId || !Array.isArray(images) || images.length === 0) return images;
  const itemKind = kind === 'image' || kind === 'file' ? kind : undefined;
  /** @type {Array<{data: Buffer, name?: string, mediaType?: string, kind?: string}>} */
  const captured = [];
  const flush = () => {
    if (captured.length === 0) return;
    const batch = captured.splice(0, captured.length);
    try {
      rememberQuotedMedia(scope, messageId, batch);
    } catch {
      // Cache misses must never break prompt delivery.
    }
  };
  const record = (source) => {
    const data = bytesOf(source);
    if (!data) return;
    captured.push({
      data,
      ...(itemKind ? { kind: itemKind } : {}),
      name: source?.name,
      mediaType: source?.mediaType,
    });
  };
  const wrapped = images.map((source) => {
    if (!source || typeof source.load !== 'function') {
      record(source);
      return source;
    }
    const load = source.load;
    return {
      ...source,
      load: async (options) => {
        const value = await load(options);
        record({ data: bytesOf(value), name: source?.name, mediaType: source?.mediaType });
        flush();
        return value;
      },
    };
  });
  // Sources that already carry their bytes never call load: keep them anyway.
  flush();
  return wrapped;
}

/** Test seam: drop everything (used by unit checks, never by the bridge). */
export function clearQuotedMediaCache() {
  entries.clear();
  totalBytes = 0;
}
