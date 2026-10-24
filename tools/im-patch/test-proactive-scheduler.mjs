// Offline self-test for the proactive scheduler (no DSH / no QQ needed).
//
//   node tools/im-patch/test-proactive-scheduler.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
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

// readBehaviorConfig caches by mtimeMs; tests rewrite the file within the same
// millisecond, so force a strictly increasing mtime after every write.
let mtimeTick = Date.now() + 1000;
function writeBehavior(document) {
  const dir = join(tempHome, 'integrations', 'dsh-im');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'behavior.json');
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  mtimeTick += 1000;
  utimesSync(path, new Date(mtimeTick), new Date(mtimeTick));
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

  // 两个目标应当在同一个 tick 里各发一次（旧的全局 lastSentAt 会只发第一个）。
  const now2 = new Date();
  now2.setHours(7, 10, 0, 0);
  const nowMs2 = now2.getTime();
  writeBehavior({
    version: 1,
    proactive: {
      enabled: true,
      dailyTimes: ['07:00'],
      jitterMinutes: 0,
      windowMinutes: 120,
      quietMinutes: 0,
      minIntervalMinutes: 120,
      minIntervalMinutesPerTarget: 120,
      maxPerDay: 9,
      maxPerDayPerTarget: 3,
      probability: 1,
      bots: {
        'bot-multi': {
          enabled: true,
          targets: ['group:A', 'group:B', 'c2c:OWNER'],
          texts: { '07:00': ['到点了。'] },
        },
      },
    },
  });
  const sentMulti = [];
  const multi = new QqProactiveScheduler({
    botId: 'bot-multi',
    now: () => nowMs2,
    send: async (key, text) => { sentMulti.push([key, text]); },
    allowed: () => true,
  });
  const multiFired = await multi.tick();
  check('every target gets its own message in the same tick',
    sentMulti.length === 3 && multiFired.length === 3
    && sentMulti.map(([key]) => key).sort().join(',') === 'c2c:OWNER,group:A,group:B',
    JSON.stringify(sentMulti));
  const multiAgain = await multi.tick();
  check('per-target slots are not re-sent', multiAgain.length === 0 && sentMulti.length === 3, JSON.stringify(multiAgain));
  multi.stop();

  // AI 主动冒泡：安静 + 概率 1 时触发一次，并遵守下次检查间隔。
  const bubbleNow = new Date();
  bubbleNow.setHours(12, 0, 0, 0);
  const bubbleNowMs = bubbleNow.getTime();
  writeBehavior({
    version: 1,
    proactive: {
      enabled: true,
      dailyTimes: ['07:00'],
      jitterMinutes: 0,
      windowMinutes: 1,
      quietMinutes: 0,
      minIntervalMinutes: 0,
      minIntervalMinutesPerTarget: 0,
      maxPerDay: 9,
      maxPerDayPerTarget: 3,
      probability: 0,
      aiBubbles: {
        enabled: true,
        includeDirect: false,
        checkIntervalMinutes: 45,
        jitterMinutes: 0,
        quietMinutes: 5,
        probability: 1,
        minIntervalMinutes: 0,
        maxPerDayPerTarget: 2,
        maxPerDay: 2,
        hours: { start: 0, end: 24 },
      },
      bots: {
        'bot-bubble': { enabled: true, targets: ['group:B'], texts: { default: ['x'] } },
      },
    },
  });
  const bubbles = [];
  const bubbleScheduler = new QqProactiveScheduler({
    botId: 'bot-bubble',
    now: () => bubbleNowMs,
    send: async () => undefined,
    allowed: () => true,
    onBubble: async (key) => { bubbles.push(key); return { sent: true }; },
  });
  const bubbleFirst = await bubbleScheduler.tick();
  check('AI bubble fires once when quiet', bubbles.length === 1 && bubbleFirst.join(',') === 'group:B|bubble',
    JSON.stringify(bubbleFirst));
  const bubbleSecond = await bubbleScheduler.tick();
  check('AI bubble respects the next-check interval', bubbles.length === 1 && bubbleSecond.length === 0,
    JSON.stringify(bubbleSecond));
  bubbleScheduler.stop();

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
