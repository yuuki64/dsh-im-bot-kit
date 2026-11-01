import assert from 'node:assert/strict'
import test from 'node:test'

import { FALLBACK_NICKNAME, INSTRUCTION, buildPrompt, isAddressed } from '../src/prompt.mjs'

const base = {
  mentionedAccount: true,
  actor: { kind: 'user', id: 'u1', name: '小明' },
  conversation: { kind: 'group', id: 'g1' },
  text: '你好',
}

test('昵称缺失时用占位名', () => {
  for (const actor of [{}, { name: '   ' }, { name: 42 }, undefined]) {
    const prompt = buildPrompt({ ...base, actor })
    assert.equal(prompt, `${INSTRUCTION}\n\n${FALLBACK_NICKNAME}：你好`)
  }
})

test('昵称保留首尾空白之外的内容', () => {
  const prompt = buildPrompt({ ...base, actor: { name: ' 阿强 ' } })
  assert.ok(prompt.includes('阿强：你好'))
})

test('正文换行原样保留', () => {
  const prompt = buildPrompt({ ...base, text: '第一行\n第二行\r\n第三行' })
  assert.ok(prompt.endsWith('小明：第一行\n第二行\r\n第三行'))
})

test('正文里的 < > 原样保留、不转义不截断', () => {
  const text = '<script>alert(1)</script> & <b>粗</b>'
  const prompt = buildPrompt({ ...base, text })
  assert.ok(prompt.endsWith(`小明：${text}`))
  assert.ok(!prompt.includes('&lt;'), '不能做 HTML 转义')
  assert.ok(!prompt.includes('&gt;'), '不能做 HTML 转义')
})

test('正文缺失按空串处理', () => {
  const prompt = buildPrompt({ ...base, text: undefined })
  assert.ok(prompt.endsWith('小明：'))
})

test('isAddressed 只看 mentionedAccount === true', () => {
  assert.equal(isAddressed({ mentionedAccount: true }), true)
  for (const value of [false, undefined, 'true', 1, null]) {
    assert.equal(isAddressed({ mentionedAccount: value }), false, `value=${String(value)}`)
  }
})
