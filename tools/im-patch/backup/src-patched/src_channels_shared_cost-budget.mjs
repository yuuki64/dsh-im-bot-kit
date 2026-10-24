// 本地补丁（2026-10-24）：按 bot 的每日成本预算（粗算，安全阀用途）。
// 每次模型调用记一笔估算费用；超过上限后只保留「点名/引用/复读」回复，
// watch 与 AI 主动冒泡自动停掉。状态存 integrations/dsh-im/cost-budget.json。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export function budgetStatePath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(home, 'integrations', 'dsh-im', 'cost-budget.json');
}

function dayKey(now) {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function readBudgetState(now = Date.now()) {
  try {
    const doc = JSON.parse(readFileSync(budgetStatePath(), 'utf8'));
    if (doc && doc.date === dayKey(now) && doc.bots && typeof doc.bots === 'object') return doc;
  } catch {
    // missing/corrupt state starts a fresh day
  }
  return { date: dayKey(now), bots: {} };
}

export function botSpentCny(botId, now = Date.now()) {
  if (!botId) return 0;
  const doc = readBudgetState(now);
  return Number(doc.bots?.[botId]?.cny) || 0;
}

/** limitCny <= 0 表示不限。 */
export function isBudgetExhausted(botId, limitCny, now = Date.now()) {
  const limit = Number(limitCny);
  if (!Number.isFinite(limit) || limit <= 0) return false;
  return botSpentCny(botId, now) >= limit;
}

/** 记一笔估算成本，返回该 bot 今日累计（元）。 */
export function chargeBudget(botId, cny, now = Date.now()) {
  const amount = Number(cny);
  if (!botId || !Number.isFinite(amount) || amount <= 0) return botSpentCny(botId, now);
  const doc = readBudgetState(now);
  const current = doc.bots[botId] ?? { cny: 0, calls: 0 };
  doc.bots[botId] = {
    cny: Math.round((Number(current.cny) + amount) * 1e6) / 1e6,
    calls: (Number(current.calls) || 0) + 1,
  };
  try {
    const path = budgetStatePath();
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    renameSync(temporary, path);
  } catch {
    // best-effort persistence; in-memory-free implementation just returns the estimate
  }
  return doc.bots[botId].cny;
}
