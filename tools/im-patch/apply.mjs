#!/usr/bin/env node
/**
 * 一次性安装 / 恢复 dsh-im 5.2.0 的本地补丁集（两个会话的成果合并版）：
 *
 *   1. 引用消息里的图片（QQ 群归档取图 —— 来自 bot-workspace 会话；QQ 私聊缓存、
 *      微信引用图 —— 本补丁集新增）
 *   2. QQ 语音（/voice 指令 + .wav/.silk 产物自动转语音）
 *
 * 用法：
 *   node apply.mjs            # 安装/恢复并重新打包
 *   node apply.mjs --check    # 只检查当前状态，不改任何文件
 *   node apply.mjs --force    # 插件版本不是 5.2.0 时也强行覆盖（不推荐）
 *
 * 适用场景：重装/升级插件后补丁被冲掉。注意本补丁集是按 5.2.0 的文件内容做的，
 * 跨版本强行恢复等于把那些文件降级回 5.2.0 —— 非 5.2.0 请先重新推导补丁。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { FILES, UPSTREAM, resolvePatchTarget, resolvePluginRoot } from './manifest.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
const checkOnly = args.has('--check');
const force = args.has('--force');

const pluginRoot = resolvePluginRoot();


function fail(message) {
  console.error(`ERROR ${message}`);
  process.exit(1);
}

if (!existsSync(pluginRoot)) fail(`dsh-im 插件不存在：${pluginRoot}`);
const pkg = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'));
if (pkg.version !== UPSTREAM.version && !force) {
  fail(`插件版本是 ${pkg.version}，本补丁集只对 ${UPSTREAM.version} 有效；确认要覆盖就加 --force`);
}

const backupRoot = join(here, 'backup', 'src-patched');
const missing = FILES.filter(([name]) => !existsSync(join(backupRoot, name)));
if (missing.length) fail(`补丁集缺文件：${missing.map(([n]) => n).join(', ')}`);

const same = ([name, rel, base]) => {
  const live = resolvePatchTarget(pluginRoot, [name, rel, base]);
  return existsSync(live) && readFileSync(live).equals(readFileSync(join(backupRoot, name)));
};

if (checkOnly) {
  for (const entry of FILES) console.log(`${same(entry) ? 'OK  ' : 'DIFF'} ${entry[2] ? `${entry[2]}/` : ''}${entry[1]}`);
  const silk = existsSync(join(pluginRoot, 'node_modules', 'silk-wasm'));
  console.log(`${silk ? 'OK  ' : 'MISS'} node_modules/silk-wasm`);
  const lib = join(pluginRoot, 'lib', 'index.js');
  const built = existsSync(lib) && readFileSync(lib, 'utf8').includes('imagesForPlatformMessage');
  // 字符串标记只能证明"打过补丁"，不能证明产物对应当前源码；完整证据见 verify-build.mjs。
  console.log(`${built ? 'OK  ' : 'MISS'} lib/index.js 已包含补丁（仅标记；产物/源码一致性用 node verify-build.mjs）`);
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const preApply = join(here, 'backup', `pre-apply-${stamp}`);
for (const [name, rel, base] of FILES) {
  const live = resolvePatchTarget(pluginRoot, [name, rel, base]);
  if (!existsSync(live)) continue;
  const to = join(preApply, name);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(live, to);
}

for (const [name, rel, base] of FILES) {
  const live = resolvePatchTarget(pluginRoot, [name, rel, base]);
  mkdirSync(dirname(live), { recursive: true });
  cpSync(join(backupRoot, name), live);
  console.log(`copied  ${base ? `${base}/` : 'src/'}${rel}`);
}

const silkSource = join(here, 'node_modules', 'silk-wasm');
const silkTarget = join(pluginRoot, 'node_modules', 'silk-wasm');
if (!existsSync(silkTarget)) {
  if (!existsSync(silkSource)) fail('找不到 silk-wasm 来源，无法补 QQ 语音依赖');
  mkdirSync(dirname(silkTarget), { recursive: true });
  cpSync(silkSource, silkTarget, { recursive: true });
  console.log('copied  node_modules/silk-wasm');
}

const build = spawnSync(process.execPath, [join(here, 'build-im.mjs')], { encoding: 'utf8' });
if (build.status !== 0) {
  console.error(build.stdout?.trim());
  console.error(build.stderr?.trim());
  fail('打包失败，原始文件已备份在 ' + preApply);
}
console.log(build.stdout?.trim());

const libPath = join(pluginRoot, 'lib', 'index.js');
const lib = readFileSync(libPath, 'utf8');
const markers = [
  'imagesForPlatformMessage',
  'sendVoice',
  'import("silk-wasm")',
  'voice.silk',
  'chat-switch-off',
  'switch page ready',
  '/api/state',
  'registeredWorkspaceId',
];
const absent = markers.filter((marker) => !lib.includes(marker));
if (absent.length) fail(`打包结果缺少标记：${absent.join(', ')}`);
console.log(`built   lib/index.js (${statSync(libPath).size} B，标记齐全)`);
console.log('\n完成。完全退出 DeepSeek Harness 再打开，补丁才会生效。');
console.log('重启后用 `node verify-build.mjs` 核对源码/产物/运行实例是否同一版本。');
console.log(`本次改动前的文件备份在：${preApply}`);
writeFileSync(join(preApply, 'APPLIED.txt'), `${new Date().toISOString()}\nfiles: ${FILES.length}\n`);
