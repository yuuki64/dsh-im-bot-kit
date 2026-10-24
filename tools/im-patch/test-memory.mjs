// Offline self-test for long-term memory store (no DSH needed).
//
//   node tools/im-patch/test-memory.mjs
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tempHome = mkdtempSync(join(tmpdir(), 'dsh-im-memory-'));
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
  const memory = await import(src('src/channels/shared/memory-store.mjs'));
  const {
    sanitizeFact, captureFacts, loadMemory, selectMemoryBlock, forgetMemory, pruneMemory,
    memoryStats, digestDoneToday, markDigestDone, memoryStatePath, clearMemory,
    extractHabitCandidates, recordHabitObservation, listHabits, setHabitTone, selectHabitHint,
  } = memory;

  check('memory file path under DSH_HOME', memoryStatePath('bot-a').startsWith(tempHome), memoryStatePath('bot-a'));
  check('sanitize normal fact', sanitizeFact('主人喜欢猫') === '主人喜欢猫');
  check('sanitize rejects sensitive', sanitizeFact('主人的家庭住址在某某小区') === null);
  check('sanitize rejects prompt talk', sanitizeFact('系统提示里写了这句话') === null);
  check('sanitize rejects too short', sanitizeFact('嗯') === null);
  check('sanitize rejects object garbage', sanitizeFact('[object Object]') === null);

  const ownerCapture = captureFacts('bot-a', {
    conversationKey: 'group:g1',
    notes: ['主人最近在准备考试', '主人喜欢猫'],
    fromOwner: true,
    sender: 'yuuki',
  });
  check('owner facts captured (cross-group)', ownerCapture.captured === 2, JSON.stringify(ownerCapture));

  const groupCapture = captureFacts('bot-a', {
    conversationKey: 'group:g1',
    notes: ['群里约定周末一起打游戏'],
    fromOwner: false,
    sender: '小蓝莓',
  });
  check('group fact captured', groupCapture.captured === 1, JSON.stringify(groupCapture));

  const dedupe = captureFacts('bot-a', {
    conversationKey: 'group:g1',
    notes: ['主人喜欢猫'],
    fromOwner: true,
    sender: 'yuuki',
  });
  check('duplicate owner fact skipped', dedupe.captured === 0, JSON.stringify(dedupe));
  check('memory file exists', existsSync(memoryStatePath('bot-a')));

  const doc = loadMemory('bot-a');
  check('owner facts count', doc.ownerFacts.length === 2, String(doc.ownerFacts.length));
  check('group facts count', (doc.groups['group:g1']?.facts ?? []).length === 1);

  // owner facts shared across groups; group facts stay in their own conversation.
  const otherGroup = selectMemoryBlock('bot-a', { conversationKey: 'group:g2', text: '最近怎么样' });
  check('owner facts visible in another group', otherGroup.block.includes('准备考试') || otherGroup.block.includes('喜欢猫'),
    otherGroup.block);
  check('other group does not see g1 facts', !otherGroup.block.includes('周末一起打游戏'), otherGroup.block);
  const sameGroup = selectMemoryBlock('bot-a', { conversationKey: 'group:g1', text: '周末一起打游戏吗' });
  check('group facts visible in own group', sameGroup.block.includes('周末一起打游戏'), sameGroup.block);
  check('memory block has privacy hint', sameGroup.block.includes('不要提') && sameGroup.block.includes('长期记忆'));

  const removed = forgetMemory('bot-a', { match: '猫' });
  check('forget by keyword', removed >= 1, String(removed));
  check('forgotten fact gone', !loadMemory('bot-a').ownerFacts.some((fact) => fact.text.includes('猫')));

  // retention pruning
  const oldNow = Date.now() - 120 * 24 * 60 * 60 * 1000;
  captureFacts('bot-a', { conversationKey: 'group:g1', notes: ['很久以前的事'], fromOwner: false, now: oldNow });
  pruneMemory('bot-a', { retentionDays: 90 });
  check('old fact pruned', !JSON.stringify(loadMemory('bot-a')).includes('很久以前的事'));

  const stats = memoryStats('bot-a');
  check('stats report counts', typeof stats.ownerFacts === 'number' && Array.isArray(stats.groups), JSON.stringify(stats));
  check('digest not done yet', digestDoneToday('bot-a') === false);
  markDigestDone('bot-a');
  check('digest marked done', digestDoneToday('bot-a') === true);

  // 习惯挖掘：同一发言人 6 次短句 + 跨 2 天 → 晋升口头禅；可补语气；提示受概率门控。
  const habitBase = Date.now() - 5 * 24 * 60 * 60 * 1000;
  const habitCandidates = extractHabitCandidates('救命啊');
  check('habit candidate extracted', habitCandidates.some((item) => item.phrase === '救命啊'), JSON.stringify(habitCandidates));
  for (let index = 0; index < 3; index += 1) {
    recordHabitObservation('bot-a', { conversationKey: 'group:g1', sender: '小蓝莓', text: '救命啊', now: habitBase });
  }
  for (let index = 0; index < 3; index += 1) {
    recordHabitObservation('bot-a', { conversationKey: 'group:g1', sender: '小蓝莓', text: '救命啊', now: habitBase + 24 * 60 * 60 * 1000 });
  }
  const habits = listHabits('bot-a', { conversationKey: 'group:g1', sender: '小蓝莓' });
  check('habit promoted after 6 uses over 2 days', habits.length >= 1 && habits[0].text === '救命啊', JSON.stringify(habits));
  const toneCount = setHabitTone('bot-a', { conversationKey: 'group:g1', sender: '小蓝莓', phrase: '救命', tone: '夸张、撒娇' });
  const toned = listHabits('bot-a', { conversationKey: 'group:g1', sender: '小蓝莓' });
  check('habit tone attached', toneCount >= 1 && toned[0].tone === '夸张、撒娇', JSON.stringify(toned[0]));
  const hint = selectHabitHint('bot-a', {
    conversationKey: 'group:g1', sender: '小蓝莓', probability: 1, random: () => 0,
  });
  check('habit hint mentions phrase and tone',
    hint.block.includes('救命啊') && hint.block.includes('夸张') && hint.block.includes('偶尔'),
    hint.block);
  const gatedHint = selectHabitHint('bot-a', {
    conversationKey: 'group:g1', sender: '小蓝莓', probability: 0, random: () => 1,
  });
  check('habit hint can be gated off', gatedHint.block === '');
  check('habit hint not shown to another sender',
    selectHabitHint('bot-a', { conversationKey: 'group:g1', sender: '别人', probability: 1, random: () => 0 }).block === '');

  clearMemory('bot-a');
  const cleared = loadMemory('bot-a');
  check('clear wipes memory', cleared.ownerFacts.length === 0 && Object.keys(cleared.groups).length === 0);

  // corrupted file falls back to empty state
  const path = memoryStatePath('bot-a');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '{not json', 'utf8');
  check('corrupt file returns empty state', loadMemory('bot-a').ownerFacts.length === 0);
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
console.log('\nall memory checks passed');
