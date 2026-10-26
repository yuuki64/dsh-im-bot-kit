// Owner-controlled reasoning ceiling for group conversations.
//
// Groups default to the cheapest tier so casual chat stays fast and cheap, but
// the owner may raise (or lower) the ceiling at any time from QQ with
// `/effort <id>`. Stored in DSH_HOME so it survives restarts and plugin updates.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const REASONING_EFFORTS = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const RANK = Object.freeze({ none: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5 });
export const DEFAULT_GROUP_REASONING = 'low';

export function effortRank(effort) {
  const id = typeof effort === 'string' ? effort.trim().toLowerCase() : '';
  return Object.hasOwn(RANK, id) ? RANK[id] : undefined;
}

export function isKnownEffort(effort) {
  return effortRank(effort) !== undefined;
}

export function normalizeReasoningCeiling(value) {
  const id = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return isKnownEffort(id) ? id : null;
}

export function groupReasoningPath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(home, 'integrations', 'dsh-im', 'group-reasoning.json');
}

/** Current ceiling; missing or malformed files fall back to `low`. */
export async function readGroupReasoningCeiling() {
  try {
    const raw = await readFile(groupReasoningPath(), 'utf8');
    const document = JSON.parse(raw);
    const ceiling = normalizeReasoningCeiling(document?.groupReasoning);
    return ceiling ?? DEFAULT_GROUP_REASONING;
  } catch {
    return DEFAULT_GROUP_REASONING;
  }
}

/**
 * 本地补丁（2026-10-26）：只有主人真的用 /effort 设过才返回强度，
 * 没设过返回 null（= 继承 bot 设置面板，不再默认压到 low）。
 */
export async function readGroupReasoningOverride() {
  try {
    const raw = await readFile(groupReasoningPath(), 'utf8');
    return normalizeReasoningCeiling(JSON.parse(raw)?.groupReasoning);
  } catch {
    return null;
  }
}

/** Persist a validated ceiling (write tmp + rename). */
export async function writeGroupReasoningCeiling(value) {
  const ceiling = normalizeReasoningCeiling(value);
  if (!ceiling) {
    const error = new Error(`Unknown reasoning effort: ${String(value)}`);
    error.code = 'group-reasoning-invalid';
    throw error;
  }
  const path = groupReasoningPath();
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ version: 1, groupReasoning: ceiling }, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
  return ceiling;
}

/**
 * Clamp a group conversation's effort to the owner-set ceiling. Values at or
 * below the ceiling (including an undefined/default value) pass through.
 */
export function clampReasoningForGroup(effort, ceiling) {
  if (effort === undefined || effort === null) return effort;
  const rank = effortRank(effort);
  const limit = effortRank(ceiling);
  if (rank === undefined || limit === undefined) return ceiling ?? effort;
  return rank > limit ? ceiling : effort;
}
