import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 本地配置所在目录（相对 DSH_HOME），不进仓库。 */
export const CONFIG_DIR_SEGMENTS = Object.freeze(['integrations', 'dsh-yuri'])
export const CONFIG_FILE_NAME = 'config.json'
export const DEFAULT_TURN_TIMEOUT_MS = 120000

/** 禁用原因，回报与日志共用这套字符串。 */
export const DISABLED_REASONS = Object.freeze({
  missingConfig: 'missing-config',
  readFailed: 'read-failed',
  invalidJson: 'invalid-json',
  invalidShape: 'invalid-shape',
  notEnabled: 'not-enabled',
  missingBotId: 'missing-bot-id',
  missingAllowedGroups: 'missing-allowed-groups',
})

/**
 * @param {string} dshHome
 * @returns {string}
 */
export function configPathFor(dshHome) {
  return join(dshHome, ...CONFIG_DIR_SEGMENTS, CONFIG_FILE_NAME)
}

/**
 * 纯函数校验：任何一项不满足都返回"禁用 + 原因"，绝不半启用。
 * @param {unknown} raw 已解析的 JSON 值
 */
export function validateConfig(raw) {
  if (raw === undefined || raw === null) return { enabled: false, reason: DISABLED_REASONS.missingConfig }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { enabled: false, reason: DISABLED_REASONS.invalidShape }
  if (raw.enabled !== true) return { enabled: false, reason: DISABLED_REASONS.notEnabled }

  const botId = typeof raw.botId === 'string' ? raw.botId.trim() : ''
  if (!botId) return { enabled: false, reason: DISABLED_REASONS.missingBotId }

  const allowedGroups = Array.isArray(raw.allowedGroups)
    ? raw.allowedGroups.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim())
    : []
  if (allowedGroups.length === 0) return { enabled: false, reason: DISABLED_REASONS.missingAllowedGroups }

  const turnTimeoutMs = Number.isSafeInteger(raw.turnTimeoutMs) && raw.turnTimeoutMs > 0
    ? raw.turnTimeoutMs
    : DEFAULT_TURN_TIMEOUT_MS

  return {
    enabled: true,
    reason: 'ok',
    botId,
    allowedGroups: Object.freeze(allowedGroups),
    turnTimeoutMs,
    debugLogText: raw.debugLogText === true,
  }
}

/**
 * 读 <DSH_HOME>/integrations/dsh-yuri/config.json；缺文件 / 坏 JSON 都算禁用。
 * @param {{ dshHome: string, readFileFn?: typeof readFile }} options
 */
export async function loadConfig({ dshHome, readFileFn = readFile }) {
  const path = configPathFor(dshHome)
  let text
  try {
    text = await readFileFn(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { enabled: false, reason: DISABLED_REASONS.missingConfig, path }
    return { enabled: false, reason: DISABLED_REASONS.readFailed, path, detail: String(error?.message ?? error) }
  }

  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    return { enabled: false, reason: DISABLED_REASONS.invalidJson, path }
  }

  return { ...validateConfig(raw), path }
}
