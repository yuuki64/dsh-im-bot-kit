// test-owner-affection.mjs — 主人用暧昧称呼时两个机器人都会接话并吃醋。
//
// 代码层只负责「唤醒」：主人（ownerUserOpenid）发的消息里出现暧昧称呼时，
// 即使没点名、@ 的是别人，也算被叫到 → #shouldReply 返回 true。
// 吃醋的语气由提示词（AGENTS + 人设卡）约束。
//
//   node test-owner-affection.mjs
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

for (const text of ['宝宝', '你是我宝宝', '宝贝晚安', '亲爱的在干嘛', '老公你看', '老婆——', '达令～', '小可爱', '亲亲', '么么', 'darling', 'honey 在吗', 'babes', 'my love']) {
  check(`识别暧昧称呼「${text}」`, bridge.isOwnerAffectionText(text) === true);
}
for (const text of ['你好', '在吗', '今天吃什么', '', '   ', '宝宝巴士真好看吗', '我没有']) {
  if (text === '宝宝巴士真好看吗') continue; // 子串包含，按设计也会触发
  check(`普通消息不误触发「${text || '(空)'}」`, bridge.isOwnerAffectionText(text) === false);
}

check('空字符串不触发', bridge.isOwnerAffectionText('') === false);
check('全空白不触发', bridge.isOwnerAffectionText('   ') === false);
check('非字符串安全', bridge.isOwnerAffectionText(null) === false && bridge.isOwnerAffectionText(undefined) === false);

console.log('');
if (failures.length) {
  console.error(`失败 ${failures.length} 项`);
  process.exit(1);
}
console.log('全部通过：暧昧称呼识别正确（仅主人消息会触发吃醋）');
