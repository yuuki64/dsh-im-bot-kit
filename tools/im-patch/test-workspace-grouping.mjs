#!/usr/bin/env node
/**
 * 离线自测：会话创建时的工作区归属（第 15 轮补丁）
 *
 * 覆盖 `HarnessClient.createSession()` 的分支：
 *   1. 目标目录是已注册工作区（哪怕只是 <DSH_HOME>/im junction 的别名）→ 传 workspaceId；
 *   2. 目标目录就是未分组默认目录且 Host 没注册它 → 传 cwd（保持旧行为）；
 *   3. 目标目录既不是未分组、也没有注册 → workspace.create 后传新 id；
 *   4. workspace.list 报错时，未分组路径回退 cwd，不把建会话拖挂；
 *   5. workspaceId() 命中已注册项时不再重复创建。
 *
 * 依赖：先跑过 `node apply.mjs`（本测试读的是已安装插件的 src）。
 * 用法：node test-workspace-grouping.mjs
 */
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const profile = process.env.DSH_PROFILE_DIR ?? join(home, 'profiles', 'desktop');
const pluginRoot = join(profile, 'node_modules', '@xmanrui', 'dsh-im');
const clientModule = join(pluginRoot, 'src', 'channels', 'shared', 'harness-client.mjs');

const { HarnessClient } = await import(pathToFileURL(clientModule).href);

const UNGROUPED = join(home, 'im');
const BOT_WORKSPACE = 'D:\\project for deepseekharness\\bot-workspace';
const BOT_WORKSPACE_ID = 'ws-bot';
const OTHER_WORKSPACE = 'D:\\project for deepseekharness\\other-workspace';

/** 造一个只接 rpc 的 client；返回每次 rpc 调用，供断言 payload。 */
function stubClient({ workspace, workspaceList = [], listError } = {}) {
  const calls = [];
  const client = new HarnessClient({ apiProxy: {}, workspace, ungroupedWorkspace: UNGROUPED });
  client.ensureRunning = async () => true;
  client.rpc = async (method, params = {}) => {
    calls.push({ method, params });
    if (method === 'workspace.list') {
      if (listError) throw listError;
      return { items: workspaceList, archivedSessionIds: [] };
    }
    if (method === 'workspace.create') {
      return { workspace: { workspaceId: 'ws-created', path: params.path } };
    }
    if (method === 'session.create') {
      return { sessionId: 'session-created' };
    }
    throw new Error(`unexpected rpc ${method}`);
  };
  return { client, calls };
}

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`ok    ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`FAIL  ${name}: ${error.message}`);
  }
}

// 1. junction 别名 = 已注册工作区 → workspaceId（不是 cwd）
{
  const { client, calls } = stubClient({
    workspace: BOT_WORKSPACE,
    workspaceList: [{ workspaceId: BOT_WORKSPACE_ID, path: BOT_WORKSPACE }],
  });
  await client.createSession({});
  const payload = calls.find((c) => c.method === 'session.create')?.params;
  check('alias-of-registered-workspace -> workspaceId', () => {
    assert.deepEqual(payload, { workspaceId: BOT_WORKSPACE_ID });
  });
}

// 1b. 从 junction 路径一侧看，同样要命中已注册工作区（canonical 比较）
{
  const { client, calls } = stubClient({
    workspace: UNGROUPED,
    workspaceList: [{ workspaceId: BOT_WORKSPACE_ID, path: BOT_WORKSPACE }],
  });
  await client.createSession({});
  const payload = calls.find((c) => c.method === 'session.create')?.params;
  check('canonical-match-from-ungrouped-path -> workspaceId', () => {
    assert.deepEqual(payload, { workspaceId: BOT_WORKSPACE_ID });
  });
}

// 2. 未注册的未分组默认目录 → cwd（旧行为不变）
{
  const { client, calls } = stubClient({ workspace: UNGROUPED, workspaceList: [] });
  await client.createSession({});
  const payload = calls.find((c) => c.method === 'session.create')?.params;
  check('unregistered-ungrouped-dir -> cwd', () => {
    assert.deepEqual(payload, { cwd: UNGROUPED });
  });
}

// 3. 非未分组且未注册 → 先 workspace.create 再传新 id
{
  const { client, calls } = stubClient({ workspace: OTHER_WORKSPACE, workspaceList: [] });
  await client.createSession({});
  const created = calls.find((c) => c.method === 'workspace.create');
  const payload = calls.find((c) => c.method === 'session.create')?.params;
  check('unregistered-non-ungrouped -> workspace.create then workspaceId', () => {
    assert.equal(created?.params?.path, OTHER_WORKSPACE);
    assert.deepEqual(payload, { workspaceId: 'ws-created' });
  });
}

// 4. workspace.list 失败时，未分组路径回退 cwd（不阻塞建会话）
{
  const { client, calls } = stubClient({ workspace: UNGROUPED, listError: new Error('host down') });
  await client.createSession({});
  const payload = calls.find((c) => c.method === 'session.create')?.params;
  check('workspace.list-error-ungrouped -> cwd fallback', () => {
    assert.deepEqual(payload, { cwd: UNGROUPED });
  });
}

// 5. workspaceId() 命中已注册项时不再重复创建
{
  const { client, calls } = stubClient({
    workspace: BOT_WORKSPACE,
    workspaceList: [{ workspaceId: BOT_WORKSPACE_ID, path: BOT_WORKSPACE }],
  });
  const id = await client.workspaceId();
  check('workspaceId() reuses registration', () => {
    assert.equal(id, BOT_WORKSPACE_ID);
    assert.equal(calls.some((c) => c.method === 'workspace.create'), false);
  });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
