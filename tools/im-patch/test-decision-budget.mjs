// Offline self-test for decision log, cost budget, closing/quiet helpers.
//
//   node tools/im-patch/test-decision-budget.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tempHome = mkdtempSync(join(tmpdir(), 'dsh-im-decision-'));
process.env.DSH_HOME = tempHome;

const pluginRoot = process.env.DSH_PROFILE_DIR
  ? join(process.env.DSH_PROFILE_DIR, 'node_modules', '@xmanrui', 'dsh-im')
  : join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', '@xmanrui', 'dsh-im');
const src = (...parts) => pathToFileURL(resolve(pluginRoot, ...parts)).href;

const failures = [];
function check(label, condition, detail = '') {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures.push(label);
}

try {
  const budget = await import(src('src/channels/shared/cost-budget.mjs'));
  const decisionLog = await import(src('src/channels/shared/decision-log.mjs'));
  const { isClosingMessage, inQuietHours } = await import(src('src/channels/qq/qq-bridge.mjs'));

  // cost budget
  check('initial spend is zero', budget.botSpentCny('bot-a') === 0);
  budget.chargeBudget('bot-a', 1.5);
  budget.chargeBudget('bot-a', 0.75);
  const spent = budget.botSpentCny('bot-a');
  check('budget accumulates', Math.abs(spent - 2.25) < 1e-9, String(spent));
  check('budget exhausted at limit 2', budget.isBudgetExhausted('bot-a', 2) === true);
  check('budget not exhausted at limit 5', budget.isBudgetExhausted('bot-a', 5) === false);
  check('other bot unaffected', budget.botSpentCny('bot-b') === 0);
  check('zero/negative limit means unlimited', budget.isBudgetExhausted('bot-a', 0) === false);

  // decision log
  const now = Date.now();
  for (let index = 0; index < 3; index += 1) {
    decisionLog.appendDecision('bot-a', { action: 'skip', reason: `reason-${index}`, text: `m${index}` }, { now });
  }
  decisionLog.appendDecision('bot-b', { action: 'sent', reason: 'replied', text: 'other' }, { now });
  const recent = decisionLog.readRecentDecisions('bot-a', { limit: 2, now });
  check('recent decisions returns latest N', recent.length === 2 && recent[1].reason === 'reason-2',
    JSON.stringify(recent.map((record) => record.reason)));
  check('decision log filters by bot', recent.every((record) => record.bot === 'bot-a'));

  // closing / quiet hours helpers
  check('closing: 晚安 closes', isClosingMessage('晚安') === true);
  check('closing: 我先睡了 closes', isClosingMessage('我先睡了') === true);
  check('closing: normal sentence stays open', isClosingMessage('今天吃什么') === false);
  const quiet = { start: 1, end: 7 };
  const at = (hour) => new Date(2026, 9, 24, hour, 30, 0).getTime();
  check('quiet hours at 02:30', inQuietHours(at(2), quiet) === true);
  check('quiet hours at 12:30 free', inQuietHours(at(12), quiet) === false);
  check('quiet hours cross-midnight 23:30', inQuietHours(at(23), { start: 22, end: 6 }) === true);
  check('quiet hours cross-midnight 07:30 free', inQuietHours(at(7), { start: 22, end: 6 }) === false);
} catch (error) {
  console.error(error);
  failures.push('import/run');
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nall decision/budget checks passed');
