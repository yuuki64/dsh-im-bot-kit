import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { loadConfig } from './src/config.mjs'
import { buildPrompt, isAddressed } from './src/prompt.mjs'
import { extractTurnReply, segmentReply } from './src/reply-text.mjs'
import { createToolRestrictor } from './src/restrict.mjs'
import { createGroupSessions } from './src/group-session.mjs'
import { createLogger, shortId } from './src/logger.mjs'

export const name = 'dsh-yuri'

/**
 * 宿主依赖在 apply 内部按需 inject：配置关闭时连服务都不等，避免
 * “装上了但没开”的机器去拉 dshIm。
 */
export const inject = []

/** 宿主服务名（dsh-im 通过 ctx.provide('dshIm') 暴露）。 */
const REQUIRED_SERVICES = ['dshIm', 'agents', 'agentDefaultModel']

/** describeBot 的等待策略：机器人刚启动时 WebSocket 还没 ready。 */
const DESCRIBE_ATTEMPTS = 8
const DESCRIBE_DELAY_MS = 5000

/** 少一个都不接管。 */
const REQUIRED_CAPABILITIES = ['exclusive-text-consumer', 'reply-text-checked']

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * @param {any} ctx cordis 插件上下文
 */
export function apply(ctx) {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const state = {
    disposed: false,
    log: undefined,
    config: undefined,
    workspace: undefined,
    child: undefined,
    dshIm: undefined,
    agents: undefined,
    agentDefaultModel: undefined,
    fingerprint: undefined,
    controller: undefined,
    consumer: undefined,
    engine: undefined,
    sessions: new Map(),
  }

  ctx.effect(() => () => {
    void shutdown(state, 'ctx-dispose')
  }, 'dsh-yuri.lifecycle()')

  void start(ctx, dshHome, state).catch((error) => {
    state.log?.error('activation-failed', { reason: String(error?.message ?? error) })
  })
}

/**
 * 读本地配置 → 决定是否接管。
 * @param {any} ctx
 * @param {string} dshHome
 * @param {any} state
 */
async function start(ctx, dshHome, state) {
  const config = await loadConfig({ dshHome })
  const log = createLogger({ debugText: config.debugLogText === true })
  state.log = log
  state.config = config

  if (!config.enabled) {
    log.info('disabled', { reason: config.reason })
    return
  }

  log.info('config-ok', {
    botId: shortId(config.botId),
    groups: config.allowedGroups.length,
    timeoutMs: config.turnTimeoutMs,
  })

  state.workspace = join(dshHome, 'integrations', 'dsh-yuri', 'workspace')
  await mkdir(state.workspace, { recursive: true })

  ctx.inject(REQUIRED_SERVICES, (child) => {
    void attach(child, state).catch((error) => {
      log.error('attach-failed', { reason: String(error?.message ?? error) })
    })
  })
}

/**
 * 校验机器人能力后接管入站消息。
 * @param {any} child 注入后的上下文
 * @param {any} state
 */
async function attach(child, state) {
  const { log, config } = state
  state.child = child
  state.dshIm = child.dshIm
  state.agents = child.agents
  state.agentDefaultModel = child.agentDefaultModel

  const described = await describeWithRetry(child.dshIm, config.botId, log)
  if (described === undefined) {
    log.warn('not-taking-over', { reason: 'describe-bot-unavailable' })
    return
  }

  const fingerprint = described.account?.fingerprint
  if (typeof fingerprint !== 'string' || fingerprint.length === 0) {
    log.warn('not-taking-over', { reason: 'missing-fingerprint' })
    return
  }

  const capabilities = Array.isArray(described.capabilities) ? described.capabilities : []
  const missing = REQUIRED_CAPABILITIES.filter((capability) => !capabilities.includes(capability))
  if (missing.length > 0) {
    log.warn('not-taking-over', { reason: 'capabilities-missing', missing })
    return
  }
  state.fingerprint = fingerprint

  const engine = createGroupSessions({
    log,
    turnTimeoutMs: config.turnTimeoutMs,
    runTurn: (input) => runTurn(state, input),
    deliver: (input) => deliverReply(state, input),
  })
  state.engine = engine

  const controller = new AbortController()
  state.controller = controller

  // 不可逆点：这一行会把机器人写成 external-consumer 模式。
  const dispose = await child.dshIm.consumeInbound(config.botId, {
    expectedFingerprint: fingerprint,
    ordinaryText: false,
    signal: controller.signal,
    onEvent: (event) => {
      if (state.disposed) return { accepted: true }
      const group = event?.conversation?.id
      if (!config.allowedGroups.includes(group)) {
        log.info('ignore-group', { group: shortId(group), event: shortId(event?.eventId) })
        return { accepted: true }
      }
      if (!isAddressed(event)) {
        log.info('ignore-not-addressed', { group: shortId(group), event: shortId(event?.eventId) })
        return { accepted: true }
      }
      const queued = engine.enqueue(event)
      log.info('event-accepted', {
        group: shortId(group),
        event: shortId(event?.eventId),
        queued: queued.queued,
      })
      return { accepted: true }
    },
  })

  state.consumer = dispose
  log.info('consumer-registered', {
    botId: shortId(config.botId),
    groups: config.allowedGroups.length,
    capabilities: capabilities.length,
  })
}

/**
 * describeBot 需要机器人已连上 QQ，启动期会短暂不可用。
 * @returns {Promise<any | undefined>}
 */
async function describeWithRetry(dshIm, botId, log) {
  for (let attempt = 1; attempt <= DESCRIBE_ATTEMPTS; attempt += 1) {
    try {
      return await dshIm.describeBot(botId)
    } catch (error) {
      const code = String(error?.code ?? error?.message ?? error)
      if (attempt === DESCRIBE_ATTEMPTS) {
        log.warn('describe-bot-failed', { attempt, code })
        return undefined
      }
      log.info('describe-bot-retry', { attempt, code })
      await sleep(DESCRIBE_DELAY_MS)
    }
  }
  return undefined
}

/**
 * 一个回合：取/建会话 → 幂等重放工具限制 → followup → whenIdle → 取文本。
 * @param {any} state
 * @param {{ event: any, sessionId: string, signal: AbortSignal }} input
 */
async function runTurn(state, { event, sessionId, signal }) {
  const { log } = state
  let record = state.sessions.get(sessionId)
  if (record === undefined) {
    record = await createSession(state, sessionId)
  }

  // 每个回合前再幂等执行一次：应对 MCP 等晚注册的全局工具。失败即 fail-closed。
  record.restrictor.apply({ tools: record.agentCtx.tools, scope: record.agent })

  const prompt = buildPrompt(event)
  log.info('turn-prompt', {
    session: shortId(sessionId),
    event: shortId(event?.eventId),
    ...(log.debugText ? { text: JSON.stringify(prompt) } : { len: prompt.length }),
  })

  const buffer = []
  const off = state.child.on('session/event', (session, sessionEvent) => {
    if (session?.id === sessionId) buffer.push(sessionEvent)
  })
  const onAbort = () => {
    try {
      record.agent.cancel({ kind: 'timeout' })
    } catch {
      /* 取消失败也不能让队列崩 */
    }
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    record.agent.followup({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    })
    await record.agent.whenIdle()
  } finally {
    try {
      off?.()
    } catch {
      /* 同上 */
    }
    signal?.removeEventListener('abort', onAbort)
  }

  if (signal?.aborted) return {}

  const verdict = extractTurnReply(buffer)
  if (!verdict.ok) {
    log.info('turn-no-reply', { session: shortId(sessionId), reason: verdict.reason })
    return {}
  }
  log.info('turn-reply', { session: shortId(sessionId), len: verdict.text.length })
  return { text: verdict.text }
}

/**
 * 每群一个会话；进程内缓存，重启后新建。
 * @param {any} state
 * @param {string} sessionId
 */
async function createSession(state, sessionId) {
  const { log, agents, agentDefaultModel, workspace } = state
  const selection = agentDefaultModel.currentSelection()
  const restrictor = createToolRestrictor({ log })
  let agentCtx
  let agent

  const handle = await agents.create({
    sessionId,
    agentOptions: { provider: selection.provider, model: selection.model },
    meta: { cwd: workspace },
    setup: (scopedCtx, createdAgent) => {
      agentCtx = scopedCtx
      agent = createdAgent
      const info = restrictor.apply({ tools: scopedCtx.tools, scope: createdAgent })
      log.info('restricted', {
        session: shortId(sessionId),
        mode: info.mode,
        denied: info.denied.length,
        visible: info.visible === null ? 'unknown' : info.visible.length,
      })
    },
  })

  const record = {
    sessionId,
    handle,
    agent: agent ?? handle.agent,
    agentCtx,
    restrictor,
  }
  state.sessions.set(sessionId, record)
  log.info('session-created', {
    session: shortId(sessionId),
    model: `${selection.provider}/${selection.model}`,
  })
  return record
}

/**
 * 回发：分段、逐段 replyChecked；任何失败只记日志，不重试、不把错误发进群。
 * @param {any} state
 * @param {{ event: any, text: string }} input
 */
async function deliverReply(state, { event, text }) {
  const { log, config, dshIm, fingerprint } = state
  if (state.disposed) return

  const { chunks, truncated } = segmentReply(text)
  if (truncated) {
    log.warn('reply-truncated', {
      event: shortId(event?.eventId),
      sourceLen: text.length,
      sentLen: chunks.join('').length,
    })
  }

  for (const [index, chunk] of chunks.entries()) {
    try {
      const result = await dshIm.replyChecked(config.botId, event.reply, chunk, {
        expectedFingerprint: fingerprint,
        signal: state.controller?.signal,
        receipt: true,
        beforeSend: () => state.disposed !== true,
      })
      log.info('reply-sent', {
        event: shortId(event?.eventId),
        part: `${index + 1}/${chunks.length}`,
        len: chunk.length,
        receipt: shortId(result?.receipt?.messageId),
      })
    } catch (error) {
      log.error('reply-failed', {
        event: shortId(event?.eventId),
        part: index + 1,
        code: String(error?.code ?? error?.message ?? error),
      })
      return
    }
  }
}

/**
 * 顺序：中止 consumer → 调 dispose → 释放所有会话句柄。
 * @param {any} state
 * @param {string} reason
 */
async function shutdown(state, reason) {
  if (state.disposed) return
  state.disposed = true
  const { log } = state

  try {
    state.controller?.abort(new Error('plugin-dispose'))
  } catch {
    /* abort 不会抛 */
  }
  try {
    await state.consumer?.()
  } catch (error) {
    log?.warn('consumer-dispose-failed', { reason: String(error?.message ?? error) })
  }
  try {
    await state.engine?.dispose()
  } catch {
    /* 队列已清空即可 */
  }
  for (const record of state.sessions.values()) {
    try {
      record.restrictor?.dispose()
    } catch {
      /* 忽略 */
    }
    try {
      await record.handle?.dispose()
    } catch {
      /* 忽略 */
    }
  }
  state.sessions.clear()
  log?.info('stopped', { reason })
}
