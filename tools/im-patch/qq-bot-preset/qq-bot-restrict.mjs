// QQ 机器人 preset 的工具裁剪（2026-10-24，v2）—— 权威副本
//
// 安装位置：%USERPROFILE%\.dsh\profiles\desktop\qq-bot-restrict.mjs
// 由 profile 的 cordis.patch.yml 里 preset-qq-bot 行以 ./qq-bot-restrict.mjs 引用。
//
// 目标：机器人会话不要再继承 profile 里的整套 MCP 工具（实测仍有 ~103k tokens/次）。
// v1 失败原因：allow 名单里的 `web_search` / `ask_user_question` 不是「全局工具」，
// restrict 对未知名字抛错 → 整条限制没生效。
//
// v2 策略：
//   1. 首选 `restrict({ allow: [] })`：隐藏该 preset 会话继承的**全部**全局工具
//      （preset 自己挂的 tool-web / tool-ask-user 是 scoped 注册，不受影响）；
//   2. 失败则用探测错误里的 "known global tools: …" 拿到真实全局工具名，
//      再 `restrict({ deny: [除保留名单外全部] })`；
//   3. 5s / 15s 再补一次（MCP 工具可能比 preset 晚注册），已应用的名称跳过。
// 失败只影响省 token，不影响启动；结果写 ~/.dsh/logs/qq-bot-restrict.log。
//
// 实测（2026-10-24 14:35，DSH 0.2.1-rc.2）：新会话 toolsTokens 109,722 → 1,207（-98.9%）。
import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const name = 'qq-bot-restrict';
export const inject = ['tools'];

const LOG_PATH = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'logs', 'qq-bot-restrict.log');
const KEEP = new Set(['ask_user_question', 'web_search', 'web_fetch', 'todo_write']);

function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  try { appendFileSync(LOG_PATH, line); } catch { /* logging is best-effort */ }
  console.error('[qq-bot-restrict]', message);
}

/** Probe the registry for its known global tool names via the restrict error text. */
function probeGlobalNames(ctx) {
  try {
    ctx.tools.restrict({ allow: ['__dsh_probe_unknown_tool__'] });
    return null;
  } catch (error) {
    const message = String(error?.message ?? error);
    const match = /known global tools: (.*)$/su.exec(message);
    if (!match) {
      log(`probe error without tool list: ${message.slice(0, 300)}`);
      return null;
    }
    return [...new Set(match[1].split(',').map((name) => name.trim().replace(/^"|"$/g, '')).filter(Boolean))];
  }
}

export function apply(ctx) {
  const appliedDeny = new Set();

  const applyOnce = (label) => {
    try {
      ctx.tools.restrict({ allow: [] });
      log(`${label}: ok allow=[]（隐藏全部继承的全局工具）`);
      return true;
    } catch (error) {
      log(`${label}: allow=[] failed: ${error?.message ?? error}`);
    }
    const known = probeGlobalNames(ctx);
    if (known === null) {
      log(`${label}: probe failed; give up`);
      return false;
    }
    const deny = known.filter((name) => !KEEP.has(name) && !appliedDeny.has(name));
    if (deny.length === 0) {
      log(`${label}: nothing new to deny（已知全局工具 ${known.length} 个）`);
      return true;
    }
    try {
      ctx.tools.restrict({ deny });
      for (const name of deny) appliedDeny.add(name);
      log(`${label}: ok deny ${deny.length} 个（全局工具共 ${known.length} 个）`);
      return true;
    } catch (error) {
      log(`${label}: deny failed: ${error?.message ?? error}`);
      return false;
    }
  };

  if (!applyOnce('initial')) return;
  for (const delay of [5000, 15000]) {
    const timer = setTimeout(() => applyOnce(`retry+${delay}ms`), delay);
    timer?.unref?.();
  }
}
