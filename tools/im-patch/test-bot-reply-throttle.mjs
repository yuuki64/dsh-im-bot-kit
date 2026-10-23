// test-bot-reply-throttle.mjs — 两个机器人互相接话的节流（放宽后）。
//
// 之前是 15 秒 1 次 / 5 分钟 8 次，导致椎名点名 yuri 时它经常不接。
// 现在是 3 秒 1 次 / 5 分钟 20 次，两个机器人不会无限对刷。
//
//   node test-bot-reply-throttle.mjs
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

const T0 = 1_700_000_000_000;
const sec = 1_000;

// 1. 第一次允许
let r = bridge.botReplyAllowed([], T0);
check('首次接话允许', r.allowed === true && r.history.length === 1);

// 2. 2 秒内不允许
r = bridge.botReplyAllowed([T0], T0 + 2 * sec);
check('2 秒内不接（防对刷）', r.allowed === false && r.history.length === 1);

// 3. 4 秒后允许
r = bridge.botReplyAllowed([T0], T0 + 4 * sec);
check('4 秒后允许', r.allowed === true && r.history.length === 2);

// 4. 5 分钟 20 次封顶
const full = Array.from({ length: 20 }, (_, index) => T0 + index * 5000);
r = bridge.botReplyAllowed(full, T0 + 20 * 5000);
check('5 分钟内 20 次后停止', r.allowed === false && r.history.length === 20);

// 5. 超过窗口的旧记录会被清掉，重新可接
const stale = Array.from({ length: 20 }, () => T0 - 10 * 60 * 1000);
r = bridge.botReplyAllowed(stale, T0);
check('窗口外的旧记录不影响', r.allowed === true && r.history.length === 1);

// 6. 乱序/垃圾输入不崩
r = bridge.botReplyAllowed(['x', null, 123], T0);
check('脏历史被安全过滤', r.allowed === true && r.history.length === 1);

console.log('');
if (failures.length) {
  console.error(`失败 ${failures.length} 项`);
  process.exit(1);
}
console.log('全部通过：机器人互相接话 3 秒 / 5 分钟 20 次');
