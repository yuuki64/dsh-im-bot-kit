// test-bot-wake.mjs — 群聊里「叫名字就能唤醒」的离线回归。
//
// 旧实现把唤醒名字写死成 yuri/小鲸鱼/DeepSeek/大肥鱼，导致 hiro 在群里被叫
// 椎名/hiro/希罗 都没反应。现在按 bots/<botId>/bot.json 的 name+aliases 生成匹配器。
//
//   node test-bot-wake.mjs
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { localValue } from './local-config.mjs';

const pluginRoot = join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', '@xmanrui', 'dsh-im');
const bridge = await import(pathToFileURL(join(pluginRoot, 'src', 'channels', 'qq', 'qq-bridge.mjs')).href);
const persona = await import(pathToFileURL(join(pluginRoot, 'src', 'channels', 'shared', 'persona.mjs')).href);

const failures = [];
function check(label, condition, detail = '') {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? `  — ${detail}` : ''}`);
  if (!condition) failures.push(label);
}

function patternFor(botId) {
  const profile = persona.readBotProfile(botId);
  return bridge.nameMentionPatternForNames(profile ? [profile.name, ...profile.aliases] : []);
}

// 真实 botId 不进仓库：环境变量优先，其次仓库根的 config.local.json（已 gitignore）。
//   $env:BOT_ID_HIRO='qq_…'; $env:BOT_ID_YURI='qq_…'; node test-bot-wake.mjs
//   （或者把两个值写进 config.local.json 的 botIdHiro / botIdYuri）
const botIdHiro = localValue('botIdHiro', 'BOT_ID_HIRO');
const botIdYuri = localValue('botIdYuri', 'BOT_ID_YURI');
if (!botIdHiro || !botIdYuri) {
  console.log('skip: 先在 config.local.json 写 botIdHiro / botIdYuri（或设同名环境变量）再跑');
  process.exit(0);
}
const hiroPattern = patternFor(botIdHiro);
const yuriPattern = patternFor(botIdYuri);
const plainPattern = patternFor('qq_plain_example');

check('hiro 有唤醒匹配器', Boolean(hiroPattern), hiroPattern ? String(hiroPattern) : 'null');
for (const text of ['hiro说句话', '椎名 在吗', '希罗你妹妹是谁', '二阶堂希罗出来', 'HIRO 你好']) {
  check(`hiro 被「${text}」唤醒`, Boolean(hiroPattern?.test(text)));
}
for (const text of ['yuri 你好', '小鲸鱼在吗', '大肥鱼过来']) {
  check(`hiro 不被「${text}」误唤醒`, !hiroPattern?.test(text));
}
for (const text of ['yuri 你好', '小鲸鱼在吗', '大肥鱼过来', 'deepseek 说说']) {
  check(`yuri 仍被「${text}」唤醒`, Boolean(yuriPattern?.test(text)));
}
for (const text of ['椎名 在吗', 'hiro 出来']) {
  check(`yuri 不被「${text}」误唤醒`, !yuriPattern?.test(text));
}
check('没有 profile 的 bot 不继承 yuri 的唤醒词（只认 @）', plainPattern === null);

// ascii 名字要整词匹配，避免 "hiro" 命中 "hiroshi"
check('ascii 名字整词匹配', Boolean(hiroPattern?.test('hiro 你好')) && !hiroPattern?.test('hiroshi 你好'));

console.log('');
if (failures.length) {
  console.error(`失败 ${failures.length} 项`);
  process.exit(1);
}
console.log('全部通过：每个机器人只被自己的名字/别名唤醒');
