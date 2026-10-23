// test-weixin-outbound-tags.mjs — 微信出站标签清理的离线回归测试。
//
// 微信（iLink）没有语音/表情包投递通道，`<dsh_im_voice>` / `<dsh_im_sticker>` 绝不能
// 原样漏给用户。本测试直接从真实源码里取出 sanitizeOutboundText（连同它的正则常量）
// 求值后断言行为——不复制实现，源码里删掉这段逻辑测试就会失败。
//
// 用法：
//   node test-weixin-outbound-tags.mjs                      # 测权威补丁副本
//   node test-weixin-outbound-tags.mjs --file <path>         # 测指定文件（如镜像副本，验证缺失时确实失败）
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = join(here, 'backup', 'src-patched', 'src_channels_weixin_weixin-bridge.mjs');

/** 从源码里取出常量声明 + 函数体，返回可直接调用的函数。取不到就抛错（视作缺失修复）。 */
export function extractSanitizer(source, { symbol = 'sanitizeOutboundText' } = {}) {
  const functionStart = source.indexOf(`function ${symbol}(`);
  if (functionStart < 0) throw new Error(`源码里找不到 function ${symbol}()`);
  let depth = 0;
  let functionEnd = -1;
  for (let index = source.indexOf('{', functionStart); index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        functionEnd = index + 1;
        break;
      }
    }
  }
  if (functionEnd < 0) throw new Error(`${symbol}() 的花括号不配对`);
  const constStart = source.lastIndexOf('const WEIXIN_VOICE_TAG_PATTERN', functionStart);
  if (constStart < 0) throw new Error('源码里找不到 WEIXIN_* 正则常量声明');
  const body = `${source.slice(constStart, functionEnd)}\nreturn ${symbol};`;
  // 仅用于离线断言：不联网、不碰文件，作用域里只有上面这段源码。
  const factory = new Function(body);
  const fn = factory();
  if (typeof fn !== 'function') throw new Error('抽取出的 sanitizer 不是函数');
  return fn;
}

const CASES = [
  {
    name: '语音标签 → 普通文本',
    input: '<dsh_im_voice>你好呀</dsh_im_voice>',
    expect: '你好呀',
  },
  {
    name: '语音标签嵌在句子里 → 保留上下文',
    input: '前文<dsh_im_voice>语音内容</dsh_im_voice>后文',
    expect: '前文语音内容后文',
  },
  {
    name: '只有表情标签 → 整段丢弃',
    input: '<dsh_im_sticker>开心</dsh_im_sticker>',
    expect: '',
  },
  {
    name: '表情标签夹在文本里 → 去掉标签保留两侧',
    input: '文本<dsh_im_sticker></dsh_im_sticker>尾巴',
    expect: '文本尾巴',
  },
  {
    name: '普通文本原样返回',
    input: '今天天气不错，没有标签。',
    expect: '今天天气不错，没有标签。',
  },
  {
    name: '只有空白语音体 → 空串（避免空投递）',
    input: '<dsh_im_voice>   </dsh_im_voice>',
    expect: '',
  },
  {
    name: '不完整的残留标签 → 清掉',
    input: '<dsh_im_voice>',
    expect: '',
  },
  {
    name: '多行空白收敛',
    input: 'a<dsh_im_sticker>x</dsh_im_sticker>\n\n\n\nb',
    expect: 'a\n\nb',
  },
  {
    name: '非字符串入参原样返回',
    input: undefined,
    expect: undefined,
  },
];

function sameValue(actual, expected) {
  if (expected === undefined) return actual === undefined;
  return actual === expected;
}

async function main() {
  const fileIndex = process.argv.indexOf('--file');
  const file = fileIndex >= 0 ? resolve(process.argv[fileIndex + 1]) : DEFAULT_FILE;
  if (!existsSync(file)) {
    console.error(`ERROR 找不到待测文件：${file}`);
    process.exit(1);
  }
  const source = await readFile(file, 'utf8');
  console.log(`[微信出站标签清理] 目标文件：${file}`);

  let sanitize;
  try {
    sanitize = extractSanitizer(source);
  } catch (error) {
    console.error(`FAIL  无法从该文件取到 sanitizeOutboundText：${error.message}`);
    console.error('      说明这个副本缺少"微信出站标签清理"修复（权威副本有、镜像没有时就是这种情况）。');
    process.exit(1);
  }

  let failed = 0;
  for (const testCase of CASES) {
    const actual = sanitize(testCase.input);
    const pass = sameValue(actual, testCase.expect);
    if (!pass) failed += 1;
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${testCase.name.padEnd(28)} 输入=${JSON.stringify(testCase.input)} 输出=${JSON.stringify(actual)}`);
  }

  // 结构性断言：只有标签时清理成空串后，发送路径必须直接返回，不能发一条空消息。
  const sendMatch = /async #send\([^)]*\)\s*\{([\s\S]*?)\n  \}/u.exec(source);
  const sendBody = sendMatch?.[1] ?? '';
  const sanitizedFirst = /text = sanitizeOutboundText\(text\);/u.test(sendBody);
  const emptyGuard = /if \(!text\) return \[\];/u.test(sendBody);
  const structurePass = sanitizedFirst && emptyGuard;
  if (!structurePass) failed += 1;
  console.log(
    `${structurePass ? 'PASS' : 'FAIL'}  ${'空文本不投递（发送路径）'.padEnd(24)} 清理调用=${sanitizedFirst} 空文本提前返回=${emptyGuard}`,
  );

  console.log('');
  const total = CASES.length + 1;
  if (failed === 0) {
    console.log(`全部通过：${total} 项（${CASES.length} 个行为用例 + 1 个发送路径结构断言）`);
    process.exit(0);
  }
  console.error(`失败：${failed}/${total}`);
  process.exit(1);
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) await main();
