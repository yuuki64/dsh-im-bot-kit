/** QQ 单条正文上限（被动回复 4000 字以内）。 */
export const MAX_REPLY_CHARS = 4000
/** 超长时分段大小。 */
export const CHUNK_CHARS = 1500
/** 最多发几段（每源最多 5 次被动回复，留余量给重试外的场景）。 */
export const MAX_CHUNKS = 3

/**
 * 只取 text 块拼正文；reasoning / tool 等块一律丢弃。
 * @param {{ content?: Array<{ type?: string, text?: string }> }} message
 * @returns {string}
 */
export function textOfMessage(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

/**
 * 从一个回合的事件切片里取最终回复。
 * - 出现 `turn/end` 且 reason.kind !== 'completed' → 不发送；
 * - 取最后一条 `assistant/message`；
 * - 只拼 text 块，trim 后为空 → 不发送。
 * @param {Array<any>} events
 * @returns {{ ok: true, text: string } | { ok: false, reason: string }}
 */
export function extractTurnReply(events) {
  const list = Array.isArray(events) ? events : []

  const lastTurnEnd = [...list].reverse().find((event) => event?.type === 'turn/end')
  const kind = lastTurnEnd?.data?.reason?.kind
  if (kind !== undefined && kind !== 'completed') return { ok: false, reason: `turn-${kind}` }

  const lastAssistant = [...list].reverse().find((event) => event?.type === 'assistant/message')
  if (lastAssistant === undefined) return { ok: false, reason: 'no-assistant-message' }

  const text = textOfMessage(lastAssistant.data?.message).trim()
  if (!text) return { ok: false, reason: 'empty-text' }
  return { ok: true, text }
}

/**
 * 分段：≤4000 字原样一条；超过则按 1500 字切、最多 3 段，其余截断。
 * 按码点切，避免把代理对（emoji）劈成半个字符。
 * @param {unknown} text
 * @param {{ max?: number, chunk?: number, chunks?: number }} [options]
 * @returns {{ chunks: string[], truncated: boolean }}
 */
export function segmentReply(text, { max = MAX_REPLY_CHARS, chunk = CHUNK_CHARS, chunks = MAX_CHUNKS } = {}) {
  const value = typeof text === 'string' ? text : ''
  if (!value) return { chunks: [], truncated: false }
  if (value.length <= max) return { chunks: [value], truncated: false }

  const points = Array.from(value)
  const parts = []
  for (let index = 0; index < chunks; index += 1) {
    const part = points.slice(index * chunk, (index + 1) * chunk).join('')
    if (part) parts.push(part)
  }
  return { chunks: parts, truncated: points.length > chunk * chunks }
}
