import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { captureGroupHistory } from '../shared/group-history.mjs';
import { BusyMessageDispatcher, canAutomaticallySteer } from '../shared/busy-message-dispatcher.mjs';
import { isPermissionCommand, runPermissionCommand } from '../shared/permission-command.mjs';
import { createDeferredDeliveryCoordinator, deferredOutcomeText } from '../shared/deferred-delivery-coordinator.mjs';
import { runWorkspaceCommand } from '../shared/workspace-command.mjs';
import { runCompactCommand } from '../shared/compact-command.mjs';
import { isClearCommand, runClearCommand } from '../shared/clear-command.mjs';
import { isHistoryCommand, runHistoryCommand } from '../shared/history-command.mjs';
import {
  isControlCommand,
  runControlCommand,
} from '../shared/control-command.mjs';
import { rememberConnectionTestTarget } from '../shared/connection-test.mjs';
import {
  harnessAnswerForQuestion,
  harnessQuestionText,
  validHarnessQuestion,
} from '../shared/harness-question.mjs';
import { HarnessApprovalQueue } from '../shared/harness-approval.mjs';
import {
  isModelCommand,
  runModelCommand,
} from '../shared/model-command.mjs';
import {
  isPresetCommand,
  runPresetCommand,
} from '../shared/preset-command.mjs';
import { askInWorkspaceSession } from '../shared/workspace-session.mjs';
import {
  captureContextEnhancement,
  captureContextEnhancementSource,
  enhanceContextContent,
} from '../shared/context-enhancement.mjs';
import {
  BatchInputManager,
  batchInputBusyMessage,
  batchInputGroupUnsupportedMessage,
  isBatchInputCommand,
} from '../shared/batch-input.mjs';
import {
  DEFAULT_MAX_IMAGES,
  fetchImageBuffer,
  hasInboundImages,
  imagePromptDiagnostic,
  imagePromptUserMessage,
} from '../shared/image-prompt.mjs';
import {
  hasInboundFiles,
  inboundFileUserMessage,
  prefetchInboundFiles,
} from '../shared/inbound-file.mjs';
import {
  trackOutboundArtifactProviderPromise,
} from '../shared/semantic/artifact.mjs';
import { deliverOutboundArtifacts } from '../shared/semantic/artifact-delivery.mjs';
import {
  hasReplyReference,
  promptContentForInboundMessage,
} from '../shared/semantic/reply-reference.mjs';
import {
  createDeliveryReceipt,
  providerMessageIdsFor,
} from '../shared/semantic/delivery.mjs';
import {
  messageFailureDiagnostic,
  channelDeliveryFailure,
  clearLastMessageFailure,
  messageFailureText,
  setLastMessageFailure,
} from '../shared/message-failure.mjs';
import {
  COMMAND_PERMISSION_DENIED_MESSAGE,
  evaluateInboundAccess,
} from '../shared/inbound-access.mjs';
import { sendMarkdownReply } from './markdown-reply.mjs';
import {
  isQqMenuCommand, parseQqMenuCommand, QqMenuStore,
  qqMenuPage, qqMenuView, sendQqMenu,
} from './qq-menu.mjs';
import { withSessionBindingLock } from '../shared/session-binding-lock.mjs';
import { t } from '../shared/i18n.mjs';
import { isQqMessageAddressed, normalizeQqMentions } from './qq-mention.mjs';
import {
  captureQuotedMedia,
  quotedMediaFor,
} from '../shared/quoted-media.mjs';
import {
  DEFAULT_VOICE_SETTINGS,
  encodeWavToSilk,
  listInstalledVoices,
  readVoiceSettings,
  resolveVoiceAlias,
  resolveVoiceChoice,
  synthesizeSpeechSilk,
  voiceAliasTable,
  voiceFailureMessage,
  writeVoiceSettings,
  VoiceError,
} from '../shared/voice-synth.mjs';
import { KOKORO_VOICES } from '../shared/kokoro-tts.mjs';
import { applyPersona, listPersonas, readBotProfile, usePersona } from '../shared/persona.mjs';
import { ensureGpuTts, gpuTtsAvailable, gpuTtsHealth, stopGpuTts } from '../shared/gpu-tts.mjs';
import { ensureGsv, gsvHealth, isGsvAvailable, stopGsv } from '../shared/gsv-tts.mjs';
import {
  allowStickerCollection,
  inferStickerTags,
  isCollectableSticker,
  pickSticker,
  removeSticker,
  saveSticker,
  tagSticker,
} from '../shared/sticker-library.mjs';
import { readBehaviorConfig } from '../shared/behavior-config.mjs';
import { chargeBudget, isBudgetExhausted, botSpentCny } from '../shared/cost-budget.mjs';
import { appendDecision, readRecentDecisions } from '../shared/decision-log.mjs';
import {
  captureFacts, clearMemory, digestDoneToday, forgetMemory, listHabits, listMemoryGroups, loadMemory,
  markDigestDone, memoryStats, pruneMemory, recentFactTexts, recordHabitObservation,
  selectHabitHint, selectMemoryBlock, setHabitTone,
} from '../shared/memory-store.mjs';
import { splitChatSegments } from './chat-segments.mjs';
import {
  REASONING_EFFORTS,
  readGroupReasoningCeiling,
  writeGroupReasoningCeiling,
} from '../shared/group-reasoning.mjs';

function interactionResolvedText() {
  return t('这个问题已在其他客户端处理，无需再次回答。');
}
const DEFAULT_FILE_UPLOAD_TIMEOUT_MS = 120_000;
// How long a group conversation stays engaged after the bot is addressed.
// Phrases that mean "I was not talking to you": drop engagement at once.
const DISMISS_PATTERN = /(?:没|不是)(?:有)?(?:在)?(?:跟|和|与)你(?:俩|两|俩个|们)?(?:说|聊)|(?:别|不要)说话了?|别插嘴|不要插嘴|没叫你|关你(?:什么|屁)事|(?:别|不要)接话/iu;

/** Pure helper (exported for tests): does this line tell the bot to back off? */
export function isDismissText(text) {
  return DISMISS_PATTERN.test(String(text ?? ''));
}
// One short line when told to back off. Keep it varied — a single fixed sentence
// ("行，那我先不打扰了。") reads robotic after the second time.
export const DISMISS_ACKS = Object.freeze([
  '行，不说了。',
  '好，我闭嘴。',
  '嗯，收到。',
  '行吧，当没听见。',
  '好，那你忙。',
  '知道了，不插嘴。',
  '行，我安静会儿。',
  '好，不打扰你。',
  '嗯，我潜水。',
  '行，你说你的。',
  '好，我退下。',
  '嗯，那我看着。',
  '行，不吵你。',
  '好，我先忙别的。',
  '知道了，收声。',
  '行，那我不接话了。',
]);
let lastDismissAck = -1;
/** Random acknowledgement, never the same one twice in a row. */
export function pickDismissAck() {
  const pool = DISMISS_ACKS.filter((_, index) => index !== lastDismissAck);
  const chosen = pool[Math.floor(Math.random() * pool.length)];
  lastDismissAck = DISMISS_ACKS.indexOf(chosen);
  return chosen;
}

// Non-owner spam guard: repeating the same line (or flooding) gets silence.
// The owner is exempt — they may repeat commands on purpose.
const SPAM_WINDOW_MS = 10 * 60 * 1000;
const SPAM_REPEAT_FAST_MS = 2 * 60 * 1000;
const SPAM_FLOOD_PER_MINUTE = 8;
const SPAM_HISTORY_MAX = 40;

// Bot-to-bot replies: still bounded (two bots must not ping-pong forever), but
// loose enough to feel natural — the owner asked the sisters to answer each
// other instead of leaving a line hanging.
const BOT_REPLY_MIN_MS = Math.max(500, Number(process.env.DSH_IM_BOT_REPLY_MIN_MS ?? 3000) || 3000);
const BOT_REPLY_WINDOW_MS = 5 * 60 * 1000;
const BOT_REPLY_MAX = Math.max(1, Number(process.env.DSH_IM_BOT_REPLY_MAX ?? 20) || 20);

/**
 * Pure decision helper (exported for tests): may the bot answer another bot now?
 * @returns {{allowed: boolean, history: number[]}}
 */
export function botReplyAllowed(history, now = Date.now()) {
  const kept = (Array.isArray(history) ? history : [])
    .filter((ts) => typeof ts === 'number' && now - ts < BOT_REPLY_WINDOW_MS);
  const last = kept[kept.length - 1];
  if (last !== undefined && now - last < BOT_REPLY_MIN_MS) return { allowed: false, history: kept };
  if (kept.length >= BOT_REPLY_MAX) return { allowed: false, history: kept };
  kept.push(now);
  return { allowed: true, history: kept };
}

// Owner-only jealousy trigger: an intimate nickname from the owner means every
// bot answers (and acts jealous), even when the line was aimed at someone else.
const OWNER_AFFECTION_PATTERN = /宝宝|宝贝|亲爱的|親愛的|老公|老婆|达令|達令|darling|honey|bab[ye]|小可爱|小可愛|亲亲|親親|么么|mua|my love/iu;

/** Pure helper (exported for tests): is this an intimate nickname line? */
export function isOwnerAffectionText(text) {
  const value = String(text ?? '');
  if (!value.trim()) return false;
  return OWNER_AFFECTION_PATTERN.test(value);
}


function normalizeSpamText(text) {
  return String(text ?? '').replace(/\s+/gu, ' ').trim().toLowerCase().slice(0, 200);
}

/**
 * Pure decision helper (exported for tests): should this message be ignored as
 * spam, given the sender's previous messages in this conversation?
 * @returns {{ignore: boolean, history: {text: string, at: number}[]}}
 */
export function spamCheck(history, text, now = Date.now()) {
  const kept = (Array.isArray(history) ? history : [])
    .filter((entry) => entry && typeof entry.text === 'string' && now - entry.at < SPAM_WINDOW_MS)
    .slice(-SPAM_HISTORY_MAX);
  const same = kept.filter((entry) => entry.text === text);
  const lastSame = same[same.length - 1];
  const recentMinute = kept.filter((entry) => now - entry.at < 60_000).length;
  let ignore = false;
  if (text) {
    // Second identical line within two minutes, or a third one in the window.
    if (lastSame && now - lastSame.at < SPAM_REPEAT_FAST_MS) ignore = true;
    else if (same.length >= 2) ignore = true;
  }
  if (recentMinute >= SPAM_FLOOD_PER_MINUTE) ignore = true;
  kept.push({ text, at: now });
  return { ignore, history: kept.slice(-SPAM_HISTORY_MAX) };
}
const ENGAGEMENT_TTL_MS = Math.max(60_000, Number(process.env.DSH_IM_ENGAGE_TTL_MS ?? 10 * 60 * 1000) || 600_000);

/**
 * Persist failed-turn diagnostics next to the DSH logs. The user-facing failure
 * notice only carries a reference id; without this record an INTERNAL_* error
 * cannot be traced to its cause afterwards.
 */
async function appendFailureLog(entry) {
  try {
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
    const directory = join(home, 'logs', 'dsh-im');
    await mkdir(directory, { recursive: true });
    const file = join(directory, `${new Date().toISOString().slice(0, 10)}.log`);
    await appendFile(file, `${JSON.stringify({ ts: new Date().toISOString(), channel: 'qq', ...entry })}\n`, 'utf8');
  } catch {
    // Diagnostics must never fail the reply path.
  }
}

export const QQ_IMAGE_HOSTS = Object.freeze([
  '.myqcloud.com',
  '.qpic.cn',
  '.qq.com',
  '.qq.com.cn',
  '.tencentcos.com',
  '.ugcimg.cn',
]);

const QQ_IMAGE_FILENAME = /\.(?:gif|jpe?g|png|webp)$/i;

/** Durable queue-entry id; the conversation key keeps ids unique across chats. */
function pendingMessageId(key, messageId) {
  return `${key}\u0000${messageId}`;
}

const PENDING_RESTART_NOTICE = '排队中的消息在服务重启时被中断。为避免重复执行，未自动重放；如果该消息尚未处理，请重新发送。';

/**
 * A queued-message restart notice is fine in a 1:1 chat, but it must never show
 * up in a group — members would see internal bookkeeping. Pure (exported for tests).
 */
export function shouldNotifyInterruptedPending(entry) {
  if (!entry || entry.target === undefined || entry.target === null) return false;
  return entry.kind !== 'group';
}

function helpText() {
  return [
    t('QQ 机器人已连接 DeepSeek Harness。'),
    '',
    t('直接发送文字、图片或文件即可继续当前会话。'),
    t('/menu 或 /m  打开可点击的功能菜单'),
    t('/new  开启一个全新会话'),
    t('/compact  压缩当前会话的较早上下文'),
    t('/clear  清空当前会话上下文（保留 Session 绑定和历史记录）'),
    t('/history [数量]  查看最近历史消息（默认 3 条，最多 5 条）'),
    t('/workspace 工作区序号或绝对路径  切换工作区'),
    t('/workspacelist  列出工作区绝对路径'),
    t('/ws、/wsl、/workspaces  工作区命令别名'),
    t('/sessionlist 或 /sessions [工作区序号或绝对路径]  列出会话 ID 和标题'),
    t('/sessionlist --limit N  仅列出当前工作区前 N 个会话'),
    t('/session Session ID 或当前工作区序号  将当前聊天绑定到指定会话'),
    t('/models  按序号列出所有可用模型'),
    t('/reasoninglist 或 /reasonings  按序号列出当前模型可用推理等级'),
    t('/reasoning [序号、等级ID或 --default]  查看或切换当前推理等级'),
    t('/model [序号或完整模型ID] [推理等级ID]  查看或切换当前会话模型'),
    t('示例：先发 /models，再发 /model 2 [推理等级ID]'),
    t('/presetlist 或 /presets  按序号列出可用 Agent Preset'),
    t('/preset [序号或完整ID]  查看或设置当前机器人 Agent Preset'),
    t('纯数字 ID：/preset id:<ID>'),
    t('/preset --default  跟随 Host 默认'),
    t('/permissionlist  按序号列出权限档位'),
    t('/permission [序号或完整ID]  查看或切换当前会话权限'),
    t('纯数字 ID：/permission id:<ID>'),
    t('/stop  停止当前任务'),
    t('/steer 补充指令  纠偏当前任务'),
    t('/voice 要说的话  发一条 QQ 语音（仅主人，最长 60 秒）'),
    t('/voice list | set yaoyao | pitch +15 | rate +5  换音色/调音'),
    t('/sticker [关键词]  从本地表情库随机/按关键词发一张表情包'),
    t('/effort [none|minimal|low|medium|high|xhigh]  设置群聊推理上限（仅主人，默认 low）'),
    t('/batch  开始批量输入（仅私聊，最多 10 条文字）'),
    t('/send  提交当前批次'),
    t('/cancel  取消当前批次'),
    t('/status  检查连接状态'),
    t('/version  查看插件版本'),
    t('/help  显示本帮助'),
  ].join('\n');
}

function conversationKey(message) {
  return `${message.kind}:${message.kind === 'group' ? message.groupOpenid : message.senderId}`;
}

function senderAllowed(message, ownerUserOpenid) {
  return message?.kind === 'group'
    || ownerUserOpenid === '*'
    || message?.senderId === ownerUserOpenid;
}

/** Scope key shared by the quote cache and every inbound/outbound path. */
function qqConversationScope(message) {
  if (!message || typeof message !== 'object') return '';
  return `qq:${message.kind ?? 'unknown'}:${message.kind === 'group'
    ? nonEmptyString(message.groupOpenid) ?? ''
    : nonEmptyString(message.senderId) ?? ''}`;
}

/** Keep the original extension so imageStorageName accepts the quoted name. */
function quotedImageName(name, index) {
  const base = nonEmptyString(name) ?? `image-${index + 1}`;
  return `引用-${base}`;
}

// 被逼急时可以连发多条语音：一次回复里最多 3 个 <dsh_im_voice> 标签，
// 每条标签发一条语音（插件不合并、不改字）。
const VOICE_TAG_PATTERN = /<dsh_im_voice>([\s\S]*?)<\/dsh_im_voice>/giu;
const MAX_VOICE_MESSAGES = 3;
// 本地补丁（2026-10-24）：被激将/被反复怼的常见说法 → 给模型加一句「这次优先用语音」的提示。
const PROVOKE_PATTERN = /(?:这也不生气|不生气|没生气|生气了|你急了|急了|破防|绷不住|就这|阴阳|怼你|骂你|你敢|敢不敢|这也能忍|气死|服了|别怂|认怂)/u;
const STICKER_TAG_PATTERN = /<dsh_im_sticker>([\s\S]*?)<\/dsh_im_sticker>/iu;
// 本地补丁：AI 看到群里的表情图后，给自动收藏补标签 / 判定不合人设就拒收。
const STICKER_TAG_ACTION = /<dsh_im_sticker_tag>([\s\S]*?)<\/dsh_im_sticker_tag>/giu;
const STICKER_REJECT_TAG = /<dsh_im_sticker_reject\s*\/?>(?:\s*<\/dsh_im_sticker_reject>)?/giu;
const STICKER_REJECT_TEST = /<dsh_im_sticker_reject\s*\/?>/iu;
// "I have nothing to say" — the model emits this instead of writing a meta line
// such as "（此处不回复）", which used to be sent to the chat verbatim.
const SILENT_TAG_PATTERN = /<dsh_im_silent\s*\/?>(?:\s*<\/dsh_im_silent>)?/giu;
const SILENT_TAG_TEST = /<dsh_im_silent\s*\/?>/iu;
const SILENT_TEXT_PATTERN = /^[（(【\[]\s*(?:此处)?不回复\s*[）)】\]]$/u;
// 本地补丁（2026-10-24）：长期记忆标签——模型顺带记录值得记住的信息。
const MEMORY_TAG_ACTION = /<dsh_im_memory>([\s\S]*?)<\/dsh_im_memory>/giu;
const MAX_MEMORY_NOTES = 2;
// 本地补丁：摘要任务给口头禅补语气（格式：短语|语气）。
const HABIT_TONE_TAG = /<dsh_im_habit_tone>([\s\S]*?)<\/dsh_im_habit_tone>/giu;
const MAX_HABIT_TONES = 2;

/**
 * Split a final answer into user-facing text plus optional spoken lines and a
 * sticker request. Tags are stripped regardless of order.
 *
 * 本地补丁（2026-10-24）：`<dsh_im_voice>` 可以出现多次（最多 3 条），
 * 对应「被逼急了连发语音」；`voiceText` 保留第一条兼容旧调用点。
 */
export function extractMediaIntent(text) {
  const raw = typeof text === 'string' ? text : '';
  let rest = raw;
  let stickerQuery = null;
  const voiceTexts = [];
  // matchAll 内部克隆正则，不会打乱后面 replace 的状态。
  for (const match of rest.matchAll(VOICE_TAG_PATTERN)) {
    const value = match[1].trim();
    if (value && voiceTexts.length < MAX_VOICE_MESSAGES) voiceTexts.push(value);
  }
  rest = rest.replace(VOICE_TAG_PATTERN, '');
  const stickerMatch = STICKER_TAG_PATTERN.exec(rest);
  if (stickerMatch) {
    stickerQuery = stickerMatch[1].trim();
    rest = rest.slice(0, stickerMatch.index) + rest.slice(stickerMatch.index + stickerMatch[0].length);
  }
  // AI 识图后给自动收藏的表情补标签（最多 2 个词）。
  const stickerTags = [];
  for (const match of rest.matchAll(STICKER_TAG_ACTION)) {
    for (const token of match[1].split(/[,，、\s|/]+/u)) {
      const tag = token.trim();
      if (tag && !stickerTags.includes(tag) && stickerTags.length < 2) stickerTags.push(tag);
    }
  }
  rest = rest.replace(STICKER_TAG_ACTION, '');
  // AI 认为这张表情不符合自己的人设：拒收（删掉自动收藏）。
  const stickerReject = STICKER_REJECT_TEST.test(rest);
  rest = rest.replace(STICKER_REJECT_TAG, '');
  // 本地补丁：长期记忆标签（只做存储，不显示给用户）。
  const memoryNotes = [];
  for (const match of rest.matchAll(MEMORY_TAG_ACTION)) {
    const note = match[1].trim();
    if (note && memoryNotes.length < MAX_MEMORY_NOTES) memoryNotes.push(note);
  }
  rest = rest.replace(MEMORY_TAG_ACTION, '');
  // 本地补丁：口头禅语气标签（短语|语气），由每日摘要模型判断后写入习惯记忆。
  const habitTones = [];
  for (const match of rest.matchAll(HABIT_TONE_TAG)) {
    const note = match[1].trim();
    if (note && habitTones.length < MAX_HABIT_TONES) habitTones.push(note);
  }
  rest = rest.replace(HABIT_TONE_TAG, '');
  const hadSilentTag = SILENT_TAG_TEST.test(rest);
  rest = rest.replace(SILENT_TAG_PATTERN, '');
  const trimmed = rest.replace(/\n{3,}/gu, '\n\n').trim();
  // 有语音/表情/表情动作要处理时不算「静默」；只剩记忆标签/空白也算静默。
  const hasMedia = voiceTexts.length > 0 || stickerQuery !== null || stickerTags.length > 0 || stickerReject;
  const silent = !hasMedia && (trimmed === '' || SILENT_TEXT_PATTERN.test(trimmed));
  return {
    text: silent ? '' : trimmed,
    voiceText: voiceTexts[0] ?? null,
    voiceTexts,
    stickerQuery,
    stickerTags,
    stickerReject,
    memoryNotes,
    habitTones,
    silent,
  };
}

/** `/sticker [query]` -> sticker request, else null. */
function parseStickerCommand(text) {
  const raw = typeof text === 'string' ? text : '';
  const match = /^\/(?:sticker|表情)(?:\s+([\s\S]*))?$/iu.exec(raw.trim());
  if (!match) return null;
  return { query: (match[1] ?? '').trim() };
}

/** `/effort [id]` -> requested group reasoning ceiling, else null. */
function parseEffortCommand(text) {
  const raw = typeof text === 'string' ? text : '';
  const match = /^\/(?:effort|reasoning|推理)\b\s*([\s\S]*)$/iu.exec(raw.trim());
  if (!match) return null;
  return { value: (match[1] ?? '').trim().toLowerCase() };
}

/** `/voice ...` -> structured request, or null when this is not a voice command. */
function parseVoiceCommand(text) {
  const raw = typeof text === 'string' ? text : '';
  const match = /^\/(?:voice|语音)(?:\s+([\s\S]*))?$/iu.exec(raw.trim());
  if (!match) return null;
  const rest = (match[1] ?? '').trim();
  if (!rest) return { kind: 'help' };
  const [first, ...others] = rest.split(/\s+/u);
  const argument = others.join(' ').trim();
  switch (first.toLowerCase()) {
    case 'list': return { kind: 'list' };
    case 'set': return { kind: 'set', value: argument };
    case 'char': return { kind: 'char', value: argument };
    case 'gpu': return { kind: 'set', value: 'gpu' };
    case 'speed': return { kind: 'speed', value: argument };
    case 'pitch': return { kind: 'pitch', value: argument };
    case 'rate': return { kind: 'rate', value: argument };
    case 'reset': return { kind: 'reset' };
    case 'test': return { kind: 'speak', text: argument || '你好呀，我是 yuri，这个声音怎么样？' };
    default: return { kind: 'speak', text: rest };
  }
}

/** Human-readable summary of the persisted voice settings. */
async function voiceSettingsSummary(botId) {
  const settings = await readVoiceSettings({ botId });
  return `${settings.voice}（${settings.provider}）· speed ${settings.speed}`
    + ` · pitch ${settings.pitch >= 0 ? '+' : ''}${settings.pitch}%`
    + ` · rate ${settings.rate >= 0 ? '+' : ''}${settings.rate}%`;
}

/** Voice is a device/app action: only the configured owner may trigger it. */
function isOwnerSender(message, ownerUserOpenid) {
  const sender = nonEmptyString(message?.senderId);
  if (!sender) return false;
  if (ownerUserOpenid === '*') return true;
  return Boolean(ownerUserOpenid) && sender === ownerUserOpenid;
}

function safeText(message) {
  return typeof message?.content === 'string' ? message.content.trim() : '';
}

// The bot answers to its own name in groups even without an @ mention.
// Defaults keep yuri's behavior; a per-bot profile
// (integrations/dsh-im/bots/<botId>/bot.json) overrides it with that bot's
// name + aliases, so a second bot does not wake up on yuri's names.
const DEFAULT_NAME_MENTION_PATTERN = /(?:^|[^a-z0-9_])yuri(?:$|[^a-z0-9_])|小鲸鱼|deepseek|大肥鱼/iu;

/** Wake-name matcher: ASCII names need word edges, CJK names match as substrings. */
export function nameMentionPatternForNames(names) {
  const list = Array.isArray(names)
    ? names.filter((name) => typeof name === 'string' && name.trim())
    : [];
  if (!list.length) return null;
  const parts = list.map((raw) => {
    const name = raw.trim();
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    return /^[A-Za-z0-9_]+$/u.test(name)
      ? `(?:^|[^A-Za-z0-9_])${escaped}(?:$|[^A-Za-z0-9_])`
      : escaped;
  });
  try {
    return new RegExp(parts.join('|'), 'iu');
  } catch {
    return null;
  }
}

function isNameMentioned(message, pattern = DEFAULT_NAME_MENTION_PATTERN) {
  if (!pattern) return false;
  const text = `${message?.content ?? ''}\n${message?.raw?.content ?? ''}`;
  return pattern.test(text);
}

/**
 * 本地补丁（2026-10-24）：QQ 群的 @ 在消息里用「群成员 openid」标记，平台不一定给
 * `mentions[].is_you`，所以退一步拿 mention 的昵称/群名片对上机器人自己的名字/别名。
 * @returns {boolean}
 */
export function mentionsBotByName(message, names) {
  const wanted = new Set((Array.isArray(names) ? names : [])
    .filter((name) => typeof name === 'string')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean));
  if (wanted.size === 0) return false;
  const mentions = Array.isArray(message?.mentions) ? message.mentions : [];
  return mentions.some((mention) => [mention?.nickname, mention?.username, mention?.name, mention?.card]
    .some((value) => typeof value === 'string' && wanted.has(value.trim().toLowerCase())));
}

/** A group/private message the bot should actually answer. */
function isReplyTriggered(message, pattern = DEFAULT_NAME_MENTION_PATTERN) {
  return isQqMessageAddressed(message) || isNameMentioned(message, pattern);
}

// 本地补丁（2026-10-24）：群里在聊「提示词/人设」而不是在跟机器人说话时，不接话。
const PROMPT_TALK_PATTERN = /(?:提示词|提示词里|系统提示|人设卡|人设设定|她的人设|你的人设|system\s*prompt|prompt\s*里)/iu;

// 收尾/结束语：接话窗口里看到这些，回最后一句就准备退出窗口。
const CLOSING_PATTERN = /^(?:那|好|行|我)?\s*(?:晚安|晚安啦|睡了|去睡了|先睡了|不聊了|先这样|下了|我下了|撤了|先撤了|拜拜|白白|88|回头聊|溜了|滚去睡)/u;
const WHY_COMMAND_PATTERN = /^\/(?:why|为什么)(?:\s+(\d{1,2}))?$/iu;

/**
 * 本地补丁（2026-10-24）：模型内容可能是 string，也可能是 [{type:'text',...}] 结构化数组，
 * 追加系统提示时必须分别处理，否则数组会被模板字符串拼成 "[object Object]".
 */
export function appendPromptPart(content, part) {
  if (Array.isArray(content)) return [...content, { type: 'text', text: part }];
  if (typeof content === 'string') return `${content}${part}`;
  return content;
}

/**
 * 是否收尾语（导出便于测试）。
 */
export function isClosingMessage(text) {
  return CLOSING_PATTERN.test(String(text ?? '').trim());
}

/**
 * 本地补丁（2026-10-24）：把最近群聊压成上下文块；机器人自己的话显示为「你」，
 * 其他机器人标「(机器人)」。导出纯函数便于测试。
 */
/**
 * 本地补丁（2026-10-24）：把最近群聊压成上下文块；机器人自己的话显示为「你」，
 * 其他机器人标「(机器人)」。当前这条用「▶」标出，并**同时带上它之后已经到达的消息**
 * （连发/排队时，回复要考虑后续几句）。导出纯函数便于测试。
 */
export function formatChatDigest(entries, {
  now = Date.now(), minutes = 15, limit = 25, maxChars = 40, excludeMessageId = null,
  current = null, limitBefore = 25, limitAfter = 4,
} = {}) {
  const windowMs = Math.max(1, Number(minutes) || 15) * 60_000;
  const width = Math.max(8, Number(maxChars) || 40);
  const maxBefore = Math.max(1, Number(limitBefore) || 25);
  const maxAfter = Math.max(1, Number(limitAfter) || 4);
  const all = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && (excludeMessageId === null || entry.messageId !== excludeMessageId))
    .filter((entry) => now - (Number(entry.at) || 0) <= windowMs);
  const lineOf = (entry) => {
    if (entry.isSelf === true) {
      return `你: ${String(entry.text ?? '').replace(/\s+/gu, ' ').slice(0, width)}`;
    }
    const base = entry.senderName || entry.senderId || '某人';
    const name = entry.senderIsBot === true ? `${base}(机器人)` : base;
    return `${name}: ${String(entry.text ?? '').replace(/\s+/gu, ' ').slice(0, width)}`;
  };
  // 找到当前这条在列表里的位置（找不到就用 current.at 切分）。
  const currentId = current?.messageId ?? null;
  const currentAt = Number(current?.at) || 0;
  let splitIndex = currentId ? all.findIndex((entry) => entry.messageId === currentId) : -1;
  if (splitIndex < 0) {
    if (currentAt > 0) {
      splitIndex = all.findIndex((entry) => (Number(entry.at) || 0) > currentAt);
      if (splitIndex < 0) splitIndex = all.length;
    } else {
      // 合并消息（#coalesced）不在缓存里：把它当作最新一条，历史都在它之前。
      splitIndex = all.length;
    }
  }
  const before = all.slice(0, splitIndex).slice(-maxBefore);
  const after = all.slice(splitIndex + (currentId ? 1 : 0)).slice(0, maxAfter);
  const currentLine = current
    ? `▶ ${lineOf({ ...current, isSelf: current.isSelf === true })}`
    : null;
  const lines = [...before.map(lineOf), ...(currentLine ? [currentLine] : []), ...after.map(lineOf)];
  if (lines.length < 2) return '';
  return `【最近群聊（按时间顺序，▶ 是当前正在回复的这条）】\n${lines.join('\n')}`;
}

/** 当前是否在免打扰时段（导出便于测试）；支持跨午夜。 */
export function inQuietHours(now, hours) {
  const start = Number(hours?.start);
  const end = Number(hours?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return false;
  const hour = new Date(now).getHours();
  return start < end ? (hour >= start && hour < end) : (hour >= start || hour < end);
}

/**
 * 本地补丁（2026-10-24）：把同一人连发的几条消息合成一条 prompt，
 * 避免「机器人抢答第一句、再答第二句」。
 * @param {Array<{message: object, messageId: string}>} entries
 * @returns {object|null} 合并后的消息（messageId 带 #coalesced 标记）
 */
export function mergeCoalescedMessages(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const messages = entries.map((entry) => entry?.message).filter(Boolean);
  if (messages.length === 0) return null;
  const last = messages[messages.length - 1];
  const texts = [];
  for (const message of messages) {
    const text = typeof message?.content === 'string' ? message.content.trim() : '';
    if (text) texts.push(text);
  }
  const attachments = [];
  for (const message of messages) {
    if (Array.isArray(message?.attachments)) attachments.push(...message.attachments);
  }
  const mentions = [];
  for (const message of messages) {
    if (Array.isArray(message?.mentions)) mentions.push(...message.mentions);
  }
  return {
    ...last,
    messageId: `${last.messageId ?? 'coalesced'}#coalesced${messages.length}`,
    content: texts.join('\n'),
    attachments,
    mentions,
  };
}

/** 归一化一行聊天文字，用于复读接龙比较（去 @、空白、标点、大小写）。 */
export function normalizeRepeatText(text) {
  return String(text ?? '')
    .replace(/<@!?[^<>\s]+>/gu, '')
    .replace(/[\s，。！？!?、,.…~～"“”'‘’（）()【】[\]{}]+/gu, '')
    .trim()
    .toLowerCase();
}

/**
 * 本地补丁：这条引用是不是在引用机器人自己说过的话（用来识别「有人回复机器人」）。
 * @returns {boolean}
 */
export function matchesOwnText(quotedContent, ownTexts) {
  const quoted = normalizeRepeatText(quotedContent);
  if (!quoted) return false;
  return (Array.isArray(ownTexts) ? ownTexts : []).some((own) => {
    const text = normalizeRepeatText(own);
    if (!text) return false;
    return text === quoted || text.includes(quoted) || quoted.includes(text);
  });
}

/**
 * 本地补丁（2026-10-24）：复读接龙检测。
 * @param {Array<{senderId?: string, senderIsBot?: boolean, text?: string, at?: number}>} history
 * @returns {boolean} 当前这条是否属于「多人在复读同一句」
 */
export function isRepeatChain(history, {
  text, senderId, now = Date.now(), windowMinutes = 5, minSenders = 2,
} = {}) {
  const current = normalizeRepeatText(text);
  if (!current) return false;
  const windowMs = Math.max(1, Number(windowMinutes) || 5) * 60_000;
  const senders = new Set();
  for (const entry of Array.isArray(history) ? history : []) {
    if (!entry || entry.senderIsBot === true) continue;
    if (now - (Number(entry.at) || 0) > windowMs) continue;
    if (!entry.senderId || entry.senderId === senderId) continue;
    if (normalizeRepeatText(entry.text) !== current) continue;
    senders.add(entry.senderId);
  }
  return senders.size >= Math.max(1, Number(minSenders) || 2);
}

function attachmentMediaType(attachment) {
  const value = nonEmptyString(attachment?.content_type ?? attachment?.contentType);
  if (!value) return null;
  return value.split(';', 1)[0].trim().toLowerCase();
}

function isQqImageAttachment(attachment) {
  const mediaType = attachmentMediaType(attachment);
  return mediaType?.startsWith('image/') === true
    || QQ_IMAGE_FILENAME.test(nonEmptyString(attachment?.filename) ?? '');
}

function hasQqImageAttachments(message) {
  return Array.isArray(message?.attachments)
    && message.attachments.some(isQqImageAttachment);
}

function hasQqFileAttachments(message) {
  return Array.isArray(message?.attachments)
    && message.attachments.some((attachment) => !isQqImageAttachment(attachment));
}

function qqAttachmentKind(attachment) {
  const mediaType = attachmentMediaType(attachment);
  if (mediaType?.startsWith('image/')) return 'image';
  if (mediaType?.startsWith('audio/')) return 'audio';
  if (mediaType?.startsWith('video/')) return 'video';
  return 'file';
}

function qqReplyReference(message) {
  const refMsgIdx = nonEmptyString(message?.refMsgIdx);
  if (!refMsgIdx) return null;
  const element = Array.isArray(message?.msgElements) ? message.msgElements[0] : null;
  const sourceAttachments = Array.isArray(element?.attachments) ? element.attachments : [];
  const attachments = sourceAttachments.map((attachment) => {
    const name = nonEmptyString(attachment?.filename);
    return { kind: qqAttachmentKind(attachment), ...(name ? { name } : {}) };
  });
  const asrText = sourceAttachments
    .filter((attachment) => qqAttachmentKind(attachment) === 'audio')
    .map((attachment) => nonEmptyString(attachment?.asr_refer_text))
    .filter(Boolean)
    .join('\n');
  const content = asrText || nonEmptyString(element?.content);
  return {
    messageId: refMsgIdx,
    ...(content ? { content } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(!content && attachments.length === 0 ? { unavailableReason: 'not-delivered' } : {}),
  };
}

async function fetchQqFileBuffer(url, { fetchImpl, signal }) {
  const normalizedUrl = url.startsWith('//') ? `https:${url}` : url;
  const response = await fetchImpl(new URL(normalizedUrl), {
    method: 'GET',
    signal,
    redirect: 'follow',
  });
  if (!response?.ok) {
    await response?.body?.cancel?.().catch?.(() => undefined);
    throw new Error(`QQ file download failed with HTTP ${response?.status ?? 'unknown'}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/** Convert QQ's attachment metadata into lazily downloaded image references. */
export function qqInboundMessage(message, { fetchImpl = fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  const images = [];
  const files = [];
  const voiceNotes = [];
  for (const attachment of message?.attachments ?? []) {
    const url = nonEmptyString(attachment?.url);
    const name = nonEmptyString(attachment?.filename) ?? undefined;
    const mediaType = attachmentMediaType(attachment);
    const declaredSize = Number(attachment?.size);
    // 本地补丁（2026-10-24）：语音消息用 QQ 自带的 asr_refer_text 转成文字，
    // 不再把 .amr/.silk 当普通文件塞给模型（模型没法播放，只会回“放不了”）。
    if (qqAttachmentKind(attachment) === 'audio') {
      const transcript = nonEmptyString(attachment?.asr_refer_text);
      voiceNotes.push(transcript ? `[语音] ${transcript}` : '[语音消息（没有可用的转写文字）]');
      continue;
    }
    if (isQqImageAttachment(attachment)) {
      images.push({
        ...(name ? { name } : {}),
        ...(mediaType?.startsWith('image/') ? { mediaType } : {}),
        ...(Number.isFinite(declaredSize) && declaredSize >= 0 ? { size: declaredSize } : {}),
        load: ({ signal, maxBytes }) => {
          if (!url) throw new Error('QQ image attachment has no download URL');
          return fetchImageBuffer(url, {
            fetchImpl,
            signal,
            maxBytes,
            allowedHosts: QQ_IMAGE_HOSTS,
          });
        },
      });
      continue;
    }
    files.push({
      name: name ?? (files.length === 0 ? 'file' : `file-${files.length + 1}`),
      ...(mediaType?.includes('/') ? { mediaType } : {}),
      ...(Number.isFinite(declaredSize) && declaredSize >= 0 ? { size: declaredSize } : {}),
      load: ({ signal } = {}) => {
        if (!url) throw new Error('QQ file attachment has no download URL');
        return fetchQqFileBuffer(url, { fetchImpl, signal });
      },
    });
  }
  const replyTo = qqReplyReference(message);
  const baseText = safeText(message);
  const content = [baseText, ...voiceNotes].filter(Boolean).join('\n');
  return {
    content,
    images,
    files,
    ...(replyTo ? { replyTo } : {}),
  };
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function artifactFailureText(fileName, error) {
  const name = String(fileName ?? t('结果文件')).replace(/[\r\n]+/g, ' ').trim() || t('结果文件');
  if (error?.name === 'UploadDailyLimitExceededError') {
    return t('结果文件「{name}」已生成，但 QQ 今日文件上传额度已用完，请稍后重试。', { name });
  }
  switch (error?.code) {
    case 'artifact-delivery-uncertain':
      return t('结果文件「{name}」的发送结果未能确认，请先检查聊天内是否已收到，不要立即重试。', { name });
    case 'artifact-permission-required':
      return t('结果文件「{name}」已生成，但当前 QQ 机器人没有文件消息权限。', { name });
    case 'artifact-too-large':
      return t('结果文件「{name}」超过当前 QQ 机器人可发送的文件大小，未发送。', { name });
    case 'artifact-empty':
      return t('结果文件「{name}」为空，QQ 不允许发送空文件。', { name });
    case 'artifact-changed':
    case 'artifact-invalid':
    case 'artifact-unavailable':
      return t('结果文件「{name}」暂时无法读取或准备发送，请确认文件仍可访问后重试。', { name });
    case 'artifact-rate-limited':
      return t('结果文件「{name}」暂时被 QQ 限流，未能发送，请稍后重试。', { name });
    case 'artifact-provider-rejected':
      return t('结果文件「{name}」已生成，但 QQ 拒绝了该文件或文件消息。', { name });
    default:
      return t('结果文件「{name}」已生成，但暂时未能通过 QQ 发送，请稍后重试。', { name });
  }
}

function answerTextForDelivery(answer, artifacts) {
  if (typeof answer === 'string' && answer.trim()) return answer;
  return artifacts.length > 0 ? t('结果文件已生成。') : answer;
}

function qqArtifactError(error, { dispatched = false } = {}) {
  if (error?.code?.startsWith?.('artifact-')) {
    return error;
  }
  if (error?.name === 'UploadDailyLimitExceededError') {
    const wrapped = new Error('QQ daily file upload limit exceeded', { cause: error });
    wrapped.name = error.name;
    wrapped.code = 'artifact-rate-limited';
    return wrapped;
  }
  const status = Number(error?.httpStatus);
  const wrapped = new Error('QQ file delivery failed', { cause: error });
  if (status === 401 || status === 403) wrapped.code = 'artifact-permission-required';
  else if (status === 413) wrapped.code = 'artifact-too-large';
  else if (status === 429) wrapped.code = 'artifact-rate-limited';
  else if ([400, 404, 405, 406, 410, 415, 422].includes(status)) {
    wrapped.code = 'artifact-provider-rejected';
  } else {
    wrapped.code = dispatched ? 'artifact-delivery-uncertain' : 'artifact-provider-failed';
  }
  return wrapped;
}

function abortReason(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted', 'AbortError');
}

function waitWithSignal(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
    if (signal.aborted) onAbort();
  });
}

/** Send one materialized artifact through QQ's native image message. */
export async function sendQqImage(
  bot,
  target,
  file,
  { signal, timeoutMs = DEFAULT_FILE_UPLOAD_TIMEOUT_MS } = {},
) {
  signal?.throwIfAborted();
  if (typeof bot?.sendImage !== 'function') {
    const unavailable = new Error('QQ image delivery is unavailable');
    unavailable.code = 'artifact-provider-unavailable';
    throw unavailable;
  }

  try {
    const timeout = AbortSignal.timeout(timeoutMs);
    const waitSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const pending = bot.sendImage(
      target,
      { buffer: file.bytes },
      { onProgress: () => signal?.throwIfAborted() },
    );
    trackOutboundArtifactProviderPromise(file, pending);
    return await waitWithSignal(pending, waitSignal);
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal);
    throw qqArtifactError(error, { dispatched: true });
  }
}

function isWavArtifact(file) {
  const type = String(file?.mediaType ?? '').toLowerCase();
  if (type === 'audio/wav' || type === 'audio/x-wav' || type === 'audio/wave') return true;
  return /\.wav$/iu.test(String(file?.fileName ?? ''));
}

function isSilkArtifact(file) {
  const type = String(file?.mediaType ?? '').toLowerCase();
  if (type === 'audio/silk' || type === 'audio/x-silk') return true;
  return /\.silk$/iu.test(String(file?.fileName ?? ''));
}

/** Send one materialized artifact through QQ's native voice message. */
export async function sendQqVoice(
  bot,
  target,
  file,
  { signal, timeoutMs = DEFAULT_FILE_UPLOAD_TIMEOUT_MS } = {},
) {
  signal?.throwIfAborted();
  if (typeof bot?.sendVoice !== 'function') {
    const unavailable = new Error('QQ voice delivery is unavailable');
    unavailable.code = 'artifact-provider-unavailable';
    throw unavailable;
  }

  try {
    const timeout = AbortSignal.timeout(timeoutMs);
    const waitSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const pending = bot.sendVoice(
      target,
      { buffer: file.bytes },
      { onProgress: () => signal?.throwIfAborted() },
    );
    trackOutboundArtifactProviderPromise(file, pending);
    return await waitWithSignal(pending, waitSignal);
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal);
    throw qqArtifactError(error, { dispatched: true });
  }
}

/**
 * Deliver an audio artifact as a real QQ voice message. WAV is encoded to SILK
 * on the fly; anything else falls back to the ordinary file message so a
 * missing encoder never loses the user's file.
 */
async function sendQqVoiceArtifact(bot, target, file, options = {}) {
  if (isSilkArtifact(file)) return sendQqVoice(bot, target, file, options);
  if (!isWavArtifact(file)) {
    throw new VoiceError(
      'voice-format-unsupported',
      `Audio artifact ${String(file?.fileName ?? 'audio')} is neither WAV nor SILK`,
      '这个音频格式转不了 QQ 语音，已按文件发送。',
    );
  }
  const { silk } = await encodeWavToSilk(file.bytes);
  return sendQqVoice(bot, target, {
    ...file,
    bytes: silk,
    fileName: 'voice.silk',
    mediaType: 'audio/silk',
  }, options);
}

async function sendQqFile(
  bot,
  target,
  file,
  { signal, timeoutMs = DEFAULT_FILE_UPLOAD_TIMEOUT_MS } = {},
) {
  signal?.throwIfAborted();
  if (typeof bot?.sendFile !== 'function') {
    const unavailable = new Error('QQ file delivery is unavailable');
    unavailable.code = 'artifact-provider-unavailable';
    throw unavailable;
  }

  try {
    const timeout = AbortSignal.timeout(timeoutMs);
    const waitSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const pending = bot.sendFile(
      target,
      { buffer: file.bytes },
      {
        fileName: file.fileName,
        onProgress: () => signal?.throwIfAborted(),
      },
    );
    trackOutboundArtifactProviderPromise(file, pending);
    return await waitWithSignal(pending, waitSignal);
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal);
    throw qqArtifactError(error, { dispatched: true });
  }
}

function canClaimInteractionReply(message, pending) {
  return pending.questions[pending.index]
    && nonEmptyString(message?.senderId) === pending.actor
    && isQqMessageAddressed(message)
    && !hasQqImageAttachments(message)
    && !hasQqFileAttachments(message)
    && nonEmptyString(safeText(message));
}

export function createQqBridgeStatus() {
  return {
    messagesReceived: 0,
    messagesReplied: 0,
    messagesRejected: 0,
    artifactsSent: 0,
    artifactSendErrors: 0,
    lastMessageAt: null,
    lastReplyAt: null,
    lastRejectedAt: null,
    lastError: null,
    lastMessageError: null,
  };
}

export class QqHarnessBridge {
  #bot;
  #botId;
  // Wake names for this bot: its own profile's name + aliases, else yuri's defaults.
  #nameMentionPattern = DEFAULT_NAME_MENTION_PATTERN;
  // 本地补丁：机器人自己的名字/别名（用于识别 QQ 群 @ 里的 mention 昵称）。
  #selfNames = Object.freeze([]);
  // 本地补丁：每个会话只记一次「认不出的 @」诊断日志。
  #mentionDebugKeys = new Set();
  #ownerUserOpenid;
  #harness;
  #state;
  #deferred;
  #contextEnhancement;
  #groupHistory;
  #accessPolicy;
  #status;
  #logger;
  #replyTimeoutMs;
  #signal;
  #fetchImpl;
  #fileUploadTimeoutMs;
  #queues = new Map();
  // Crash-recovery for #queues, started with the bridge; see recoverPendingMessages().
  #pendingRecovery = null;
  #busyMessages = new BusyMessageDispatcher();
  #pendingInteractions = new Map();
  #interactionKeys = new Map();
  // Keep the accepted configuration through the existing queue/reply lifecycle.
  #acceptedMessageIds = new Map();
  #approvalTasks = new Set();
  #commandTasks = new Set();
  #approvals;
  #batchInputs = new BatchInputManager();
  #menus = new QqMenuStore();
  #menuTasks = new Map();
  // Conversation engagement: after a group message addresses the bot (mention,
  // @, or its name), that sender keeps getting answered for a while, so a
  // normal back-and-forth does not need the name repeated every line.
  #engaged = new Map();
  // Who spoke last in each conversation; stops interjecting once the
  // conversation has moved on to someone else.
  #lastSpeaker = new Map();
  // Bot-to-bot replies: throttled per conversation to avoid loops.
  #botReplies = new Map();
  // 本地补丁：每个会话最近自动收藏的表情（给 AI 识图后打标签/拒收用）。
  #recentStickers = new Map();
  // 本地补丁：watch 模式（没人叫也先看一眼）的限速记录。
  #watchHistory = new Map();
  // 本地补丁：每个会话最近 30 分钟的聊天（活跃度 + 复读接龙判断）。
  #recentChat = new Map();
  // 本地补丁：复读接龙回复冷却（每个会话）。
  #repeatReplies = new Map();
  // 本地补丁：机器人自己在每个会话里最近发的文字（用于识别「有人引用/回复我」）。
  #botTexts = new Map();
  // 本地补丁：接话窗口里「连续无关」计数（模型沉默几次后退出窗口）。
  #engagementMisses = new Map();
  // 本地补丁：本轮是否由「接话窗口」续聊触发（用于追加轻量判断提示）。
  #engagedTurnIds = new Set();
  // 本地补丁：本轮是否由明确点名触发（用于区分「点名」与「接话窗口」提示）。
  #explicitTurnIds = new Set();
  // 本地补丁：同一人连发多条时的合并缓冲（每会话一个）。
  #coalescePending = new Map();
  // Non-owner spam guard: per (conversation, sender) recent lines.
  #spamHistory = new Map();

  constructor({
    bot,
    botId,
    ownerUserOpenid,
    harness,
    state,
    contextEnhancement,
    groupHistory,
    accessPolicy,
    status = createQqBridgeStatus(),
    logger = console,
    replyTimeoutMs = 600_000,
    signal,
    fetchImpl = fetch,
    fileUploadTimeoutMs = DEFAULT_FILE_UPLOAD_TIMEOUT_MS,
  }) {
    if (!bot || typeof bot.sendText !== 'function') throw new TypeError('QQ bot client is required');
    if (!ownerUserOpenid) throw new TypeError('QQ scanner identity is required');
    if (!harness || !state) throw new TypeError('Harness client and state store are required');
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
    if (!Number.isInteger(fileUploadTimeoutMs) || fileUploadTimeoutMs < 1) {
      throw new TypeError('fileUploadTimeoutMs must be a positive integer');
    }
    this.#bot = bot;
    // Per-bot persona / wake words / voice live under integrations/dsh-im/bots/<botId>/.
    // Without a botId the bridge keeps the legacy global persona + voice.json.
    this.#botId = typeof botId === 'string' && /^[A-Za-z0-9_-]{1,80}$/u.test(botId.trim())
      ? botId.trim() : '';
    const profile = readBotProfile(this.#botId);
    // A bot with an id but without a profile must NOT inherit yuri's names
    // (two bots answering "yuri" would be wrong); it only answers to @ then.
    this.#nameMentionPattern = this.#botId
      ? nameMentionPatternForNames(profile ? [profile.name, ...profile.aliases] : [])
      : DEFAULT_NAME_MENTION_PATTERN;
    this.#selfNames = Object.freeze(this.#botId
      ? [profile?.name, ...(Array.isArray(profile?.aliases) ? profile.aliases : [])].filter(Boolean)
      : ['yuri', '小鲸鱼', 'DeepSeek', '大肥鱼']);
    this.#ownerUserOpenid = ownerUserOpenid;
    this.#harness = harness;
    this.#state = state;
    this.#contextEnhancement = contextEnhancement;
    this.#groupHistory = groupHistory;
    this.#accessPolicy = accessPolicy;
    this.#status = status;
    this.#logger = logger;
    this.#replyTimeoutMs = replyTimeoutMs;
    this.#signal = signal;
    this.#deferred = createDeferredDeliveryCoordinator({ harness, state, signal, logger,
      finalAnswerOnly: true,
      deliver: (entry, outcome) => this.#deliverDeferredOutcome(entry, outcome),
    });
    this.#fetchImpl = fetchImpl;
    this.#fileUploadTimeoutMs = Math.min(fileUploadTimeoutMs, DEFAULT_FILE_UPLOAD_TIMEOUT_MS);
    this.#approvals = new HarnessApprovalQueue({ label: 'qq', logger });
    this.#warmVoiceSidecar();
    // A queued message lives only in #queues. If the process dies before its
    // turn runs the user has already been told it is queued, so the persisted
    // entry must be replayed or reported as soon as the bridge starts.
    this.recoverPendingMessages();
  }

  get status() {
    return structuredClone(this.#status);
  }

  accept(message) {
    if (!this.#groupHistory || message?.kind !== 'group') return this.#accept(message);
    const normalized = { ...qqInboundMessage(message, { fetchImpl: this.#fetchImpl }), kind: 'group',
      senderId: message.senderId, senderIsBot: message.senderIsBot, addressed: isQqMessageAddressed(message) };
    return captureGroupHistory(this.#groupHistory, normalized, {
      channel: 'qq', scope: `app:${this.#bot.appId}`, groupId: message.groupOpenid,
      messageId: message.messageId, sentAt: message.timestamp, senderName: message.senderName,
      text: message.raw?.content ?? message.content ?? '',
      type: message.attachments?.length ? 'file' : 'text',
      capability: '仅保存实际投递的消息；未 @ 能力及跨应用群身份尚需验证，当前按应用来源隔离。',
    }, { logger: this.#logger })
      .then(() => { message.groupHistory = normalized.groupHistory; return this.#accept(message); });
  }

  /** Per-sender engagement map for one conversation (several people may call us). */
  #engagementMap(key) {
    let map = this.#engaged.get(key);
    if (!map) {
      map = new Map();
      this.#engaged.set(key, map);
    }
    return map;
  }

  /** 接话窗口时长（显式点名 10 分钟 / watch 触发 5 分钟，配置可改）。 */
  #engagementTtlMs(kind = 'explicit') {
    const engagement = readBehaviorConfig().engagement;
    const minutes = kind === 'watch'
      ? Number(engagement?.watchMinutes)
      : Number(engagement?.explicitMinutes);
    const fallback = kind === 'watch' ? 5 : 10;
    return Math.max(60_000, (Number.isFinite(minutes) && minutes > 0 ? minutes : fallback) * 60_000);
  }

  /** Remember that a sender is talking to us; keeps at most 8 senders per chat. */
  #markEngaged(key, senderId, kind = 'explicit') {
    if (!senderId) return;
    const map = this.#engagementMap(key);
    map.delete(senderId);
    map.set(senderId, Date.now() + this.#engagementTtlMs(kind));
    this.#engagementMisses.delete(`${key}\u0000${senderId}`);
    while (map.size > 8) map.delete(map.keys().next().value);
  }

  /** 接话窗口里模型连续沉默达到上限 → 主动退出窗口（返回 true 表示已退出）。 */
  #noteEngagementMiss(key, senderId) {
    if (!senderId) return false;
    const mapKey = `${key}\u0000${senderId}`;
    const limit = Math.max(1, Number(readBehaviorConfig().engagement?.irrelevantMissLimit) || 2);
    const misses = (this.#engagementMisses.get(mapKey) ?? 0) + 1;
    if (misses >= limit) {
      this.#engagementMisses.delete(mapKey);
      this.#engageMapDelete(key, senderId);
      return true;
    }
    this.#engagementMisses.set(mapKey, misses);
    return false;
  }

  /** Warm the voice sidecar so the first voice reply is not a cold start. */
  #warmVoiceSidecar() {
    void readVoiceSettings({ botId: this.#botId }).then(async (settings) => {
      // Only keep the sidecar for the active provider resident in VRAM.
      if (settings.provider === 'gsv') {
        // Per-bot endpoints (e.g. a second voice on another port) stay stopped
        // until that voice is actually used in a chat, so an unused bot does
        // not hold VRAM after a restart.
        if (!settings.endpoint) await ensureGsv();
        await stopGpuTts();
      } else if (settings.provider === 'f5') {
        await ensureGpuTts();
        await stopGsv();
      }
    }).catch(() => undefined);
  }

  /** True when this message should be ignored as non-owner spam. */
  #shouldIgnoreSpam(message, key) {
    if (process.env.DSH_IM_SPAM_GUARD === '0') return false;
    if (message?.senderIsBot === true) return false;
    if (isOwnerSender(message, this.#ownerUserOpenid)) return false;
    const senderId = nonEmptyString(message?.senderId);
    if (!senderId) return false;
    const mapKey = `${key}\u0000${senderId}`;
    const text = normalizeSpamText(`${message?.content ?? ''}\n${message?.raw?.content ?? ''}`);
    const { ignore, history } = spamCheck(this.#spamHistory.get(mapKey), text);
    this.#spamHistory.set(mapKey, history);
    while (this.#spamHistory.size > 500) this.#spamHistory.delete(this.#spamHistory.keys().next().value);
    if (ignore) {
      this.#logger.info?.('[dsh-im:qq] ignoring repeated non-owner message', { senderId });
    }
    return ignore;
  }

  /** Should this message be answered? Several senders can be engaged at once. */
  #shouldReply(message, key) {
    const text = `${message?.content ?? ''}\n${message?.raw?.content ?? ''}`;
    const mentionedByName = mentionsBotByName(message, this.#selfNames);
    // 本地补丁（2026-10-24）：引用不再直接算点名——引用后的内容要由模型判断是不是在跟它说。
    const explicit = isQqMessageAddressed(message)
      || isNameMentioned(message, this.#nameMentionPattern)
      || mentionedByName;
    // 本地补丁：认不出的群 @（正文有 <@id> 但既非事件也不是自己）记一次诊断，
    // 方便下次从日志确认平台返回的 mentions / rawEventType 结构。
    if (!explicit && message?.kind === 'group' && /<@!?[^<>\s]+>/u.test(text)
      && !this.#mentionDebugKeys.has(key)) {
      this.#mentionDebugKeys.add(key);
      let rawMentions = message?.mentions;
      try { rawMentions = JSON.stringify(rawMentions); } catch { rawMentions = String(rawMentions); }
      this.#logger.warn?.(`[dsh-im:qq] unresolved group mention debug: rawEventType=${message?.rawEventType} mentions=${rawMentions} content=${JSON.stringify(text.slice(0, 120))}`);
    }
    const senderId = message?.senderId;
    const now = Date.now();
    // The owner calling someone an intimate nickname (宝宝/宝贝/亲爱的…) is a
    // deliberate provocation: every bot answers and gets jealous, even when the
    // message targets someone else.
    const ownerAffection = isOwnerAffectionText(text)
      && isOwnerSender(message, this.#ownerUserOpenid);
    if (ownerAffection) {
      this.#markEngaged(key, senderId);
      return true;
    }
    // Addressing someone else means the bot is no longer part of this thread.
    const mentions = Array.isArray(message?.mentions) ? message.mentions : [];
    const mentionsSelf = mentionedByName || mentions.some((mention) => mention?.is_you === true);
    const mentionsOther = mentions.some((mention) => mention?.is_you !== true);
    if (!explicit && mentionsOther && !mentionsSelf) {
      this.#engageMapDelete(key, senderId);
      return false;
    }
    // 不抢话：别人之间在「引用/回复」某条消息时，没有明确叫我们就不插嘴（主人除外）。
    if (!explicit && !isOwnerSender(message, this.#ownerUserOpenid) && qqReplyReference(message)) {
      this.#engageMapDelete(key, senderId);
      return false;
    }
    // Retraction wins: "I was not talking to you" clears the follow-up window.
    if (DISMISS_PATTERN.test(text)) {
      this.#engageMapDelete(key, senderId);
      return false;
    }
    if (explicit) {
      if (message?.messageId) this.#explicitTurnIds.add(message.messageId);
      if (message?.senderIsBot !== true) this.#markEngaged(key, senderId);
      return true;
    }
    if (!senderId) return false;
    const map = this.#engaged.get(key);
    const until = map?.get(senderId);
    if (!until) return false;
    if (now > until) {
      map.delete(senderId);
      this.#engagementMisses.delete(`${key}\u0000${senderId}`);
      return false;
    }
    // 免打扰时段：接话窗口内也不延长（只回点名/@）。
    const engagement = readBehaviorConfig().engagement;
    if (inQuietHours(now, engagement?.quietHours)) {
      map.delete(senderId);
      return false;
    }
    map.set(senderId, now + this.#engagementTtlMs('explicit'));
    this.#engagedTurnIds.add(message?.messageId);
    // 收尾语：允许回最后一句，然后 60 秒后自然退出窗口。
    if (isClosingMessage(text)) {
      map.set(senderId, now + 60_000);
      return true;
    }
    return true;
  }

  #engageMapDelete(key, senderId) {
    if (!senderId) return;
    this.#engaged.get(key)?.delete(senderId);
  }

  /** Engaged already, without touching the TTL. */
  #isEngaged(message, key) {
    const senderId = message?.senderId;
    if (!senderId) return false;
    const map = this.#engaged.get(key);
    const until = map?.get(senderId);
    if (!until) return false;
    if (Date.now() > until) {
      map.delete(senderId);
      return false;
    }
    return true;
  }

  /**
   * Throttle replies to other bots. Still bounded so two bots cannot ping-pong
   * forever, but loose enough to feel natural: at most one per 3 s and 20 per
   * 5 min (owner asked the sisters to actually answer each other).
   */
  #allowBotReply(message, key) {
    if (message?.senderIsBot !== true) return true;
    const { allowed, history } = botReplyAllowed(this.#botReplies.get(key));
    this.#botReplies.set(key, history);
    return allowed;
  }

  /**
   * Local patch (2026-10-24): copy small GIF/WebP/PNG images from incoming
   * messages into the sticker library (behavior.json → stickerCollect).
   * Runs beside the reply path and never blocks it.
   */
  async #collectInboundStickers(message) {
    const config = (await readBehaviorConfig()).stickerCollect;
    if (!config?.enabled) return;
    if (config.scope === 'group' && message.kind !== 'group') return;
    const conversationId = message.kind === 'group'
      ? nonEmptyString(message.groupOpenid)
      : nonEmptyString(message.senderId);
    if (!conversationId) return;
    if (Array.isArray(config.groups) && config.groups.length > 0
      && !config.groups.includes(conversationId)) return;
    const attachments = Array.isArray(message.attachments) ? message.attachments : [];
    if (attachments.length === 0) return;
    const extensions = Array.isArray(config.extensions) && config.extensions.length > 0
      ? new Set(config.extensions.map((extension) => String(extension).toLowerCase()))
      : undefined;
    for (const attachment of attachments) {
      if (!isQqImageAttachment(attachment)) continue;
      const name = nonEmptyString(attachment?.filename) ?? '';
      const mediaType = attachmentMediaType(attachment);
      const declaredSize = Number(attachment?.size);
      if (!isCollectableSticker({
        name,
        mediaType,
        size: Number.isFinite(declaredSize) ? declaredSize : null,
        ...(extensions ? { extensions } : {}),
      })) continue;
      const url = nonEmptyString(attachment?.url);
      if (!url) continue;
      if (!allowStickerCollection({
        perMinute: config.perMinute,
        perHour: config.perHour,
        perDay: config.perDay,
      })) return;
      const bytes = await fetchImageBuffer(url, {
        fetchImpl: fetch,
        signal: AbortSignal.timeout(8_000),
        maxBytes: config.maxBytes,
        allowedHosts: QQ_IMAGE_HOSTS,
      }).catch((error) => {
        this.#logger.warn?.('[dsh-im:qq] sticker download failed:', error?.message ?? error);
        return null;
      });
      if (!bytes) continue;
      // 本地补丁：按这条消息的文字猜情绪标签写进文件名，AI 之后按心情/场景挑图时能命中。
      const tags = config.autoTag === false
        ? []
        : inferStickerTags(safeText(message), { max: Number.isInteger(config.maxTags) ? config.maxTags : 2 });
      const result = await saveSticker({ bytes, name, tags, maxLibrary: config.maxLibrary });
      if (result.saved) {
        this.#logger.info?.(`[dsh-im:qq] sticker collected: ${result.path}`);
        const key = conversationKey(message);
        const list = this.#recentStickers.get(key) ?? [];
        list.push({ path: result.path, at: Date.now() });
        while (list.length > 5) list.shift();
        this.#recentStickers.set(key, list);
      }
    }
  }

  /**
   * Local patch (2026-10-24): AI 识图后的表情判决。
   * - stickerTags：给该会话最近收藏的一张补标签（换文件名，之后按心情能挑到）
   * - stickerReject：认为不符合人设 → 删掉这张自动收藏
   */
  async #applyStickerVerdict(key, { stickerTags = [], stickerReject = false } = {}) {
    const list = this.#recentStickers.get(key);
    if (!Array.isArray(list) || list.length === 0) return;
    const latest = list[list.length - 1];
    if (!latest || typeof latest.path !== 'string') return;
    if (stickerReject) {
      const result = await removeSticker({ path: latest.path });
      if (result.removed) {
        list.pop();
        this.#logger.info?.(`[dsh-im:qq] sticker rejected by model: ${latest.path}`);
      } else {
        this.#logger.warn?.(`[dsh-im:qq] sticker reject skipped (${result.reason})`);
      }
      return;
    }
    if (stickerTags.length === 0) return;
    const result = await tagSticker({ path: latest.path, tags: stickerTags });
    if (result.tagged) {
      latest.path = result.path;
      this.#logger.info?.(`[dsh-im:qq] sticker tagged by model: ${result.path}`);
    } else {
      this.#logger.warn?.(`[dsh-im:qq] sticker tag skipped (${result.reason})`);
    }
  }

  /**
   * 本地补丁（2026-10-24）：AI 主动冒泡——在该会话里让模型结合上下文主动说一句。
   * 返回 null 表示模型选择沉默（<dsh_im_silent/>）或生成失败。
   */
  /** 本地补丁：把机器人主动发出的话记进最近群聊（AI 冒泡等运行时代发场景用）。 */
  noteOwnMessage(key, text) {
    this.#rememberOwnChat(key, text);
  }

  async generateProactiveBubble(key, { quietMinutes = 15 } = {}) {
    // 预算用尽时不再主动冒泡（只保留点名/引用/复读回复）。
    const budget = readBehaviorConfig().budget;
    if (isBudgetExhausted(this.#botId, budget?.dailyLimitCny)) return null;
    const prompt = `【主动发言机会】这个会话已经安静了大约 ${quietMinutes} 分钟。你可以选择主动说一句话，也可以不说。要求：像平时一样短（1~2 句、≤40 字），结合你们之前的聊天自然开口；不要提“主动机会/系统提示/冒泡/我来看看”这类词，不要用模板句式；觉得没必要就只输出 <dsh_im_silent/>。`;
    try {
      const { answer } = await askInWorkspaceSession({
        harness: this.#harness,
        state: this.#state,
        key,
        text: prompt,
        sourceGuidance: applyPersona(undefined, { botId: this.#botId }),
        timeoutMs: this.#replyTimeoutMs,
        signal: this.#signal,
        askOptions: {
          timeoutMs: this.#replyTimeoutMs,
          signal: this.#signal,
          control: { owner: this, key },
          progressMode: 'final',
          finalAnswerOnly: true,
        },
      });
      const intent = extractMediaIntent(answer);
      chargeBudget(this.#botId, readBehaviorConfig().budget?.bubbleCny);
      return intent.silent ? null : (intent.text || null);
    } catch (error) {
      this.#logger.warn?.('[dsh-im:qq] proactive bubble generation failed:', error?.message ?? error);
      return null;
    }
  }

  /**
   * 本地补丁：watch 模式——没叫机器人时也把这条消息递给他看一眼，
   * 由 AI 自己决定接不接（不需要就在回复里只输出 <dsh_im_silent/>）。
   * 限速与开关都在 behavior.json → watch；默认关闭。
   */
  #watchDecision(message, key) {
    const behavior = readBehaviorConfig();
    const config = behavior.watch;
    const deny = (reason) => ({ allow: false, reason });
    if (!config?.enabled) return deny('watch-disabled');
    if (Array.isArray(config.botIds) && config.botIds.length > 0
      && !config.botIds.includes(this.#botId)) return deny('bot-not-watching');
    const budget = behavior.budget;
    if (isBudgetExhausted(this.#botId, budget?.dailyLimitCny)) return deny('budget-exhausted');
    if (inQuietHours(Date.now(), behavior.engagement?.quietHours)) return deny('quiet-hours');
    const text = safeText(message);
    const everyoneReview = config.everyone === true;
    const ownerMessage = isOwnerSender(message, this.#ownerUserOpenid);
    const fullReview = everyoneReview || ownerMessage;
    const hasImage = hasQqImageAttachments(message);
    const hasFile = hasQqFileAttachments(message);
    const quoteRef = Boolean(qqReplyReference(message));
    if (text.startsWith('/')) return deny('command');
    if (!text && !(fullReview && hasImage) && !quoteRef) return deny('empty');
    // 本地补丁（2026-10-24）：别人发的图片/文件不主动“看一眼”解释，除非
    // mediaReview=all（或主人发的、或引用回复）。别人没问就不要当解说员。
    const mediaReview = config.mediaReview ?? 'owner';
    if (!quoteRef && (hasImage || hasFile)) {
      if (mediaReview === 'none') return deny('media-review-off');
      if (mediaReview === 'owner' && !ownerMessage) return deny('media-not-asked');
    }
    const trimmed = text.trim();
    if (!fullReview && !quoteRef) {
      const minChars = Number(config.minChars);
      if (Number.isFinite(minChars) && minChars > 0 && trimmed.length < minChars) return deny('too-short');
      if (!/[\p{L}\p{N}]/u.test(trimmed)) return deny('non-text');
    }
    const mentions = Array.isArray(message?.mentions) ? message.mentions : [];
    if (mentions.length > 0
      && !mentions.some((mention) => mention?.is_you === true)
      && !mentionsBotByName(message, this.#selfNames)) return deny('mentions-someone-else');
    const topicMap = config.topics && typeof config.topics === 'object' ? config.topics : null;
    const topics = topicMap
      ? (Array.isArray(topicMap[this.#botId]) ? topicMap[this.#botId] : topicMap.all)
      : null;
    if (text && Array.isArray(topics) && topics.length > 0
      && !topics.some((word) => typeof word === 'string' && word && trimmed.includes(word))) return deny('topic-mismatch');
    if (!fullReview && !quoteRef && config.textOnly !== false
      && (hasImage || hasFile)) return deny('media-skipped');
    if (message.kind === 'c2c' && config.direct !== true) return deny('direct-disabled');
    if (message.kind === 'group') {
      const groups = Array.isArray(config.groups) ? config.groups : [];
      const groupId = nonEmptyString(message.groupOpenid);
      if (groups.length > 0 && (!groupId || !groups.includes(groupId))) return deny('group-filtered');
    }
    if (text && config.skipPromptTalk !== false && PROMPT_TALK_PATTERN.test(trimmed)) return deny('prompt-talk');
    const activityWindow = Number(config.activityWindowMinutes);
    const activityMin = Number(config.activityMinMessages);
    if (!fullReview && !quoteRef && Number.isFinite(activityWindow) && activityWindow > 0
      && Number.isFinite(activityMin) && activityMin > 0) {
      const nowForActivity = Date.now();
      const recentCount = (this.#recentChat.get(key) ?? [])
        .filter((entry) => nowForActivity - entry.at <= activityWindow * 60_000).length;
      if (recentCount < activityMin) return deny('inactive-group');
    }
    const now = Date.now();
    const state = this.#watchHistory.get(key) ?? { lastAtBySender: {}, hits: [] };
    if (!state.lastAtBySender || typeof state.lastAtBySender !== 'object') state.lastAtBySender = {};
    const senderId = nonEmptyString(message?.senderId) ?? 'unknown';
    // 引用消息、主人消息不按发送者冷却（否则同一个人 1 分钟内再发一句就被挡掉）。
    const bypassSenderCooldown = quoteRef || ownerMessage;
    if (!bypassSenderCooldown
      && now - (Number(state.lastAtBySender[senderId]) || 0) < (Number(config.minIntervalMs) || 0)) {
      return deny('sender-cooldown');
    }
    state.hits = (Array.isArray(state.hits) ? state.hits : []).filter((at) => now - at < 24 * 60 * 60 * 1000);
    const hourHits = state.hits.filter((at) => now - at < 60 * 60 * 1000);
    const hourLimit = Number(config.maxPerHour);
    if (Number.isFinite(hourLimit) && hourLimit > 0 && hourHits.length >= hourLimit) return deny('hour-cap');
    const dayLimit = Number(config.maxPerDay);
    if (Number.isFinite(dayLimit) && dayLimit > 0 && state.hits.length >= dayLimit) return deny('day-cap');
    state.lastAtBySender[senderId] = now;
    state.hits.push(now);
    this.#watchHistory.set(key, state);
    return { allow: true, reason: quoteRef ? 'quote-review' : 'watch' };
  }

  /** 本地补丁：记录每会话最近聊天（活跃度 + 复读检测 + 上下文摘要）。 */
  #rememberChat(message, key) {
    const text = safeText(message);
    if (!text) return;
    const now = Date.now();
    const list = this.#recentChat.get(key) ?? [];
    list.push({
      senderId: message?.senderId,
      senderName: message?.senderName || message?.senderId,
      senderIsBot: message?.senderIsBot === true,
      messageId: message?.messageId,
      text,
      at: now,
    });
    this.#recentChat.set(key, list.filter((entry) => now - entry.at <= 30 * 60 * 1000).slice(-40));
    // 本地补丁：习惯挖掘——统计每个人高频短语（零模型调用），够次数+跨天就晋升口头禅。
    const habitConfig = readBehaviorConfig().memory?.habits;
    if (habitConfig?.enabled !== false && message?.senderIsBot !== true) {
      try {
        recordHabitObservation(this.#botId, {
          conversationKey: key,
          sender: message?.senderName || message?.senderId || '',
          text,
          fromOwner: isOwnerSender(message, this.#ownerUserOpenid),
          now,
          config: habitConfig ?? {},
        });
      } catch (error) {
        this.#logger.warn?.('[dsh-im:qq] habit observation failed:', error?.message ?? error);
      }
    }
  }

  /**
   * 本地补丁（2026-10-24）：把最近几条群聊压成一段上下文，帮助模型判断
   * 「这句话是在回谁」——QQ 的引用/回复信息不一定能拿到，只能靠群聊顺序推断。
   * 包含机器人自己发过的话（标成「你」），否则模型会误判别人在跟谁说话。
   */
  #recentChatBlock(key, message) {
    const messageId = message?.messageId ?? null;
    return formatChatDigest(this.#recentChat.get(key) ?? [], {
      now: Date.now(),
      minutes: 15,
      maxChars: 40,
      limitBefore: 25,
      limitAfter: 4,
      current: {
        messageId,
        at: Number(message?.__receivedAt) || 0,
        senderName: message?.senderName || message?.senderId || '当前消息',
        senderIsBot: message?.senderIsBot === true,
        text: safeText(message),
      },
    });
  }

  /** 本地补丁：把机器人自己刚发出的话记进最近群聊（显示为「你」）。 */
  #rememberOwnChat(key, text) {
    const value = String(text ?? '').trim();
    if (!value) return;
    const now = Date.now();
    const list = this.#recentChat.get(key) ?? [];
    list.push({
      senderId: this.#botId,
      senderName: this.#selfNames[0] || '我',
      senderIsBot: false,
      isSelf: true,
      text: value,
      at: now,
    });
    this.#recentChat.set(key, list.filter((entry) => now - entry.at <= 30 * 60 * 1000).slice(-40));
  }

  /** 本地补丁：记录机器人自己发过的文字（用于判断有人引用/回复它）。 */
  #rememberBotText(key, text) {
    const value = String(text ?? '').trim();
    if (!value) return;
    const now = Date.now();
    const list = this.#botTexts.get(key) ?? [];
    list.push({ text: value, at: now });
    this.#botTexts.set(key, list.filter((entry) => now - entry.at <= 60 * 60 * 1000).slice(-20));
  }

  /** 本地补丁：这条消息引用的内容是不是机器人自己说过的。 */
  #quotedMyMessage(message, key) {
    const ref = qqReplyReference(message);
    if (!ref || typeof ref.content !== 'string') return false;
    const own = (this.#botTexts.get(key) ?? []).map((entry) => entry.text);
    return matchesOwnText(ref.content, own);
  }

  /**
   * 本地补丁（2026-10-24）：群友在复读接龙（≥N 个不同的人复读同一句）时，跟着接一句。
   * 有独立冷却，且同一 bot 每会话最多每 repeatReplyCooldownMinutes 一次。
   */
  #shouldJoinRepeat(message, key) {
    const config = readBehaviorConfig().watch;
    if (!config?.enabled) return false;
    // 免打扰时段只回点名，不主动接龙。
    if (inQuietHours(Date.now(), readBehaviorConfig().engagement?.quietHours)) return false;
    if (message?.senderIsBot === true) return false;
    if (Array.isArray(config.botIds) && config.botIds.length > 0
      && !config.botIds.includes(this.#botId)) return false;
    if (message?.kind !== 'group') return false;
    const text = safeText(message);
    if (!text || text.startsWith('/')) return false;
    if (PROMPT_TALK_PATTERN.test(text)) return false;
    const groups = Array.isArray(config.groups) ? config.groups : [];
    const groupId = nonEmptyString(message.groupOpenid);
    if (groups.length > 0 && (!groupId || !groups.includes(groupId))) return false;
    const now = Date.now();
    const cooldownMs = Math.max(1, Number(config.repeatReplyCooldownMinutes) || 10) * 60_000;
    if (now - (this.#repeatReplies.get(key) ?? 0) < cooldownMs) return false;
    const repeated = isRepeatChain(this.#recentChat.get(key) ?? [], {
      text,
      senderId: message?.senderId,
      now,
      windowMinutes: Number(config.repeatChainWindowMinutes) || 5,
      minSenders: Number(config.repeatChainMinSenders) || 2,
    });
    if (!repeated) return false;
    this.#repeatReplies.set(key, now);
    return true;
  }

  /**
   * 本地补丁（2026-10-24）：把「这条消息怎么处理」收敛成一个判定函数，
   * 结果是 reply / watch / repeat / skip 之一，并附原因（用于决策日志）。
   * @returns {{action: 'reply'|'watch'|'repeat'|'skip', reason: string}}
   */
  #decideInbound(message, key) {
    const watchConfig = readBehaviorConfig().watch;
    const explicitAddress = isQqMessageAddressed(message)
      || isNameMentioned(message, this.#nameMentionPattern)
      || mentionsBotByName(message, this.#selfNames);
    if (message?.senderIsBot === true && !explicitAddress && !this.#isEngaged(message, key)) {
      if (!(watchConfig?.enabled && watchConfig.everyone === true)) {
        return { action: 'skip', reason: 'bot-not-addressed' };
      }
    }
    const addressed = this.#shouldReply(message, key);
    if (addressed) {
      if (!this.#allowBotReply(message, key)) return { action: 'skip', reason: 'bot-throttled' };
      return { action: 'reply', reason: 'addressed' };
    }
    if (this.#shouldJoinRepeat(message, key)) return { action: 'repeat', reason: 'repeat-chain' };
    const watch = this.#watchDecision(message, key);
    if (watch.allow) return { action: 'watch', reason: watch.reason };
    return { action: 'skip', reason: watch.reason };
  }

  #logDecision(message, key, decision) {
    const config = readBehaviorConfig().decisionLog;
    if (!config?.enabled) return;
    const prefix = Math.max(0, Number(config.textPrefix) || 24);
    try {
      appendDecision(this.#botId, {
        conv: key,
        sender: message?.senderName || message?.senderId,
        owner: isOwnerSender(message, this.#ownerUserOpenid),
        fromBot: message?.senderIsBot === true,
        action: decision.action,
        reason: decision.reason,
        text: safeText(message).slice(0, prefix),
        quoted: Boolean(qqReplyReference(message)),
        image: hasQqImageAttachments(message) ? 1 : 0,
      }, { retentionDays: Number(config.retentionDays) || 30 });
    } catch {
      // logging is best-effort
    }
  }

  #logOutcome(message, key, outcome) {
    const config = readBehaviorConfig().decisionLog;
    if (!config?.enabled) return;
    const prefix = Math.max(0, Number(config.textPrefix) || 24);
    try {
      appendDecision(this.#botId, {
        conv: key,
        sender: message?.senderName || message?.senderId,
        owner: isOwnerSender(message, this.#ownerUserOpenid),
        fromBot: message?.senderIsBot === true,
        action: outcome.action,
        reason: outcome.reason,
        text: safeText(message).slice(0, prefix),
        engaged: outcome.engagedTurn === true ? 1 : 0,
      }, { retentionDays: Number(config.retentionDays) || 30 });
    } catch {
      // logging is best-effort
    }
  }

  /** 主人 /why [N]：看最近 N 条判定记录 + 今日估算花费。 */
  #handleWhyCommand(message, messageId, countArg) {
    if (this.#signal?.aborted) return Promise.resolve();
    const limit = Math.max(1, Math.min(10, Number(countArg) || 5));
    const records = readRecentDecisions(this.#botId, { limit });
    const lines = records.map((record) => {
      const time = new Date(record.ts).toLocaleTimeString('zh-CN', { hour12: false });
      const text = String(record.text ?? '').replace(/\s+/gu, ' ').slice(0, 16);
      return `${time} ${record.action}/${record.reason} 「${text}」`;
    });
    const spent = botSpentCny(this.#botId);
    const body = lines.length > 0 ? lines.join('\n') : '最近没有决策记录。';
    return this.#bot.sendText(message.replyTarget, `最近决策：\n${body}\n今日估算 ¥${spent.toFixed(3)}`)
      .then(() => this.#state.markSeen(messageId))
      .catch(() => undefined);
  }

  /** 主人 /memory：查看 / 删除 / 清空长期记忆。 */
  #handleMemoryCommand(message, messageId, verb, argument) {
    if (this.#signal?.aborted) return Promise.resolve();
    const reply = (text) => this.#bot.sendText(message.replyTarget, text)
      .then(() => this.#state.markSeen(messageId)).catch(() => undefined);
    try {
      if (verb === 'clear' || verb === '清空') {
        clearMemory(this.#botId);
        return reply('长期记忆已清空。');
      }
      if (verb === 'forget' || verb === '删除') {
        if (!argument) return reply('用法：/memory forget 关键词');
        const removed = forgetMemory(this.#botId, { match: argument });
        return reply(`已删除 ${removed} 条相关记忆。`);
      }
      const stats = memoryStats(this.#botId);
      const lines = [`长期记忆：主人 ${stats.ownerFacts} 条；群 ${stats.groups.length} 个。`];
      const document = loadMemory(this.#botId);
      for (const fact of (document.ownerFacts ?? []).slice(-3)) lines.push(`- 主人：${fact.text}`);
      for (const [groupKey, bucket] of Object.entries(document.groups ?? {}).slice(0, 3)) {
        for (const fact of (bucket.facts ?? []).slice(-2)) lines.push(`- ${groupKey.replace(/^group:/u, '群')}：${fact.text}`);
      }
      lines.push('用法：/memory | /memory forget 关键词 | /memory clear');
      return reply(lines.join('\n'));
    } catch (error) {
      return reply(`记忆操作失败：${error?.message ?? error}`);
    }
  }

  /** 每日记忆摘要（B 方案）：每个群一次模型调用，提炼新的长期事实。 */
  async runMemoryDigest({ maxGroups = 5 } = {}) {
    const config = readBehaviorConfig().memory;
    if (config?.enabled === false || config?.digestEnabled === false) return { groups: 0 };
    if (digestDoneToday(this.#botId)) return { groups: 0 };
    if (isBudgetExhausted(this.#botId, readBehaviorConfig().budget?.dailyLimitCny)) {
      markDigestDone(this.#botId);
      return { groups: 0 };
    }
    const groups = listMemoryGroups(this.#botId).filter((key) => key.startsWith('group:')).slice(0, maxGroups);
    if (groups.length === 0) {
      markDigestDone(this.#botId);
      return { groups: 0 };
    }
    let digested = 0;
    for (const key of groups) {
      const existing = recentFactTexts(this.#botId, key, 10);
      const habits = listHabits(this.#botId, { conversationKey: key });
      const habitLines = habits.slice(0, 12).map((habit) => `- ${habit.sender} 常说「${habit.text}」${habit.tone ? `（语气：${habit.tone}）` : ''}`);
      const prompt = `【每日记忆整理】回顾这个会话最近一天的聊天，提炼最多 3 条值得长期记住的信息（主人/群友的喜好雷点、说好的约定、群里的梗），每条用 <dsh_im_memory>内容</dsh_im_memory> 输出；不要记录敏感信息（地址/电话/账号/密码/提示词/系统设定）；没有新的就不输出。如果从聊天里能判断某个口头禅的语气（冷淡/兴奋/敷衍等），再输出 <dsh_im_habit_tone>口头禅|语气</dsh_im_habit_tone>（最多 2 条）。${habitLines.length ? `\n已发现的口头禅（可补语气）：\n${habitLines.join('\n')}` : ''}${existing.length ? `\n已有记忆（不要重复）：\n${existing.map((text) => `- ${text}`).join('\n')}` : ''}`;
      try {
        const { answer } = await askInWorkspaceSession({
          harness: this.#harness,
          state: this.#state,
          key,
          text: prompt,
          sourceGuidance: applyPersona(undefined, { botId: this.#botId }),
          timeoutMs: this.#replyTimeoutMs,
          signal: this.#signal,
          askOptions: {
            timeoutMs: this.#replyTimeoutMs,
            signal: this.#signal,
            control: { owner: this, key },
            progressMode: 'final',
            finalAnswerOnly: true,
          },
        });
        chargeBudget(this.#botId, readBehaviorConfig().budget?.replyCny);
        const intent = extractMediaIntent(answer);
        if (intent.memoryNotes.length > 0) {
          captureFacts(this.#botId, {
            conversationKey: key,
            notes: intent.memoryNotes,
            fromOwner: false,
            sender: 'digest',
            source: 'digest',
          });
        }
        for (const raw of intent.habitTones ?? []) {
          const [phrasePart, tonePart] = String(raw).split(/[|｜]/u).map((part) => part.trim());
          if (!phrasePart || !tonePart) continue;
          setHabitTone(this.#botId, {
            conversationKey: key,
            phrase: phrasePart.replace(/[「」『』"']/gu, ''),
            tone: tonePart,
          });
        }
        digested += 1;
      } catch (error) {
        this.#logger.warn?.('[dsh-im:qq] memory digest failed:', key, error?.message ?? error);
      }
    }
    pruneMemory(this.#botId, {
      retentionDays: Number(config.retentionDays) || 90,
      maxFactsPerGroup: Number(config.maxFactsPerGroup) || 60,
      maxOwnerFacts: Number(config.maxOwnerFacts) || 80,
    });
    markDigestDone(this.#botId);
    this.#logger.info?.(`[dsh-im:qq] memory digest done for ${digested} group(s)`);
    return { groups: digested };
  }

  #accept(message) {
    if (this.#signal?.aborted) return Promise.resolve();
    const messageId = nonEmptyString(message?.messageId);
    const sender = nonEmptyString(message?.senderId);
    if (!messageId || !sender
      || !['c2c', 'group'].includes(message?.kind)
      || this.#state.hasSeen(messageId)
      || this.#acceptedMessageIds.has(messageId)) return Promise.resolve();
    message = normalizeQqMentions(message, new Set([this.#bot.appId]));
    const key = conversationKey(message);
    // 本地补丁：记录聊天用于「活跃群」与「复读接龙」判断（包括不回复的消息）。
    this.#rememberChat(message, key);
    // 本地补丁：群友发的表情（gif/webp/png 小图）顺手收进表情库，下次能自己发。
    // 不阻塞回复链路，失败只记日志。
    void this.#collectInboundStickers(message).catch((error) => {
      this.#logger.warn?.('[dsh-im:qq] sticker collection failed:', error?.message ?? error);
    });
    // 主人 /memory：查看/删除/清空长期记忆。
    const memoryCommand = /^\/(?:memory|记忆)(?:\s+(\S+))?(?:\s+([\s\S]+))?$/iu.exec(safeText(message));
    if (memoryCommand && isOwnerSender(message, this.#ownerUserOpenid)) {
      this.#acceptedMessageIds.set(messageId, null);
      return this.#handleMemoryCommand(
        message,
        messageId,
        (memoryCommand[1] ?? '').toLowerCase(),
        (memoryCommand[2] ?? '').trim(),
      );
    }
    // 主人 /why [N]：先于判定处理，避免被当成普通聊天。
    const whyMatch = WHY_COMMAND_PATTERN.exec(safeText(message));
    if (whyMatch && isOwnerSender(message, this.#ownerUserOpenid)) {
      this.#acceptedMessageIds.set(messageId, null);
      return this.#handleWhyCommand(message, messageId, whyMatch[1]);
    }
    // Other bots: only answer when they clearly address us and the throttle
    // allows it, so two bots cannot loop forever.
    const decision = this.#decideInbound(message, key);
    if (decision.action === 'skip') {
      this.#engagedTurnIds.delete(messageId);
      this.#explicitTurnIds.delete(messageId);
      this.#logDecision(message, key, decision);
      return Promise.resolve();
    }
    if (decision.action === 'watch' || decision.action === 'repeat') {
      this.#logDecision(message, key, decision);
      this.#acceptedMessageIds.set(messageId, captureContextEnhancement(
        this.#contextEnhancement,
        message.kind === 'c2c' ? 'direct' : 'group',
      ));
      return this.#enqueueMessage(message, messageId, key, {
        watchMode: true,
        repeatMode: decision.action === 'repeat',
      });
    }
    // decision.action === 'reply'
    // 本地补丁（2026-10-24）：同一人连发几条时先等 settleMs，再合成一条一起回，
    // 避免「抢答第一句、再答第二句」；命令/待回答问题/批量输入不合并。
    if (this.#canCoalesce(message, key)) {
      return this.#queueCoalesced(message, messageId, key);
    }
    const addressed = true;
    const commandText = safeText(message);
    const menuTextOnly = !hasQqImageAttachments(message) && !hasQqFileAttachments(message)
      && !qqReplyReference(message);
    const explicitMenu = menuTextOnly && isQqMenuCommand(commandText);
    const numericMenu = menuTextOnly && /^\d{1,2}$/u.test(commandText)
      && this.#menus.has(key, sender)
      && !this.#pendingInteractions.has(key) && !this.#approvals.hasPending(key)
      && this.#batchInputs.status(key).phase === 'idle';
    const menuInput = numericMenu
      ? `/m pick ${this.#menus.tokenFor(key, sender)} ${commandText}` : commandText;
    if (addressed) {
      const access = this.#accessPolicy
        ? evaluateInboundAccess(this.#accessPolicy, {
            conversationType: message.kind === 'c2c' ? 'direct' : 'group',
            senderIds: sender,
            text: commandText,
            hasImages: hasQqImageAttachments(message),
            hasFiles: hasQqFileAttachments(message),
            ...(explicitMenu || numericMenu || isPermissionCommand(commandText) ? { isCommand: true } : {}),
          })
        : senderAllowed(message, this.#ownerUserOpenid)
          ? { allowed: true, reason: 'legacy-owner' }
          : { allowed: false, reason: 'sender-not-allowed' };
      if (!access.allowed) {
        this.#acceptedMessageIds.set(messageId, null);
        return this.#finishAccessDecision(message, messageId, access);
      }
    }
    if (addressed) {
      const effortCommand = parseEffortCommand(commandText);
      if (effortCommand !== null) {
        this.#acceptedMessageIds.set(messageId, null);
        if (!isOwnerSender(message, this.#ownerUserOpenid)) {
          return this.#bot.sendText(message.replyTarget, t('推理等级只能由主人调整。'))
            .catch(() => undefined);
        }
        return this.#handleEffortCommand(message, messageId, effortCommand);
      }
    }
    if (addressed) {
      const stickerCommand = parseStickerCommand(commandText);
      if (stickerCommand !== null) {
        this.#acceptedMessageIds.set(messageId, null);
        return this.#handleStickerCommand(message, messageId, stickerCommand);
      }
    }
    if (addressed) {
      const voiceCommand = parseVoiceCommand(commandText);
      if (voiceCommand !== null) {
        this.#acceptedMessageIds.set(messageId, null);
        if (!isOwnerSender(message, this.#ownerUserOpenid)) {
          return this.#bot.sendText(message.replyTarget, t('语音指令只对主人开放。'))
            .catch(() => undefined);
        }
        return this.#handleVoiceCommand(message, messageId, voiceCommand);
      }
    }
    this.#acceptedMessageIds.set(messageId, captureContextEnhancement(
      this.#contextEnhancement,
      message.kind === 'c2c' ? 'direct' : 'group',
    ));
    if (message.kind === 'c2c'
      && (this.#ownerUserOpenid === '*' || sender === this.#ownerUserOpenid)
      && message.replyTarget?.scope === 'c2c'
      && nonEmptyString(message.replyTarget.targetId) === sender) {
      rememberConnectionTestTarget(this.#state, message.replyTarget);
    }
    const pending = this.#pendingInteractions.get(key);
    const batchCommand = isBatchInputCommand(commandText);
    const batchStatus = this.#batchInputs.status(key);
    // Ordinary prompts and other commands end number selection. A pending
    // question/approval or batch keeps its existing interpretation of digits.
    if (addressed && !explicitMenu && !numericMenu) this.#menus.clear(key, sender);
    if (batchCommand && addressed && message.kind === 'group') {
      return this.#finishBatchResult(
        message,
        messageId,
        { message: batchInputGroupUnsupportedMessage() },
      );
    }
    if (message.kind === 'c2c'
      && (batchCommand || batchStatus.phase === 'collecting')) {
      if (explicitMenu) return this.#finishBatchResult(message, messageId, {
        message: t('当前正在批量输入，请先发送 /send 或 /cancel，再打开菜单。'),
      });
      const exactBatchStart = /^\/batch$/iu.test(commandText);
      const result = exactBatchStart
        && batchStatus.phase === 'idle'
        && (this.#queues.has(key) || pending || this.#approvals.hasPending(key))
        ? { handled: true, kind: 'busy', message: batchInputBusyMessage() }
        : this.#batchInputs.handle(key, commandText, {
            plainText: Boolean(commandText)
              && !hasQqImageAttachments(message)
              && !hasQqFileAttachments(message)
              && !qqReplyReference(message),
          });
      if (result.handled) {
        if (result.kind === 'submit') {
          return this.#enqueueMessage(
            {
              ...message,
              content: result.prompt,
              // The submission is exactly the collected text: the command
              // message's own attachments and quoted message are not part of it.
              attachments: [],
              refMsgIdx: undefined,
            },
            messageId,
            key,
            { batchSubmission: result },
          );
        }
        return this.#finishBatchResult(message, messageId, result);
      }
    }
    const commandRunner = explicitMenu || numericMenu
      ? () => this.#runMenuCommand(message, menuInput, key)
      : isClearCommand(commandText) ? runClearCommand
      : isHistoryCommand(commandText) ? runHistoryCommand
      : isPermissionCommand(commandText) ? runPermissionCommand
      : hasQqFileAttachments(message) ? null : isControlCommand(commandText)
      ? runControlCommand
      : (isModelCommand(commandText)
          ? runModelCommand
          : (isPresetCommand(commandText) ? runPresetCommand : null));
    if (commandRunner && addressed) {
      let task;
      task = this.#processFastCommand(
        message,
        messageId,
        key,
        commandText,
        commandRunner,
      ).catch((error) => {
        if (error?.code === 'turn-stopped' || this.#signal?.aborted) return;
        this.#status.lastError = error?.message ?? String(error);
        const failure = setLastMessageFailure(this.#status, error);
        this.#logger.error?.(
          `[dsh-im:qq] failed to process a command [${failure.referenceId}]:`,
          messageFailureDiagnostic(error, failure),
        );
        return this.#bot.sendText(message.replyTarget, messageFailureText(failure))
          .catch(() => undefined);
      }).finally(() => {
        this.#acceptedMessageIds.delete(messageId);
        this.#commandTasks.delete(task);
      });
      this.#commandTasks.add(task);
      return task;
    }
    const approval = this.#approvals.claimReply({
      key,
      actor: sender,
      messageId,
      text: hasQqImageAttachments(message) || hasQqFileAttachments(message) ? '' : safeText(message),
      addressed,
      hasPendingQuestion: Boolean(pending),
      questionCompletion: pending?.submitting || pending?.claimedReplyMessageId
        ? pending.queue
        : null,
      isQuestionPending: () => this.#pendingInteractions.has(key),
      send: (text) => this.#bot.sendText(message.replyTarget, text),
    });
    if (approval) {
      let task;
      task = approval.process(async () => {
          if (this.#state.hasSeen(messageId)) return false;
          await this.#state.markSeen(messageId);
          this.#status.messagesReceived += 1;
          this.#status.lastMessageAt = new Date().toISOString();
          return true;
        })
        .finally(() => {
          this.#acceptedMessageIds.delete(messageId);
          this.#approvalTasks.delete(task);
        });
      this.#approvalTasks.add(task);
      return task;
    }
    if (pending && sender !== pending.actor) {
      return this.#enqueueMessage(message, messageId, key);
    }
    if (pending?.submitting || pending?.claimedReplyMessageId) {
      return this.#enqueueMessage(message, messageId, key);
    }
    if (pending) {
      if (canClaimInteractionReply(message, pending)) {
        pending.claimedReplyMessageId = messageId;
      }
      const previous = pending.queue ?? Promise.resolve();
      const current = previous
        .catch(() => undefined)
        .then(() => this.#processInteractionReply(message, messageId, key, pending))
        .catch((error) => this.#handleInteractionFailure(message, messageId, error))
        .finally(() => {
          this.#acceptedMessageIds.delete(messageId);
          if (pending.claimedReplyMessageId === messageId) pending.claimedReplyMessageId = null;
          if (pending.queue === current) pending.queue = null;
        });
      pending.queue = current;
      return current;
    }
    return this.#busyMessages.dispatch({
      key, messageId, text: commandText,
      eligible: () => addressed && menuTextOnly && !explicitMenu && !numericMenu
        && canAutomaticallySteer(this.#accessPolicy, message.kind === 'c2c' ? 'direct' : 'group', sender),
      harness: this.#harness, state: this.#state, status: this.#status,
      signal: this.#signal, control: { owner: this, key }, logger: this.#logger,
      acceptedMessageIds: this.#acceptedMessageIds,
      pendingInteraction: () => this.#pendingInteractions.has(key) || this.#approvals.hasPending(key),
      enhancement: {
        snapshot: this.#acceptedMessageIds.get(messageId),
        source: () => ({ channel: 'qq', senderId: sender,
          senderName: message.kind === 'group' ? message.senderName : undefined,
          chatId: message.kind === 'group' ? message.groupOpenid : sender }),
      },
      isQueued: () => this.#queues.has(key),
      // The queue receipt is useful in a private chat, but noisy in a group.
      queueReceipt: message.kind !== 'group',
      enqueue: (options) => this.#enqueueMessage(message, messageId, key, options),
      send: (reply) => addressed ? this.#bot.sendText(message.replyTarget, reply) : Promise.resolve(),
      onError: (error) => this.#handleInteractionFailure(message, messageId, error),
    });
  }

  /** 同一人连发多条时是否合并成一个回复。 */
  #canCoalesce(message, key) {
    const config = readBehaviorConfig().replyCoalesce;
    if (!config?.enabled) return false;
    if (message?.senderIsBot === true) return false;
    const text = safeText(message);
    if (text.startsWith('/')) return false;
    if (this.#pendingInteractions.has(key) || this.#approvals.hasPending(key)) return false;
    if (this.#batchInputs.status(key).phase !== 'idle') return false;
    if (isQqMenuCommand(text)) return false;
    return true;
  }

  #queueCoalesced(message, messageId, key) {
    const config = readBehaviorConfig().replyCoalesce;
    const settleMs = Math.max(200, Number(config?.settleMs) || 2500);
    const maxMessages = Math.max(2, Math.min(20, Number(config?.maxMessages) || 6));
    const buffer = this.#coalescePending.get(key) ?? { entries: [], timer: null };
    buffer.entries.push({ message, messageId });
    if (buffer.timer) {
      clearTimeout(buffer.timer);
      buffer.timer = null;
    }
    const flush = () => {
      if (buffer.timer) {
        clearTimeout(buffer.timer);
        buffer.timer = null;
      }
      void this.#flushCoalesced(key).catch((error) => {
        this.#logger.warn?.('[dsh-im:qq] coalesced reply failed:', error?.message ?? error);
      });
    };
    if (buffer.entries.length >= maxMessages) flush();
    else buffer.timer = setTimeout(flush, settleMs);
    this.#coalescePending.set(key, buffer);
    return Promise.resolve();
  }

  async #flushCoalesced(key) {
    const buffer = this.#coalescePending.get(key);
    if (!buffer) return;
    if (buffer.timer) {
      clearTimeout(buffer.timer);
      buffer.timer = null;
    }
    // 上一轮还在生成：等它结束再一起处理（期间新消息会继续进缓冲）。
    if (this.#queues.has(key)) {
      buffer.timer = setTimeout(() => {
        if (buffer.timer) {
          clearTimeout(buffer.timer);
          buffer.timer = null;
        }
        void this.#flushCoalesced(key).catch(() => {});
      }, 500);
      this.#coalescePending.set(key, buffer);
      return;
    }
    this.#coalescePending.delete(key);
    const entries = buffer.entries.filter((entry) => entry?.message && entry?.messageId);
    if (entries.length === 0) return;
    // 原消息全部标记已读；合成消息本身不再重复计数。
    for (const entry of entries) {
      await this.#state.markSeen(entry.messageId).catch(() => {});
    }
    const merged = mergeCoalescedMessages(entries);
    if (!merged) return;
    this.#acceptedMessageIds.set(merged.messageId, captureContextEnhancement(
      this.#contextEnhancement,
      merged.kind === 'c2c' ? 'direct' : 'group',
    ));
    this.#logDecision(merged, key, { action: 'reply', reason: `coalesced-${entries.length}` });
    await this.#enqueueMessage(merged, merged.messageId, key, { forceReply: true, alreadyRecorded: true });
  }

  #enqueueMessage(message, messageId, key, {
    releaseMessageId = true,
    alreadyRecorded = false,
    batchSubmission = null,
    watchMode = false,
    repeatMode = false,
    forceReply = false,
  } = {}) {
    // Persist before the message joins the in-memory chain: the chain may wait
    // behind a long turn, and a restart in that window must not lose the input.
    const pending = this.#recordPendingMessage(message, messageId, key);
    const addressed = forceReply || this.#shouldReply(message, key);
    const preparedMessage = addressed
      ? prefetchInboundFiles(
          qqInboundMessage(message, { fetchImpl: this.#fetchImpl }),
          { signal: this.#signal },
        )
      : undefined;
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => pending)
      .then(() => this.#process(message, key, {
        alreadyRecorded,
        preparedMessage,
        batchSubmission,
        watchMode,
        repeatMode,
        forceReply,
      }))
      .finally(async () => {
        if (releaseMessageId) this.#acceptedMessageIds.delete(messageId);
        if (this.#queues.get(key) === current) this.#queues.delete(key);
        await this.#removePendingMessage(pendingMessageId(key, messageId));
      });
    this.#queues.set(key, current);
    return current;
  }

  /**
   * Replay (submitted: false) or report (submitted: true) the messages this
   * bridge persisted before a restart. Idempotent: each entry is removed as it
   * is handled, and the returned promise is shared with waitForIdle().
   */
  recoverPendingMessages() {
    this.#pendingRecovery ??= this.#recoverPendingMessages().catch((error) => {
      this.#logger.warn?.('[dsh-im:qq] queued-message recovery failed:', error?.message ?? error);
    });
    return this.#pendingRecovery;
  }

  async #recoverPendingMessages() {
    if (typeof this.#state?.pendingMessages !== 'function') return;
    const entries = this.#state.pendingMessages();
    if (!Array.isArray(entries) || entries.length === 0) return;
    for (const entry of entries) {
      if (!entry || this.#signal?.aborted) return;
      try {
        if (entry.submitted === true) {
          await this.#notifyInterruptedPending(entry);
          await this.#removePendingMessage(entry.id);
          continue;
        }
        this.#logger.warn?.(
          '[dsh-im:qq] replaying a queued message that a restart interrupted:',
          entry.messageId,
        );
        // The turn never reached Harness, so any earlier mark-seen is an
        // attempt, not a completed delivery; clear it so the replay can run.
        if (typeof this.#state.unmarkSeen === 'function') {
          await this.#state.unmarkSeen(entry.messageId).catch(() => undefined);
        }
        await this.#replayPendingMessage(entry);
      } catch (error) {
        this.#logger.warn?.(
          '[dsh-im:qq] failed to recover a queued message:',
          entry?.messageId,
          error?.message ?? error,
        );
      }
    }
  }

  #recordPendingMessage(message, messageId, key) {
    if (typeof this.#state?.putPendingMessage !== 'function') return Promise.resolve();
    const text = safeText(message);
    if (!text) return Promise.resolve();
    const senderId = nonEmptyString(message.senderId);
    const entry = {
      id: pendingMessageId(key, messageId),
      key,
      messageId,
      kind: message.kind === 'group' ? 'group' : 'c2c',
      text,
      submitted: false,
      createdAt: new Date().toISOString(),
      ...(senderId ? { senderId } : {}),
      ...(message.replyTarget !== undefined ? { target: message.replyTarget } : {}),
    };
    return this.#state.putPendingMessage(entry).catch((error) => {
      this.#logger.warn?.('[dsh-im:qq] failed to persist a queued message:', error?.message ?? error);
    });
  }

  async #markPendingSubmitted(key, messageId) {
    if (typeof this.#state?.patchPendingMessage !== 'function') return;
    await this.#state.patchPendingMessage(pendingMessageId(key, messageId), { submitted: true });
  }

  async #removePendingMessage(id) {
    if (typeof this.#state?.removePendingMessage !== 'function') return;
    try {
      await this.#state.removePendingMessage(id);
    } catch (error) {
      this.#logger.warn?.('[dsh-im:qq] failed to clear a queued-message entry:', error?.message ?? error);
    }
  }

  #replayPendingMessage(entry) {
    const message = this.#pendingReplayMessage(entry);
    if (!message) return Promise.resolve();
    return this.#enqueueMessage(message, entry.messageId, entry.key);
  }

  #pendingReplayMessage(entry) {
    const separator = String(entry.key).indexOf(':');
    if (separator < 0) return null;
    const kind = entry.key.slice(0, separator) === 'group' ? 'group' : 'c2c';
    const conversationId = entry.key.slice(separator + 1);
    if (!conversationId || !entry.messageId) return null;
    // Rebuild exactly the turn fields the queue path reads, so the recovered
    // text is dispatched as the user's own message with no added framing.
    return {
      kind,
      rawEventType: kind === 'group' ? 'GROUP_AT_MESSAGE_CREATE' : 'C2C_MESSAGE_CREATE',
      senderId: entry.senderId ?? '',
      messageId: entry.messageId,
      content: entry.text,
      ...(kind === 'group' ? { groupOpenid: conversationId } : {}),
      ...(entry.target !== undefined ? { replyTarget: entry.target } : {}),
    };
  }

  async #notifyInterruptedPending(entry) {
    if (!shouldNotifyInterruptedPending(entry)) {
      if (entry.kind === 'group') {
        this.#logger.warn?.(
          '[dsh-im:qq] a queued group message was interrupted by a restart; staying silent:',
          entry.messageId,
        );
      }
      if (entry.target === undefined || entry.target === null) {
        this.#logger.warn?.(
          '[dsh-im:qq] a queued message was interrupted by a restart but has no delivery target:',
          entry.messageId,
        );
        return;
      }
      return;
    }
    try {
      await this.#bot.sendText(entry.target, t(PENDING_RESTART_NOTICE));
    } catch (error) {
      this.#logger.warn?.(
        '[dsh-im:qq] failed to report an interrupted queued message:',
        error?.message ?? error,
      );
    }
  }

  async #deliverDeferredOutcome(entry, outcome) {
    await sendMarkdownReply(this.#bot, entry.target, deferredOutcomeText(outcome), { logger: this.#logger });
    return true;
  }

  #menuContext(key) {
    const workspace = this.#harness.currentWorkspace?.();
    const sessionWorkspace = typeof this.#harness.currentConversationWorkspace === 'function'
      ? this.#harness.currentConversationWorkspace(key) : workspace;
    return { workspace, sessionWorkspace, sessionId: this.#state.sessionFor(key) };
  }

  async #showMenu(message, key, name, pageView = null) {
    const actor = message.senderId;
    const context = this.#menuContext(key);
    const entry = this.#menus.begin(key, actor, context);
    const view = pageView ?? await qqMenuView(name, this.#harness, this.#state, key, {
      signal: this.#signal, busy: this.#queues.has(key)
        || this.#pendingInteractions.has(key) || this.#approvals.hasPending(key),
    });
    this.#signal?.throwIfAborted();
    this.#harness.assertWorkspaceScope?.();
    const current = this.#menuContext(key);
    if (current.workspace !== context.workspace || current.sessionWorkspace !== context.sessionWorkspace
      || current.sessionId !== context.sessionId) {
      return { message: t('会话或工作区已变化，请重新发送 /m。') };
    }
    if (!this.#menus.publish(key, actor, entry, view)) return { messages: [] };
    await sendQqMenu(this.#bot, message.replyTarget, view, entry.token, { logger: this.#logger });
    this.#status.messagesReplied += 1;
    this.#status.lastReplyAt = new Date().toISOString();
    return { messages: [] };
  }

  async #runMenuCommand(message, text, key) {
    const parsed = isQqMenuCommand(text) ? parseQqMenuCommand(text) : { number: Number(text) };
    if (parsed.error) return { message: t('菜单命令无效，请发送 /m 重新打开。') };
    if (parsed.name) return this.#showMenu(message, key, parsed.name);
    const choice = this.#menus.take(key, message.senderId, parsed.number, parsed.token, this.#menuContext(key));
    if (choice.error) return { message: choice.error };
    const action = choice.action;
    if (action.kind === 'section') return this.#showMenu(message, key, action.name);
    if (action.kind === 'page') return this.#showMenu(message, key, '', qqMenuPage(action.list, action.page));
    if (action.kind === 'archive') {
      await this.#state.setIncludeArchivedSessions(action.include);
      return this.#showMenu(message, key, 'main');
    }
    const command = action.text;
    const pendingInteraction = this.#pendingInteractions.has(key) || this.#approvals.hasPending(key);
    const isBusy = () => this.#queues.has(key) || this.#pendingInteractions.has(key)
      || this.#approvals.hasPending(key) || this.#batchInputs.status(key).phase !== 'idle';
    const needsIdle = /^\/(?:new|session|workspace|compact|clear)(?:\s|$)/u.test(command);
    if (isBusy() && needsIdle) {
      return { message: t('当前任务仍在运行，请先停止任务或等待任务完成后再执行此操作。') };
    }
    const options = { signal: this.#signal, isDirect: message.kind === 'c2c', pendingInteraction,
      control: { owner: this, key }, deferredDelivery: this.#deferred,
      enhancement: captureContextEnhancementSource(
        this.#contextEnhancement,
        message.kind === 'c2c' ? 'direct' : 'group',
        () => ({
          channel: 'qq',
          senderId: nonEmptyString(message.senderId),
          senderName: message.kind === 'group' ? message.senderName : undefined,
          chatId: message.kind === 'group' ? message.groupOpenid : message.senderId,
        }),
      ) };
    // Existing runners own all Host mutations and control authorization.
    const execute = async () => {
      this.#signal?.throwIfAborted();
      const current = this.#menuContext(key);
      if (current.workspace !== choice.context.workspace
        || current.sessionWorkspace !== choice.context.sessionWorkspace
        || current.sessionId !== choice.context.sessionId) {
        return { message: t('会话或工作区已变化，请重新发送 /m。') };
      }
      // A prompt may have started while this action waited for a prior menu command.
      if (needsIdle && isBusy()) return { message: t('当前任务仍在运行，请先停止任务或等待任务完成后再执行此操作。') };
      if (isControlCommand(command)) return runControlCommand(command, this.#harness, this.#state, key, options);
      if (isModelCommand(command)) return runModelCommand(command, this.#harness, this.#state, key, options);
      if (isPresetCommand(command)) return runPresetCommand(command, this.#harness, this.#state, key, options);
      if (command === '/new') return withSessionBindingLock(this.#state, key, async () => {
        if (isBusy()) return { message: t('当前任务仍在运行，请先停止任务或等待任务完成后再执行此操作。') };
        const locked = this.#menuContext(key);
        if (locked.workspace !== choice.context.workspace
          || locked.sessionWorkspace !== choice.context.sessionWorkspace
          || locked.sessionId !== choice.context.sessionId) {
          return { message: t('会话或工作区已变化，请重新发送 /m。') };
        }
        await this.#state.clearSession(key);
        return { message: t('已开启新会话。请发送你的问题。') };
      });
      if (isClearCommand(command)) return runClearCommand(command, this.#harness, this.#state, key, options);
      if (command === '/compact') return runCompactCommand(command, this.#harness, this.#state, key, options);
      return runWorkspaceCommand(command, this.#harness, key);
    };
    // Stop/steer must stay available while a slower menu mutation is pending.
    if (isControlCommand(command)) return execute();
    const previous = this.#menuTasks.get(key) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(execute);
    this.#menuTasks.set(key, task);
    try { return await task; }
    finally { if (this.#menuTasks.get(key) === task) this.#menuTasks.delete(key); }
  }

  async waitForIdle() {
    await this.#pendingRecovery;
    await this.#busyMessages.whenIdle();
    await Promise.allSettled([
      ...this.#queues.values(),
      ...[...this.#pendingInteractions.values()].flatMap((pending) => (
        pending.queue ? [pending.queue] : []
      )),
      ...this.#approvalTasks,
      ...this.#commandTasks,
    ]);
    await this.#deferred.whenIdle();
  }

  async #processFastCommand(message, messageId, key, text, runner) {
    this.#signal?.throwIfAborted();
    if (this.#state.hasSeen(messageId)) return;
    await this.#state.markSeen(messageId);
    this.#status.messagesReceived += 1;
    this.#status.lastMessageAt = new Date().toISOString();
    const result = await runner(text, this.#harness, this.#state, key, {
      signal: this.#signal,
      isDirect: message.kind === 'c2c',
      hasImages: hasQqImageAttachments(message),
      hasFiles: hasQqFileAttachments(message),
      pendingInteraction: this.#pendingInteractions.has(key)
        || this.#approvals.hasPending(key),
      busy: this.#queues.has(key),
      control: { owner: this, key },
      deferredDelivery: this.#deferred,
      enhancement: captureContextEnhancementSource(
        this.#contextEnhancement,
        message.kind === 'c2c' ? 'direct' : 'group',
        () => ({
          channel: 'qq',
          senderId: nonEmptyString(message.senderId),
          senderName: message.kind === 'group' ? message.senderName : undefined,
          chatId: message.kind === 'group' ? message.groupOpenid : message.senderId,
        }),
      ),
    });
    if (result?.stopped) {
      await Promise.allSettled([
        this.#cancelPendingInteraction(key),
        this.#approvals.closeRoute(key),
      ]);
    }
    for (const reply of result?.messages ?? [result?.message]) {
      if (reply) await this.#bot.sendText(message.replyTarget, reply);
    }
    this.#status.lastError = null;
  }

  #finishBatchResult(message, messageId, result) {
    let task;
    task = Promise.resolve().then(async () => {
      if (this.#state.hasSeen(messageId)) return;
      await this.#state.markSeen(messageId);
      this.#status.messagesReceived += 1;
      this.#status.lastMessageAt = new Date().toISOString();
      if (result.message) await this.#bot.sendText(message.replyTarget, result.message);
      this.#status.lastError = null;
    }).catch(async (error) => {
      if (this.#signal?.aborted) return;
      this.#status.lastError = error?.message ?? String(error);
      const failure = setLastMessageFailure(this.#status, error);
      this.#logger.error?.(
        `[dsh-im:qq] failed to process a batch input message [${failure.referenceId}]:`,
        messageFailureDiagnostic(error, failure),
      );
      await this.#bot.sendText(message.replyTarget, messageFailureText(failure))
        .catch(() => undefined);
    }).finally(() => {
      this.#acceptedMessageIds.delete(messageId);
      this.#commandTasks.delete(task);
    });
    this.#commandTasks.add(task);
    return task;
  }

  #finishAccessDecision(message, messageId, access) {
    let task;
    task = Promise.resolve().then(async () => {
      if (this.#state.hasSeen(messageId)) return;
      await this.#state.markSeen(messageId);
      if (access.reason === 'command-not-allowed') {
        this.#status.messagesReceived += 1;
        this.#status.lastMessageAt = new Date().toISOString();
        await this.#bot.sendText(message.replyTarget, t(COMMAND_PERMISSION_DENIED_MESSAGE));
        this.#status.messagesReplied += 1;
        this.#status.lastReplyAt = new Date().toISOString();
      } else {
        this.#status.messagesRejected += 1;
        this.#status.lastRejectedAt = new Date().toISOString();
      }
      this.#status.lastError = null;
    }).catch((error) => {
      if (this.#signal?.aborted) return;
      this.#status.lastError = error?.message ?? String(error);
      this.#logger.error?.('[dsh-im:qq] failed to apply inbound access policy:', error);
    }).finally(() => {
      this.#acceptedMessageIds.delete(messageId);
      this.#commandTasks.delete(task);
    });
    this.#commandTasks.add(task);
    return task;
  }

  async #deliverArtifacts(target, replyTo, artifacts = [], baseReceipt = null) {
    if (artifacts.length === 0) {
      return { receipt: baseReceipt, failureNoticeVisible: false, artifactSendErrors: 0 };
    }
    const delivery = await deliverOutboundArtifacts({
      artifacts,
      baseReceipt,
      deliveryId: replyTo,
      aggregatePresentation: baseReceipt ? 'qq-text-and-files' : 'qq-files',
      alwaysMerge: true,
      channelKey: 'qq',
      signal: this.#signal,
      sendImage: (file) => sendQqImage(this.#bot, target, file, {
        signal: this.#signal,
        timeoutMs: this.#fileUploadTimeoutMs,
      }),
      sendFile: (file) => sendQqFile(this.#bot, target, file, {
        signal: this.#signal,
        timeoutMs: this.#fileUploadTimeoutMs,
      }),
      sendVoice: (file) => sendQqVoiceArtifact(this.#bot, target, file, {
        signal: this.#signal,
        timeoutMs: this.#fileUploadTimeoutMs,
      }),
      onFailure: (artifact, error) => setLastMessageFailure(this.#status, error, {
        userMessage: artifactFailureText(artifact?.fileName, error),
        reason: error?.code,
      }),
      sendFailureNotice: (_artifact, _error, failure) => this.#bot.sendText(
        target,
        messageFailureText(failure),
      ),
      logger: this.#logger,
    });
    this.#status.artifactsSent = (this.#status.artifactsSent ?? 0)
      + delivery.artifactsSent;
    this.#status.artifactSendErrors = (this.#status.artifactSendErrors ?? 0)
      + delivery.artifactSendErrors;
    return {
      receipt: delivery.receipt,
      failureNoticeVisible: delivery.failureNoticeVisible,
      artifactSendErrors: delivery.artifactSendErrors,
    };
  }

  /**
   * Quoted messages arrive with attachment names but no download URL. Two
   * sources can still recover the files: the group archive (when that message
   * was delivered before) and the local quote cache filled by the normal
   * inbound download path. Images join the prompt as image sources; other
   * files join it as ordinary inbound files so the model can read the content.
   */
  async #attachQuotedMedia(message, promptMessage) {
    if (!promptMessage || typeof promptMessage !== 'object') return;
    const quoted = Array.isArray(promptMessage.replyTo?.attachments)
      ? promptMessage.replyTo.attachments
      : [];
    const platformMessageId = nonEmptyString(promptMessage.replyTo?.messageId);
    if (!platformMessageId || quoted.length === 0) return;
    const scope = qqConversationScope(message);
    const context = message?.groupHistory;
    const quotedImages = quoted.filter((attachment) => attachment?.kind === 'image');
    const quotedFiles = quoted.filter((attachment) => attachment?.kind && attachment.kind !== 'image');
    if (quotedImages.length > 0) {
      const existing = Array.isArray(promptMessage.images) ? promptMessage.images : [];
      const room = Math.max(0, DEFAULT_MAX_IMAGES - existing.length);
      if (room > 0) {
        let images = [];
        if (typeof context?.store?.imagesForPlatformMessage === 'function') {
          try {
            images = await context.store.imagesForPlatformMessage(
              context.groupId,
              platformMessageId,
              quotedImages.map((attachment) => attachment?.name),
            );
          } catch (error) {
            this.#logger.warn?.('[dsh-im:qq] unable to attach quoted images from the archive:', error?.message ?? error);
          }
        }
        if (!Array.isArray(images) || images.length === 0) {
          images = quotedMediaFor(scope, platformMessageId)
            .filter((item) => item?.kind === 'image' || String(item?.mediaType ?? '').startsWith('image/'));
        }
        if (Array.isArray(images) && images.length > 0) {
          promptMessage.images = [...existing, ...images.slice(0, room).map((image, index) => ({
            ...image,
            ...(image?.name ? { name: quotedImageName(image.name, index) } : {}),
          }))];
        }
      }
    }
    if (quotedFiles.length > 0) {
      const existing = Array.isArray(promptMessage.files) ? promptMessage.files : [];
      let files = [];
      if (typeof context?.store?.filesForPlatformMessage === 'function') {
        try {
          files = await context.store.filesForPlatformMessage(
            context.groupId,
            platformMessageId,
            quotedFiles.map((attachment) => attachment?.name),
          );
        } catch (error) {
          this.#logger.warn?.('[dsh-im:qq] unable to attach quoted files from the archive:', error?.message ?? error);
        }
      }
      if (!Array.isArray(files) || files.length === 0) {
        files = quotedMediaFor(scope, platformMessageId)
          .filter((item) => item?.kind === 'file'
            || (!item?.kind && String(item?.mediaType ?? '').length > 0
              && !String(item.mediaType).startsWith('image/')));
      }
      if (Array.isArray(files) && files.length > 0) {
        promptMessage.files = [...existing, ...files.slice(0, 8).map((file, index) => ({
          ...file,
          name: file?.name ? `引用-${file.name}` : `引用-文件-${index + 1}`,
        }))];
      }
    }
  }

  /** `/sticker [query]`: send one sticker from the local library (any sender). */
  async #handleStickerCommand(message, messageId, command) {
    const target = message.replyTarget;
    try {
      if (!this.#state.hasSeen(messageId)) await this.#state.markSeen(messageId);
      const sticker = await pickSticker(command?.query ?? '');
      if (!sticker) {
        await this.#bot.sendText(target, t('表情库是空的，先放几张图片进去再试。')).catch(() => undefined);
        return;
      }
      await sendQqImage(this.#bot, target, {
        bytes: sticker.bytes,
        fileName: sticker.name,
        mediaType: sticker.mediaType,
      }, { signal: this.#signal, timeoutMs: this.#fileUploadTimeoutMs });
      this.#status.messagesReplied += 1;
      this.#status.lastReplyAt = new Date().toISOString();
      this.#logger.info?.(`[dsh-im:qq] sticker command sent (${sticker.mediaType}, ${sticker.bytes.length} B)`);
    } catch (error) {
      this.#logger.warn?.('[dsh-im:qq] sticker command failed:', error?.message ?? error);
      await this.#bot.sendText(target, t('表情包没发出去：{reason}', {
        reason: error?.message ?? String(error),
      })).catch(() => undefined);
    } finally {
      this.#acceptedMessageIds.delete(messageId);
    }
  }

  /**
   * `/effort [id]`: owner-set reasoning ceiling for group conversations. Groups
   * default to `low`; the owner may raise or lower it explicitly.
   */
  async #handleEffortCommand(message, messageId, command) {
    const target = message.replyTarget;
    try {
      if (!this.#state.hasSeen(messageId)) await this.#state.markSeen(messageId);
      const requested = typeof command?.value === 'string' ? command.value.trim().toLowerCase() : '';
      const current = await readGroupReasoningCeiling();
      if (!requested || requested === 'list' || requested === 'status') {
        await this.#bot.sendText(target, t('群聊推理上限：{current}\n可选：{options}\n用法：/effort low', {
          current,
          options: REASONING_EFFORTS.join(' / '),
        }));
        return;
      }
      const next = await writeGroupReasoningCeiling(requested);
      await this.#bot.sendText(target, t('群聊推理上限已设为：{next}（新建群会话生效，或 /new 后重新开会话）', { next }));
    } catch (error) {
      this.#logger.warn?.('[dsh-im:qq] effort command failed:', error?.message ?? error);
      await this.#bot.sendText(target, t('推理等级没改成：{reason}', {
        reason: error?.code === 'group-reasoning-invalid'
          ? t('可选：{options}', { options: REASONING_EFFORTS.join(' / ') })
          : (error?.message ?? String(error)),
      })).catch(() => undefined);
    } finally {
      this.#acceptedMessageIds.delete(messageId);
    }
  }

  /**
   * `/voice ...`: pick a local voice, tune pitch/rate, or speak a line as a
   * native QQ voice message. Voice is an owner-only action.
   */
  async #handleVoiceCommand(message, messageId, command) {
    const target = message.replyTarget;
    try {
      if (!this.#state.hasSeen(messageId)) await this.#state.markSeen(messageId);
      switch (command?.kind) {
        case 'list': {
          const [voices, current] = await Promise.all([listInstalledVoices(), readVoiceSettings({ botId: this.#botId })]);
          const kokoro = KOKORO_VOICES
            .map((entry) => `${entry.alias} = ${entry.name}（${entry.hint}）`)
            .join('\n');
          const installed = voices
            .map((voice) => `· ${voice.name}${voice.language ? ` ${voice.language}` : ''}${voice.gender ? ` ${voice.gender}` : ''}`)
            .join('\n');
          await this.#bot.sendText(target, t('当前：{current}\n\nKokoro 二次元音色（本地 CPU）：\n{kokoro}\n\nWindows 本机音色：\n{installed}\n\n用法：/voice set xiaobei · /voice speed 1.1',
            { current: await voiceSettingsSummary(this.#botId), kokoro, installed }));
          break;
        }
        case 'set': {
          const value = typeof command.value === 'string' ? command.value.trim() : '';
          const choice = resolveVoiceChoice(value);
          if (!choice) {
            await this.#bot.sendText(target, t('用法：/voice set xiaobei（可用：xiaobei / xiaoni / xiaoxiao / xiaoyi / yaoyao / huihui）'));
            break;
          }
          const next = await writeVoiceSettings({ provider: choice.provider, voice: choice.voice }, { botId: this.#botId });
          if (next.provider === 'gsv') void stopGpuTts();
          else if (next.provider === 'f5') void stopGsv();
          await this.#bot.sendText(target, t('语音已换成：{voice}（{provider}）\n试听：/voice test', {
            voice: next.voice, provider: next.provider,
          }));
          break;
        }
        case 'char': {
          const value = typeof command.value === 'string' ? command.value.trim() : '';
          if (!value) {
            const health = await gpuTtsHealth({ timeoutMs: 1500 }).catch(() => null);
            const names = Array.isArray(health?.characters) && health.characters.length
              ? health.characters.join(' / ') : 'default';
            await this.#bot.sendText(target, t('\u53ef\u7528\u89d2\u8272\u53c2\u8003\uff1a{names}\n\u7528\u6cd5\uff1a/voice char <\u540d\u5b57>', { names }));
            break;
          }
          const next = await writeVoiceSettings({ character: value }, { botId: this.#botId });
          await this.#bot.sendText(target, t('\u5df2\u5207\u5230 GPU \u514b\u9686\u97f3\u8272\uff1a{character}\uff08{provider}\uff09\n\u8bd5\u542c\uff1a/voice test', {
            character: next.character, provider: next.provider,
          }));
          break;
        }
        case 'speed': {
          const value = Number.parseFloat(String(command.value ?? ''));
          if (!Number.isFinite(value)) {
            await this.#bot.sendText(target, t('用法：/voice speed 1.1（0.5~2.0，仅 Kokoro 音色生效）'));
            break;
          }
          const next = await writeVoiceSettings({ speed: value }, { botId: this.#botId });
          await this.#bot.sendText(target, t('语速已设为：{speed}', { speed: next.speed }));
          break;
        }
        case 'pitch':
        case 'rate': {
          const value = Number.parseInt(String(command.value ?? ''), 10);
          if (!Number.isFinite(value)) {
            await this.#bot.sendText(target, t('用法：/voice {field} {value}', {
              field: command.kind, value: command.kind === 'pitch' ? '+15' : '+5',
            }));
            break;
          }
          const next = await writeVoiceSettings({ [command.kind]: value }, { botId: this.#botId });
          await this.#bot.sendText(target, t('已更新：{summary}', { summary: t('{voice} · pitch {pitch}% · rate {rate}%', {
            voice: next.voice,
            pitch: `${next.pitch >= 0 ? '+' : ''}${next.pitch}`,
            rate: `${next.rate >= 0 ? '+' : ''}${next.rate}`,
          }) }));
          break;
        }
        case 'reset': {
          const next = await writeVoiceSettings({ ...DEFAULT_VOICE_SETTINGS }, { botId: this.#botId });
          await this.#bot.sendText(target, t('语音设置已恢复默认：{voice}', { voice: next.voice }));
          break;
        }
        case 'speak': {
          const say = typeof command.text === 'string' ? command.text.trim() : '';
          if (!say) {
            await this.#bot.sendText(target, t('用法：/voice 要说的话（最长 60 秒）'));
            break;
          }
          const { silk, durationMs, provider } = await synthesizeSpeechSilk(say, {
            signal: this.#signal,
            settings: await readVoiceSettings({ botId: this.#botId }),
          });
          await sendQqVoice(this.#bot, target, {
            bytes: silk,
            fileName: 'voice.silk',
            mediaType: 'audio/silk',
          }, { signal: this.#signal, timeoutMs: this.#fileUploadTimeoutMs });
          this.#status.messagesReplied += 1;
          this.#status.lastReplyAt = new Date().toISOString();
          this.#logger.info?.(`[dsh-im:qq] voice reply sent (${durationMs} ms, ${provider})`);
          break;
        }
        default: {
          await this.#bot.sendText(target, t(
            '语音用法：\n/voice 要说的话  发一条语音\n/voice list  看当前音色和可用音色\n/voice set yaoyao  换音色\n/voice pitch +15  调音高（-50~+50）\n/voice rate +5  调语速（-30~+30）\n/voice reset  恢复默认\n当前：{current}',
            { current: await voiceSettingsSummary(this.#botId) },
          ));
        }
      }
    } catch (error) {
      this.#logger.warn?.('[dsh-im:qq] voice command failed:', error?.message ?? error);
      const reason = voiceFailureMessage(error);
      await this.#bot.sendText(target, t('语音没发出去：{reason}', { reason }))
        .catch(() => undefined);
    } finally {
      this.#acceptedMessageIds.delete(messageId);
    }
  }

  async #process(message, key, {
    alreadyRecorded = false,
    preparedMessage,
    batchSubmission = null,
    watchMode = false,
    repeatMode = false,
    forceReply = false,
  } = {}) {
    if (this.#signal?.aborted) return;
    const messageId = nonEmptyString(message?.messageId);
    const sender = nonEmptyString(message?.senderId);
    if (!messageId || !sender) return;
    if (!['c2c', 'group'].includes(message.kind)) return;
    // 本地补丁：本轮是否由接话窗口续聊触发（消费一次）。
    const engagedTurn = this.#engagedTurnIds.delete(messageId);
    // 本地补丁：本轮是否由明确点名触发（消费一次）。
    const explicitTurn = this.#explicitTurnIds.delete(messageId);
    if (!alreadyRecorded) {
      if (this.#state.hasSeen(messageId)) return;
      this.#status.messagesReceived += 1;
      this.#status.lastMessageAt = new Date().toISOString();
    }
    let messageRecorded = alreadyRecorded;
    const markMessageSeen = async () => {
      if (messageRecorded) return;
      await this.#state.markSeen(messageId);
      messageRecorded = true;
    };
    // Someone telling us to back off gets one short acknowledgement, then silence.
    const dismissText = `${message?.content ?? ''}\n${message?.raw?.content ?? ''}`;
    if (DISMISS_PATTERN.test(dismissText) && !this.#nameMentionPattern?.test(dismissText)) {
      this.#engageMapDelete(key, message?.senderId);
      if (!alreadyRecorded) {
        await this.#state.markSeen(messageId);
        this.#status.messagesReceived += 1;
        this.#status.lastMessageAt = new Date().toISOString();
      }
      const ack = pickDismissAck();
      await this.#bot.sendText(message.replyTarget, ack).catch(() => undefined);
      this.#status.messagesReplied += 1;
      this.#status.lastReplyAt = new Date().toISOString();
      return;
    }
    // Non-owner spam: repeating the same line, or flooding, gets silence.
    if (this.#shouldIgnoreSpam(message, key)) {
      await markMessageSeen().catch(() => undefined);
      return;
    }
    if (!watchMode && !forceReply && !this.#shouldReply(message, key)) return;
    if (!this.#allowBotReply(message, key)) return;

    const target = message.replyTarget;
    const promptMessage = preparedMessage
      ?? qqInboundMessage(message, { fetchImpl: this.#fetchImpl });
    const quoteScope = qqConversationScope(message);
    if (Array.isArray(promptMessage.images) && promptMessage.images.length > 0) {
      promptMessage.images = captureQuotedMedia(quoteScope, messageId, promptMessage.images, { kind: 'image' });
    }
    if (Array.isArray(promptMessage.files) && promptMessage.files.length > 0) {
      promptMessage.files = captureQuotedMedia(quoteScope, messageId, promptMessage.files, { kind: 'file' });
    }
    await this.#attachQuotedMedia(message, promptMessage);
    let text = promptMessage.content;
    const hasImages = hasInboundImages(promptMessage);    const hasFiles = hasInboundFiles(promptMessage);
    const hasReply = hasReplyReference(promptMessage);
    let stream = null;
    let batchSettled = batchSubmission === null;
    try {
      if (!text && !hasImages && !hasFiles && !hasReply) {
        await this.#bot.sendText(target, t('目前支持文字、图片和文件消息。'));
        await markMessageSeen();
        return;
      }
      const command = text.toLowerCase();
      if (!hasImages && !hasFiles && command === '/help') {
        await this.#bot.sendText(target, helpText());
        await markMessageSeen();
        return;
      }
      if (!hasImages && !hasFiles && command === '/status') {
        await this.#harness.ensureRunning({ signal: this.#signal });
        await this.#bot.sendText(target, t('QQ 机器人与 DeepSeek Harness 连接正常。'));
        await markMessageSeen();
        return;
      }
      if (!hasImages && !hasFiles && command === '/new') {
        await this.#state.clearSession(key);
        await this.#bot.sendText(target, t('已开启新会话。请发送你的问题。'));
        await markMessageSeen();
        return;
      }
      const clearCommand = await runClearCommand(text, this.#harness, this.#state, key, {
        signal: this.#signal,
        hasImages,
        hasFiles,
        pendingInteraction: this.#pendingInteractions.has(key) || this.#approvals.hasPending(key),
        busy: this.#queues.has(key),
      });
      if (clearCommand) {
        await this.#bot.sendText(target, clearCommand.message);
        await markMessageSeen();
        return;
      }
      const workspaceCommand = hasImages || hasFiles
        ? null
        : await runWorkspaceCommand(text, this.#harness, key);
      if (workspaceCommand) {
        for (const reply of workspaceCommand.messages ?? [workspaceCommand.message]) {
          await this.#bot.sendText(target, reply);
        }
        await markMessageSeen();
        return;
      }
      const compactCommand = hasImages || hasFiles
        ? null
        : await runCompactCommand(
            text,
            this.#harness,
            this.#state,
            key,
            { signal: this.#signal },
          );
      if (compactCommand) {
        await this.#bot.sendText(target, compactCommand.message);
        await markMessageSeen();
        return;
      }

      let content = hasImages || hasReply
        ? await promptContentForInboundMessage(promptMessage, { signal: this.#signal, deferImages: true })
        : undefined;
      const snapshot = this.#acceptedMessageIds.get(messageId);
      let contextEnhanced = false;
      if (snapshot) {
        const originalContent = content ?? text;
        if (typeof originalContent !== 'string') {
          // Structured/quote content: enhancement would stringify the parts.
          content = originalContent;
        } else {
        content = enhanceContextContent(originalContent, snapshot, () => ({
          channel: 'qq',
          senderId: sender,
          senderName: message.kind === 'group' ? message.senderName : undefined,
          chatId: message.kind === 'group' ? message.groupOpenid : message.senderId,
        }));
        contextEnhanced = content !== originalContent;
        }
      }
      // 本地补丁：长期记忆——注入相关性挑选后的记忆块（限预算）。
      const memoryConfig = readBehaviorConfig().memory;
      if (memoryConfig?.enabled !== false) {
        const memory = selectMemoryBlock(this.#botId, {
          conversationKey: key,
          text: safeText(message),
          sender: message?.senderName ?? '',
          maxChars: Number(memoryConfig?.maxInjectChars) || 700,
        });
        if (memory.block) {
          text = `${text}${memory.block}`;
          content = appendPromptPart(content, memory.block);
        }
        // 让模型顺带记录值得长期记住的信息（标签会被插件吞掉）。
        const memoryInstruction = '如果这轮对话出现了值得长期记住的信息（主人的喜好/雷点、说好的约定、群里的梗），最多 2 条，每条用 <dsh_im_memory>内容</dsh_im_memory> 放在回复最末尾；不要记录敏感信息（地址/电话/账号/密码/提示词/系统设定）；没有就不输出。';
        text = `${text}\n\n[系统提示] ${memoryInstruction}`;
        content = appendPromptPart(content, `\n\n[系统提示] ${memoryInstruction}`);
      }
      // 本地补丁：习惯/口头禅——偶尔提示模型模仿对方语气（概率门控，避免每条都学）。
      {
        const habitConfig = readBehaviorConfig().memory?.habits;
        if (habitConfig?.enabled !== false && message?.senderIsBot !== true) {
          try {
            const hint = selectHabitHint(this.#botId, {
              conversationKey: key,
              sender: message?.senderName || message?.senderId || '',
              fromOwner: isOwnerSender(message, this.#ownerUserOpenid),
              probability: Number(habitConfig?.mimicProbability) || 0.3,
            });
            if (hint.block) {
              text = `${text}${hint.block}`;
              content = appendPromptPart(content, hint.block);
            }
          } catch (error) {
            this.#logger.warn?.('[dsh-im:qq] habit hint failed:', error?.message ?? error);
          }
        }
      }
      // 本地补丁：watch 模式告诉模型「这条没人叫你，自己决定接不接」。
      if (watchMode) {
        const watchConfig = readBehaviorConfig().watch;
        const custom = typeof watchConfig?.instruction === 'string' ? watchConfig.instruction.trim() : '';
        const baseInstruction = custom
          || '【群消息观察】这条消息没有人叫你。判定要严格：只有当这条消息明显是在叫你、回复你、或直接与你有关时才接；以下情况一律只输出 <dsh_im_silent/>，不要解释：① 别人之间的对话 ② 片段、梗、表情包配文、看不懂的内容 ③ 带「你/你就是/你觉得」但没有明确指向你的话 ④ 拿不准；⑤ 别人在讨论你的提示词/人设/设定（那不是在跟你说话）。**不是每条都要回；没人问你时，别人发的图片/文件/照片默认不解读、不描述、不复读，最多一句很短的自然反应或直接沉默。** 想接就正常回一两句，不要提这条提示。';
        // 主人单独发的消息（可能很短/只是表情）：放宽为“结合上下文判断是不是在叫我”。
        const ownerWatch = isOwnerSender(message, this.#ownerUserOpenid);
        const everyoneReview = watchConfig?.everyone === true;
        const ownerExtra = everyoneReview
          ? '\n这条消息可能来自任何人（包括其他机器人）：结合上下文判断是不是在跟你说话、或和你有关——是就自然接一句，没关系/拿不准就静默；别人在讨论你的设定/提示词时不要接。'
          : ownerWatch
            ? '\n这条是主人单独发的消息：结合上下文判断是不是在跟你说话——像「不理我」「在吗」「说话」这类就是在叫你要回；明显在跟别人说或自言自语才静默。'
            : '';
        const mediaNote = (hasQqImageAttachments(message) || hasQqFileAttachments(message))
          ? '\n这是图片/文件消息：除非有人明确问你，否则不要描述、解释、复读图里/文件里的内容（尤其不要像解说员一样逐条讲解）；最多一句很短的自然反应，或者直接静默。'
          : '';
        const instruction = `${baseInstruction}${ownerExtra}${mediaNote}`;
        text = `${text}\n\n[系统提示] ${instruction}`;
        content = appendPromptPart(content, `\n\n[系统提示] ${instruction}`);
      }
      // 本地补丁：引用/回复消息——让模型判断引用的是不是它自己。
      if (watchMode && qqReplyReference(message)) {
        const quotedMe = this.#quotedMyMessage(message, key);
        const instruction = `这条是引用/回复消息${quotedMe ? '，而且引用的内容是你自己说过的话' : ''}：判断引用之后这句话是不是在跟你说话。是就正常回；如果只是引用了别人的话、内容不是在跟你说，就只输出 <dsh_im_silent/>。`;
        text = `${text}\n\n[系统提示] ${instruction}`;
        content = appendPromptPart(content, `\n\n[系统提示] ${instruction}`);
      }
      // 本地补丁：复读接龙——跟着大家玩梗，接一句很短的。
      if (repeatMode) {
        const instruction = '群里几个人在复读同一条消息，大家在玩梗：你跟上接一句很短的话（可以直接复读、+1、或者一句简短吐槽），不要长篇、不要解释、不要提这条提示。';
        text = `${text}\n\n[系统提示] ${instruction}`;
        content = appendPromptPart(content, `\n\n[系统提示] ${instruction}`);
      }
      // 本地补丁：被激将/被怼时提示模型这次优先用语音（连发 1~2 条），别只发文字。
      if (!watchMode) {
        const provokeText = `${message?.content ?? ''}\n${message?.raw?.content ?? ''}`;
        if (PROVOKE_PATTERN.test(provokeText)) {
          const instruction = '对方在激你/怼你。按你的人设，这次**优先用语音回应**：输出 1~2 个 <dsh_im_voice>短句</dsh_im_voice>（可以再补一句很短文字），不要只用文字顶回去。';
          text = `${text}\n\n[系统提示] ${instruction}`;
          content = appendPromptPart(content, `\n\n[系统提示] ${instruction}`);
        }
      }
      // 本地补丁：真正被点名（名字/@）时，不让模型用「不抢话」当理由沉默。
      if (explicitTurn && !watchMode && message.kind === 'group' && !PROMPT_TALK_PATTERN.test(safeText(message))) {
        const instruction = '【点名】这条消息明确叫到了你（名字/@你）。不要拿「不抢话/不是在跟我说话」当理由装死——正常回一句；只有内容明显和你无关时才静默。';
        text = `${text}\n\n[系统提示] ${instruction}`;
        content = appendPromptPart(content, `\n\n[系统提示] ${instruction}`);
      }
      // 本地补丁：接话窗口续聊——每条都做一次轻量判断，聊完/转向别人就别硬接。
      if (engagedTurn && !watchMode && !repeatMode) {
        const instruction = '这条来自刚才在跟你聊天的人（接话窗口）。先轻量判断：如果对方已经转向别人、在跟别人说、或明显收尾，就只输出 <dsh_im_silent/>；如果还在跟你聊，就正常接。';
        text = `${text}\n\n[系统提示] ${instruction}`;
        content = appendPromptPart(content, `\n\n[系统提示] ${instruction}`);
      }
      // 本地补丁（2026-10-24）：注入最近群聊，帮助模型判断「这句话在回谁」。
      // QQ 的引用/回复不一定拿得到，群聊顺序往往才是可靠线索。
      if (message.kind === 'group') {
        const chatBlock = this.#recentChatBlock(key, message);
        if (chatBlock) {
          text = `${chatBlock}\n\n${text}`;
          if (Array.isArray(content)) content = [{ type: 'text', text: chatBlock }, ...content];
          else if (typeof content === 'string') content = `${chatBlock}\n\n${content}`;
        }
      }
      // QQ stream_messages can acknowledge a final frame without rendering it in
      // some C2C clients. Standard Markdown delivery is the reliable reply path.
      const toolErrors = [];
      // 本地补丁：模型可能把 <dsh_im_silent/> 当成工具调用（不存在），
      // 这时不向群里报错，按「静默」语义处理。
      let attemptedSilentTool = false;
      let answer;
      let artifacts = [];
      try {
        // Persist consumption before handing the prompt to Harness. Provider
        // redelivery after a failed error notice must never execute it twice.
        await markMessageSeen();
        // The prompt is about to enter the Harness inbox, which is itself
        // durable. Marking the entry submitted first means a crash after this
        // point reports the message instead of replaying a turn the Harness may
        // already own.
        await this.#markPendingSubmitted(key, messageId);
        ({ answer, artifacts = [] } = await askInWorkspaceSession({
          deferredDelivery: () => ({ coordinator: this.#deferred, target: { scope: target.scope, targetId: target.targetId } }),
          harness: this.#harness,
          state: this.#state,
          key,
          text,
          content,
          titleText: batchSubmission?.title,
          sourceGuidance: applyPersona(snapshot?.config?.guidance, { botId: this.#botId }),
          contextEnhanced,
          createOptions: { signal: this.#signal },
          existsOptions: { signal: this.#signal },
          askOptions: {
            groupHistory: message.groupHistory,
            timeoutMs: this.#replyTimeoutMs,
            signal: this.#signal,
            control: { owner: this, key },
            progressMode: 'all',
            finalAnswerOnly: true,
            onUpdate: (update) => {
              if (!update.error) return;
              const rawName = nonEmptyString(update.toolName) ?? '';
              // 文本标签被误当成工具：静默/表情类都吞掉，不往群里发错误提示。
              if (/^dsh_im_(?:silent|sticker|voice|sticker_tag|sticker_reject)$/u.test(rawName)) {
                if (rawName === 'dsh_im_silent') attemptedSilentTool = true;
                this.#logger.info?.(`[dsh-im:qq] model used a virtual tag as a tool call: ${rawName}`);
                return;
              }
              const name = (rawName || t('工具'))
                .replace(/[\r\n]+/gu, ' ')
                .slice(0, 80);
              toolErrors.push(t(
                '工具调用「{name}」未成功，请检查工具配置或稍后重试。',
                { name },
              ));
            },
            onInteraction: (interaction) => this.#handleInteraction(interaction, {
              key,
              actor: sender,
              target,
              requiresMention: message.kind === 'group',
            }),
            onInteractionResolved: (resolution) => this.#handleInteractionResolved(resolution),
            files: promptMessage.files,
            images: promptMessage.images,
          },
        }));
        if (batchSubmission) {
          this.#batchInputs.complete(key, batchSubmission.token);
          batchSettled = true;
        }
      } finally {
        await Promise.allSettled([
          this.#cancelPendingInteraction(key),
          this.#approvals.closeRoute(key),
        ]);
      }
      this.#signal?.throwIfAborted();
      const answerText = answerTextForDelivery(answer, artifacts);
      // 本地补丁：每次模型调用记一笔估算成本（每日预算安全阀）。
      chargeBudget(
        this.#botId,
        watchMode ? readBehaviorConfig().budget?.watchCny : readBehaviorConfig().budget?.replyCny,
      );
      // Natural-language media: the model wraps what it wants sent in
      // <dsh_im_voice>…</dsh_im_voice> / <dsh_im_sticker>…</dsh_im_sticker>; the
      // plugin turns those into a real QQ voice message and a sticker image.
      // Any sender may ask for either; the tags never reach the user.
      const mediaIntent = extractMediaIntent(answerText);
      // 本地补丁：先落长期记忆（即使后面沉默也保存）。
      if (Array.isArray(mediaIntent.memoryNotes) && mediaIntent.memoryNotes.length > 0) {
        const memoryConfig = readBehaviorConfig().memory;
        if (memoryConfig?.enabled !== false) {
          try {
            captureFacts(this.#botId, {
              conversationKey: key,
              notes: mediaIntent.memoryNotes,
              fromOwner: isOwnerSender(message, this.#ownerUserOpenid),
              sender: message?.senderName ?? '',
              source: 'tag',
            });
          } catch (error) {
            this.#logger.warn?.('[dsh-im:qq] memory capture failed:', error?.message ?? error);
          }
        }
      }
      // 本地补丁：口头禅语气标签（每日摘要/模型判断）写回习惯记忆。
      if (Array.isArray(mediaIntent.habitTones) && mediaIntent.habitTones.length > 0) {
        for (const raw of mediaIntent.habitTones) {
          const [phrasePart, tonePart] = String(raw).split(/[|｜]/u).map((part) => part.trim());
          if (!phrasePart || !tonePart) continue;
          try {
            setHabitTone(this.#botId, {
              conversationKey: key,
              sender: message?.senderName || message?.senderId || '',
              phrase: phrasePart.replace(/[「」『』"']/gu, ''),
              tone: tonePart,
              fromOwner: isOwnerSender(message, this.#ownerUserOpenid),
            });
          } catch (error) {
            this.#logger.warn?.('[dsh-im:qq] habit tone update failed:', error?.message ?? error);
          }
        }
      }
      const hasVoiceIntent = Array.isArray(mediaIntent.voiceTexts) && mediaIntent.voiceTexts.length > 0;
      if (mediaIntent.silent && !hasVoiceIntent && !mediaIntent.stickerQuery) {
        this.#logger.info?.('[dsh-im:qq] model chose silence');
        if (!watchMode && message.kind === 'group' && message.senderIsBot !== true) {
          if (this.#noteEngagementMiss(key, sender)) {
            this.#logger.info?.('[dsh-im:qq] engagement window closed after repeated silence');
          }
        }
        this.#logOutcome(message, key, { action: 'silent', reason: 'model-silent', engagedTurn });
        return;
      }
      // 模型把 <dsh_im_silent/> 当成工具调用（不存在）时：视为静默，不报错、不发消息。
      if (attemptedSilentTool && !mediaIntent.text && !hasVoiceIntent
        && mediaIntent.stickerQuery === null
        && mediaIntent.stickerTags.length === 0
        && mediaIntent.stickerReject === false) {
        this.#logger.info?.('[dsh-im:qq] model chose silence (dsh_im_silent used as a tool call)');
        if (!watchMode && message.kind === 'group' && message.senderIsBot !== true) {
          if (this.#noteEngagementMiss(key, sender)) {
            this.#logger.info?.('[dsh-im:qq] engagement window closed after repeated silence');
          }
        }
        this.#logOutcome(message, key, { action: 'silent', reason: 'model-silent-tool', engagedTurn });
        return;
      }
      // AI 识图后的表情判决：补标签 / 不合人设就删掉自动收藏。
      if (mediaIntent.stickerTags.length > 0 || mediaIntent.stickerReject) {
        await this.#applyStickerVerdict(key, mediaIntent).catch((error) => {
          this.#logger.warn?.('[dsh-im:qq] sticker verdict failed:', error?.message ?? error);
        });
      }
      const textAnswer = mediaIntent.text;
      const displayAnswer = toolErrors.length > 0
        ? `${textAnswer}\n\n---\n\n${toolErrors.join('\n\n')}`.trim()
        : textAnswer;
      let voiceFailure = null;
      let stickerFailure = null;
      // 本地补丁：一次回复里可以有 1~3 条语音（被逼急时连发）。
      const voiceTexts = Array.isArray(mediaIntent.voiceTexts) && mediaIntent.voiceTexts.length > 0
        ? mediaIntent.voiceTexts
        : (mediaIntent.voiceText ? [mediaIntent.voiceText] : []);
      if (voiceTexts.length > 0) {
        let voiceSettings;
        try {
          voiceSettings = await readVoiceSettings({ botId: this.#botId });
        } catch (error) {
          this.#logger.warn?.('[dsh-im:qq] unable to read voice settings; using defaults:', error?.message ?? error);
        }
        for (const [voiceIndex, voiceText] of voiceTexts.entries()) {
          this.#signal?.throwIfAborted();
          if (voiceIndex > 0) {
            await new Promise((resolve) => setTimeout(resolve, 250 + Math.floor(Math.random() * 450)));
            this.#signal?.throwIfAborted();
          }
          try {
            const { silk, durationMs, provider } = await synthesizeSpeechSilk(voiceText, {
              signal: this.#signal,
              settings: voiceSettings,
            });
            await sendQqVoice(this.#bot, target, {
              bytes: silk,
              fileName: `voice-${voiceIndex + 1}.silk`,
              mediaType: 'audio/silk',
            }, { signal: this.#signal, timeoutMs: this.#fileUploadTimeoutMs });
            this.#status.messagesReplied += 1;
            this.#status.lastReplyAt = new Date().toISOString();
            this.#logger.info?.(
              `[dsh-im:qq] natural-language voice ${voiceIndex + 1}/${voiceTexts.length} sent (${durationMs} ms, ${provider})`,
            );
          } catch (error) {
            this.#logger.warn?.('[dsh-im:qq] natural-language voice failed:', error?.message ?? error);
            voiceFailure = voiceFailureMessage(error);
            break;
          }
        }
        // 本地补丁：语音回复也记进最近群聊，让下一轮上下文里能看到「刚才是我说的」。
        if (message.kind === 'group') {
          this.#rememberOwnChat(key, `[语音] ${voiceTexts.join(' / ')}`);
        }
      }
      if (mediaIntent.stickerQuery !== null) {
        try {
          const sticker = await pickSticker(mediaIntent.stickerQuery);
          if (!sticker) throw new Error('sticker library is empty');
          await sendQqImage(this.#bot, target, {
            bytes: sticker.bytes,
            fileName: sticker.name,
            mediaType: sticker.mediaType,
          }, { signal: this.#signal, timeoutMs: this.#fileUploadTimeoutMs });
          this.#status.messagesReplied += 1;
          this.#status.lastReplyAt = new Date().toISOString();
          this.#logger.info?.(`[dsh-im:qq] sticker sent (${sticker.mediaType}, ${sticker.bytes.length} B)`);
        } catch (error) {
          this.#logger.warn?.('[dsh-im:qq] sticker failed:', error?.message ?? error);
          stickerFailure = t('表情包没发出去：{reason}', { reason: error?.message ?? String(error) });
        }
      }
      let textReceipt = null;
      let textSendError = null;
      try {
        let streamFinished = false;
        if (stream && displayAnswer) {
          try {
            await stream.update(displayAnswer);
            streamFinished = true;
            textReceipt = createDeliveryReceipt({
              deliveryId: messageId,
              presentation: 'qq-text',
              providerMessageIds: providerMessageIdsFor(stream),
            });
            try {
              await stream.complete();
            } catch (error) {
              this.#logger.warn?.('[dsh-im:qq] QQ stream completion failed after visible final content:', error);
            }
          } catch (error) {
            stream.cancel?.();
            this.#logger.warn?.('[dsh-im:qq] QQ stream update failed; using markdown fallback:', error);
          }
        }
        if (!streamFinished && displayAnswer) {
          // Local patch (2026-10-24): chat replies are delivered one short
          // message at a time instead of one long bubble. Long paragraphs,
          // code blocks, tables and URLs still take the normal path.
          const chunking = readBehaviorConfig().replyChunking;
          const chatSegments = chunking?.enabled
            ? splitChatSegments(displayAnswer, {
              maxChars: chunking.maxChars,
              maxSegments: chunking.maxSegments,
            })
            : null;
          const deliveries = await sendMarkdownReply(this.#bot, target, displayAnswer, {
            logger: this.#logger,
            ...(chatSegments
              ? {
                segments: chatSegments,
                segmentGap: { minMs: chunking.gapMinMs, maxMs: chunking.gapMaxMs },
              }
              : {}),
          });
          // 本地补丁：记住自己发过的话，之后有人引用它就能识别为「在回复我」；
          // 同时记进最近群聊，让下一轮能看见「刚才是我说的」。
          this.#rememberBotText(key, displayAnswer);
          if (message.kind === 'group') this.#rememberOwnChat(key, displayAnswer);
          // 本地补丁：watch/复读接话成功后进入短接话窗口（同一个人后续聊能跟上）。
          if ((watchMode || repeatMode) && message.kind === 'group' && message.senderIsBot !== true) {
            this.#markEngaged(key, sender, 'watch');
          }
          this.#logOutcome(message, key, {
            action: 'sent',
            reason: repeatMode ? 'repeat-replied' : watchMode ? 'watch-replied' : 'replied',
            engagedTurn,
          });
          textReceipt = createDeliveryReceipt({
            deliveryId: messageId,
            presentation: 'qq-text',
            providerMessageIds: deliveries.flatMap((delivery) => providerMessageIdsFor(delivery)),
          });
        }
      } catch (error) {
        textSendError = channelDeliveryFailure(error);
        this.#logger.warn?.('[dsh-im:qq] final text delivery failed; continuing with result files:', error);
      }
      const delivery = await this.#deliverArtifacts(target, messageId, artifacts, textReceipt);
      if (voiceFailure) {
        await this.#bot.sendText(target, t('语音没发出去：{reason}', { reason: voiceFailure }))
          .catch(() => undefined);
      }
      if (stickerFailure) {
        await this.#bot.sendText(target, stickerFailure).catch(() => undefined);
      }
      const artifactDispatched = delivery.receipt?.artifacts?.some(
        ({ outcome }) => outcome === 'sent' || outcome === 'unknown',
      );
      if (textSendError && !artifactDispatched && !delivery.failureNoticeVisible) {
        throw textSendError;
      }
      if (textSendError && delivery.artifactSendErrors === 0) {
        setLastMessageFailure(this.#status, textSendError);
      }
      this.#status.messagesReplied += 1;
      this.#status.lastReplyAt = new Date().toISOString();
      this.#status.lastError = null;
      if (!textSendError && delivery.artifactSendErrors === 0) {
        clearLastMessageFailure(this.#status);
      }
      return delivery.receipt;
    } catch (error) {
      let batchFailureMessage = null;
      if (!batchSettled && batchSubmission) {
        if (error?.code === 'turn-stopped') {
          this.#batchInputs.complete(key, batchSubmission.token);
        } else {
          batchFailureMessage = this.#batchInputs.fail(key, batchSubmission.token).message ?? null;
        }
        batchSettled = true;
      }
      if (error?.code === 'turn-stopped') {
        try {
          stream?.cancel?.();
        } catch (streamError) {
          this.#logger.warn?.('[dsh-im:qq] unable to cancel a stopped QQ stream:', streamError);
        }
        try {
          await this.#bot.sendText(target, t('已停止。'));
        } catch (sendError) {
          this.#logger.warn?.('[dsh-im:qq] unable to announce a stopped QQ turn:', sendError);
        }
        await markMessageSeen();
        return;
      }
      try {
        stream?.cancel?.();
      } catch (streamError) {
        this.#logger.warn?.('[dsh-im:qq] unable to cancel a failed QQ stream:', streamError);
      }
      if (this.#signal?.aborted) return;
      this.#status.lastError = error?.message ?? String(error);
      const userMessage = inboundFileUserMessage(error)
        ?? imagePromptUserMessage(error);
      const failure = setLastMessageFailure(this.#status, error, {
        userMessage,
        reason: imagePromptDiagnostic(error)?.reason,
      });
      this.#logger.error?.(
        `[dsh-im:qq] failed to process an inbound message [${failure.referenceId}]:`,
        messageFailureDiagnostic(error, failure),
      );
      void appendFailureLog({
        referenceId: failure.referenceId,
        reason: failure.reason,
        userMessage: failure.userMessage,
        code: error?.code,
        message: typeof error?.message === 'string' ? error.message.slice(0, 2000) : String(error),
        stage: error?.diagnostic?.stage ?? error?.details?.stage,
        diagnostic: messageFailureDiagnostic(error, failure),
        target: target?.scope ? { scope: target.scope } : undefined,
      });
      try {
        const errorMessage = messageFailureText(failure);
        await this.#bot.sendText(
          target,
          batchFailureMessage ? `${errorMessage}\n\n${batchFailureMessage}` : errorMessage,
        );
        await markMessageSeen();
      } catch (sendError) {
        this.#logger.error?.('[dsh-im:qq] failed to send the safe error reply:', sendError);
      }
    }
  }

  async #processInteractionReply(message, messageId, key, expected) {
    this.#signal?.throwIfAborted();
    const current = this.#pendingInteractions.get(key);
    const claimed = expected.claimedReplyMessageId === messageId;
    if (!current || current !== expected || current.submitting) {
      if (claimed && (!current || current !== expected)) {
        return this.#discardResolvedInteractionReply(message, messageId);
      }
      return this.#enqueueMessage(message, messageId, key, { releaseMessageId: false });
    }
    if (this.#state.hasSeen(messageId)) return;
    await this.#state.markSeen(messageId);
    this.#status.messagesReceived += 1;
    this.#status.lastMessageAt = new Date().toISOString();

    if (!isQqMessageAddressed(message)) return;
    const text = nonEmptyString(safeText(message));
    if (!text || hasQqImageAttachments(message) || hasQqFileAttachments(message)) {
      await this.#bot.sendText(message.replyTarget, t('请用文字回答当前问题。'));
      return;
    }

    const pending = this.#pendingInteractions.get(key);
    if (!pending || pending !== expected || pending.submitting) {
      if (claimed && (!pending || pending !== expected)) {
        await this.#bot.sendText(message.replyTarget, interactionResolvedText());
        return;
      }
      return this.#enqueueMessage(message, messageId, key, {
        releaseMessageId: false,
        alreadyRecorded: true,
      });
    }
    pending.target = message.replyTarget;
    if (pending.needsPresentation) {
      try {
        await this.#presentInteraction(pending);
      } catch {
        this.#status.lastError = t('QQ 交互问题发送失败。');
        this.#logger.error?.('[dsh-im:qq] failed to retry an interaction question');
        pending.interaction.reconnect?.();
        return;
      }
      const presentedPending = this.#pendingInteractions.get(key);
      if (!presentedPending || presentedPending !== expected || presentedPending.submitting) {
        if (claimed && (!presentedPending || presentedPending !== expected)) {
          await this.#bot.sendText(message.replyTarget, interactionResolvedText())
            .catch(() => undefined);
          return;
        }
        return this.#enqueueMessage(message, messageId, key, {
          releaseMessageId: false,
          alreadyRecorded: true,
        });
      }
    }

    const question = pending.questions[pending.index];
    if (!question) return;
    pending.answers.push(harnessAnswerForQuestion(question, text));
    pending.index += 1;
    if (pending.index < pending.questions.length) {
      if (pending.claimedReplyMessageId === messageId) {
        pending.claimedReplyMessageId = null;
      }
      pending.needsPresentation = true;
      try {
        await this.#presentInteraction(pending);
      } catch {
        this.#status.lastError = t('QQ 交互问题发送失败。');
        this.#logger.error?.('[dsh-im:qq] failed to send the next interaction question');
        pending.interaction.reconnect?.();
      }
      return;
    }

    pending.submitting = true;
    try {
      await pending.interaction.respond({
        ok: true,
        value: {
          sessionId: pending.sessionId,
          answer: { answers: pending.answers },
        },
      });
      this.#clearPendingInteraction(key, pending.interactionId);
      this.#status.lastError = null;
    } catch (error) {
      if (this.#signal?.aborted) return;
      if (error?.code === 'interaction-not-pending') {
        this.#clearPendingInteraction(key, pending.interactionId);
        await this.#bot.sendText(pending.target, interactionResolvedText()).catch(() => undefined);
        return;
      }
      if (this.#pendingInteractions.get(key) !== pending) return;
      pending.submitting = false;
      pending.answers.pop();
      pending.index -= 1;
      this.#status.lastError = t('回答提交失败。');
      this.#logger.error?.('[dsh-im:qq] failed to answer a Harness interaction');
      await this.#bot.sendText(pending.target, t('回答提交失败，请重新发送当前问题的答案。'))
        .catch(() => undefined);
    }
  }

  async presentSessionSyncApproval(interaction, context, options = {}) {
    return this.#approvals.handleSessionSyncRequested(interaction, context, {
      ...options, runtimeSignal: this.#signal, accessPolicy: this.#accessPolicy,
    });
  }

  async #handleInteraction(interaction, {
    key,
    actor,
    target,
    requiresMention,
  }) {
    if (interaction?.kind === 'approval') {
      return this.#approvals.handleRequested(interaction, {
        key,
        actor,
        requiresMention,
        send: (text) => this.#bot.sendText(target, text),
      });
    }
    if (interaction?.kind !== 'question') return;
    const questions = interaction?.payload?.questions;
    const interactionId = typeof interaction?.interactionId === 'string'
      ? interaction.interactionId
      : interaction?.rpcId;
    if (typeof interaction?.rpcId !== 'string'
      || typeof interactionId !== 'string'
      || typeof interaction.sessionId !== 'string'
      || !Array.isArray(questions)
      || questions.length === 0
      || questions.some((question) => !validHarnessQuestion(question))) {
      this.#logger.warn?.('[dsh-im:qq] ignored an invalid Harness question interaction');
      return;
    }

    if (interaction.recovered === true) {
      await interaction.respond({
        ok: false,
        error: {
          code: 'cancelled',
          message: 'QQ safely cancelled an interaction left by an earlier client.',
          details: {},
        },
      });
      await this.#bot.sendText(
        target,
        t('检测到这个 Session 中遗留的待回答问题，已安全取消并继续处理你刚才的消息。'),
      ).catch(() => undefined);
      return;
    }

    const existing = this.#pendingInteractions.get(key);
    if (existing?.interactionId === interactionId) {
      existing.interaction = interaction;
      if (existing.needsPresentation) await this.#presentInteraction(existing);
      return;
    }
    if (this.#interactionKeys.has(interactionId)) return;
    if (existing) {
      await interaction.respond({
        ok: false,
        error: {
          code: 'cancelled',
          message: 'QQ is already handling another user interaction.',
          details: {},
        },
      });
      return;
    }

    const pending = {
      kind: 'question',
      interactionId,
      sessionId: interaction.sessionId,
      interaction,
      actor,
      requiresMention,
      questions,
      answers: [],
      index: 0,
      target,
      queue: null,
      claimedReplyMessageId: null,
      presentationPromise: null,
      submitting: false,
      needsPresentation: true,
    };
    this.#pendingInteractions.set(key, pending);
    this.#interactionKeys.set(interactionId, key);
    await this.#presentInteraction(pending);
  }

  async #handleInteractionResolved(resolution) {
    if (resolution?.kind === 'approval') {
      await this.#approvals.handleResolved(resolution);
      return;
    }
    const interactionId = resolution?.interactionId;
    if (resolution?.kind !== 'question' || typeof interactionId !== 'string') return;
    const key = this.#interactionKeys.get(interactionId);
    if (!key) return;
    this.#clearPendingInteraction(key, interactionId);
  }

  #presentInteraction(pending) {
    if (!pending.needsPresentation) return Promise.resolve();
    if (pending.presentationPromise) return pending.presentationPromise;
    const question = pending.questions[pending.index];
    if (!question) return Promise.resolve();
    const presentation = this.#bot.sendText(
      pending.target,
      harnessQuestionText(
        question,
        pending.index,
        pending.questions.length,
        { requiresMention: pending.requiresMention },
      ),
    ).then(() => {
      pending.needsPresentation = false;
    }).finally(() => {
      if (pending.presentationPromise === presentation) pending.presentationPromise = null;
    });
    pending.presentationPromise = presentation;
    return presentation;
  }

  async #discardResolvedInteractionReply(message, messageId) {
    if (this.#state.hasSeen(messageId)) return;
    await this.#state.markSeen(messageId);
    this.#status.messagesReceived += 1;
    this.#status.lastMessageAt = new Date().toISOString();
    await this.#bot.sendText(message.replyTarget, interactionResolvedText()).catch(() => undefined);
  }

  #takePendingInteraction(key, interactionId) {
    const pending = this.#pendingInteractions.get(key);
    if (!pending
      || (interactionId !== undefined && pending.interactionId !== interactionId)) return null;
    this.#pendingInteractions.delete(key);
    this.#interactionKeys.delete(pending.interactionId);
    return pending;
  }

  #clearPendingInteraction(key, interactionId) {
    return this.#takePendingInteraction(key, interactionId) !== null;
  }

  async #cancelPendingInteraction(key) {
    const pending = this.#takePendingInteraction(key);
    if (!pending || pending.kind !== 'question') return;
    try {
      await pending.interaction.respond({
        ok: false,
        error: {
          code: 'cancelled',
          message: 'The QQ interaction ended before the user answered.',
          details: {},
        },
      }, { signal: AbortSignal.timeout(5_000) });
    } catch (error) {
      if (error?.code !== 'interaction-not-pending') {
        this.#logger.warn?.('[dsh-im:qq] failed to cancel a pending Harness interaction');
      }
    }
  }

  async #handleInteractionFailure(message, messageId, error) {
    if (this.#signal?.aborted) return;
    this.#status.lastError = error?.message ?? String(error);
    const failure = setLastMessageFailure(this.#status, error);
    this.#logger.error?.(
      `[dsh-im:qq] failed to process an interaction reply [${failure.referenceId}]:`,
      messageFailureDiagnostic(error, failure),
    );
    if (!this.#state.hasSeen(messageId)) {
      await this.#state.markSeen(messageId).catch(() => undefined);
    }
    await this.#bot.sendText(message.replyTarget, messageFailureText(failure))
      .catch(() => undefined);
  }
}
