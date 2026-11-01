import assert from 'node:assert/strict'
import test from 'node:test'

import { DISABLED_REASONS, configPathFor, loadConfig, validateConfig } from '../src/config.mjs'

const HOME = 'X:\\dsh-home'

function reader(text, error) {
  return async () => {
    if (error) throw error
    return text
  }
}

test('缺配置文件 → 禁用 missing-config', async () => {
  const error = Object.assign(new Error('not found'), { code: 'ENOENT' })
  const config = await loadConfig({ dshHome: HOME, readFileFn: reader(undefined, error) })
  assert.equal(config.enabled, false)
  assert.equal(config.reason, DISABLED_REASONS.missingConfig)
  assert.equal(config.path, configPathFor(HOME))
})

test('坏 JSON → 禁用 invalid-json', async () => {
  const config = await loadConfig({ dshHome: HOME, readFileFn: reader('{ not json') })
  assert.equal(config.enabled, false)
  assert.equal(config.reason, DISABLED_REASONS.invalidJson)
})

test('enabled 不是 true → 禁用 not-enabled', async () => {
  for (const value of [{ enabled: false }, { enabled: 'true' }, { enabled: 1 }, { botId: 'qq_x', allowedGroups: ['g'] }]) {
    const config = validateConfig(value)
    assert.equal(config.enabled, false, `value=${JSON.stringify(value)}`)
    assert.equal(config.reason, DISABLED_REASONS.notEnabled)
  }
})

test('配置整体缺失 → missing-config', () => {
  for (const value of [undefined, null]) {
    const config = validateConfig(value)
    assert.equal(config.enabled, false)
    assert.equal(config.reason, DISABLED_REASONS.missingConfig)
  }
})

test('缺 botId → 禁用 missing-bot-id', () => {
  for (const botId of [undefined, '', '   ', 42]) {
    const config = validateConfig({ enabled: true, botId, allowedGroups: ['g'] })
    assert.equal(config.enabled, false)
    assert.equal(config.reason, DISABLED_REASONS.missingBotId)
  }
})

test('allowedGroups 为空 / 非数组 / 全空白 → 禁用 missing-allowed-groups', () => {
  for (const allowedGroups of [undefined, [], ['  '], 'g', 42]) {
    const config = validateConfig({ enabled: true, botId: 'qq_1', allowedGroups })
    assert.equal(config.enabled, false, `allowedGroups=${JSON.stringify(allowedGroups)}`)
    assert.equal(config.reason, DISABLED_REASONS.missingAllowedGroups)
  }
})

test('合法配置 → 启用，并带默认超时与 debugLogText=false', () => {
  const config = validateConfig({
    enabled: true,
    botId: ' qq_abc ',
    allowedGroups: [' g1 ', '', 'g2'],
  })
  assert.equal(config.enabled, true)
  assert.equal(config.botId, 'qq_abc')
  assert.deepEqual([...config.allowedGroups], ['g1', 'g2'])
  assert.equal(config.turnTimeoutMs, 120000)
  assert.equal(config.debugLogText, false)
})

test('显式 turnTimeoutMs / debugLogText 被采纳', async () => {
  const config = await loadConfig({
    dshHome: HOME,
    readFileFn: reader(JSON.stringify({ enabled: true, botId: 'b', allowedGroups: ['g'], turnTimeoutMs: 5000, debugLogText: true })),
  })
  assert.equal(config.enabled, true)
  assert.equal(config.turnTimeoutMs, 5000)
  assert.equal(config.debugLogText, true)
})

test('非法 turnTimeoutMs 回落默认值', () => {
  for (const turnTimeoutMs of [0, -1, 1.5, '1000', null]) {
    const config = validateConfig({ enabled: true, botId: 'b', allowedGroups: ['g'], turnTimeoutMs })
    assert.equal(config.turnTimeoutMs, 120000, `turnTimeoutMs=${String(turnTimeoutMs)}`)
  }
})
