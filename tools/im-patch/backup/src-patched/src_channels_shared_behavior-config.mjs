// Local patch-set behavior config: reply chunking / sticker auto-collect / proactive messages.
//
// One file for every runtime knob so tuning never needs a rebuild:
//   <DSH_HOME>/integrations/dsh-im/behavior.json
//
// Everything here is optional; a missing or malformed file falls back to the
// defaults below, and individual sections merge over them (partial files work).
// Read on each use with an mtime cache, so edits apply to the next message.
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const BEHAVIOR_FILE_NAME = 'behavior.json';

export function behaviorConfigPath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(home, 'integrations', 'dsh-im', BEHAVIOR_FILE_NAME);
}

/**
 * Defaults mirror the operator's policy: short chat replies split into at most
 * three messages, only GIF/WebP/PNG stickers auto-collected from groups, and
 * three proactive windows (morning / lunch / dinner) that are off by default
 * until a bot + target list is configured.
 */
export const BEHAVIOR_DEFAULTS = Object.freeze({
  version: 1,
  // 2026-10-24：接话窗口（被点名后继续聊 / watch 触发后的短窗口）与结束条件。
  engagement: Object.freeze({
    explicitMinutes: 10,
    watchMinutes: 5,
    irrelevantMissLimit: 2,
    closingPatterns: Object.freeze([]),
    quietHours: Object.freeze({ start: 1, end: 7 }),
  }),
  // 2026-10-24：每 bot 每日成本预算（粗算安全阀）；超限后只回点名/引用/复读。
  budget: Object.freeze({
    dailyLimitCny: 3,
    replyCny: 0.006,
    watchCny: 0.004,
    bubbleCny: 0.006,
  }),
  // 2026-10-24：决策日志（/why）。
  decisionLog: Object.freeze({
    enabled: true,
    retentionDays: 30,
    textPrefix: 24,
  }),
  // 2026-10-25：B 站视频内容（字幕优先 + 本地 ASR 兜底；只取音频内容，不获取画面）。
  video: Object.freeze({
    enabled: true,
    subtitleEnabled: true,
    asrEnabled: true,
    sessdata: '',
    whisperModel: 'medium',
    whisperDevice: 'auto',
    maxDurationSeconds: 1800,
    maxTranscriptChars: 6000,
    cacheDays: 7,
    commentsEnabled: true,
    maxComments: 6,
    // 2026-10-25：异步 + 画面抽帧（关键词召回 + 模型判断；明确问画面才抽帧）。
    asyncEnabled: true,
    framesEnabled: true,
    framesCount: 4,
    framesMaxWidth: 512,
    framesTimeoutMs: 240000,
    downloadTimeoutMs: 180000,
    subtitleTimeoutMs: 120000,
    asrTimeoutMs: 600000,
  }),
  // 2026-10-24：长期记忆（标签抓取 + 每日摘要 + prompt 注入）。
  memory: Object.freeze({
    enabled: true,
    maxInjectChars: 700,
    captureLimitPerTurn: 2,
    retentionDays: 90,
    maxOwnerFacts: 80,
    maxFactsPerGroup: 60,
    digestEnabled: true,
    digestHour: 23,
    digestMinute: 30,
    // 2026-10-24：口头禅/习惯挖掘（高频短语统计 + 偶尔模仿语气）。
    habits: Object.freeze({
      enabled: true,
      minCount: 6,
      minCountFragment: 10,
      minDays: 2,
      maxShortChars: 16,
      maxCandidatesPerSender: 200,
      candidateTtlDays: 30,
      maxHabitsPerGroup: 10,
      maxOwnerHabits: 12,
      mimicProbability: 0.3,
    }),
  }),
  replyChunking: Object.freeze({
    enabled: true,
    maxChars: 20,
    maxSegments: 2,
    gapMinMs: 600,
    gapMaxMs: 600,
    // 2026-10-25：单句超过这个长度时按逗号兜底拆（只兜底，不常规拆逗号）。
    longSentenceLimit: 60,
  }),
  // 2026-10-24：同一人连发多条时先等一小会儿再一起回复（避免抢答第一句）。
  replyCoalesce: Object.freeze({
    enabled: true,
    settleMs: 2500,
    maxMessages: 6,
  }),
  stickerCollect: Object.freeze({
    enabled: true,
    scope: 'group',
    extensions: Object.freeze(['.gif', '.webp', '.png']),
    minBytes: 2048,
    maxBytes: 3 * 1024 * 1024,
    groups: Object.freeze([]),
    autoTag: true,
    maxTags: 2,
    perMinute: 1,
    perHour: 10,
    perDay: 40,
    maxLibrary: 800,
  }),
  watch: Object.freeze({
    enabled: false,
    // 所有人（含其他机器人）的消息都进入“看一眼”，由 AI 判断是否在跟它说话。
    everyone: false,
    groups: Object.freeze([]),
    direct: false,
    textOnly: true,
    minChars: 6,
    botIds: Object.freeze([]),
    minIntervalMs: 60000,
    maxPerHour: 4,
    maxPerDay: 30,
    topics: Object.freeze({}),
    // 图片/文件消息默认不主动“看一眼”解释：owner=只有主人发的才看，all=都看，none=都不看。
    mediaReview: 'owner',
    // 2026-10-24 “活跃群模式”：最近 N 分钟至少 M 条消息才 watch（配合清空 topics 使用）。
    activityWindowMinutes: 5,
    activityMinMessages: 3,
    // 复读接龙：同一段文字被 ≥N 个不同的人复读时，跟着接一句。
    repeatChainWindowMinutes: 5,
    repeatChainMinSenders: 2,
    repeatReplyCooldownMinutes: 10,
    // 别人在聊她的提示词/人设（不是跟她说话）时不接。
    skipPromptTalk: true,
    instruction: '',
  }),
  // 2026-10-25：线程窗口——机器人发言后的一小段时间内，其他人接话/反应优先交给模型判断。
  threadWindow: Object.freeze({
    enabled: true,
    seconds: 120,
    maxPerSender: 2,
    nudgeEnabled: true,
  }),
  proactive: Object.freeze({
    enabled: false,
    dailyTimes: Object.freeze(['07:45', '11:45', '17:45']),
    jitterMinutes: 25,
    windowMinutes: 90,
    quietMinutes: 30,
    minIntervalMinutes: 120,
    maxPerDay: 9,
    // 每个目标（每个群 / 私聊）自己的预算与冷却：一个目标发过不会挡住其他目标。
    minIntervalMinutesPerTarget: 120,
    maxPerDayPerTarget: 3,
    probability: 0.85,
    // 2026-10-24：AI 主动冒泡（群安静时让模型结合上下文自己说一句，而不是发模板）。
    aiBubbles: Object.freeze({
      enabled: false,
      includeDirect: false,
      checkIntervalMinutes: 45,
      jitterMinutes: 20,
      quietMinutes: 15,
      probability: 0.35,
      minIntervalMinutes: 60,
      maxPerDayPerTarget: 6,
      maxPerDay: 12,
      hours: Object.freeze({ start: 8, end: 23 }),
    }),
    bots: Object.freeze({}),
  }),
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Deep-merge a partial document over a defaults object (arrays replace). */
export function mergeBehavior(defaults, patch) {
  if (!isPlainObject(patch)) return defaults;
  const out = { ...defaults };
  for (const [key, value] of Object.entries(patch)) {
    const base = defaults?.[key];
    out[key] = isPlainObject(value) && isPlainObject(base) ? mergeBehavior(base, value) : value;
  }
  return out;
}

let cache = null;
let cacheAt = 0;
let cacheMtime = null;

/** Effective behavior config (defaults + behavior.json). Cached by mtime. */
export function readBehaviorConfig({ refresh = false } = {}) {
  const path = behaviorConfigPath();
  let mtimeMs = null;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    cache = null;
    cacheMtime = null;
    return structuredClone(BEHAVIOR_DEFAULTS);
  }
  if (!refresh && cache && cacheMtime === mtimeMs) return cache;
  let document = null;
  try {
    document = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    document = null;
  }
  cache = isPlainObject(document)
    ? mergeBehavior(BEHAVIOR_DEFAULTS, document)
    : structuredClone(BEHAVIOR_DEFAULTS);
  cacheMtime = mtimeMs;
  cacheAt = Date.now();
  return cache;
}

/** Last successful read time (diagnostics only). */
export function behaviorCacheAt() {
  return cache ? cacheAt : 0;
}
