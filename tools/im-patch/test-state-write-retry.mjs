// test-state-write-retry.mjs — QQ 状态落盘的 Windows 锁重试。
//
// 现象：日志里反复 STATE_WRITE_FAILED / EPERM（rename 覆盖目标文件时，
// 目标被杀毒/索引服务短暂占用）。现在写 .tmp → rename 会重试，仍失败则退化为直接覆盖。
//
//   node test-state-write-retry.mjs
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const pluginRoot = join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', '@xmanrui', 'dsh-im');
const store = await import(pathToFileURL(join(pluginRoot, 'src', 'channels', 'qq', 'state-store.mjs')).href);

const failures = [];
function check(label, condition, detail = '') {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? `  — ${detail}` : ''}`);
  if (!condition) failures.push(label);
}

function makeFs({ renameFailures = 0, renameCode = 'EPERM', writeError = null } = {}) {
  const calls = { writeFile: [], rename: [], mkdir: [], unlink: [] };
  let remaining = renameFailures;
  return {
    calls,
    async mkdir(path) { calls.mkdir.push(path); },
    async writeFile(path, data) {
      if (writeError) throw Object.assign(new Error('write failed'), { code: writeError });
      calls.writeFile.push(path);
    },
    async rename(from, to) {
      calls.rename.push([from, to]);
      if (remaining > 0) {
        remaining -= 1;
        throw Object.assign(new Error('locked'), { code: renameCode });
      }
    },
    async unlink(path) { calls.unlink.push(path); },
  };
}

const snapshot = '{"version":1}\n';
const target = 'C:/fake/dsh/bots/qq_x/state.json';

// 1. 正常一次成功
{
  const fs = makeFs();
  const result = await store.writeSnapshotAtomically(fs, target, snapshot, { baseDelayMs: 1 });
  check('正常写入用 rename', result.strategy === 'rename' && result.attempts === 1);
  check('写入先落到 .tmp', fs.calls.writeFile[0] === `${target}.tmp`);
}

// 2. EPERM 两次后成功（重试生效）
{
  const fs = makeFs({ renameFailures: 2 });
  const result = await store.writeSnapshotAtomically(fs, target, snapshot, { baseDelayMs: 1 });
  check('EPERM 重试后成功', result.strategy === 'rename' && result.attempts === 3, `attempts=${result.attempts}`);
}

// 3. 一直 EPERM → 退化为直接覆盖
{
  const fs = makeFs({ renameFailures: 99 });
  const result = await store.writeSnapshotAtomically(fs, target, snapshot, { baseDelayMs: 1, attempts: 3 });
  check('rename 一直失败则直接覆盖', result.strategy === 'direct', result.strategy);
  check('直接覆盖写的是目标文件', fs.calls.writeFile.includes(target));
}

// 4. 非锁类错误不重试，直接抛出
{
  const fs = makeFs({ renameFailures: 0 });
  let code = '';
  try {
    await store.writeSnapshotAtomically(fs, target, snapshot, { baseDelayMs: 1 });
    await store.writeSnapshotAtomically({ ...fs, async writeFile() { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } }, target, snapshot);
  } catch (error) {
    code = error?.code ?? '';
  }
  check('ENOSPC 之类不重试而是抛出', code === 'ENOSPC', code);
}

console.log('');
if (failures.length) {
  console.error(`失败 ${failures.length} 项`);
  process.exit(1);
}
console.log('全部通过：状态写盘能扛住 Windows 临时文件锁');
