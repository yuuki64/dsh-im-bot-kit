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
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
const checkOnly = args.has('--check');
const force = args.has('--force');

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const profile = process.env.DSH_PROFILE_DIR ?? join(home, 'profiles', 'desktop');
const pluginRoot = join(profile, 'node_modules', '@xmanrui', 'dsh-im');

/** 备份文件名 -> [插件内相对路径, 基线目录（src 或 plugin-src/host）] */
const FILES = [
  ['src_channels_qq_qq-bridge.mjs', 'channels/qq/qq-bridge.mjs'],
  ['src_channels_shared_group-history-store.mjs', 'channels/shared/group-history-store.mjs'],
  ['src_channels_shared_image-prompt.mjs', 'channels/shared/image-prompt.mjs'],
  ['src_channels_shared_quoted-media.mjs', 'channels/shared/quoted-media.mjs'],
  ['src_channels_shared_voice-synth.mjs', 'channels/shared/voice-synth.mjs'],
  ['src_channels_shared_kokoro-tts.mjs', 'channels/shared/kokoro-tts.mjs'],
  ['src_channels_shared_gpu-tts.mjs', 'channels/shared/gpu-tts.mjs'],
  ['src_channels_shared_gsv-tts.mjs', 'channels/shared/gsv-tts.mjs'],
  ['src_channels_shared_persona.mjs', 'channels/shared/persona.mjs'],
  ['src_channels_shared_busy-message-dispatcher.mjs', 'channels/shared/busy-message-dispatcher.mjs'],
  ['src_channels_shared_sticker-library.mjs', 'channels/shared/sticker-library.mjs'],
  ['src_channels_shared_bot-workspace-store.mjs', 'channels/shared/bot-workspace-store.mjs'],
  ['src_channels_shared_harness-client.mjs', 'channels/shared/harness-client.mjs'],
  ['src_channels_shared_group-reasoning.mjs', 'channels/shared/group-reasoning.mjs'],
  ['src_channels_shared_im-switch.mjs', 'channels/shared/im-switch.mjs'],
  ['src_channels_shared_im-switch-server.mjs', 'channels/shared/im-switch-server.mjs'],
  ['src_channels_shared_inbound-access.mjs', 'channels/shared/inbound-access.mjs'],
  ['src_channels_shared_semantic_artifact.mjs', 'channels/shared/semantic/artifact.mjs'],
  ['src_channels_shared_semantic_artifact-delivery.mjs', 'channels/shared/semantic/artifact-delivery.mjs'],
  ['src_channels_weixin_weixin-api.mjs', 'channels/weixin/weixin-api.mjs'],
  ['src_channels_weixin_weixin-bridge.mjs', 'channels/weixin/weixin-bridge.mjs'],
  ['plugin-src_host_channels_shared_startup.mjs', 'channels/shared/startup.mjs', 'plugin-src/host'],
];


function fail(message) {
  console.error(`ERROR ${message}`);
  process.exit(1);
}

if (!existsSync(pluginRoot)) fail(`dsh-im 插件不存在：${pluginRoot}`);
const pkg = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'));
if (pkg.version !== '5.2.0' && !force) {
  fail(`插件版本是 ${pkg.version}，本补丁集只对 5.2.0 有效；确认要覆盖就加 --force`);
}

const backupRoot = join(here, 'backup', 'src-patched');
const missing = FILES.filter(([name]) => !existsSync(join(backupRoot, name)));
if (missing.length) fail(`补丁集缺文件：${missing.map(([n]) => n).join(', ')}`);

const target = (rel, base = 'src') => join(pluginRoot, base, rel);
const same = ([name, rel, base]) => {
  const live = target(rel, base);
  return existsSync(live) && readFileSync(live).equals(readFileSync(join(backupRoot, name)));
};

if (checkOnly) {
  for (const entry of FILES) console.log(`${same(entry) ? 'OK  ' : 'DIFF'} ${entry[2] ? `${entry[2]}/` : ''}${entry[1]}`);
  const silk = existsSync(join(pluginRoot, 'node_modules', 'silk-wasm'));
  console.log(`${silk ? 'OK  ' : 'MISS'} node_modules/silk-wasm`);
  const lib = join(pluginRoot, 'lib', 'index.js');
  const built = existsSync(lib) && readFileSync(lib, 'utf8').includes('imagesForPlatformMessage');
  console.log(`${built ? 'OK  ' : 'MISS'} lib/index.js 已包含补丁`);
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const preApply = join(here, 'backup', `pre-apply-${stamp}`);
for (const [name, rel, base] of FILES) {
  const live = target(rel, base);
  if (!existsSync(live)) continue;
  const to = join(preApply, name);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(live, to);
}

for (const [name, rel, base] of FILES) {
  const live = target(rel, base);
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
console.log(`本次改动前的文件备份在：${preApply}`);
writeFileSync(join(preApply, 'APPLIED.txt'), `${new Date().toISOString()}\nfiles: ${FILES.length}\n`);
