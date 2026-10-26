// test-reasoning-default.mjs — IM 会话按渠道应用模型/思考强度。
//
// 2026-10-26 起语义变了：默认不再强制 low，而是继承 bot 设置面板；
// 只有 behavior.json → channelModels.direct/group 里显式配置才覆盖。
// 群聊仍尊重主人用 /effort 设过的上限（没设过就继承）。
//
//   node test-reasoning-default.mjs
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const tempHome = mkdtempSync(join(tmpdir(), 'dsh-reasoning-'));
process.env.DSH_HOME = tempHome;
const configDir = join(tempHome, 'integrations', 'dsh-im');
mkdirSync(configDir, { recursive: true });
let stamp = Date.now();
function writeBehavior(channelModels) {
  const path = join(configDir, 'behavior.json');
  writeFileSync(path, JSON.stringify({ channelModels }), 'utf8');
  // behavior-config caches by mtime; force a strictly newer mtime for rapid rewrites.
  stamp += 1000;
  utimesSync(path, new Date(stamp), new Date(stamp));
}

const pluginRoot = join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', '@xmanrui', 'dsh-im');
const ws = await import(new URL(`file://${join(pluginRoot, 'src', 'channels', 'shared', 'workspace-session.mjs').replace(/\\/g, '/')}`).href);

const failures = [];
function check(label, condition, detail = '') {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? `  — ${detail}` : ''}`);
  if (!condition) failures.push(label);
}

function makeSession({ efforts = ['low', 'high'], currentEffort = 'high', supportsModels = true } = {}) {
  const calls = [];
  const session = {
    calls,
    ...(supportsModels
      ? {
        async models() {
          return {
            groups: [{
              id: 'deepseek-account',
              models: [{
                id: 'deepseek-v4.1-flash',
                reasoning: { efforts: efforts.map((id) => ({ id, name: id })), defaultEffort: efforts[0] },
              }],
            }],
            current: { provider: 'deepseek-account', model: 'deepseek-v4.1-flash', reasoningEffort: currentEffort },
          };
        },
        async selectModel(selection) {
          calls.push(selection);
          return { selected: selection };
        },
      }
      : {}),
  };
  return session;
}

try {
  // 1. 默认（无 channelModels 配置）→ 继承面板，不强制改
  writeBehavior({});
  {
    const session = makeSession();
    const result = await ws.ensureReasoningDefault(session, 's-inherit', 'c2c:abc', {});
    check('默认继承面板（不改会话）', result === 'skipped' && session.calls.length === 0, result);
  }

  // 2. 私聊显式配 low → 应用到会话
  writeBehavior({ direct: { reasoningEffort: 'low' } });
  {
    const session = makeSession();
    const result = await ws.ensureReasoningDefault(session, 's-direct-low', 'c2c:abc', {});
    check('私聊按配置切到 low', result === 'applied' && session.calls[0]?.reasoningEffort === 'low', result);
    check('同时保留原 provider/model', session.calls[0]?.provider === 'deepseek-account'
      && session.calls[0]?.model === 'deepseek-v4.1-flash');
  }

  // 3. 同一会话不重复切换
  {
    const session = makeSession();
    await ws.ensureReasoningDefault(session, 's-twice', 'c2c:abc', {});
    const second = await ws.ensureReasoningDefault(session, 's-twice', 'c2c:abc', {});
    check('同一会话不重复切换', second === 'already' && session.calls.length === 1, second);
  }

  // 4. 已经是目标强度 → already
  {
    const session = makeSession({ currentEffort: 'low' });
    const result = await ws.ensureReasoningDefault(session, 's-low', 'c2c:abc', {});
    check('已是 low 时跳过', result === 'already' && session.calls.length === 0, result);
  }

  // 5. 模型不支持配置的强度 → unsupported，不乱设
  {
    const session = makeSession({ efforts: ['medium', 'high'] });
    const result = await ws.ensureReasoningDefault(session, 's-unsupported', 'c2c:abc', {});
    check('模型没有 low 档时保持原样', result === 'unsupported' && session.calls.length === 0, result);
  }

  // 6. 群聊渠道独立配置
  writeBehavior({ direct: { reasoningEffort: 'low' }, group: { reasoningEffort: 'high' } });
  {
    const groupSession = makeSession({ currentEffort: 'low' });
    const result = await ws.ensureReasoningDefault(groupSession, 's-group', 'group:g1', {});
    check('群聊按独立配置切到 high', result === 'applied' && groupSession.calls[0]?.reasoningEffort === 'high', result);
  }

  // 7. Host 没有模型 API 时不报错
  {
    const result = await ws.ensureReasoningDefault(makeSession({ supportsModels: false }), 's-noapi', 'c2c:abc', {});
    check('没有模型 API 时安全跳过', result === 'skipped', result);
  }
} catch (error) {
  console.error(error);
  failures.push('run');
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}

console.log('');
if (failures.length) {
  console.error(`失败 ${failures.length} 项`);
  process.exit(1);
}
console.log('全部通过：按渠道配置应用模型/强度，默认继承面板');
