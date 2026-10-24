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
  return {
    version: STATE_VERSION,
    updatedAt: 0,
    lastDigestDay: '',
    ownerFacts: [],
    ownerHabits: [],
    groups: {},
    // 习惯挖掘（2026-10-24）：高频短语 / 活跃时段 / 说话长度。
    habitCandidates: {},
    activity: {},
    style: {},
  };
}

function normalizeState(document) {
  const state = emptyState();
  if (!document || typeof document !== 'object') return state;
  state.updatedAt = Number(document.updatedAt) || 0;
  state.lastDigestDay = typeof document.lastDigestDay === 'string' ? document.lastDigestDay : '';
  state.ownerFacts = Array.isArray(document.ownerFacts) ? document.ownerFacts.filter(Boolean) : [];
  state.ownerHabits = Array.isArray(document.ownerHabits) ? document.ownerHabits.filter(Boolean) : [];
  if (document.groups && typeof document.groups === 'object') {
    for (const [key, entry] of Object.entries(document.groups)) {
      if (!entry || typeof entry !== 'object') continue;
      state.groups[key] = {
        facts: Array.isArray(entry.facts) ? entry.facts.filter(Boolean) : [],
        habits: Array.isArray(entry.habits) ? entry.habits.filter(Boolean) : [],
        updatedAt: Number(entry.updatedAt) || 0,
      };
    }
  }
  if (document.habitCandidates && typeof document.habitCandidates === 'object') {
    state.habitCandidates = document.habitCandidates;
  }
  if (document.activity && typeof document.activity === 'object') state.activity = document.activity;
  if (document.style && typeof document.style === 'object') state.style = document.style;
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
  retentionDays = 90, maxFactsPerGroup = 60, maxOwnerFacts = 80,
  maxHabitsPerGroup = 10, maxOwnerHabits = 12, candidateTtlDays = 30, now = Date.now(),
} = {}) {
  const state = loadMemory(botId);
  const cutoff = now - Math.max(1, Number(retentionDays) || 90) * 24 * 60 * 60 * 1000;
  const pruneList = (facts, cap) => (Array.isArray(facts) ? facts : [])
    .filter((fact) => (Number(fact.at) || 0) >= cutoff)
    .slice(-cap);
  state.ownerFacts = pruneList(state.ownerFacts, Math.max(1, Number(maxOwnerFacts) || 80));
  state.ownerHabits = pruneList(state.ownerHabits, Math.max(1, Number(maxOwnerHabits) || 12));
  for (const [key, bucket] of Object.entries(state.groups ?? {})) {
    bucket.facts = pruneList(bucket.facts, Math.max(1, Number(maxFactsPerGroup) || 60));
    bucket.habits = pruneList(bucket.habits, Math.max(1, Number(maxHabitsPerGroup) || 10));
    if (bucket.facts.length === 0 && bucket.habits.length === 0) delete state.groups[key];
  }
  const candidateCutoff = now - Math.max(1, Number(candidateTtlDays) || 30) * 24 * 60 * 60 * 1000;
  for (const [bucketKey, candidates] of Object.entries(state.habitCandidates ?? {})) {
    const kept = Object.fromEntries(Object.entries(candidates ?? {})
      .filter(([, entry]) => (Number(entry?.lastAt) || 0) >= candidateCutoff));
    if (Object.keys(kept).length === 0) delete state.habitCandidates[bucketKey];
    else state.habitCandidates[bucketKey] = kept;
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
    ownerHabits: Array.isArray(state.ownerHabits) ? state.ownerHabits.length : 0,
    groups,
    habits: groups.reduce((sum, group) => {
      const bucket = state.groups?.[group.conversationKey];
      return sum + (Array.isArray(bucket?.habits) ? bucket.habits.length : 0);
    }, 0),
    updatedAt: state.updatedAt ?? 0,
    lastDigestDay: state.lastDigestDay ?? '',
  };
}

// 太常见、没有辨识度的短语不进入习惯候选。
const HABIT_STOP_PHRASES = new Set([
  '什么', '这个', '那个', '就是', '然后', '真的', '可以', '不是', '我们', '你们', '他们',
  '现在', '还是', '已经', '可能', '一个', '没有', '知道', '觉得', '不会', '这么', '那么',
  '怎么', '为什么', '哈哈', '哈哈哈', '呵呵', '嗯嗯', '好的', '对的', '是啊', '没事',
  '不是吧', '还行', '今天', '明天', '昨天', '一下', '有点', '应该', '因为', '所以',
]);

/** 从一条消息提取候选口癖短语（短句整句 + 2~4 字中文片段）。 */
export function extractHabitCandidates(text, { maxShortChars = 16 } = {}) {
  const value = String(text ?? '');
  const out = new Map(); // phrase -> short(bool)
  const stripped = value.replace(/\s+/gu, ' ').trim();
  if (!stripped) return [];
  const normalized = stripped.replace(/[，。！？!?、,.…~～"“”'‘’（）()【】[\]{}<>/\\|]+/gu, '').trim();
  if (normalized.length >= 2 && normalized.length <= Math.max(2, Number(maxShortChars) || 16)
    && /[\p{L}\p{N}]/u.test(normalized) && !HABIT_STOP_PHRASES.has(normalized)) {
    out.set(normalized, true);
  }
  // 中文片段只在不太长的消息里抽，避免长文量产噪音。
  if (stripped.length <= 60) {
    for (const run of stripped.matchAll(/[\u3400-\u9fff]{2,}/gu)) {
      const chars = Array.from(run[0]);
      for (let start = 0; start < chars.length; start += 1) {
        for (let length = 2; length <= 4 && start + length <= chars.length; length += 1) {
          const phrase = chars.slice(start, start + length).join('');
          if (HABIT_STOP_PHRASES.has(phrase)) continue;
          if (!out.has(phrase)) out.set(phrase, false);
        }
      }
    }
  }
  return [...out.entries()].map(([phrase, short]) => ({ phrase, short }));
}

/**
 * 本地补丁（2026-10-24）：记录一条消息用于习惯挖掘。
 * 规则：短句整句阈值 minCount（默认 6）；中文 2~4 字片段阈值 minCountFragment（默认 10）；
 * 且至少跨 minDays（默认 2）天出现才晋升为「口头禅」记忆。
 */
export function recordHabitObservation(botId, {
  conversationKey, sender = '', text = '', fromOwner = false, now = Date.now(), config = {},
} = {}) {
  const settings = {
    minCount: Math.max(2, Number(config.minCount) || 6),
    minCountFragment: Math.max(2, Number(config.minCountFragment) || 10),
    minDays: Math.max(1, Number(config.minDays) || 2),
    maxCandidatesPerSender: Math.max(10, Number(config.maxCandidatesPerSender) || 200),
    maxShortChars: Number(config.maxShortChars) || 16,
  };
  const key = String(conversationKey ?? '');
  const who = String(sender ?? '').trim();
  const value = String(text ?? '').trim();
  if (!key || !who || !value) return { promoted: 0, habits: [] };
  const candidates = extractHabitCandidates(value, { maxShortChars: settings.maxShortChars });
  if (candidates.length === 0) return { promoted: 0, habits: [] };
  const state = loadMemory(botId);
  const bucketKey = `${key}\u0000${who}`;
  const day = dayKey(now);
  const store = state.habitCandidates[bucketKey] ?? {};
  const promoted = [];
  for (const { phrase, short } of candidates.slice(0, 40)) {
    const entry = store[phrase] ?? { count: 0, days: [], firstAt: now, lastAt: now, short };
    entry.count = (Number(entry.count) || 0) + 1;
    entry.lastAt = now;
    if (!Array.isArray(entry.days)) entry.days = [];
    if (!entry.days.includes(day)) entry.days.push(day);
    entry.days = entry.days.slice(-30);
    store[phrase] = entry;
    const threshold = short ? settings.minCount : settings.minCountFragment;
    if (entry.count < threshold || entry.days.length < settings.minDays) continue;
    const list = fromOwner
      ? (state.ownerHabits ??= [])
      : ((state.groups[key] ??= { facts: [], habits: [], updatedAt: 0 }).habits ??= []);
    const existing = list.find((habit) => habit.sender === who && habit.text === phrase);
    if (existing) {
      existing.count = entry.count;
      existing.days = entry.days.slice(-30);
      existing.at = now;
      continue;
    }
    list.push({
      id: `h${now.toString(36)}${promoted.length}`,
      at: now,
      sender: who,
      text: phrase,
      tone: '',
      count: entry.count,
      days: entry.days.slice(-30),
      kind: 'habit',
    });
    promoted.push(phrase);
  }
  const entries = Object.entries(store);
  if (entries.length > settings.maxCandidatesPerSender) {
    entries.sort((left, right) => (Number(right[1].lastAt) || 0) - (Number(left[1].lastAt) || 0));
    state.habitCandidates[bucketKey] = Object.fromEntries(entries.slice(0, settings.maxCandidatesPerSender));
  } else {
    state.habitCandidates[bucketKey] = store;
  }
  if (promoted.length > 0) state.updatedAt = now;
  saveMemory(botId, state);
  return { promoted: promoted.length, habits: promoted };
}

/** 列出某个会话（可指定发言人）的习惯记忆。 */
export function listHabits(botId, { conversationKey, sender = '', fromOwner = false } = {}) {
  const state = loadMemory(botId);
  const pool = [];
  if (fromOwner) pool.push(...(state.ownerHabits ?? []));
  const key = String(conversationKey ?? '');
  if (key) pool.push(...(state.groups?.[key]?.habits ?? []));
  const wanted = String(sender ?? '').trim();
  return (wanted ? pool.filter((habit) => habit.sender === wanted) : pool)
    .slice()
    .sort((left, right) => (Number(right.count) || 0) - (Number(left.count) || 0));
}

/** 给某条习惯设置语气描述（来自每日摘要的模型判断）。 */
export function setHabitTone(botId, {
  conversationKey, sender = '', phrase = '', tone = '', fromOwner = false,
} = {}) {
  const wanted = normalizeMemoryText(phrase);
  const description = String(tone ?? '').replace(/\s+/gu, ' ').trim().slice(0, 40);
  if (!wanted || !description) return 0;
  const state = loadMemory(botId);
  let updated = 0;
  const pools = [];
  if (fromOwner || !conversationKey) pools.push(state.ownerHabits ?? []);
  const key = String(conversationKey ?? '');
  if (key) pools.push(state.groups?.[key]?.habits ?? []);
  for (const pool of pools) {
    for (const habit of pool) {
      if (sender && habit.sender !== sender) continue;
      const habitText = normalizeMemoryText(habit.text);
      if (!habitText) continue;
      if (habitText.includes(wanted) || wanted.includes(habitText)) {
        habit.tone = description;
        updated += 1;
      }
    }
  }
  if (updated > 0) saveMemory(botId, state);
  return updated;
}

/**
 * 选一段「对方说话习惯」提示（概率门控，避免每条都学）。
 * @returns {{block: string, habits: Array}}
 */
export function selectHabitHint(botId, {
  conversationKey, sender = '', fromOwner = false, probability = 0.3, random = Math.random,
} = {}) {
  const habits = listHabits(botId, { conversationKey, sender, fromOwner }).slice(0, 2);
  if (habits.length === 0) return { block: '', habits: [] };
  const gate = Number(probability);
  if (Number.isFinite(gate) && gate <= 0) return { block: '', habits: [] };
  if (Number.isFinite(gate) && gate < 1 && random() > gate) return { block: '', habits: [] };
  const lines = habits.map((habit) => `- 常说「${habit.text}」${habit.tone ? `（语气：${habit.tone}）` : ''}`);
  const block = `\n\n[对方说话习惯] ${lines.join('\n')}\n可以偶尔自然地模仿一点对方的语气或口头禅（不要每句都学、不要刻意复读、不要提这是学来的）。`;
  return { block, habits };
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
  state.ownerHabits = filter(state.ownerHabits);
  const keys = conversationKey ? [String(conversationKey)] : Object.keys(state.groups ?? {});
  for (const key of keys) {
    const bucket = state.groups?.[key];
    if (!bucket) continue;
    bucket.facts = filter(bucket.facts);
    if (Array.isArray(bucket.habits)) bucket.habits = filter(bucket.habits);
    if (bucket.facts.length === 0 && (!bucket.habits || bucket.habits.length === 0)) delete state.groups[key];
  }
  if (!conversationKey) state.habitCandidates = {};
  else {
    for (const [bucketKey, candidates] of Object.entries(state.habitCandidates ?? {})) {
      if (!bucketKey.startsWith(`${conversationKey}\u0000`)) continue;
      const kept = Object.fromEntries(Object.entries(candidates ?? {})
        .filter(([phrase]) => (needle ? !normalizeMemoryText(phrase).includes(needle) : false)));
      if (Object.keys(kept).length === 0) delete state.habitCandidates[bucketKey];
      else state.habitCandidates[bucketKey] = kept;
    }
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
