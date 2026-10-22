// Per-conversation IM switches (private chat / group chat), controlled from a
// local click page. State is one small JSON file under the DSH home so the
// switch page, the CLI helper and the running plugin all agree without RPC:
//
//   <DSH_HOME>/integrations/dsh-im/switches.json
//   { "version": 1, "direct": true, "group": true, "updatedAt": "..." }
//
// true = the bot keeps answering that conversation type, false = every inbound
// message of that type is dropped silently (no reply, no session work).
// The global pause marker (`paused`) stays a separate, whole-channel switch.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const IM_CHAT_TYPES = Object.freeze(['direct', 'group']);
export const IM_SWITCH_DEFAULTS = Object.freeze({ direct: true, group: true });

const SWITCH_OFF = Object.freeze({ allowed: false, reason: 'chat-switch-off' });

function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh');
}

export function imIntegrationDir() {
  return join(dshHome(), 'integrations', 'dsh-im');
}

export function imSwitchPath() {
  return join(imIntegrationDir(), 'switches.json');
}

export function imGlobalPausePath() {
  return join(imIntegrationDir(), 'paused');
}

/** Coerce arbitrary persisted data into the canonical boolean pair. */
export function normalizeSwitchState(input) {
  const state = { ...IM_SWITCH_DEFAULTS };
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    for (const type of IM_CHAT_TYPES) {
      if (typeof input[type] === 'boolean') state[type] = input[type];
    }
  }
  return state;
}

// One-entry stat cache: the page polls, bridges evaluate per message, and both
// only need to notice a change the switch page already wrote atomically.
let cached = { path: null, mtimeMs: -1, state: null };

export function readSwitchState() {
  const path = imSwitchPath();
  let mtimeMs = -1;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    mtimeMs = -1;
  }
  if (cached.path === path && cached.mtimeMs === mtimeMs && cached.state) return cached.state;
  let state = { ...IM_SWITCH_DEFAULTS };
  if (mtimeMs >= 0) {
    try {
      state = normalizeSwitchState(JSON.parse(readFileSync(path, 'utf8')));
    } catch {
      state = { ...IM_SWITCH_DEFAULTS };
    }
  }
  cached = { path, mtimeMs, state };
  return state;
}

/** Merge a partial patch into the persisted switches; returns the new state. */
export function writeSwitchState(patch = {}) {
  const next = normalizeSwitchState({ ...readSwitchState(), ...patch });
  const path = imSwitchPath();
  mkdirSync(dirname(path), { recursive: true });
  const payload = {
    version: 1,
    direct: next.direct,
    group: next.group,
    updatedAt: new Date().toISOString(),
  };
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
  cached = { path: null, mtimeMs: -1, state: null };
  return next;
}

export function isChatEnabled(conversationType) {
  if (!IM_CHAT_TYPES.includes(conversationType)) return true;
  return readSwitchState()[conversationType] !== false;
}

/**
 * True while at least one side still wants the bot connected. Both sides off
 * means the plugin closes its platform connection entirely, so the DSH
 * workspace indicator shows offline exactly like the global pause.
 */
export function anyChatEnabled() {
  const state = readSwitchState();
  return state.direct === true || state.group === true;
}

/**
 * Decision object for the shared inbound-access gate, or null when the
 * conversation type is enabled (or unknown, which keeps old callers working).
 */
export function chatSwitchDecision(conversationType) {
  if (!IM_CHAT_TYPES.includes(conversationType)) return null;
  return isChatEnabled(conversationType) ? null : SWITCH_OFF;
}

export function isImGloballyPaused() {
  try {
    return existsSync(imGlobalPausePath());
  } catch {
    return false;
  }
}

/** Snapshot for the switch page and the CLI. */
export function switchSnapshot() {
  const state = readSwitchState();
  let updatedAt = null;
  try {
    updatedAt = statSync(imSwitchPath()).mtime.toISOString();
  } catch {
    updatedAt = null;
  }
  return {
    direct: state.direct,
    group: state.group,
    updatedAt,
    globalPaused: isImGloballyPaused(),
    path: imSwitchPath(),
  };
}
