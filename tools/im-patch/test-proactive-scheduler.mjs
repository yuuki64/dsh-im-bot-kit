// Offline self-test for the proactive scheduler (no DSH / no QQ needed).
//
//   node tools/im-patch/test-proactive-scheduler.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tempHome = mkdtempSync(join(tmpdir(), 'dsh-im-proactive-'));
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

function writeBehavior(document) {
  const dir = join(tempHome, 'integrations', 'dsh-im');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'behavior.json'), `${JSON.stringify(document, null, 2)}\n`, 'utf8');
}

try {
  const proactive = await import(src('src/channels/qq/qq-proactive.mjs'));
  const {
    parseDailyTimes, formatSlot, jitteredSlotMinutes, evaluateProactiveFire,
    pickProactiveText, QqProactiveScheduler, startOfLocalDay, proactiveStatePath,
  } = proactive;

  check('parseDailyTimes sorts and drops invalid', JSON.stringify(parseDailyTimes(['11:45', '07:45', '7:05', 'bad', '25:00', 9])) === JSON.stringify([425, 465, 705]),
    JSON.stringify(parseDailyTimes(['11:45', '07:45', '7:05', 'bad', '25:00', 9])));
  check('formatSlot pads', formatSlot(425) === '07:05' && formatSlot(705) === '11:45');

  const dayKey = '2026-10-24';
  const a = jitteredSlotMinutes({ dailyMinutes: 465, dayKey, targetKey: 'group:x', jitterMinutes: 10 });
  const b = jitteredSlotMinutes({ dailyMinutes: 465, dayKey, targetKey: 'group:x', jitterMinutes: 10 });
  check('jitter is deterministic', a === b, `${a} vs ${b}`);
  check('jitter stays in range', a >= 455 && a <= 475, String(a));
  const c = jitteredSlotMinutes({ dailyMinutes: 465, dayKey, targetKey: 'group:y', jitterMinutes: 10 });
  check('different targets get different jitter', typeof c === 'number' && c >= 455 && c <= 475);

  const base = { plannedMs: 1_000_000, windowMinutes: 90, quietMinutes: 30, minIntervalMinutes: 120, maxPerDay: 3, probability: 1 };
  check('not-yet before slot', evaluateProactiveFire({ ...base, nowMs: 999_999, countToday: 0 }).reason === 'not-yet');
  check('fired slot skipped', evaluateProactiveFire({ ...base, nowMs: 1_000_001, fired: true, countToday: 0 }).reason === 'already-fired');
  check('window passed skipped', evaluateProactiveFire({ ...base, nowMs: 1_000_000 + 91 * 60_000, countToday: 0 }).reason === 'window-passed');
  check('daily cap blocks', evaluateProactiveFire({ ...base, nowMs: 1_000_001, countToday: 3 }).reason === 'daily-cap');
  check('cooldown blocks', evaluateProactiveFire({ ...base, nowMs: 1_000_001, countToday: 0, lastSentMs: 1_000_001 - 60 * 60_000 }).reason === 'cooldown');
  check('busy group blocks', evaluateProactiveFire({ ...base, nowMs: 1_000_001, countToday: 0, lastActivityMs: 1_000_001 - 5 * 60_000 }).reason === 'not-quiet');
  check('probability blocks', evaluateProactiveFire({ ...base, nowMs: 1_000_001, countToday: 0, probability: 0.5, roll: 0.9 }).reason === 'probability');
  check('due fires', evaluateProactiveFire({ ...base, nowMs: 1_000_001, countToday: 0, roll: 0.1 }).fire === true);

  check('pick exact slot text', pickProactiveText({ '07:45': ['早', '早安'] }, '07:45', () => 0) === '早');
  check('pick default fallback', pickProactiveText({ '07:45': [], default: ['默认'] }, '07:45', () => 0) === '默认');
  check('pick array form', pickProactiveText(['a', 'b'], '07:45', () => 0.9) === 'b');
  check('empty texts', pickProactiveText({}, '07:45', () => 0) === '');

  // Integration: one due slot, one target, probability 1.
  const now = new Date();
  now.setHours(7, 10, 0, 0);
  const nowMs = now.getTime();
  writeBehavior({
    version: 1,
    proactive: {
      enabled: true,
      dailyTimes: ['07:00'],
      jitterMinutes: 0,
      windowMinutes: 120,
      quietMinutes: 0,
      minIntervalMinutes: 0,
      maxPerDay: 1,
      probability: 1,
      bots: {
        'bot-test': {
          enabled: true,
          targets: ['group:TESTGROUP'],
          texts: { '07:00': ['到点了。'] },
        },
      },
    },
  });
  const sent = [];
  const scheduler = new QqProactiveScheduler({
    botId: 'bot-test',
    now: () => nowMs,
    send: async (key, text) => { sent.push([key, text]); },
    allowed: () => true,
  });
  const fired = await scheduler.tick();
  check('scheduler sends the due slot', sent.length === 1 && sent[0][0] === 'group:TESTGROUP' && sent[0][1] === '到点了。',
    JSON.stringify(sent));
  check('scheduler reports fired keys', Array.isArray(fired) && fired.length === 1, JSON.stringify(fired));
  const again = await scheduler.tick();
  check('same slot is not sent twice', again.length === 0 && sent.length === 1);
  const statePath = proactiveStatePath();
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  check('state persisted per bot', state.bots['bot-test']?.count === 1, JSON.stringify(state.bots['bot-test'] ?? null));

  // Daily cap from config still respected on a second target.
  writeBehavior({
    version: 1,
    proactive: {
      enabled: true,
      dailyTimes: ['07:00'],
      jitterMinutes: 0,
      windowMinutes: 120,
      quietMinutes: 0,
      minIntervalMinutes: 0,
      maxPerDay: 1,
      probability: 1,
      bots: {
        'bot-test': {
          enabled: true,
          targets: ['group:OTHER'],
          texts: { '07:00': ['另一个群。'] },
        },
      },
    },
  });
  const capped = await scheduler.tick();
  check('daily cap blocks the second target', capped.length === 0, JSON.stringify(capped));

  // Disabled config never sends.
  writeBehavior({ version: 1, proactive: { enabled: false } });
  const disabled = await scheduler.tick();
  check('disabled config sends nothing', disabled.length === 0);
  scheduler.stop();

  check('startOfLocalDay is local midnight', new Date(startOfLocalDay(nowMs)).getHours() === 0);
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
console.log('\nall proactive-scheduler checks passed');
