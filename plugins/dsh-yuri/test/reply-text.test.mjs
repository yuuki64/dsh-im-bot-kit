import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CHUNK_CHARS,
  MAX_CHUNKS,
  MAX_REPLY_CHARS,
  extractTurnReply,
  segmentReply,
  textOfMessage,
} from '../src/reply-text.mjs'

const assistant = (blocks, seq = 1) => ({
  type: 'assistant/message',
  seq,
  data: { turn: 1, step: 1, message: { role: 'assistant', content: blocks, source: { kind: 'model' } } },
})
const turnEnd = (kind, seq = 2) => ({ type: 'turn/end', seq, data: { turn: 1, reason: { kind } } })

test('只拼 text 块，reasoning 必须被丢弃', () => {
  const events = [
    assistant([
      { type: 'reasoning', text: '这里是想办法，不该进群' },
      { type: 'text', text: '你好呀' },
      { type: 'reasoning', text: '再想想' },
      { type: 'text', text: '～' },
    ]),
  ]
  const verdict = extractTurnReply(events)
  assert.equal(verdict.ok, true)
  assert.equal(verdict.text, '你好呀～')
  assert.ok(!verdict.text.includes('想办法'))
})

test('只有 reasoning → 不发送（empty-text）', () => {
  const verdict = extractTurnReply([assistant([{ type: 'reasoning', text: 'only thinking' }])])
  assert.deepEqual(verdict, { ok: false, reason: 'empty-text' })
})

test('空白文本 → 不发送（empty-text）', () => {
  const verdict = extractTurnReply([assistant([{ type: 'text', text: '   \n\t ' }])])
  assert.deepEqual(verdict, { ok: false, reason: 'empty-text' })
})

test('多条 assistant/message → 取最后一条', () => {
  const events = [
    assistant([{ type: 'text', text: '旧回复' }], 1),
    assistant([{ type: 'text', text: '新回复' }], 2),
  ]
  assert.equal(extractTurnReply(events).text, '新回复')
})

test('turn/end 非 completed → 不发送', () => {
  for (const kind of ['error', 'aborted', 'interrupted', 'blocked', 'max-tokens']) {
    const verdict = extractTurnReply([assistant([{ type: 'text', text: '看起来像回复' }]), turnEnd(kind)])
    assert.deepEqual(verdict, { ok: false, reason: `turn-${kind}` }, `kind=${kind}`)
  }
})

test('turn/end completed → 正常发送', () => {
  const verdict = extractTurnReply([assistant([{ type: 'text', text: '好的' }]), turnEnd('completed')])
  assert.deepEqual(verdict, { ok: true, text: '好的' })
})

test('没有 assistant/message → 不发送', () => {
  assert.deepEqual(extractTurnReply([turnEnd('completed')]), { ok: false, reason: 'no-assistant-message' })
  assert.deepEqual(extractTurnReply([]), { ok: false, reason: 'no-assistant-message' })
  assert.deepEqual(extractTurnReply(undefined), { ok: false, reason: 'no-assistant-message' })
})

test('textOfMessage 对畸形输入不抛错', () => {
  for (const value of [undefined, null, {}, { content: 'x' }, { content: [null, 1, { type: 'text' }] }]) {
    assert.equal(textOfMessage(value), '')
  }
})

test('≤4000 字原样一条', () => {
  const text = 'a'.repeat(MAX_REPLY_CHARS)
  const result = segmentReply(text)
  assert.equal(result.chunks.length, 1)
  assert.equal(result.chunks[0].length, MAX_REPLY_CHARS)
  assert.equal(result.truncated, false)
})

test('超 4000 字按 1500 字切、最多 3 段', () => {
  const text = 'b'.repeat(MAX_REPLY_CHARS + 1)
  const result = segmentReply(text)
  assert.equal(result.chunks.length, MAX_CHUNKS)
  assert.deepEqual(result.chunks.map((chunk) => chunk.length), [CHUNK_CHARS, CHUNK_CHARS, MAX_REPLY_CHARS + 1 - CHUNK_CHARS * 2])
  assert.equal(result.truncated, false, '4001 字仍在 3×1500 之内')

  const longer = 'c'.repeat(CHUNK_CHARS * MAX_CHUNKS + 10)
  const truncated = segmentReply(longer)
  assert.equal(truncated.chunks.length, MAX_CHUNKS)
  assert.equal(truncated.truncated, true)
  assert.equal(truncated.chunks.join('').length, CHUNK_CHARS * MAX_CHUNKS)
})

test('分段不劈坏代理对（emoji）', () => {
  const text = '😀'.repeat(CHUNK_CHARS * MAX_CHUNKS + 1) // UTF-16 长度 9002 → 触发分段 + 截断
  const result = segmentReply(text)
  assert.equal(result.chunks.length, MAX_CHUNKS)
  assert.equal(result.truncated, true)
  for (const chunk of result.chunks) {
    assert.equal(chunk.isWellFormed(), true)
    assert.equal(Array.from(chunk).length, CHUNK_CHARS)
  }
})

test('空串不分段', () => {
  assert.deepEqual(segmentReply(''), { chunks: [], truncated: false })
  assert.deepEqual(segmentReply(undefined), { chunks: [], truncated: false })
})
