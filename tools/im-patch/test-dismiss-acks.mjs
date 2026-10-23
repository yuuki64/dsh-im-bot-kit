// test-dismiss-acks.mjs — 「不说话」时的确认语要短、要多样、不能总是一句。
//
//   node test-dismiss-acks.mjs
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

const acks = bridge.DISMISS_ACKS;
check('确认语至少 10 条', Array.isArray(acks) && acks.length >= 10, `${acks?.length ?? 0} 条`);
check('每条都很短（≤ 12 字）', acks.every((line) => [...line].length <= 12));
check('没有空串/重复', acks.every((line) => line.trim()) && new Set(acks).size === acks.length);
check('不再包含原来的僵硬度台词', !acks.includes('行，那我先不打扰了。'));

const picked = [];
for (let index = 0; index < 200; index += 1) picked.push(bridge.pickDismissAck());
check('随机到多种说法（≥ 8 种）', new Set(picked).size >= 8, `${new Set(picked).size} 种`);
check('不会连续两次一样', picked.every((line, index) => index === 0 || line !== picked[index - 1]));
check('结果都来自列表', picked.every((line) => acks.includes(line)));

console.log('');
if (failures.length) {
  console.error(`失败 ${failures.length} 项`);
  process.exit(1);
}
console.log('全部通过：确认语短、多、随机，且不连续重复');
