// IM persona (人设提示词) for QQ / WeChat bot conversations.
//
// Two layers, both plain files, resolved per bot with a global fallback:
//
//   <DSH_HOME>/integrations/dsh-im/bots/<botId>/bot.json    – 名字/别名（唤醒词）+ 备注
//   <DSH_HOME>/integrations/dsh-im/bots/<botId>/persona.md  – 这个 bot 的人设
//   <DSH_HOME>/integrations/dsh-im/personas/<name>.md       – 人设卡库（可复用）
//   <DSH_HOME>/integrations/dsh-im/persona.md               – 全局默认人设
//
// 没有 per-bot 文件时行为和以前完全一样（只读全局 persona.md）。人设和身份块都会
// 追加到 channel 已经发布给会话的 guidance 上，所以每个 QQ/微信会话都能带上，不用碰
// 本机 DSH 会话。改文件后下一条消息生效，不需要重启。

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const MAX_CHARS = 12_000;

function home() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh');
}

function imDir() {
  return join(home(), 'integrations', 'dsh-im');
}

export function personaDir() {
  return join(imDir(), 'personas');
}

export function botsDir() {
  return join(imDir(), 'bots');
}

function cleanBotId(botId) {
  if (typeof botId !== 'string') return '';
  const trimmed = botId.trim();
  return /^[A-Za-z0-9_-]{1,80}$/u.test(trimmed) ? trimmed : '';
}

/** Per-bot profile directory; `null` when the bot id is absent/invalid. */
export function botDir(botId) {
  const clean = cleanBotId(botId);
  return clean ? join(botsDir(), clean) : null;
}

/** Global (active) persona used by bots without their own persona file. */
export function activePersonaPath() {
  return join(imDir(), 'persona.md');
}

/** Persona path a given bot actually reads: per-bot file first, then global. */
export function personaPathFor(botId) {
  const dir = botDir(botId);
  if (dir) {
    const own = join(dir, 'persona.md');
    if (existsSync(own)) return own;
  }
  return activePersonaPath();
}

/** Per-bot identity (name / wake words). Missing file means "no extra identity". */
export function readBotProfile(botId) {
  const dir = botDir(botId);
  if (!dir) return null;
  try {
    const document = JSON.parse(readFileSync(join(dir, 'bot.json'), 'utf8'));
    if (!document || typeof document !== 'object') return null;
    const name = typeof document.name === 'string' ? document.name.trim().slice(0, 40) : '';
    const aliases = Array.isArray(document.aliases)
      ? document.aliases
        .filter((alias) => typeof alias === 'string' && alias.trim())
        .map((alias) => alias.trim().slice(0, 40))
        .slice(0, 12)
      : [];
    if (!name && !aliases.length) return null;
    const ownerRaw = typeof document.ownerOpenid === 'string' ? document.ownerOpenid.trim() : '';
    const ownerOpenid = /^[A-Za-z0-9*_-]{1,64}$/u.test(ownerRaw) ? ownerRaw : '';
    return { name, aliases, ownerOpenid, note: typeof document.note === 'string' ? document.note.slice(0, 200) : '' };
  } catch {
    return null;
  }
}

// Per-path cache: one persona file can be shared by several bots, and bridges
// evaluate this per message, so avoid a read every time.
const cache = new Map();

/** Persona text for a bot (empty when not configured). Cached by mtime. */
export function readPersona(botId) {
  const path = personaPathFor(botId);
  try {
    const info = statSync(path);
    const cached = cache.get(path);
    if (cached && cached.mtime === info.mtimeMs) return cached.text;
    const text = readFileSync(path, 'utf8').trim().slice(0, MAX_CHARS);
    cache.set(path, { mtime: info.mtimeMs, text });
    return text;
  } catch {
    return '';
  }
}

function identityBlock(profile) {
  if (!profile) return '';
  const names = [profile.name, ...profile.aliases].filter(Boolean);
  if (!names.length && !profile.ownerOpenid) return '';
  const unique = [...new Set(names)];
  return [
    '<dsh_im_identity>',
    unique.length ? `你在本机器人上的名字：${unique[0]}。` : '',
    unique.length > 1 ? `别人叫你 ${unique.slice(1).join('、')} 时也是在叫你。` : '',
    unique.length ? '自我介绍、被点名、被问“你是谁”时用这个名字，不要用别的机器人的名字。' : '',
    profile.ownerOpenid
      ? `这个机器人的主人 openid：${profile.ownerOpenid}。只有消息开头 <dsh_im_source> 里的 senderId 与它精确相等才算主人，其他人一律按第三方处理。`
      : '',
    profile.note ? `备注：${profile.note}` : '',
    '</dsh_im_identity>',
  ].filter(Boolean).join('\n');
}

/**
 * Append identity + persona to channel guidance; no-op when neither exists.
 * Persona goes last so a persona card can still override wording.
 */
export function applyPersona(guidance, { botId } = {}) {
  const base = typeof guidance === 'string' ? guidance.trim() : '';
  const parts = [base];
  const identity = identityBlock(readBotProfile(botId));
  if (identity) parts.push(identity);
  const persona = readPersona(botId);
  if (persona) parts.push(`<dsh_im_persona>\n${persona}\n</dsh_im_persona>`);
  return parts.filter(Boolean).join('\n\n');
}

/** Personas available in the personas directory (name without .md). */
export function listPersonas() {
  try {
    return readdirSync(personaDir())
      .filter((name) => name.toLowerCase().endsWith('.md'))
      .map((name) => name.slice(0, -3))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Copy `personas/<name>.md` over the persona a bot reads (global when no
 * `botId`). Returns false if the card is missing.
 */
export function usePersona(name, { botId } = {}) {
  const clean = String(name ?? '').trim().replace(/[\\/]+/gu, '');
  if (!clean) return false;
  const source = join(personaDir(), `${clean}.md`);
  if (!existsSync(source)) return false;
  const text = readFileSync(source, 'utf8').trim().slice(0, MAX_CHARS);
  const dir = botDir(botId);
  const target = dir ? join(dir, 'persona.md') : activePersonaPath();
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${text}\n`, 'utf8');
  cache.delete(target);
  return true;
}
