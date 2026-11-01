import assert from 'node:assert/strict'
import test from 'node:test'

import { runTurn } from '../index.js'

const SESSION_ID = 'yuri-qq-test'
const EVENT = { eventId: 'evt-1', actor: { name: '群友' }, text: '你好' }

const header = (names = []) => ({
  type: 'request/header',
  data: { header: names.length > 0 ? { tools: names.map((name) => ({ name })) } : {} },
})
const assistant = (text = '你好') => ({
  type: 'assistant/message',
  data: { message: { content: [{ type: 'text', text }] } },
})

function recordingLog() {
  const entries = []
  const push = (level) => (message, fields) => entries.push({ level, message, fields })
  return { entries, debugText: false, info: push('info'), warn: push('warn'), error: push('error') }
}

/** 预先塞一个会话（跳过 createSession），用假 agent 跑 runTurn。 */
function setupRun({ visible = [], lastHeaderTools = null, turnEvents = [] } = {}) {
  const log = recordingLog()
  const errors = []
  const record = {
    sessionId: SESSION_ID,
    handle: { dispose: async () => { record.handleDisposed = true } },
    agent: { cancel() {}, whenIdle: async () => {} },
    agentCtx: { tools: {} },
    restrictor: {
      apply: () => ({ mode: 'allow-empty', denied: [], visible, fresh: [] }),
      dispose() { record.restrictorDisposed = true },
    },
    lastHeaderTools,
    followupCalls: 0,
  }
  const state = { log, sessions: new Map([[SESSION_ID, record]]), child: null }
  let handler
  state.child = {
    on: (type, listener) => {
      handler = listener
      return () => { handler = undefined }
    },
  }
  record.agent.followup = () => {
    record.followupCalls += 1
    for (const event of turnEvents) handler?.({ id: SESSION_ID }, event)
  }
  const signal = new AbortController().signal
  return { state, record, log, errors, run: () => runTurn(state, { event: EVENT, sessionId: SESSION_ID, signal }) }
}

test('visible 非空 → 不发起回合，返回 {}，会话被移除', async () => {
  const { state, record, log, run } = setupRun({ visible: ['x'] })
  const result = await run()

  assert.deepEqual(result, {})
  assert.equal(record.followupCalls, 0, '不能发起 followup')
  assert.equal(state.sessions.size, 0, '会话必须从 state.sessions 移除')
  assert.equal(record.handleDisposed, true, '会话句柄必须释放')
  const failure = log.entries.find((entry) => entry.message === 'restrict-postcondition-failed')
  assert.ok(failure, '必须记录 restrict-postcondition-failed')
  assert.equal(failure.fields.visible, 1)
  assert.deepEqual(failure.fields.names, ['x'])
})

test('visible 为 null → 同样拦截，visible 记 unknown', async () => {
  const { state, log, run } = setupRun({ visible: null })
  const result = await run()

  assert.deepEqual(result, {})
  assert.equal(state.sessions.size, 0)
  const failure = log.entries.find((entry) => entry.message === 'restrict-postcondition-failed')
  assert.equal(failure.fields.visible, 'unknown')
})

test('buffer 里有 tool/call → 不出回复，会话被移除', async () => {
  const { state, log, run } = setupRun({ turnEvents: [header(), { type: 'tool/call' }, assistant()] })
  const result = await run()

  assert.deepEqual(result, {})
  assert.equal(state.sessions.size, 0)
  const failure = log.entries.find((entry) => entry.message === 'turn-tool-activity')
  assert.ok(failure)
  assert.equal(failure.fields.calls, 1)
})

test('request/header 工具清单非空 → 不出回复', async () => {
  const { state, log, run } = setupRun({ turnEvents: [header(['read_file']), assistant()] })
  const result = await run()

  assert.deepEqual(result, {})
  assert.equal(state.sessions.size, 0)
  const failure = log.entries.find((entry) => entry.message === 'turn-tools-visible')
  assert.ok(failure)
  assert.equal(failure.fields.tools, 1)
})

test('本回合没有 header 且从未见过 → 不发送', async () => {
  const { state, log, run } = setupRun({ lastHeaderTools: null, turnEvents: [assistant()] })
  const result = await run()

  assert.deepEqual(result, {})
  assert.equal(state.sessions.size, 0)
  assert.ok(log.entries.some((entry) => entry.message === 'turn-header-missing'))
})

test('本回合没有 header 但继承到上一次的 0 → 正常出回复', async () => {
  const { state, record, run } = setupRun({ lastHeaderTools: 0, turnEvents: [assistant('收到')] })
  const result = await run()

  assert.deepEqual(result, { text: '收到' })
  assert.equal(state.sessions.size, 1)
  assert.equal(record.lastHeaderTools, 0)
})

test('正常回合：header 清单为空、无工具事件 → 正常出回复并记住工具数', async () => {
  const { state, record, run } = setupRun({ turnEvents: [header(), assistant('好的')] })
  const result = await run()

  assert.deepEqual(result, { text: '好的' })
  assert.equal(state.sessions.size, 1)
  assert.equal(record.lastHeaderTools, 0)
})

/** createSession 路径：假的 agents.create 会同步调用 setup。 */
function setupCreate({ tools, turnEvents = [] }) {
  const log = recordingLog()
  const state = {
    log,
    sessions: new Map(),
    workspace: '.',
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    child: null,
    agents: {
      create: async (options) => {
        const agent = {
          cancel() {},
          whenIdle: async () => {},
          followup() {
            for (const event of turnEvents) handler?.({ id: SESSION_ID }, event)
          },
        }
        options.setup({ tools }, agent)
        return { agent, dispose: async () => {} }
      },
    },
  }
  let handler
  state.child = { on: (type, listener) => { handler = listener; return () => { handler = undefined } } }
  const signal = new AbortController().signal
  return { state, log, run: () => runTurn(state, { event: EVENT, sessionId: SESSION_ID, signal }) }
}

test('createSession：首次 apply 后 visible 非空 → 会话创建失败，不发起 followup', async () => {
  const tools = {
    restrict: () => () => {},
    schemas: () => [{ name: 'x' }],
  }
  const { state, run } = setupCreate({ tools })
  // agents.create 内部的 setup 抛错时，runTurn 必须拒绝。
  await assert.rejects(run(), /restrict-postcondition-failed/)
  assert.equal(state.sessions.size, 0)
})

test('createSession：正常创建（visible 为空）→ 会话保留并出回复', async () => {
  const tools = {
    restrict(filter) {
      if (Array.isArray(filter?.allow) && filter.allow.length === 1) {
        throw new Error('tools.restrict() names unknown global tool; known global tools: a')
      }
      return () => {}
    },
    schemas: () => [],
  }
  const { state, run } = setupCreate({ tools, turnEvents: [header(), assistant('在')] })
  const result = await run()

  assert.deepEqual(result, { text: '在' })
  assert.equal(state.sessions.size, 1)
})
