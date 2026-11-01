/**
 * 发送前的回合判定：只按事件类型和 `request/header` 的工具清单做判断，
 * 不读正文、不改 buffer，方便单测。
 */

/**
 * 一个 `request/header` 事件里的工具数。
 * 宿主在清单为空时**不写** `tools` 字段，所以缺字段按 0 算。
 * @param {{ data?: { header?: { tools?: unknown } } }} event
 * @returns {number}
 */
export function headerToolCount(event) {
  const tools = event?.data?.header?.tools
  return Array.isArray(tools) ? tools.length : 0
}

/**
 * 判定本回合能不能发送。
 *
 * `request/header` 只在首次请求、envelope 变化或序列起点时写
 * （`dsh-agent-loop/lib/index.js:1225-1240`），普通后续回合继承上一个快照。
 * 所以本回合没有 header 时沿用 `lastHeaderTools`；从未见过 header 则不放行。
 *
 * @param {Array<any>} events 本回合 buffer
 * @param {number | null} [lastHeaderTools] 该会话上一次见到的工具数（null = 从未见过）
 * @returns {{ ok: true, tools: number, headerSeen: boolean }
 *   | { ok: false, reason: 'turn-tool-activity', calls: number }
 *   | { ok: false, reason: 'turn-tools-visible', tools: number }
 *   | { ok: false, reason: 'turn-header-missing' }}
 */
export function inspectTurnEvents(events, lastHeaderTools = null) {
  const list = Array.isArray(events) ? events : []
  let activity = 0
  let headers = 0
  let lastHeaderCount = 0
  let firstVisible = null

  for (const event of list) {
    if (event?.type === 'tool/call' || event?.type === 'tool/result') {
      // 两类都算"本回合出现过工具活动"，calls 记的是这两类事件总数。
      activity += 1
      continue
    }
    if (event?.type === 'request/header') {
      headers += 1
      const count = headerToolCount(event)
      lastHeaderCount = count
      if (count > 0 && firstVisible === null) firstVisible = count
    }
  }

  if (activity > 0) return { ok: false, reason: 'turn-tool-activity', calls: activity }
  if (firstVisible !== null) return { ok: false, reason: 'turn-tools-visible', tools: firstVisible }
  if (headers === 0) {
    if (!Number.isInteger(lastHeaderTools) || lastHeaderTools < 0) {
      return { ok: false, reason: 'turn-header-missing' }
    }
    return { ok: true, tools: lastHeaderTools, headerSeen: false }
  }
  return { ok: true, tools: lastHeaderCount, headerSeen: true }
}
