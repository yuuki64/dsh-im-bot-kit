// test-spam-guard.mjs — 非主人重复刷同一句话 / 短时间内刷屏时静默忽略。
//
//   node test-spam-guard.mjs
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
const min = 60_000;

// 1. 首次正常消息不拦
let r = bridge.spamCheck([], '你好', T0);
check('首次消息不拦', r.ignore === false);

// 2. 2 分钟内重复同一句 → 拦
r = bridge.spamCheck(r.history, '你好', T0 + 30_000);
check('2 分钟内重复同一句被忽略', r.ignore === true);

// 3. 4 分钟后才重复第二遍 → 只出现 2 次，不拦
let fresh = bridge.spamCheck([], '在吗', T0);
const later = bridge.spamCheck(fresh.history, '在吗', T0 + 4 * min);
check('4 分钟后重复第二遍不忽略', later.ignore === false);

// 4. 窗口内第三次 → 拦
let third = bridge.spamCheck([], '？', T0);
third = bridge.spamCheck(third.history, '？', T0 + 4 * min);
const thirdHit = bridge.spamCheck(third.history, '？', T0 + 8 * min);
check('10 分钟内第三次重复被忽略', thirdHit.ignore === true);

// 5. 一分钟内刷屏（不同内容）→ 超过 8 条后忽略
let flood = { ignore: false, history: [] };
let floodIgnoredAt = 0;
for (let index = 0; index < 12; index += 1) {
  flood = bridge.spamCheck(flood.history, `第 ${index} 条`, T0 + index * 3_000);
  if (flood.ignore && !floodIgnoredAt) floodIgnoredAt = index + 1;
}
check('一分钟刷 8 条以上被忽略', floodIgnoredAt >= 8, `第 ${floodIgnoredAt} 条开始忽略`);

// 6. 空白文本（纯图片）不触发重复判定
let image = bridge.spamCheck([], '', T0);
image = bridge.spamCheck(image.history, '', T0 + 10_000);
check('只有图片的重复不按文字判重', image.ignore === false);

// 7. 历史不会无限增长
let big = { ignore: false, history: [] };
for (let index = 0; index < 100; index += 1) {
  big = bridge.spamCheck(big.history, `m${index}`, T0 + index * 1_000);
}
check('历史长度有上限', big.history.length <= 40, `${big.history.length} 条`);

// 8. 不同发送者各自独立：给 A 的历史不应影响 B（由调用方按 key 分开存）
let a = bridge.spamCheck([], 'hi', T0);
check('返回结构可复用于下一个发送者', Array.isArray(a.history) && a.history.length === 1);

console.log('');
if (failures.length) {
  console.error(`失败 ${failures.length} 项`);
  process.exit(1);
}
console.log('全部通过：重复/刷屏判定符合预期');
