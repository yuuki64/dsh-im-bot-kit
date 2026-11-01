import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PROBE_TOOL_NAME,
  RESERVED_TRANSPORT,
  createToolRestrictor,
  listVisibleToolNames,
  parseKnownToolNames,
} from '../src/restrict.mjs'

/** 只记录日志，不改行为。 */
function recordingLog() {
  const entries = []
  return {
    entries,
    debugText: false,
    info: (message, fields) => entries.push({ level: 'info', message, fields }),
    warn: (message, fields) => entries.push({ level: 'warn', message, fields }),
    error: (message, fields) => entries.push({ level: 'error', message, fields }),
  }
}

const silentLog = { info() {}, warn() {}, error() {} }

function fakeTools(options = {}) {
  const config = {
    known: ['web_search', 'read_file', RESERVED_TRANSPORT],
    probe: 'throw-with-list',
    denyFails: false,
    allowFails: false,
    visible: [],
    ...options,
  }
  const calls = []
  return {
    calls,
    config,
    restrict(filter) {
      calls.push(filter)
      const isProbe = Array.isArray(filter?.allow) && filter.allow.length === 1 && filter.allow[0] === PROBE_TOOL_NAME
      if (isProbe) {
        if (config.probe === 'accept') {
          return () => calls.push({ probeDisposed: true })
        }
        if (config.probe === 'throw-no-list') throw new Error('tools.restrict() requires a scoped context')
        throw new Error(
          `tools.restrict() names unknown global tool "${PROBE_TOOL_NAME}"; known global tools: ${config.known.join(', ')}`,
        )
      }
      if (filter?.deny !== undefined) {
        if (config.denyFails) throw new Error('deny failed')
        return () => {}
      }
      if (filter?.allow !== undefined) {
        if (config.allowFails) throw new Error('allow failed')
        return () => {}
      }
      throw new Error('unexpected filter')
    },
    schemas() {
      return config.visible.map((name) => ({ name }))
    },
  }
}

const isAllowEmpty = (call) => Array.isArray(call.allow) && call.allow.length === 0 && call.deny === undefined
const isDeny = (call) => call.deny !== undefined

test('parseKnownToolNames 从报错文本里取名单', () => {
  assert.deepEqual(parseKnownToolNames(new Error('boom; known global tools: "a", b , c')), ['a', 'b', 'c'])
  assert.equal(parseKnownToolNames(new Error('boom')), null)
  assert.equal(parseKnownToolNames(new Error('known global tools: ')), null)
})

test('白名单先落，再 deny 探测到的全部名称（跳过 run_code）', () => {
  const tools = fakeTools()
  const restrictor = createToolRestrictor({ log: silentLog })
  const result = restrictor.apply({ tools, scope: {} })

  assert.equal(tools.calls[0] !== undefined, true)
  assert.ok(isAllowEmpty(tools.calls[0]), '第一次调用必须是 restrict({ allow: [] })')
  assert.deepEqual([...result.denied].sort(), ['read_file', 'web_search'])
  assert.equal(result.mode, 'allow-empty+deny')
  const denyCall = tools.calls.find(isDeny)
  assert.ok(denyCall, '必须发出一次 deny')
  assert.ok(!denyCall.deny.includes(RESERVED_TRANSPORT), 'run_code 不能出现在 deny 名单里')
})

test('探测失败（无名单）→ 白名单仍然生效，不抛', () => {
  const tools = fakeTools({ probe: 'throw-no-list' })
  const log = recordingLog()
  const restrictor = createToolRestrictor({ log })
  const result = restrictor.apply({ tools })

  assert.equal(result.mode, 'allow-empty')
  assert.ok(tools.calls.some(isAllowEmpty))
  assert.ok(
    log.entries.some((entry) => entry.level === 'warn' && entry.message === 'restrict-probe-failed'),
    '探测失败必须留一条 warn',
  )
})

test('allow:[] 失败 → 抛出（fail-closed），不再继续探测/deny', () => {
  const tools = fakeTools({ allowFails: true })
  const restrictor = createToolRestrictor({ log: silentLog })
  assert.throws(() => restrictor.apply({ tools }), /allow failed/)
  assert.ok(!tools.calls.some(isDeny), '白名单没落下就不该继续 deny')
})

test('allow:[] 成功、探测失败 → apply 不抛，只有 warn', () => {
  const tools = fakeTools({ probe: 'throw-no-list' })
  const log = recordingLog()
  const restrictor = createToolRestrictor({ log })
  assert.doesNotThrow(() => restrictor.apply({ tools }))
  assert.equal(log.entries.filter((entry) => entry.level === 'warn').length, 1)
})

test('deny 失败 → 只 warn，不抛，也不计入 denied', () => {
  const tools = fakeTools({ denyFails: true })
  const log = recordingLog()
  const restrictor = createToolRestrictor({ log })
  const result = restrictor.apply({ tools })

  assert.equal(result.mode, 'allow-empty+deny')
  assert.deepEqual(result.denied, [])
  const warn = log.entries.find((entry) => entry.message === 'restrict-deny-failed')
  assert.ok(warn, 'deny 失败必须留一条 warn')
  assert.deepEqual(warn.fields.names.sort(), ['read_file', 'web_search'])
})

test('探测意外被接受 → 立即解除，并回落到白名单', () => {
  const tools = fakeTools({ probe: 'accept' })
  const restrictor = createToolRestrictor({ log: silentLog })
  const result = restrictor.apply({ tools })
  assert.equal(result.mode, 'allow-empty')
  assert.ok(tools.calls.some((call) => call.probeDisposed === true), '探测性限制必须被解除')
})

test('第二次调用幂等：allow:[] 只落一次，没有新工具就不再发 deny', () => {
  const tools = fakeTools()
  const restrictor = createToolRestrictor({ log: silentLog })
  restrictor.apply({ tools })
  const allowBefore = tools.calls.filter(isAllowEmpty).length
  const denyBefore = tools.calls.filter(isDeny).length
  const second = restrictor.apply({ tools })
  const allowAfter = tools.calls.filter(isAllowEmpty).length
  const denyAfter = tools.calls.filter(isDeny).length

  assert.equal(allowBefore, 1)
  assert.equal(allowAfter, 1, '白名单不能重复落')
  assert.equal(denyAfter, denyBefore)
  assert.equal(second.mode, 'allow-empty+deny')
  assert.deepEqual(second.fresh, [])
})

test('晚注册的新工具：第二次调用只 deny 新增的那些', () => {
  const tools = fakeTools()
  const restrictor = createToolRestrictor({ log: silentLog })
  restrictor.apply({ tools })
  tools.config.known.push('late_tool')

  const second = restrictor.apply({ tools })
  assert.deepEqual(second.fresh, ['late_tool'])
  assert.ok(restrictor.deniedNames().includes('late_tool'))
  assert.equal(restrictor.deniedNames().length, 3, 'web_search / read_file / late_tool')
})

test('tools 不带 restrict → 抛出', () => {
  const restrictor = createToolRestrictor({ log: silentLog })
  assert.throws(() => restrictor.apply({ tools: {} }), /restrict unavailable/)
})

test('listVisibleToolNames：正常返回名字，异常/缺失返回 null', () => {
  assert.deepEqual(listVisibleToolNames({ schemas: () => [{ name: 'a' }, {}] }, {}), ['a'])
  assert.equal(listVisibleToolNames({ schemas: () => { throw new Error('x') } }, {}), null)
  assert.equal(listVisibleToolNames({}, {}), null)
})
