// test-reasoning-default.mjs — IM 会话默认推理等级的落地逻辑。
//
// 背景：之前用 session.executeCommand('/reasoning low')，那是插件层的命令、
// Host 不认，所以静默失败，会话一直停在 high（GUI 里能看到 High）。
// 现在改成 Host 的模型 API：models() 读当前模型 → selectModel({reasoningEffort})。
//
//   node test-reasoning-default.mjs
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const pluginRoot = join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', '@xmanrui', 'dsh-im');
const ws = await import(pathToFileURL(join(pluginRoot, 'src', 'channels', 'shared', 'workspace-session.mjs')).href);

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
            current: {
              provider: 'deepseek-account',
              model: 'deepseek-v4.1-flash',
              reasoningEffort: currentEffort,
            },
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

// 1. high → low
{
  const session = makeSession();
  const result = await ws.ensureReasoningDefault(session, 's-one', 'c2c:abc', {});
  check('把会话从 high 切到 low', result === 'applied' && session.calls[0]?.reasoningEffort === 'low', result);
  check('同时保留原 provider/model', session.calls[0]?.provider === 'deepseek-account'
    && session.calls[0]?.model === 'deepseek-v4.1-flash');
}

// 2. 每个会话只应用一次
{
  const session = makeSession();
  await ws.ensureReasoningDefault(session, 's-twice', 'c2c:abc', {});
  const second = await ws.ensureReasoningDefault(session, 's-twice', 'c2c:abc', {});
  check('同一会话不重复切换', second === 'skipped' && session.calls.length === 1, second);
}

// 3. 已经 low 就不再动
{
  const session = makeSession({ currentEffort: 'low' });
  const result = await ws.ensureReasoningDefault(session, 's-low', 'c2c:abc', {});
  check('已是 low 时跳过', result === 'already' && session.calls.length === 0, result);
}

// 4. 模型不支持 low 时不动（不乱设未知等级）
{
  const session = makeSession({ efforts: ['medium', 'high'] });
  const result = await ws.ensureReasoningDefault(session, 's-unsupported', 'c2c:abc', {});
  check('模型没有 low 档时保持原样', result === 'unsupported' && session.calls.length === 0, result);
}

// 5. Host 没有模型 API 时不报错
{
  const result = await ws.ensureReasoningDefault(makeSession({ supportsModels: false }), 's-noapi', 'c2c:abc', {});
  check('没有模型 API 时安全跳过', result === 'skipped', result);
}

console.log('');
if (failures.length) {
  console.error(`失败 ${failures.length} 项`);
  process.exit(1);
}
console.log('全部通过：默认推理等级只用 Host 模型 API，且不乱改不支持的情况');
