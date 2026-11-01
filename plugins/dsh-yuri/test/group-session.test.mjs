import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_QUEUE_PER_GROUP,
  SESSION_PREFIX,
  createDeduper,
  createGroupSessions,
  sessionIdForGroup,
} from '../src/group-session.mjs'

const silentLog = { info() {}, warn() {}, error() {} }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const event = (id, group = 'g1', text = '你好') => ({
  eventId: id,
  conversation: { kind: 'group', id: group },
  actor: { kind: 'user', id: 'u1', name: '小明' },
  text,
  reply: { messageId: id, conversationId: group, actorId: 'u1' },
})

test('sessionIdForGroup：前缀 + 16 位十六进制，且稳定', () => {
  const id = sessionIdForGroup('group-alpha')
  assert.ok(id.startsWith(SESSION_PREFIX))
  assert.match(id, /^yuri-qq-[0-9a-f]{16}$/)
  assert.equal(id, sessionIdForGroup('group-alpha'))
  assert.notEqual(id, sessionIdForGroup('group-beta'))
})

test('去重：同 eventId 只跑一次', async () => {
  const runs = []
  const engine = createGroupSessions({
    log: silentLog,
    runTurn: async ({ event: e }) => {
      runs.push(e.eventId)
      return { text: 'ok' }
    },
    deliver: () => {},
  })
  engine.enqueue(event('e1'))
  engine.enqueue(event('e1'))
  await sleep(30)
  assert.deepEqual(runs, ['e1'])
  assert.equal(engine.enqueue(event('e1')).reason, 'duplicate')
})

test('同群串行：任何时刻并发不超过 1', async () => {
  let running = 0
  let maxRunning = 0
  const order = []
  const engine = createGroupSessions({
    log: silentLog,
    runTurn: async ({ event: e }) => {
      running += 1
      maxRunning = Math.max(maxRunning, running)
      order.push(`start:${e.eventId}`)
      await sleep(15)
      order.push(`end:${e.eventId}`)
      running -= 1
      return { text: 'ok' }
    },
    deliver: () => {},
  })
  engine.enqueue(event('a1'))
  engine.enqueue(event('a2'))
  engine.enqueue(event('a3'))
  await sleep(90)
  assert.equal(maxRunning, 1, '同群不能并发')
  assert.deepEqual(order, [
    'start:a1', 'end:a1',
    'start:a2', 'end:a2',
    'start:a3', 'end:a3',
  ])
})

test('不同群并行', async () => {
  let running = 0
  let maxRunning = 0
  const engine = createGroupSessions({
    log: silentLog,
    runTurn: async () => {
      running += 1
      maxRunning = Math.max(maxRunning, running)
      await sleep(20)
      running -= 1
      return { text: 'ok' }
    },
    deliver: () => {},
  })
  engine.enqueue(event('g1-a', 'g1'))
  engine.enqueue(event('g2-a', 'g2'))
  await sleep(60)
  assert.equal(maxRunning, 2, '不同群应同时跑')
})

test(`队列上限 ${MAX_QUEUE_PER_GROUP}：超出丢最旧`, async () => {
  const gate = { resolve: null }
  const started = []
  const warnings = []
  const engine = createGroupSessions({
    log: { info() {}, warn: (message, fields) => warnings.push([message, fields]), error() {} },
    runTurn: async ({ event: e }) => {
      started.push(e.eventId)
      if (e.eventId === 'q1') await new Promise((resolve) => { gate.resolve = resolve })
      return { text: 'ok' }
    },
    deliver: () => {},
  })

  for (let index = 1; index <= 7; index += 1) engine.enqueue(event(`q${index}`))
  await sleep(5)
  const overflow = warnings.filter(([message]) => message === 'queue-overflow')
  assert.equal(overflow.length, 1, '7 条入队 → 只丢 1 条')
  assert.equal(overflow[0][1].dropped, warnings[0][1].dropped)

  gate.resolve()
  await sleep(60)
  assert.equal(started[0], 'q1')
  assert.equal(started.length, MAX_QUEUE_PER_GROUP + 1, '1 条在跑 + 5 条排队')
  assert.ok(!started.includes('q2'), 'q2 是被丢掉的"最旧"排队项')
})

test('超时：取消且不发送', async () => {
  const delivered = []
  const warnings = []
  const engine = createGroupSessions({
    log: { info() {}, warn: (message, fields) => warnings.push([message, fields]), error() {} },
    turnTimeoutMs: 20,
    turnOverrunMs: 500,
    runTurn: async ({ signal }) => {
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
      return { text: '迟到的回复' }
    },
    deliver: ({ text }) => delivered.push(text),
  })
  engine.enqueue(event('t1'))
  await sleep(80)
  assert.deepEqual(delivered, [], '超时不能发')
  assert.ok(warnings.some(([message]) => message === 'turn-timeout'))
})

test('回合卡死（不响应取消）也不会堵死队列', async () => {
  const delivered = []
  const engine = createGroupSessions({
    log: silentLog,
    turnTimeoutMs: 10,
    turnOverrunMs: 20,
    runTurn: async ({ event: e }) => {
      if (e.eventId === 'stuck') return new Promise(() => {})
      return { text: '正常回复' }
    },
    deliver: ({ text }) => delivered.push(text),
  })
  engine.enqueue(event('stuck'))
  engine.enqueue(event('after'))
  await sleep(120)
  assert.deepEqual(delivered, ['正常回复'])
})

test('dispose 之后不再发送', async () => {
  const delivered = []
  const engine = createGroupSessions({
    log: silentLog,
    runTurn: async () => {
      await sleep(30)
      return { text: '慢回复' }
    },
    deliver: ({ text }) => delivered.push(text),
  })
  engine.enqueue(event('d1'))
  await sleep(5)
  await engine.dispose()
  await sleep(60)
  assert.deepEqual(delivered, [])
  assert.equal(engine.enqueue(event('d2')).reason, 'disposed')
})

test('runTurn 抛错 → 不发送', async () => {
  const delivered = []
  const errors = []
  const engine = createGroupSessions({
    log: { info() {}, warn: (message, fields) => errors.push([message, fields]), error() {} },
    runTurn: async () => {
      throw new Error('setup failed: restrict unavailable')
    },
    deliver: ({ text }) => delivered.push(text),
  })
  engine.enqueue(event('e-err'))
  await sleep(30)
  assert.deepEqual(delivered, [])
  assert.ok(errors.some(([message]) => message === 'turn-failed'))
})

test('空文本不发送', async () => {
  const delivered = []
  const engine = createGroupSessions({
    log: silentLog,
    runTurn: async () => ({ text: '   ' }),
    deliver: ({ text }) => delivered.push(text),
  })
  engine.enqueue(event('empty'))
  await sleep(30)
  assert.deepEqual(delivered, [])
})

test('deliver 抛错不会中断队列', async () => {
  const delivered = []
  const engine = createGroupSessions({
    log: { info() {}, warn() {}, error() {} },
    runTurn: async ({ event: e }) => ({ text: e.eventId }),
    deliver: ({ text }) => {
      if (text === 'x1') throw new Error('reply-failed')
      delivered.push(text)
    },
  })
  engine.enqueue(event('x1'))
  engine.enqueue(event('x2'))
  await sleep(40)
  assert.deepEqual(delivered, ['x2'])
})

test('createDeduper 只保留最近 limit 条', () => {
  const dedupe = createDeduper(3)
  for (const id of ['a', 'b', 'c', 'd']) dedupe.add(id)
  assert.equal(dedupe.size(), 3)
  assert.equal(dedupe.has('a'), false)
  assert.equal(dedupe.has('d'), true)
})
