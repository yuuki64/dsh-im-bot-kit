/** 给 Agent 的固定指令：只描述场景与输出格式，不带任何人设。 */
export const INSTRUCTION = '你在 QQ 群里被人 @，用中文简短回答，只输出要发到群里的话，不要提到工具或系统。'

/** 昵称缺失时的占位。 */
export const FALLBACK_NICKNAME = '群友'

/**
 * 是否被 @：外部消费者事件里只有这一个字段表示"点名了本机器人"。
 * @param {any} event
 * @returns {boolean}
 */
export function isAddressed(event) {
  return event?.mentionedAccount === true
}

/**
 * @param {any} event
 * @returns {string}
 */
export function nicknameOf(event) {
  const name = event?.actor?.name
  return typeof name === 'string' && name.trim() ? name.trim() : FALLBACK_NICKNAME
}

/**
 * 组装发给 Agent 的一轮文本：固定指令 + 「昵称：内容」。
 * 正文原样保留（换行、`<`、`>` 都不转义、不截断）。
 * @param {any} event
 * @returns {string}
 */
export function buildPrompt(event) {
  const text = typeof event?.text === 'string' ? event.text : ''
  return `${INSTRUCTION}\n\n${nicknameOf(event)}：${text}`
}
