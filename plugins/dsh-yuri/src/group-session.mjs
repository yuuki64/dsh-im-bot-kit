import { createHash } from 'node:crypto'

import { shortId } from './logger.mjs'

/** 会话 id 前缀。 */
export const SESSION_PREFIX = 'yuri-qq-'
/** 每群最多排队条数（超出丢最旧）。 */
export const MAX_QUEUE_PER_GROUP = 5
/** 事件去重窗口。 */
export const DEDUPE_LIMIT = 500
/** 取消后仍然等不到 whenIdle 时的兜底宽限。 */
export const TURN_OVERRUN_MS = 15000

/**
 * 每群一个会话：`yuri-qq-` + 群 OpenID 的 SHA-256 前 16 位。
 * @param {string} groupId
 * @returns {string}
 */
export function sessionIdForGroup(groupId) {
  return SESSION_PREFIX + createHash('sha256').update(String(groupId)).digest('hex').slice(0, 16)
}

/**
 * 有上限的事件 id 去重集合（先进先出淘汰）。
 * @param {number} [limit]
 */
export function createDeduper(limit = DEDUPE_LIMIT) {
  const seen = new Set()
  const order = []
  return {
    has: (id) => seen.has(id),
    add(id) {
      if (typeof id !== 'string' || id.length === 0 || seen.has(id)) return
      seen.add(id)
      order.push(id)
      while (order.length > limit) seen.delete(order.shift())
    },
    size: () => seen.size,
  }
}

/**
 * 每群串行、跨群并行的处理引擎。
 * @param {{
 *   runTurn: (input: { event: any, sessionId: string, signal: AbortSignal }) => Promise<{ text?: string }>,
 *   deliver: (input: { event: any, text: string }) => Promise<void> | void,
 *   log?: { info: Function, warn: Function, error: Function },
 *   turnTimeoutMs?: number,
 *   maxQueuePerGroup?: number,
 *   dedupeLimit?: number,
 *   turnOverrunMs?: number,
 * }} options
 */
export function createGroupSessions({
  runTurn,
  deliver,
  log,
  turnTimeoutMs = 120000,
  maxQueuePerGroup = MAX_QUEUE_PER_GROUP,
  dedupeLimit = DEDUPE_LIMIT,
  turnOverrunMs = TURN_OVERRUN_MS,
}) {
  const groups = new Map()
  const dedupe = createDeduper(dedupeLimit)
  const active = new Set()
  let disposed = false

  const stateOf = (group) => {
    let state = groups.get(group)
    if (state === undefined) {
      state = { queue: [], running: false }
      groups.set(group, state)
    }
    return state
  }

  /** 立即中止某群正在跑的回合（不用等超时）。 */
  const abortGroup = (group) => {
    const state = groups.get(group)
    if (state === undefined) return
    for (const controller of state.controllers ?? []) {
      try {
        controller.abort(new Error('group-disposed'))
      } catch {
        /* abort 不会抛，这里只是兜底 */
      }
    }
  }

  async function processItem(item) {
    const { event, group } = item
    const sessionId = sessionIdForGroup(group)
    const controller = new AbortController()
    const state = stateOf(group)
    state.controllers ??= new Set()
    state.controllers.add(controller)
    active.add(controller)

    let timedOut = false
    let timeoutTimer
    let overrunTimer
    const timeout = new Promise((resolve) => {
      timeoutTimer = setTimeout(() => {
        timedOut = true
        try {
          controller.abort(new Error('turn-timeout'))
        } catch {
          /* 同上 */
        }
        resolve('timeout')
      }, turnTimeoutMs)
      timeoutTimer?.unref?.()
    })
    const overrun = new Promise((_, reject) => {
      overrunTimer = setTimeout(() => reject(new Error('turn-stuck')), turnTimeoutMs + turnOverrunMs)
      overrunTimer?.unref?.()
    })

    log?.info('turn-start', {
      group: shortId(group),
      session: shortId(sessionId),
      event: shortId(event?.eventId),
    })

    let outcome
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => runTurn({ event, sessionId, signal: controller.signal })),
        overrun,
      ])
      outcome = { kind: 'ok', result }
    } catch (error) {
      outcome = { kind: 'error', error }
    } finally {
      clearTimeout(timeoutTimer)
      clearTimeout(overrunTimer)
      void timeout
      state.controllers.delete(controller)
      active.delete(controller)
    }

    if (disposed) {
      log?.info('turn-abandoned', { session: shortId(sessionId), reason: 'disposed' })
      return
    }
    if (timedOut) {
      log?.warn('turn-timeout', { session: shortId(sessionId), timeoutMs: turnTimeoutMs })
      return
    }
    if (outcome.kind === 'error') {
      log?.warn('turn-failed', {
        session: shortId(sessionId),
        error: String(outcome.error?.message ?? outcome.error),
      })
      return
    }

    const text = typeof outcome.result?.text === 'string' ? outcome.result.text : ''
    if (!text.trim()) {
      log?.info('turn-empty', { session: shortId(sessionId) })
      return
    }

    try {
      await deliver({ event, text })
    } catch (error) {
      log?.error('deliver-failed', { code: String(error?.code ?? error?.message ?? error) })
    }
  }

  async function pump(group) {
    const state = stateOf(group)
    if (state.running || disposed) return
    state.running = true
    try {
      while (!disposed && state.queue.length > 0) {
        const item = state.queue.shift()
        await processItem(item)
      }
    } finally {
      state.running = false
    }
  }

  return {
    /**
     * 入队：同步返回，onEvent 可以直接 return `{ accepted: true }`。
     * @param {any} event
     * @returns {{ accepted: boolean, reason?: string, queued?: number }}
     */
    enqueue(event) {
      if (disposed) return { accepted: false, reason: 'disposed' }

      const eventId = event?.eventId
      if (typeof eventId === 'string' && eventId.length > 0) {
        if (dedupe.has(eventId)) {
          log?.info('event-duplicate', { event: shortId(eventId) })
          return { accepted: false, reason: 'duplicate' }
        }
        dedupe.add(eventId)
      }

      const group = event?.conversation?.id
      if (typeof group !== 'string' || group.length === 0) return { accepted: false, reason: 'no-conversation' }

      const state = stateOf(group)
      state.queue.push({ event, group })
      if (state.queue.length > maxQueuePerGroup) {
        const dropped = state.queue.shift()
        log?.warn('queue-overflow', {
          group: shortId(group),
          limit: maxQueuePerGroup,
          dropped: shortId(dropped?.event?.eventId),
        })
      }
      void pump(group)
      return { accepted: true, queued: state.queue.length }
    },

    /** 队列长度快照（日志/测试用）。 */
    stats() {
      return [...groups.entries()].map(([group, state]) => ({
        group: shortId(group),
        queued: state.queue.length,
        running: state.running,
      }))
    },

    /** 停止：中止在跑回合、清空队列，之后不再投递任何回复。 */
    async dispose() {
      if (disposed) return
      disposed = true
      for (const controller of active) {
        try {
          controller.abort(new Error('engine-disposed'))
        } catch {
          /* 同上 */
        }
      }
      active.clear()
      for (const group of groups.keys()) abortGroup(group)
      groups.clear()
      log?.info('engine-disposed', {})
    },
  }
}
