// 补丁集的唯一清单：上游版本、补丁文件列表、构建证据文件名。
// apply / build / verify / status 都从这里取，避免同一组数字在多个脚本和文档里各写一份。
// 修改补丁清单（增删文件）只需要改这里，然后跑 `node verify-build.mjs --self-test` 和 `node status.mjs`。
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** 补丁集只对这一版上游源码有效；跨版本请先重新推导补丁。 */
export const UPSTREAM = Object.freeze({
  name: '@xmanrui/dsh-im',
  version: '5.2.0',
});

/**
 * 备份文件名 -> [插件内相对路径, 基线目录（src 或 plugin-src/host）]
 * 顺序即 apply 的复制顺序；VERIFY 也按这个顺序逐项比对。
 */
export const FILES = Object.freeze([
  ['src_channels_qq_qq-bridge.mjs', 'channels/qq/qq-bridge.mjs'],
  ['src_channels_qq_qq-runtime.mjs', 'channels/qq/qq-runtime.mjs'],
  ['src_channels_qq_qq-proactive.mjs', 'channels/qq/qq-proactive.mjs'],
  ['src_channels_qq_chat-segments.mjs', 'channels/qq/chat-segments.mjs'],
  ['src_channels_qq_markdown-reply.mjs', 'channels/qq/markdown-reply.mjs'],
  ['src_channels_qq_state-store.mjs', 'channels/qq/state-store.mjs'],
  ['src_channels_shared_workspace-session.mjs', 'channels/shared/workspace-session.mjs'],
  ['src_channels_shared_group-history-store.mjs', 'channels/shared/group-history-store.mjs'],
  ['src_channels_shared_image-prompt.mjs', 'channels/shared/image-prompt.mjs'],
  ['src_channels_shared_quoted-media.mjs', 'channels/shared/quoted-media.mjs'],
  ['src_channels_shared_voice-synth.mjs', 'channels/shared/voice-synth.mjs'],
  ['src_channels_shared_kokoro-tts.mjs', 'channels/shared/kokoro-tts.mjs'],
  ['src_channels_shared_gpu-tts.mjs', 'channels/shared/gpu-tts.mjs'],
  ['src_channels_shared_gsv-tts.mjs', 'channels/shared/gsv-tts.mjs'],
  ['src_channels_shared_persona.mjs', 'channels/shared/persona.mjs'],
  ['src_channels_shared_behavior-config.mjs', 'channels/shared/behavior-config.mjs'],
  ['src_channels_shared_busy-message-dispatcher.mjs', 'channels/shared/busy-message-dispatcher.mjs'],
  ['src_channels_shared_sticker-library.mjs', 'channels/shared/sticker-library.mjs'],
  ['src_channels_shared_cost-budget.mjs', 'channels/shared/cost-budget.mjs'],
  ['src_channels_shared_decision-log.mjs', 'channels/shared/decision-log.mjs'],
  ['src_channels_shared_memory-store.mjs', 'channels/shared/memory-store.mjs'],
  ['src_channels_shared_video-helper.mjs', 'channels/shared/video-helper.mjs'],
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
]);

/** 构建证据文件（build-im.mjs 写入，verify-build.mjs 读取）。本机生成，不进开源镜像。 */
export const BUILD_MANIFEST_FILE = 'build-manifest.json';

/** 状态文档里"最后核验日期"的值；改完并跑过校验再更新。 */
export const LAST_VERIFIED = '2026-10-23';

/** 补丁个数从清单推导，不要在文档里手抄。 */
export const PATCH_FILE_COUNT = FILES.length;

/** 装在 profile 里的插件目录；测试/校验时可以用参数覆盖。 */
export function resolvePluginRoot(env = process.env) {
  if (env.DSH_PROFILE_DIR) return resolve(env.DSH_PROFILE_DIR, 'node_modules', '@xmanrui', 'dsh-im');
  const home = env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(home, 'profiles', 'desktop', 'node_modules', '@xmanrui', 'dsh-im');
}

/** 补丁文件在插件里的落点。base 缺省是 `src`。 */
export function resolvePatchTarget(pluginRoot, [, rel, base]) {
  return join(pluginRoot, base ?? 'src', rel);
}

/**
 * 构建证据目录（build-manifest.json 所在目录）。
 * 镜像副本里没有本机构建证据，所以按顺序退：环境变量 IM_PATCH_AUTH → 本目录 →
 * 本机权威补丁目录 `<WORKSPACE>\tools\im-patch`（本目录上溯三层再进 tools/im-patch）。
 */
export function resolveEvidenceDir() {
  const fromEnv = process.env.IM_PATCH_AUTH;
  if (fromEnv && existsSync(join(fromEnv, BUILD_MANIFEST_FILE))) return resolve(fromEnv);
  if (existsSync(join(here, BUILD_MANIFEST_FILE))) return here;
  const authoritative = resolve(here, '..', '..', '..', 'tools', 'im-patch');
  if (existsSync(join(authoritative, BUILD_MANIFEST_FILE))) return authoritative;
  return here;
}

/** 本脚本所在目录（补丁集目录本身）。 */
export const PATCH_DIR = here;
