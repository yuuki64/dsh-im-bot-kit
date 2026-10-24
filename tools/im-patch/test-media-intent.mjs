// Offline self-test for media tags in a QQ answer (voice burst / sticker / silence).
//
//   node tools/im-patch/test-media-intent.mjs
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = process.env.DSH_PROFILE_DIR
  ? join(process.env.DSH_PROFILE_DIR, 'node_modules', '@xmanrui', 'dsh-im')
  : join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', '@xmanrui', 'dsh-im');
const src = (...parts) => pathToFileURL(resolve(pluginRoot, ...parts)).href;

const failures = [];
function check(label, condition, detail = '') {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures.push(label);
}

try {
  const { extractMediaIntent, mentionsBotByName } = await import(src('src/channels/qq/qq-bridge.mjs'));

  check('mention by nickname matches bot name',
    mentionsBotByName({ mentions: [{ nickname: 'yuri' }] }, ['yuri', '小鲸鱼']) === true);
  check('mention by other nickname is not us',
    mentionsBotByName({ mentions: [{ nickname: '初童新月' }] }, ['yuri', '小鲸鱼']) === false);
  check('mention without names is not us', mentionsBotByName({ mentions: [] }, ['yuri']) === false);

  const plain = extractMediaIntent('就一句话。');
  check('plain text has no voice', plain.voiceTexts.length === 0 && plain.voiceText === null, JSON.stringify(plain));

  const one = extractMediaIntent('<dsh_im_voice>第一句</dsh_im_voice>');
  check('single voice extracted', one.voiceTexts.length === 1 && one.voiceTexts[0] === '第一句', JSON.stringify(one));
  check('single voice keeps compatibility field', one.voiceText === '第一句');
  check('voice tag stripped from text', one.text === '');

  const three = extractMediaIntent('你再说一遍？\n<dsh_im_voice>第一条</dsh_im_voice>\n<dsh_im_voice>第二条</dsh_im_voice>\n<dsh_im_voice>第三条</dsh_im_voice>');
  check('three voices extracted in order', JSON.stringify(three.voiceTexts) === JSON.stringify(['第一条', '第二条', '第三条']), JSON.stringify(three));
  check('text kept before voice tags', three.text === '你再说一遍？');

  const four = extractMediaIntent('<dsh_im_voice>1</dsh_im_voice><dsh_im_voice>2</dsh_im_voice><dsh_im_voice>3</dsh_im_voice><dsh_im_voice>4</dsh_im_voice>');
  check('voice burst capped at 3', four.voiceTexts.length === 3, JSON.stringify(four.voiceTexts));

  const mixed = extractMediaIntent('<dsh_im_sticker>无语</dsh_im_sticker><dsh_im_voice>别说了</dsh_im_voice>好。');
  check('sticker and voice both extracted', mixed.stickerQuery === '无语' && mixed.voiceTexts.length === 1 && mixed.text === '好。', JSON.stringify(mixed));

  const silent = extractMediaIntent('<dsh_im_silent/>');
  check('silent alone stays silent', silent.silent === true && silent.text === '' && silent.voiceTexts.length === 0, JSON.stringify(silent));

  const silentWithVoice = extractMediaIntent('<dsh_im_silent/> <dsh_im_voice>我就说一句</dsh_im_voice>');
  check('silent tag with voice is not dropped', silentWithVoice.voiceTexts.length === 1 && silentWithVoice.silent === false, JSON.stringify(silentWithVoice));

  const tagged = extractMediaIntent('<dsh_im_sticker_tag>无语, 离谱</dsh_im_sticker_tag>');
  check('sticker tag action parsed', JSON.stringify(tagged.stickerTags) === JSON.stringify(['无语', '离谱']) && tagged.silent === false, JSON.stringify(tagged));

  const rejected = extractMediaIntent('这张不行<dsh_im_sticker_reject/>');
  check('sticker reject parsed', rejected.stickerReject === true && rejected.text === '这张不行', JSON.stringify(rejected));

  const actionOnly = extractMediaIntent('<dsh_im_sticker_tag>开心</dsh_im_sticker_tag><dsh_im_silent/>');
  check('sticker action with silent still acts', actionOnly.silent === false && actionOnly.stickerTags.length === 1, JSON.stringify(actionOnly));

  const tagWithText = extractMediaIntent('还行吧<dsh_im_sticker>摆烂</dsh_im_sticker><dsh_im_sticker_tag>无语</dsh_im_sticker_tag>');
  check('sticker query and tag action kept apart', tagWithText.stickerQuery === '摆烂' && tagWithText.stickerTags[0] === '无语' && tagWithText.text === '还行吧', JSON.stringify(tagWithText));
} catch (error) {
  console.error(error);
  failures.push('import/run');
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nall media-intent checks passed');
