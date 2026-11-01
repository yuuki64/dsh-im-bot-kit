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
 * 工具限制器，白名单为主、deny 为辅：
 * 1. 每个实例首次 apply 先 `restrict({ allow: [] })`：失败直接抛出（fail-closed），
 *    成功后不再重复（限制在 dispose 时才解除）；
 * 2. 再探测全局工具名，把探测到的名字 deny 掉：这一层只是纵深防御 + 发现
 *    "晚注册"的新名字，任何失败都只 warn，不抛出（白名单已经生效）；
 * 3. 最后读 `visible`，交给调用方做发送前置检查。
 *
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
   * 第一层：白名单。失败必须向上抛，让调用方 fail-closed。
   * @param {{ restrict: (filter: object) => unknown }} tools
   */
  function applyAllowEmpty(tools) {
    remember(tools.restrict({ allow: [] }))
    allowEmptyApplied = true
  }

  /**
   * 第二层：探测全局工具名。任何失败都只返回错误，不抛。
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

      // 第一层：只做一次。抛错即 fail-closed。
      if (!allowEmptyApplied) applyAllowEmpty(tools)

      // 第二层：探测 + deny。失败只 warn。
      const probed = probe(tools)
      if (probed.unexpected) log?.warn('restrict-probe-unexpectedly-accepted', { probe: PROBE_TOOL_NAME })

      let fresh = []
      if (Array.isArray(probed.names)) {
        fresh = probed.names.filter((name) => name !== RESERVED_TRANSPORT && !denied.has(name))
        if (fresh.length > 0) {
          try {
            remember(tools.restrict({ deny: fresh }))
            for (const name of fresh) denied.add(name)
          } catch (error) {
            // 白名单已生效；deny 失败不影响本回合，只是这层防线没补上。
            log?.warn('restrict-deny-failed', {
              names: fresh,
              error: String(error?.message ?? error),
            })
          }
        }
        mode = 'allow-empty+deny'
      } else {
        if (!probed.unexpected) {
          log?.warn('restrict-probe-failed', { error: String(probed.error?.message ?? probed.error) })
        }
        mode = 'allow-empty'
      }

      const visible = listVisibleToolNames(tools, scope)
      log?.info('restrict-applied', {
        mode,
        denied: denied.size,
        known: Array.isArray(probed.names) ? probed.names.length : 'unknown',
        fresh: fresh.length,
        visible: visible === null ? 'unknown' : visible.length,
      })
      return { mode, denied: [...denied], visible, fresh }
    },
    /** 解除本实例持有的全部限制（正常路径由 agent scope 自动回收，这里只是兜底）。 */
    dispose() {
      // 解除之后如果还被复用，下一次 apply 必须重新落白名单。
      allowEmptyApplied = false
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
