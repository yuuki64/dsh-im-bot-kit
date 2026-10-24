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
  const {
    extractMediaIntent, mentionsBotByName, qqInboundMessage, isRepeatChain, matchesOwnText,
    appendPromptPart, mergeCoalescedMessages, formatChatDigest,
  } = await import(src('src/channels/qq/qq-bridge.mjs'));

  const merged = mergeCoalescedMessages([
    { messageId: 'm1', message: { messageId: 'm1', content: '第一句', attachments: [{ content_type: 'text/plain' }] } },
    { messageId: 'm2', message: { messageId: 'm2', content: '第二句', mentions: [{ nickname: 'a' }] } },
  ]);
  check('coalesce merges text/attachments/mentions',
    merged && merged.content === '第一句\n第二句' && merged.attachments.length === 1
    && merged.mentions.length === 1 && String(merged.messageId).startsWith('m2#coalesced'),
    JSON.stringify(merged));
  check('coalesce of empty list is null', mergeCoalescedMessages([]) === null);

  // 回归：引用消息的 content 是 [{type:'text'}] 数组，追加提示不能拼成 [object Object]。
  const stringContent = appendPromptPart('正文', '\n\n[系统提示] X');
  check('append instruction to string content', stringContent === '正文\n\n[系统提示] X', JSON.stringify(stringContent));
  const arrayContent = appendPromptPart([{ type: 'text', text: '引用块' }, { type: 'text', text: '正文' }], '\n\n[系统提示] X');
  check('append instruction to structured content',
    Array.isArray(arrayContent) && arrayContent.length === 3
    && arrayContent[2].type === 'text' && arrayContent[2].text === '\n\n[系统提示] X'
    && !JSON.stringify(arrayContent).includes('[object Object]'),
    JSON.stringify(arrayContent));
  check('append instruction to missing content', appendPromptPart(undefined, 'X') === undefined);

  // 最近群聊摘要：机器人自己的话显示为「你」，当前消息用 ▶ 标出，并包含它之后的消息。
  const nowMs = Date.now();
  const digest = formatChatDigest([
    { senderName: '小蓝莓', text: '猫娘yuuki', at: nowMs - 60_000 },
    { messageId: 'cur', senderName: 'yuuki🍁', text: '才不是！', at: nowMs - 30_000 },
    { isSelf: true, senderName: 'yuri', text: '我才不是猫娘', at: nowMs - 20_000 },
    { senderName: '初童新月', senderIsBot: true, text: '像什么像', at: nowMs - 10_000 },
  ], {
    now: nowMs,
    current: { messageId: 'cur', senderName: 'yuuki🍁', text: '才不是！' },
  });
  check('digest includes before/after and marks current',
    digest.includes('小蓝莓: 猫娘yuuki')
    && digest.includes('▶ yuuki🍁: 才不是！')
    && digest.includes('你: 我才不是猫娘')
    && digest.includes('初童新月(机器人): 像什么像'),
    JSON.stringify(digest));
  const digestOrder = digest.indexOf('小蓝莓: 猫娘yuuki') < digest.indexOf('▶ yuuki🍁: 才不是！')
    && digest.indexOf('▶ yuuki🍁: 才不是！') < digest.indexOf('你: 我才不是猫娘');
  check('digest keeps chronological order around current', digestOrder === true, JSON.stringify(digest));
  check('digest needs at least two entries',
    formatChatDigest([], { now: nowMs, current: { text: 'only' } }) === '');
  check('digest drops stale entries',
    formatChatDigest([
      { senderName: 'a', text: 'old', at: nowMs - 30 * 60_000 },
    ], { now: nowMs, minutes: 15, current: { text: 'now' } }) === '');

  // 前 25 条 / 后 4 条：历史只保留最近 25 条，当前之后最多 4 条。
  const manyEntries = [];
  for (let index = 0; index < 30; index += 1) {
    manyEntries.push({ senderName: `u${index}`, text: `before-${index}`, at: nowMs - (60 - index) * 1000 });
  }
  manyEntries.push({ messageId: 'cur2', senderName: 'owner', text: 'current', at: nowMs });
  for (let index = 0; index < 6; index += 1) {
    manyEntries.push({ senderName: `a${index}`, text: `after-${index}`, at: nowMs + (index + 1) * 1000 });
  }
  const wideDigest = formatChatDigest(manyEntries, {
    now: nowMs + 10_000,
    minutes: 60,
    current: { messageId: 'cur2', senderName: 'owner', text: 'current' },
  });
  check('digest keeps only the newest 25 before-current lines',
    !wideDigest.includes('before-0') && wideDigest.includes('before-29'), JSON.stringify(wideDigest).slice(0, 300));
  check('digest keeps at most 4 after-current lines',
    wideDigest.includes('after-0') && wideDigest.includes('after-3') && !wideDigest.includes('after-4'),
    JSON.stringify(wideDigest).slice(-200));

  check('quote of own message matches',
    matchesOwnText('他就发个表情，我接啥', ['他就发个表情，我接啥']) === true);
  check('quote with different punctuation matches',
    matchesOwnText('他就发个表情 我接啥。', ['他就发个表情，我接啥']) === true);
  check('quote of someone else does not match',
    matchesOwnText('今天吃什么', ['他就发个表情，我接啥']) === false);

  const chainHistory = [
    { senderId: 'u1', text: '谁说没有完美犯罪（', at: 1000 },
    { senderId: 'u2', text: '谁说没有完美犯罪 (', at: 2000 },
    { senderId: 'bot', senderIsBot: true, text: '谁说没有完美犯罪（', at: 2500 },
  ];
  check('repeat chain detected for third person',
    isRepeatChain(chainHistory, { text: '谁说没有完美犯罪（', senderId: 'u3', now: 3000, windowMinutes: 5, minSenders: 2 }) === true);
  check('repeat chain ignores single echo',
    isRepeatChain(chainHistory.slice(0, 1), { text: '谁说没有完美犯罪（', senderId: 'u3', now: 3000 }) === false);
  check('repeat chain ignores stale messages',
    isRepeatChain(chainHistory, { text: '谁说没有完美犯罪（', senderId: 'u3', now: 10 * 60_000, windowMinutes: 5 }) === false);

  const voiceMsg = qqInboundMessage({
    content: '',
    attachments: [{ content_type: 'audio/amr', asr_refer_text: '今晚吃什么', url: 'https://example.com/v.amr' }],
  });
  check('voice message uses QQ asr text', voiceMsg.content.includes('今晚吃什么') && voiceMsg.files.length === 0,
    JSON.stringify(voiceMsg));
  const voiceNoAsr = qqInboundMessage({
    content: '',
    attachments: [{ content_type: 'audio/amr', url: 'https://example.com/v.amr' }],
  });
  check('voice without asr is noted, not filed', voiceNoAsr.content.includes('语音') && voiceNoAsr.files.length === 0,
    JSON.stringify(voiceNoAsr));

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
