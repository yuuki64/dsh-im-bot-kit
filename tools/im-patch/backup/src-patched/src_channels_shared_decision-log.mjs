// 本地补丁（2026-10-24）：决策日志——每条群消息为什么回/不回，写 jsonl 供 /why 查询。
// 只记录摘要（消息前 N 字 + 判定原因），保留 N 天，不做外发。
import { appendFileSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function decisionLogDir() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(home, 'integrations', 'dsh-im', 'decision-log');
}

function dayKey(now) {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** 追加一条决策，返回写入的记录。 */
export function appendDecision(botId, entry, { now = Date.now(), retentionDays = 30 } = {}) {
  const record = {
    ts: new Date(now).toISOString(),
    bot: botId,
    ...entry,
  };
  const directory = decisionLogDir();
  try {
    mkdirSync(directory, { recursive: true });
    appendFileSync(join(directory, `${dayKey(now)}.jsonl`), `${JSON.stringify(record)}\n`, 'utf8');
  } catch {
    // logging is best-effort
  }
  pruneDecisionLogs(retentionDays, now);
  return record;
}

export function pruneDecisionLogs(retentionDays = 30, now = Date.now()) {
  const days = Math.max(1, Math.floor(Number(retentionDays) || 30));
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  const cutoffKey = dayKey(cutoff);
  const directory = decisionLogDir();
  try {
    for (const file of readdirSync(directory)) {
      if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/u.test(file)) continue;
      if (file.slice(0, 10) < cutoffKey) {
        try { unlinkSync(join(directory, file)); } catch { /* ignore */ }
      }
    }
  } catch {
    // directory missing
  }
}

/** 最近 N 条决策（跨 1~2 天，按时间正序返回）。 */
export function readRecentDecisions(botId, { limit = 20, now = Date.now() } = {}) {
  const directory = decisionLogDir();
  const wanted = Math.max(1, Math.min(200, Math.floor(Number(limit) || 20)));
  const out = [];
  try {
    const files = readdirSync(directory).filter((file) => /^\d{4}-\d{2}-\d{2}\.jsonl$/u.test(file)).sort().reverse();
    for (const file of files.slice(0, 3)) {
      const lines = readFileSync(join(directory, file), 'utf8').split('\n').filter(Boolean);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
          const record = JSON.parse(lines[index]);
          if (record?.bot !== botId) continue;
          out.push(record);
        } catch {
          // skip malformed line
        }
        if (out.length >= wanted) return out.reverse();
      }
    }
  } catch {
    // missing directory = empty log
  }
  return out.reverse();
}
