// test-pending-notice.mjs — 重启时"排队消息被中断"的提示只在私聊发，群里不发。
//
// 群里发这种内部提示很出戏（截图里椎名把「排队中的消息在服务重启时被中断…」
// 直接发到了群里）。私聊保留提示，因为只有主人看得到。
//
//   node test-pending-notice.mjs
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const pluginRoot = join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', '@xmanrui', 'dsh-im');
const bridge = await import(pathToFileURL(join(pluginRoot, 'src', 'channels', 'qq', 'qq-bridge.mjs')).href);

const failures = [];
function check(label, condition, detail = '') {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? `  — ${detail}` : ''}`);
  if (!condition) failures.push(label);
}

const target = { scope: 'c2c', targetId: 'user-openid' };

check('群里不提示', bridge.shouldNotifyInterruptedPending({ kind: 'group', target: { scope: 'group', targetId: 'g' } }) === false);
check('私聊提示', bridge.shouldNotifyInterruptedPending({ kind: 'c2c', target }) === true);
check('没有投递目标不发', bridge.shouldNotifyInterruptedPending({ kind: 'c2c' }) === false);
check('null/undefined 安全', bridge.shouldNotifyInterruptedPending(null) === false
  && bridge.shouldNotifyInterruptedPending(undefined) === false);
check('未知 kind 不按群处理（保守只私聊）', bridge.shouldNotifyInterruptedPending({ kind: 'unknown', target }) === true);

console.log('');
if (failures.length) {
  console.error(`失败 ${failures.length} 项`);
  process.exit(1);
}
console.log('全部通过：重启提示只进私聊');
