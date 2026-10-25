// Split a chat-style reply into several short QQ messages.
//
// The operator asked for long sentences to be sent as separate messages, not
// one long line, and explicitly not to rely on commas. This module works on
// sentence boundaries (。！？…!?；) and line breaks only, keeps every segment
// readable on its own, and never touches code blocks, tables or URLs — those
// go through the ordinary markdown chunker untouched.

const SENTENCE_BREAK = /(?<=[。！？!?…；;])|\n+/u;
const BLOCK_MARKER = /```|(^|\n)[ \t]*\|/u;
const URL_PATTERN = /https?:\/\/\S+/iu;
const HARD_SEGMENT_LIMIT = 4; // passive reply cap is 5 (group) / 4 (c2c)
// 本地补丁（2026-10-25）：单句超过这个长度才按逗号兜底拆——只做极限兜底，不常规拆逗号。
const LONG_SENTENCE_LIMIT = 60;
const COMMA_BREAK = /[，,、]/gu;

export const CHAT_SEGMENT_DEFAULTS = Object.freeze({
  maxChars: 60,
  maxSegments: 3,
  longSentenceLimit: LONG_SENTENCE_LIMIT,
});

function normalizeOptions(options = {}) {
  const maxChars = Number(options.maxChars);
  const maxSegments = Number(options.maxSegments);
  const longSentenceLimit = Number(options.longSentenceLimit);
  return {
    maxChars: Number.isFinite(maxChars) && maxChars >= 20 ? Math.floor(maxChars) : CHAT_SEGMENT_DEFAULTS.maxChars,
    maxSegments: Number.isFinite(maxSegments) && maxSegments >= 2
      ? Math.min(HARD_SEGMENT_LIMIT, Math.floor(maxSegments))
      : CHAT_SEGMENT_DEFAULTS.maxSegments,
    longSentenceLimit: Number.isFinite(longSentenceLimit) && longSentenceLimit >= 20
      ? Math.floor(longSentenceLimit)
      : CHAT_SEGMENT_DEFAULTS.longSentenceLimit,
  };
}

/** Split a too-long single sentence at commas, capped at 2 segments. */
export function splitLongSentence(value, maxSegments = 2) {
  const text = typeof value === 'string' ? value.trim() : '';
  const cap = Math.max(2, Math.min(2, Number(maxSegments) || 2));
  const segments = [];
  let rest = text;
  let remaining = cap;
  while (remaining > 1) {
    const positions = [...rest.matchAll(COMMA_BREAK)].map((match) => match.index + 1);
    if (positions.length === 0) break;
    const target = rest.length / remaining;
    let cut = positions[0];
    for (const position of positions) {
      if (Math.abs(position - target) < Math.abs(cut - target)) cut = position;
    }
    const head = rest.slice(0, cut).trim();
    if (!head) break;
    segments.push(head);
    rest = rest.slice(cut).trim();
    remaining -= 1;
  }
  if (rest) segments.push(rest);
  return segments.length >= 2 ? segments : null;
}

/** Split into sentence-ish pieces, keeping the trailing punctuation. */
export function splitSentences(text) {
  const value = typeof text === 'string' ? text.replace(/\r\n?/gu, '\n') : '';
  return value
    .split(SENTENCE_BREAK)
    .map((piece) => piece.trim())
    .filter(Boolean);
}

function packPieces(pieces, maxChars) {
  const packed = [];
  let current = '';
  for (const piece of pieces) {
    if (current && current.length + piece.length > maxChars) {
      packed.push(current);
      current = piece;
    } else {
      current += piece;
    }
  }
  if (current) packed.push(current);
  return packed;
}

function mergeToLimit(segments, limit) {
  const merged = [...segments];
  while (merged.length > limit) {
    let bestIndex = 0;
    let bestSize = Number.POSITIVE_INFINITY;
    for (let index = 0; index + 1 < merged.length; index += 1) {
      const size = merged[index].length + merged[index + 1].length;
      if (size < bestSize) {
        bestSize = size;
        bestIndex = index;
      }
    }
    merged.splice(bestIndex, 2, merged[bestIndex] + merged[bestIndex + 1]);
  }
  return merged;
}

/**
 * Plan chat segments. Returns null when the reply must stay a single message
 * (short, one long sentence, code block, table or URL) so callers can simply
 * fall through to the normal delivery path.
 *
 * @returns {string[]|null}
 */
export function splitChatSegments(text, options = {}) {
  const { maxChars, maxSegments, longSentenceLimit } = normalizeOptions(options);
  const value = typeof text === 'string' ? text.trim() : '';
  if (!value || value.length <= maxChars) return null;
  if (BLOCK_MARKER.test(value) || URL_PATTERN.test(value)) return null;
  const sentences = splitSentences(value);
  // A single long sentence is normally left alone; only an extreme one is split
  // at commas (operator decision 2026-10-25: >80 chars, max 2 messages).
  if (sentences.length < 2) {
    if (value.length <= longSentenceLimit) return null;
    return splitLongSentence(value, 2);
  }
  const packed = packPieces(sentences, maxChars);
  if (packed.length < 2) return null;
  const capped = mergeToLimit(packed, maxSegments);
  if (capped.length < 2) return null;
  return capped;
}

/** Cheap boolean form for call sites that only need the decision. */
export function shouldSplitChatReply(text, options = {}) {
  return splitChatSegments(text, options) !== null;
}

