// test-dismiss-silence.mjs — 「别跟我说话」识别 + 模型真的不说话时不要发正文。
//
// 1) DISMISS 识别放宽：之前「我没在跟你两说话！」匹配不上，机器人当普通消息回了「行。」，
//    之后还继续接话。现在覆盖「没/不是 + 在/有 + 跟/和/与 + 你(俩/两) + 说/聊」和「别说话了」。
// 2) 不想说话：模型输出 <dsh_im_silent/> 或「（此处不回复）」，插件一律吞掉不发；
//    之前「（此处不回复）」被当成正文发进群里。
//
//   node test-dismiss-silence.mjs
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

// --- 别跟我说话 ---
for (const text of [
  '我没在跟你两说话！',
  '没在跟你俩说话',
  '我没跟你说话',
  '不是跟你聊',
  '没和你说话',
  '别说话了',
  'yuri不要说话了',
  '别插嘴',
  '没叫你',
  '关你什么事',
  '别接话',
]) {
  check(`识别叫停「${text}」`, bridge.isDismissText(text) === true);
}
for (const text of ['你好', '在吗', '今天吃什么', '我没在吃饭', '这是你说的']) {
  check(`普通消息不误判「${text}」`, bridge.isDismissText(text) === false);
}

// --- 静默标记 ---
function silentOf(text) {
  return bridge.extractMediaIntent(text);
}
for (const text of ['<dsh_im_silent/>', '<dsh_im_silent></dsh_im_silent>', '（此处不回复）', '（不回复）', '[不回复]', '【不回复】', '(此处不回复)']) {
  const intent = silentOf(text);
  check(`静默标记「${text}」不发正文`, intent.silent === true && intent.text === '', JSON.stringify(intent));
}
{
  const intent = silentOf('行。<dsh_im_silent/>');
  check('静默标记混在正文里只去掉标记', intent.silent === false && intent.text === '行。', JSON.stringify(intent));
}
{
  const intent = silentOf('好<dsh_im_voice>我在。</dsh_im_voice>');
  check('语音标签仍然正常解析', intent.voiceText === '我在。' && intent.text === '好', JSON.stringify(intent));
}
{
  const intent = silentOf('嗯<dsh_im_sticker>无语</dsh_im_sticker>');
  check('表情标签仍然正常解析', intent.stickerQuery === '无语' && intent.text === '嗯', JSON.stringify(intent));
}

console.log('');
if (failures.length) {
  console.error(`失败 ${failures.length} 项`);
  process.exit(1);
}
console.log('全部通过：叫停识别 + 静默标记都按预期工作');
