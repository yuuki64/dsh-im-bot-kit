/** 探测用的假工具名：故意不存在，只为让 restrict 把已知全局工具名回显出来。 */
export const PROBE_TOOL_NAME = '__yuri_probe_unknown__'

/** PTC 传输名：restrict 明确拒绝把它写进 allow/deny。 */
export const RESERVED_TRANSPORT = 'run_code'

/**
 * 从 restrict 抛出的报错文本里解析 "known global tools: a, b, c"。
 * @param {unknown} error
 * @returns {string[] | null}
 */
export function parseKnownToolNames(error) {
  const message = String(error?.message ?? error ?? '')
  const match = /known global tools: (.*)$/su.exec(message)
  if (!match) return null
  const names = match[1]
    .split(',')
    .map((name) => name.trim().replace(/^"|"$/g, ''))
    .filter((name) => name.length > 0)
  if (names.length === 0) return null
  return [...new Set(names)]
}

/**
 * 读取某个 scope 当前**实际可见**的工具名（模型侧 schema 投影）。
 * 取不到就返回 null，由调用方决定是否视为失败。
 * @param {{ schemas?: (scope?: unknown) => Array<{ name?: string }> }} tools
 * @param {unknown} scope
 * @returns {string[] | null}
 */
export function listVisibleToolNames(tools, scope) {
  if (typeof tools?.schemas !== 'function') return null
  try {
    const schemas = tools.schemas(scope)
    if (!Array.isArray(schemas)) return null
    return schemas.map((schema) => schema?.name).filter((name) => typeof name === 'string')
  } catch {
    return null
  }
}

/**
 * 工具限制器，fail-closed：
 * 1. 探测全局工具名；
 * 2. 优先 deny 全部探测到的名字（跳过已拒绝的、跳过 run_code）；
 * 3. 探测不到就兜底 `restrict({ allow: [] })`；
 * 4. 两条都失败 → 抛出，调用方（setup）失败，本回合不跑 Agent、不发送。
 * @param {{ log?: { info: Function, warn: Function, error: Function } }} [options]
 */
export function createToolRestrictor({ log } = {}) {
  const denied = new Set()
  const disposers = []
  let mode = 'none'
  let allowEmptyApplied = false

  const remember = (disposer) => {
    if (typeof disposer === 'function') disposers.push(disposer)
  }

  /**
   * @param {{ restrict?: (filter: object) => unknown }} tools
   * @returns {{ names: string[] | null, error?: unknown, unexpected?: boolean }}
   */
  function probe(tools) {
    let disposer
    try {
      disposer = tools.restrict({ allow: [PROBE_TOOL_NAME] })
    } catch (error) {
      return { names: parseKnownToolNames(error), error }
    }
    // 探测竟然成功：说明这个版本不校验未知名字。立刻解除，按"探测失败"处理。
    try {
      if (typeof disposer === 'function') disposer()
    } catch {
      /* 解除失败也不该让插件崩 */
    }
    return { names: null, unexpected: true }
  }

  return {
    get mode() {
      return mode
    },
    deniedNames() {
      return [...denied]
    },
    /**
     * 幂等：每个回合前都可以再调一次，只为补上"晚注册"的全局工具。
     * @param {{ tools: any, scope?: unknown }} input
     * @returns {{ mode: string, denied: string[], visible: string[] | null, fresh: string[] }}
     */
    apply({ tools, scope } = {}) {
      if (typeof tools?.restrict !== 'function') throw new Error('tools.restrict unavailable')

      const probed = probe(tools)
      if (probed.unexpected) log?.warn('restrict-probe-unexpectedly-accepted', { probe: PROBE_TOOL_NAME })

      if (Array.isArray(probed.names)) {
        const fresh = probed.names.filter((name) => name !== RESERVED_TRANSPORT && !denied.has(name))
        if (fresh.length > 0) {
          // 失败即向上抛：调用方 fail-closed。
          remember(tools.restrict({ deny: fresh }))
          for (const name of fresh) denied.add(name)
        }
        mode = 'deny'
        const visible = listVisibleToolNames(tools, scope)
        log?.info('restrict-applied', {
          mode,
          denied: denied.size,
          known: probed.names.length,
          fresh: fresh.length,
          visible: visible === null ? 'unknown' : visible.length,
        })
        return { mode, denied: [...denied], visible, fresh }
      }

      if (allowEmptyApplied) {
        const visible = listVisibleToolNames(tools, scope)
        log?.info('restrict-reapplied', { mode, visible: visible === null ? 'unknown' : visible.length })
        return { mode, denied: [...denied], visible, fresh: [] }
      }

      // 探测不到名单：兜底隐藏全部继承工具。这里同样失败即抛。
      remember(tools.restrict({ allow: [] }))
      allowEmptyApplied = true
      mode = 'allow-empty'
      const visible = listVisibleToolNames(tools, scope)
      log?.info('restrict-applied', { mode, visible: visible === null ? 'unknown' : visible.length })
      return { mode, denied: [...denied], visible, fresh: [] }
    },
    /** 解除本实例持有的全部限制（正常路径由 agent scope 自动回收，这里只是兜底）。 */
    dispose() {
      for (const disposer of disposers.splice(0)) {
        try {
          disposer()
        } catch {
          /* 回收失败不影响退出 */
        }
      }
    },
  }
}
