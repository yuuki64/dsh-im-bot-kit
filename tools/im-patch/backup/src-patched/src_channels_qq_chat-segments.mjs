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

export const CHAT_SEGMENT_DEFAULTS = Object.freeze({
  maxChars: 60,
  maxSegments: 3,
});

function normalizeOptions(options = {}) {
  const maxChars = Number(options.maxChars);
  const maxSegments = Number(options.maxSegments);
  return {
    maxChars: Number.isFinite(maxChars) && maxChars >= 20 ? Math.floor(maxChars) : CHAT_SEGMENT_DEFAULTS.maxChars,
    maxSegments: Number.isFinite(maxSegments) && maxSegments >= 2
      ? Math.min(HARD_SEGMENT_LIMIT, Math.floor(maxSegments))
      : CHAT_SEGMENT_DEFAULTS.maxSegments,
  };
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
  const { maxChars, maxSegments } = normalizeOptions(options);
  const value = typeof text === 'string' ? text.trim() : '';
  if (!value || value.length <= maxChars) return null;
  if (BLOCK_MARKER.test(value) || URL_PATTERN.test(value)) return null;
  const sentences = splitSentences(value);
  // A single long sentence is left alone: the operator asked for long *messages*
  // to be split at natural boundaries, not for one sentence to be cut in half.
  if (sentences.length < 2) return null;
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
