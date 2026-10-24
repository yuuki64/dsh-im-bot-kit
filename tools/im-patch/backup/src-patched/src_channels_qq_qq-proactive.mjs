// Deterministic proactive-message scheduler (morning / lunch / dinner windows).
//
// The upstream plugin has no wake-up loop at all: bots only answer inbound
// messages. This adds exactly three fixed windows per bot (default 07:45 /
// 11:45 / 17:45 with ±25 min jitter) instead of the expensive "check every
// 30–90 minutes and burn a full LLM turn even when silent" model used by
// qq-bridge. Messages are templates: zero token cost, no session involved.
//
// Config lives in behavior.json → proactive (merged over defaults); state
// (which slot already fired, daily counters) is persisted per bot so a DSH
// restart does not double-send.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { readBehaviorConfig } from '../shared/behavior-config.mjs';

const TICK_MS = 30_000;
const STATE_VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;

export function proactiveStatePath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(home, 'integrations', 'dsh-im', 'proactive-state.json');
}

/** "07:45" -> 465 (minutes after midnight); invalid entries are dropped. */
export function parseDailyTimes(list) {
  const minutes = [];
  for (const entry of Array.isArray(list) ? list : []) {
    const match = /^(\d{1,2}):(\d{2})$/u.exec(String(entry ?? '').trim());
    if (!match) continue;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue;
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) continue;
    const value = hour * 60 + minute;
    if (!minutes.includes(value)) minutes.push(value);
  }
  return minutes.sort((left, right) => left - right);
}

/** Minutes after midnight -> "HH:MM". */
export function formatSlot(minutes) {
  const value = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

/** Local midnight for a timestamp (ms). */
export function startOfLocalDay(nowMs) {
  const date = new Date(nowMs);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Stable non-crypto hash so jitter is the same for a target on the same day. */
export function stableHash(seed) {
  let hash = 2166136261;
  const value = String(seed ?? '');
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Planned minutes for one slot: dailyTime plus a per-day, per-target jitter in
 * [-jitterMinutes, +jitterMinutes].
 */
export function jitteredSlotMinutes({ dailyMinutes, dayKey, targetKey, jitterMinutes = 0 }) {
  const span = Number.isFinite(Number(jitterMinutes)) ? Math.floor(Number(jitterMinutes)) : 0;
  if (span <= 0) return dailyMinutes;
  const offset = (stableHash(`${dayKey}|${targetKey}|${dailyMinutes}`) % (span * 2 + 1)) - span;
  return dailyMinutes + offset;
}

/** Pick one template for the slot; `texts` may be { "07:45": [...] } or a list. */
export function pickProactiveText(texts, slotLabel, random = Math.random) {
  if (Array.isArray(texts)) {
    return texts.length ? texts[Math.floor(random() * texts.length)] : '';
  }
  if (texts && typeof texts === 'object') {
    const pool = Array.isArray(texts[slotLabel]) && texts[slotLabel].length
      ? texts[slotLabel]
      : Array.isArray(texts.default) ? texts.default : [];
    return pool.length ? pool[Math.floor(random() * pool.length)] : '';
  }
  return '';
}

/**
 * Pure decision function (kept separate so it can be unit-tested).
 * @returns {{fire: boolean, reason: string}}
 */
export function evaluateProactiveFire({
  nowMs,
  plannedMs,
  windowMinutes,
  fired = false,
  quietMinutes,
  lastActivityMs,
  lastSentMs,
  minIntervalMinutes,
  maxPerDay,
  countToday,
  probability,
  roll,
}) {
  if (nowMs < plannedMs) return { fire: false, reason: 'not-yet' };
  const window = Math.max(1, Number(windowMinutes) || 90) * 60_000;
  if (nowMs >= plannedMs + window) return { fire: false, reason: 'window-passed' };
  if (fired) return { fire: false, reason: 'already-fired' };
  if (Number(countToday) >= Number(maxPerDay)) return { fire: false, reason: 'daily-cap' };
  if (lastSentMs && nowMs - lastSentMs < (Number(minIntervalMinutes) || 0) * 60_000) {
    return { fire: false, reason: 'cooldown' };
  }
  if (lastActivityMs && nowMs - lastActivityMs < (Number(quietMinutes) || 0) * 60_000) {
    return { fire: false, reason: 'not-quiet' };
  }
  const chance = Number.isFinite(Number(probability)) ? Number(probability) : 0.85;
  const rollValue = Number.isFinite(Number(roll)) ? Number(roll) : Math.random();
  if (rollValue >= chance) return { fire: false, reason: 'probability' };
  return { fire: true, reason: 'due' };
}

function emptyState() {
  return { version: STATE_VERSION, bots: {} };
}

function loadState() {
  try {
    const document = JSON.parse(readFileSync(proactiveStatePath(), 'utf8'));
    if (document && typeof document === 'object' && document.bots && typeof document.bots === 'object') {
      return { version: STATE_VERSION, bots: document.bots };
    }
  } catch {
    // Missing/malformed state simply starts clean.
  }
  return emptyState();
}

function pruneState(state, nowMs) {
  for (const [botId, record] of Object.entries(state.bots)) {
    if (!record || typeof record !== 'object') {
      delete state.bots[botId];
      continue;
    }
    const dayKey = typeof record.day === 'string' ? record.day : '';
    if (dayKey && nowMs - Date.parse(`${dayKey}T00:00:00`) > 3 * DAY_MS) {
      delete state.bots[botId];
    }
  }
  return state;
}

function saveState(state) {
  const path = proactiveStatePath();
  const temp = `${path}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    renameSync(temp, path);
  } catch {
    // State persistence is best-effort; in-memory tracking still works.
  }
}

function dayKeyFor(nowMs) {
  const date = new Date(nowMs);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function ensureRecord(state, botId, dayKey) {
  const current = state.bots[botId];
  if (current && current.day === dayKey) return current;
  const next = {
    day: dayKey,
    count: 0,
    lastSentAt: 0,
    counts: {},
    lastSentByTarget: {},
    fired: {},
  };
  state.bots[botId] = next;
  return next;
}

export class QqProactiveScheduler {
  #botId;
  #send;
  #logger;
  #allowed;
  #now;
  #timer = null;
  #activities = new Map();
  #startedAt = 0;
  #lastTickAt = 0;
  #sentTotal = 0;

  constructor({ botId, send, logger = console, allowed = null, now = () => Date.now() }) {
    if (typeof botId !== 'string' || !botId) throw new TypeError('botId is required');
    if (typeof send !== 'function') throw new TypeError('send must be a function');
    this.#botId = botId;
    this.#send = send;
    this.#logger = logger;
    this.#allowed = typeof allowed === 'function' ? allowed : null;
    this.#now = now;
  }

  /** Record inbound activity so "quiet group" can be checked cheaply. */
  noteActivity(key, at = this.#now()) {
    if (typeof key !== 'string' || !key) return;
    this.#activities.set(key, at);
  }

  start() {
    if (this.#timer) return;
    this.#startedAt = this.#now();
    this.#timer = setInterval(() => {
      void this.tick().catch((error) => this.#logger.warn?.('[dsh-im:qq] proactive tick failed:', error?.message ?? error));
    }, TICK_MS);
    this.#timer.unref?.();
    void this.tick().catch(() => undefined);
    this.#logger.info?.(`[dsh-im:qq] proactive scheduler started (${this.#botId})`);
  }

  stop() {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = null;
    this.#logger.info?.(`[dsh-im:qq] proactive scheduler stopped (${this.#botId})`);
  }

  status() {
    return {
      botId: this.#botId,
      running: Boolean(this.#timer),
      startedAt: this.#startedAt || null,
      lastTickAt: this.#lastTickAt || null,
      sentTotal: this.#sentTotal,
    };
  }

  async tick() {
    const config = readBehaviorConfig().proactive;
    if (!config?.enabled) return [];
    const entry = config.bots?.[this.#botId];
    if (!entry || entry.enabled === false) return [];
    const targets = Array.isArray(entry.targets) ? entry.targets.filter((key) => typeof key === 'string' && key) : [];
    if (targets.length === 0) return [];
    const nowMs = this.#now();
    this.#lastTickAt = nowMs;
    const dayKey = dayKeyFor(nowMs);
    const dayStart = startOfLocalDay(nowMs);
    const state = pruneState(loadState(), nowMs);
    const record = ensureRecord(state, this.#botId, dayKey);
    const slots = parseDailyTimes(config.dailyTimes);
    const firedKeys = [];
    let stateChanged = false;
    // 全局日上限（跨目标安全阀）+ 每个目标自己的上限/冷却（2026-10-24 修复：
    // 以前一个目标发过之后，全局 lastSentAt 会把同一次 tick 里的其他目标全挡掉，
    // 导致「只发了一个群，私聊/别的群都没发」）。
    const globalCap = Number(config.maxPerDay);
    const perTargetCap = Number(config.maxPerDayPerTarget);
    const perTargetCooldown = Number(config.minIntervalMinutesPerTarget ?? config.minIntervalMinutes);

    for (const targetKey of targets) {
      if (this.#allowed && !this.#allowed(targetKey)) continue;
      if (Number.isFinite(globalCap) && globalCap > 0 && record.count >= globalCap) break;
      const lastActivityMs = this.#activities.get(targetKey) ?? 0;
      let targetCount = Number(record.counts?.[targetKey] ?? 0);
      let targetLastSent = Number(record.lastSentByTarget?.[targetKey] ?? 0);
      for (const slotMinutes of slots) {
        if (Number.isFinite(globalCap) && globalCap > 0 && record.count >= globalCap) break;
        // 私聊（c2c）不打散：固定到整点窗口，重启晚到也能落在 90 分钟窗口里。
        const isDirectTarget = targetKey.startsWith('c2c:');
        const plannedMinutes = jitteredSlotMinutes({
          dailyMinutes: slotMinutes,
          dayKey,
          targetKey,
          jitterMinutes: isDirectTarget ? 0 : config.jitterMinutes,
        });
        const plannedMs = dayStart + plannedMinutes * 60_000;
        const slotLabel = formatSlot(slotMinutes);
        const firedMap = record.fired[targetKey] ?? {};
        const decision = evaluateProactiveFire({
          nowMs,
          plannedMs,
          windowMinutes: config.windowMinutes,
          fired: firedMap[slotLabel] === dayKey,
          quietMinutes: config.quietMinutes,
          lastActivityMs,
          lastSentMs: targetLastSent,
          minIntervalMinutes: Number.isFinite(perTargetCooldown) ? perTargetCooldown : config.minIntervalMinutes,
          maxPerDay: Number.isFinite(perTargetCap) && perTargetCap > 0 ? perTargetCap : globalCap,
          countToday: targetCount,
          probability: config.probability,
          roll: Math.random(),
        });
        if (!decision.fire) continue;
        const text = pickProactiveText(entry.texts, slotLabel);
        if (!text) continue;
        try {
          await this.#send(targetKey, text);
          this.#sentTotal += 1;
          targetCount += 1;
          targetLastSent = nowMs;
          record.count += 1;
          record.lastSentAt = nowMs;
          record.counts = { ...(record.counts ?? {}), [targetKey]: targetCount };
          record.lastSentByTarget = { ...(record.lastSentByTarget ?? {}), [targetKey]: nowMs };
          record.fired[targetKey] = { ...firedMap, [slotLabel]: dayKey };
          stateChanged = true;
          firedKeys.push(`${targetKey}|${slotLabel}`);
          this.#logger.info?.(`[dsh-im:qq] proactive message sent (${targetKey} ${slotLabel})`);
          // 多个目标之间稍作间隔，避免同一秒连发。
          await new Promise((resolve) => setTimeout(resolve, 1000));
        } catch (error) {
          this.#logger.warn?.(`[dsh-im:qq] proactive message failed (${targetKey} ${slotLabel}):`, error?.message ?? error);
          // Mark the slot as consumed so a broken target cannot retry every tick.
          record.fired[targetKey] = { ...firedMap, [slotLabel]: dayKey };
          stateChanged = true;
        }
      }
    }
    if (stateChanged) saveState(state);
    return firedKeys;
  }
}

export function createQqProactiveScheduler(options) {
  return new QqProactiveScheduler(options);
}
