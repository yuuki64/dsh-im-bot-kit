import { createHash } from 'node:crypto'

const PREFIX = '[dsh-yuri]'

/**
 * 标识符脱敏：群 / 用户 / 消息 / 会话一律只留 SHA-256 前 8 位。
 * @param {unknown} value
 * @returns {string}
 */
export function shortId(value) {
  if (value === undefined || value === null || value === '') return '-'
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 8)
}

/**
 * 正文摘要：默认只记长度；只有显式打开时才记原文。
 * @param {unknown} text
 * @param {boolean} allowText
 * @returns {string}
 */
export function textInfo(text, allowText = false) {
  const value = typeof text === 'string' ? text : ''
  return allowText ? `text=${JSON.stringify(value)}` : `len=${value.length}`
}

/**
 * 基于任意 sink 的极简日志器，便于单测里换成假对象。
 * @param {{ sink?: { info?: Function, warn?: Function, error?: Function, log?: Function }, debugText?: boolean }} [options]
 */
export function createLogger({ sink = console, debugText = false } = {}) {
  const emit = (level, message, fields = {}) => {
    const parts = Object.entries(fields)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(',') : value}`)
    const line = `${PREFIX} ${message}${parts.length > 0 ? ` ${parts.join(' ')}` : ''}`
    const write = sink?.[level] ?? sink?.log
    if (typeof write === 'function') write.call(sink, line)
  }
  return {
    debugText,
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    textInfo: (text) => textInfo(text, debugText),
  }
}
