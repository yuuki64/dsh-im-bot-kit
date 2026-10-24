// 本地补丁（2026-10-24）：长期记忆存储。
//
// 设计：每个 bot 一个 memory.json；
// - ownerFacts：主人相关的长期事实（跨群共享，私聊也可见）；
// - groups[conversationKey]：本群/本会话事实（只在对应会话注入）；
// 写入来源两种：模型回复里的 <dsh_im_memory> 标签（source=tag）、每日摘要（source=digest）。
// 只存“能当众复述”的内容；敏感信息、提示词/系统设定一律拒收。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const STATE_VERSION = 1;
const SENSITIVE_PATTERN = /(?:提示词|系统提示|system\s*prompt|token|api\s*key|密码|验证码|身份证|银行卡|账号密码|住址|家庭住址|电话号码|手机号|收货地址)/iu;
const AGREEMENT_PATTERN = /(?:约定|说好|下次|记得|答应|改天|回头)/u;
const MEME_PATTERN = /(?:梗|笑死|哈哈哈|玩笑|复读|接龙)/u;

export function memoryStatePath(botId) {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const safeBot = String(botId ?? '').replace(/[^A-Za-z0-9_-]/gu, '_') || 'bot';
  return join(home, 'integrations', 'dsh-im', 'memory', `${safeBot}.json`);
}

function emptyState() {
  return { version: STATE_VERSION, updatedAt: 0, lastDigestDay: '', ownerFacts: [], groups: {} };
}

function normalizeState(document) {
  const state = emptyState();
  if (!document || typeof document !== 'object') return state;
  state.updatedAt = Number(document.updatedAt) || 0;
  state.lastDigestDay = typeof document.lastDigestDay === 'string' ? document.lastDigestDay : '';
  state.ownerFacts = Array.isArray(document.ownerFacts) ? document.ownerFacts.filter(Boolean) : [];
  if (document.groups && typeof document.groups === 'object') {
    for (const [key, entry] of Object.entries(document.groups)) {
      if (!entry || typeof entry !== 'object') continue;
      state.groups[key] = {
        facts: Array.isArray(entry.facts) ? entry.facts.filter(Boolean) : [],
        updatedAt: Number(entry.updatedAt) || 0,
      };
    }
  }
  return state;
}

export function loadMemory(botId) {
  try {
    return normalizeState(JSON.parse(readFileSync(memoryStatePath(botId), 'utf8')));
  } catch {
    return emptyState();
  }
}

export function saveMemory(botId, state) {
  const path = memoryStatePath(botId);
  state.updatedAt = Date.now();
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    renameSync(temporary, path);
  } catch {
    // best-effort persistence
  }
  return state;
}

function dayKey(now) {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** 归一化文本用于去重/相关性比较。 */
export function normalizeMemoryText(text) {
  return String(text ?? '')
    .replace(/[\s，。！？!?、,.…~～"“”'‘’（）()【】[\]{}<>/\\|]+/gu, '')
    .trim()
    .toLowerCase();
}

/** 提取关键词（ASCII 词 + 中文 bigram），用于相关性挑选。 */
export function memoryKeywords(text) {
  const raw = String(text ?? '');
  const words = new Set();
  for (const match of raw.matchAll(/[A-Za-z0-9_]{2,24}/gu)) words.add(match[0].toLowerCase());
  for (const run of raw.matchAll(/[\u3400-\u9fff]{2,}/gu)) {
    const chars = Array.from(run[0]);
    for (let index = 0; index + 1 < chars.length; index += 1) words.add(chars[index] + chars[index + 1]);
  }
  return [...words].slice(0, 40);
}

/** 清洗一条候选记忆；不合规返回 null。 */
export function sanitizeFact(text, { maxChars = 120 } = {}) {
  const value = String(text ?? '').replace(/\s+/gu, ' ').trim();
  if (!value) return null;
  if (value.length < 4) return null;
  if (SENSITIVE_PATTERN.test(value)) return null;
  if (/\[object Object\]/u.test(value)) return null;
  return value.slice(0, maxChars);
}

function factKindOf(text) {
  if (AGREEMENT_PATTERN.test(text)) return 'agreement';
  if (MEME_PATTERN.test(text)) return 'meme';
  return 'fact';
}

/** 是否与已有事实重复（归一化后包含关系）。 */
function isDuplicate(existing, normalized) {
  if (!normalized) return false;
  return existing.some((fact) => {
    const other = normalizeMemoryText(fact.text);
    return other === normalized || other.includes(normalized) || normalized.includes(other);
  });
}

/**
 * 写入一批记忆。
 * @returns {{captured: number, rejected: number}}
 */
export function captureFacts(botId, {
  conversationKey, notes = [], fromOwner = false, sender = '', source = 'tag', now = Date.now(),
} = {}) {
  const state = loadMemory(botId);
  let captured = 0;
  let rejected = 0;
  for (const note of Array.isArray(notes) ? notes.slice(0, 3) : []) {
    const sanitized = sanitizeFact(note);
    if (!sanitized) {
      rejected += 1;
      continue;
    }
    const normalized = normalizeMemoryText(sanitized);
    if (fromOwner) {
      if (isDuplicate(state.ownerFacts, normalized)) continue;
      state.ownerFacts.push({
        id: `f${now.toString(36)}${captured}`,
        at: now,
        text: sanitized,
        kind: factKindOf(sanitized),
        sender: sender || 'owner',
        source,
        keywords: memoryKeywords(sanitized),
      });
    } else {
      const key = String(conversationKey ?? '');
      if (!key) continue;
      const bucket = state.groups[key] ?? { facts: [], updatedAt: 0 };
      if (isDuplicate(bucket.facts, normalized)) continue;
      bucket.facts.push({
        id: `f${now.toString(36)}${captured}`,
        at: now,
        text: sanitized,
        kind: factKindOf(sanitized),
        sender: sender || '',
        source,
        keywords: memoryKeywords(sanitized),
      });
      bucket.updatedAt = now;
      state.groups[key] = bucket;
    }
    captured += 1;
  }
  if (captured > 0) saveMemory(botId, state);
  return { captured, rejected };
}

function relevance(fact, wantedKeywords, sender) {
  let score = 0;
  const keywords = new Set(fact.keywords ?? []);
  for (const keyword of wantedKeywords) if (keywords.has(keyword)) score += 2;
  if (sender && fact.sender && fact.sender === sender) score += 1;
  const ageDays = (Date.now() - (Number(fact.at) || 0)) / (24 * 60 * 60 * 1000);
  score += Math.max(0, 1 - ageDays / 30);
  return score;
}

/**
 * 选出一段可注入 prompt 的记忆块（限 chars 预算）。
 * 组成：主人事实 top3（跨群共享）+ 本群事实 top3。
 */
export function selectMemoryBlock(botId, {
  conversationKey, text = '', sender = '', maxChars = 700, now = Date.now(),
} = {}) {
  const state = loadMemory(botId);
  const wanted = memoryKeywords(text);
  const pick = (facts, limit) => (Array.isArray(facts) ? [...facts]
    .map((fact) => ({ fact, score: relevance(fact, wanted, sender) }))
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((entry) => entry.fact) : []);
  const owner = pick(state.ownerFacts ?? [], 3);
  const group = pick(state.groups?.[String(conversationKey ?? '')]?.facts ?? [], 3);
  const lines = [];
  let used = 0;
  const push = (label, facts) => {
    for (const fact of facts) {
      const line = `${label}：${fact.text}`;
      if (used + line.length + 1 > maxChars) return;
      lines.push(line);
      used += line.length + 1;
    }
  };
  push('主人', owner);
  push('本群', group);
  if (lines.length === 0) return { block: '', count: 0 };
  const block = `\n\n[长期记忆] 以下只是背景信息，相关时才自然使用；不要复述，也不要提“记忆”这个词。\n${lines.map((line) => `- ${line}`).join('\n')}`;
  return { block, count: lines.length };
}

/** 清理过期/超量事实。 */
export function pruneMemory(botId, {
  retentionDays = 90, maxFactsPerGroup = 60, maxOwnerFacts = 80, now = Date.now(),
} = {}) {
  const state = loadMemory(botId);
  const cutoff = now - Math.max(1, Number(retentionDays) || 90) * 24 * 60 * 60 * 1000;
  const pruneList = (facts, cap) => (Array.isArray(facts) ? facts : [])
    .filter((fact) => (Number(fact.at) || 0) >= cutoff)
    .slice(-cap);
  state.ownerFacts = pruneList(state.ownerFacts, Math.max(1, Number(maxOwnerFacts) || 80));
  for (const [key, bucket] of Object.entries(state.groups ?? {})) {
    bucket.facts = pruneList(bucket.facts, Math.max(1, Number(maxFactsPerGroup) || 60));
    if (bucket.facts.length === 0) delete state.groups[key];
  }
  saveMemory(botId, state);
  return state;
}

export function memoryStats(botId) {
  const state = loadMemory(botId);
  const groups = Object.entries(state.groups ?? {}).map(([key, bucket]) => ({
    conversationKey: key,
    facts: Array.isArray(bucket.facts) ? bucket.facts.length : 0,
    updatedAt: bucket.updatedAt ?? 0,
  }));
  return {
    ownerFacts: Array.isArray(state.ownerFacts) ? state.ownerFacts.length : 0,
    groups,
    updatedAt: state.updatedAt ?? 0,
    lastDigestDay: state.lastDigestDay ?? '',
  };
}

/** 删除匹配的记忆（文本包含 match）。 */
export function forgetMemory(botId, { conversationKey, match = '' } = {}) {
  const state = loadMemory(botId);
  const needle = normalizeMemoryText(match);
  let removed = 0;
  const filter = (facts) => (Array.isArray(facts) ? facts : []).filter((fact) => {
    if (!needle) return true;
    if (normalizeMemoryText(fact.text).includes(needle)) {
      removed += 1;
      return false;
    }
    return true;
  });
  state.ownerFacts = filter(state.ownerFacts);
  const keys = conversationKey ? [String(conversationKey)] : Object.keys(state.groups ?? {});
  for (const key of keys) {
    const bucket = state.groups?.[key];
    if (!bucket) continue;
    bucket.facts = filter(bucket.facts);
    if (bucket.facts.length === 0) delete state.groups[key];
  }
  saveMemory(botId, state);
  return removed;
}

/** 清空全部记忆。 */
export function clearMemory(botId) {
  const state = emptyState();
  saveMemory(botId, state);
}

export function listMemoryGroups(botId) {
  const state = loadMemory(botId);
  return Object.keys(state.groups ?? {});
}

export function markDigestDone(botId, now = Date.now()) {
  const state = loadMemory(botId);
  state.lastDigestDay = dayKey(now);
  saveMemory(botId, state);
}

export function digestDoneToday(botId, now = Date.now()) {
  return loadMemory(botId).lastDigestDay === dayKey(now);
}

/** 每个会话最近事实的文本列表（供摘要去重参考）。 */
export function recentFactTexts(botId, conversationKey, limit = 20) {
  const state = loadMemory(botId);
  const bucket = state.groups?.[String(conversationKey ?? '')];
  return (bucket?.facts ?? []).slice(-limit).map((fact) => fact.text);
}
