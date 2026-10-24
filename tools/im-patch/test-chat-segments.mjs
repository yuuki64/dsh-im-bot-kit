// Offline self-test for the chat reply splitter (no DSH needed).
//
//   node tools/im-patch/test-chat-segments.mjs
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
  const { splitChatSegments, splitSentences, shouldSplitChatReply } = await import(src('src/channels/qq/chat-segments.mjs'));

  check('short reply stays one message', splitChatSegments('好的。') === null);
  check('empty stays null', splitChatSegments('') === null);
  check('single long sentence is not cut', splitChatSegments('这是一句非常非常长的话它没有任何句末标点所以不应该被切成两条消息即使它超过六十个字符也一样保持原样不改动它') === null);
  check('code fence stays one message', splitChatSegments('看看这段：\n```js\nconsole.log(1)\n```\n就这样，没什么别的。') === null);
  check('table stays one message', splitChatSegments('对比一下：\n| a | b |\n| 1 | 2 |\n结论你自己看。') === null);
  check('URL reply stays one message', splitChatSegments('文档在这里 https://example.com/a/b 自己看，别问我。') === null);

  const two = '今天下午可能会下很大的雨所以出门要带伞。晚上温度会降到十度以下记得加衣服。';
  const twoSegments = splitChatSegments(two, { maxChars: 30 });
  check('two long sentences split into two', Array.isArray(twoSegments) && twoSegments.length === 2, JSON.stringify(twoSegments));

  const long = '第一句话讲的是今天要做的事情，比较长一点所以需要拆开。第二句话是补充说明。第三句是结论。第四句是提醒。第五句是结尾。';
  const longSegments = splitChatSegments(long, { maxChars: 40, maxSegments: 3 });
  check('five sentences capped to maxSegments', Array.isArray(longSegments) && longSegments.length <= 3, JSON.stringify(longSegments));
  check('segments preserve all visible text', longSegments.join('').replace(/\s+/gu, '') === long.replace(/\s+/gu, ''),
    JSON.stringify(longSegments));
  check('each segment readable (not empty)', longSegments.every((segment) => segment.trim().length > 0));

  const newlineReply = '第一行内容比较长一点\n第二行内容也比较长一点';
  const newlineSegments = splitChatSegments(newlineReply, { maxChars: 20, maxSegments: 3 });
  check('newlines separate segments', Array.isArray(newlineSegments) && newlineSegments.length >= 2, JSON.stringify(newlineSegments));

  // 用户实际遇到的那条「看起来很长但只有 52 字」的回复：maxChars=40 时应拆成两条。
  const userCase = '就三点：越来越能自己干活，越来越便宜，越来越难信。 瓶颈早不是聪不聪明，是它瞎编的时候谁来兜。';
  const userSegments = splitChatSegments(userCase, { maxChars: 40, maxSegments: 3 });
  check('52-char two-sentence reply splits at 40', Array.isArray(userSegments) && userSegments.length === 2, JSON.stringify(userSegments));
  check('user reply keeps all text', userSegments.join('').replace(/\s+/gu, '') === userCase.replace(/\s+/gu, ''),
    JSON.stringify(userSegments));

  check('shouldSplitChatReply agrees with splitter', shouldSplitChatReply(two, { maxChars: 30 }) === Boolean(twoSegments));
  check('splitSentences keeps punctuation', splitSentences('a。b！c？')[0].includes('。'));

  // maxSegments above the passive cap is clamped to 4.
  const manySentences = Array.from({ length: 30 }, (_, index) => `第${index}句。`).join('');
  const clamped = splitChatSegments(manySentences, { maxChars: 20, maxSegments: 9 });
  check('maxSegments clamped to passive cap (4)', Array.isArray(clamped) && clamped.length === 4, JSON.stringify(clamped));
} catch (error) {
  console.error(error);
  failures.push('import/run');
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nall chat-segment checks passed');
