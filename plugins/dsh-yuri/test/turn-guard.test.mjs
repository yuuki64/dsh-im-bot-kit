import assert from 'node:assert/strict'
import test from 'node:test'

import { headerToolCount, inspectTurnEvents } from '../src/turn-guard.mjs'

const header = (names = []) => ({
  type: 'request/header',
  data: { header: names.length > 0 ? { tools: names.map((name) => ({ name })) } : {} },
})
const assistant = (text = '你好') => ({
  type: 'assistant/message',
  data: { message: { content: [{ type: 'text', text }] } },
})

test('headerToolCount：宿主为空时不写 tools，缺字段按 0 算', () => {
  assert.equal(headerToolCount(header()), 0)
  assert.equal(headerToolCount({ type: 'request/header', data: { header: {} } }), 0)
  assert.equal(headerToolCount(header(['a', 'b'])), 2)
  assert.equal(headerToolCount({}), 0)
})

test('正常回合：header 工具清单为空 → 放行', () => {
  const verdict = inspectTurnEvents([header(), assistant()], null)
  assert.deepEqual(verdict, { ok: true, tools: 0, headerSeen: true })
})

test('tool/call 或 tool/result → turn-tool-activity，calls 记两类总数', () => {
  assert.deepEqual(inspectTurnEvents([{ type: 'tool/call' }], null), {
    ok: false,
    reason: 'turn-tool-activity',
    calls: 1,
  })
  const both = inspectTurnEvents([{ type: 'tool/call' }, { type: 'tool/result' }, assistant()], null)
  assert.equal(both.reason, 'turn-tool-activity')
  assert.equal(both.calls, 2)
})

test('request/header 工具清单非空 → turn-tools-visible', () => {
  const verdict = inspectTurnEvents([header(['read_file'])], null)
  assert.deepEqual(verdict, { ok: false, reason: 'turn-tools-visible', tools: 1 })
})

test('多个 header 里只要有一个非空就拦，tools 取第一个非空的数量', () => {
  const verdict = inspectTurnEvents([header(), header(['a', 'b'])], null)
  assert.equal(verdict.reason, 'turn-tools-visible')
  assert.equal(verdict.tools, 2)
})

test('本回合没有 header 且从未见过 → turn-header-missing', () => {
  assert.deepEqual(inspectTurnEvents([assistant()], null), { ok: false, reason: 'turn-header-missing' })
  assert.equal(inspectTurnEvents([], undefined).reason, 'turn-header-missing')
})

test('本回合没有 header 但见过上一次 → 沿用上一次的工具数', () => {
  assert.deepEqual(inspectTurnEvents([assistant()], 0), { ok: true, tools: 0, headerSeen: false })
})

test('工具活动优先于其它判定', () => {
  const verdict = inspectTurnEvents([header(['a']), { type: 'tool/call' }], 0)
  assert.equal(verdict.reason, 'turn-tool-activity')
})
