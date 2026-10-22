#!/usr/bin/env node
/**
 * IM 机器人私聊 / 群聊开关（命令行版，和点击页面共用同一个状态文件）。
 *
 *   node im-switch.mjs                 # 查看状态（= status）
 *   node im-switch.mjs status
 *   node im-switch.mjs direct on|off   # 私聊开关
 *   node im-switch.mjs group on|off    # 群聊开关
 *   node im-switch.mjs all on|off      # 两个一起
 *   node im-switch.mjs open            # 用默认浏览器打开点击页面
 *
 * 状态文件：<DSH_HOME>/integrations/dsh-im/switches.json
 *   true  = 该侧正常回复；false = 该侧所有入站消息静默丢弃（不回复、不开会话）。
 * 与全局暂停（paused 标记）相互独立：全局暂停时所有通道离线，开关不生效。
 *
 * 点击页面由插件启动在 http://127.0.0.1:17863/ （DSH 重启后可用）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const dir = join(home, 'integrations', 'dsh-im');
const statePath = join(dir, 'switches.json');
const pausePath = join(dir, 'paused');
const pageUrl = `http://127.0.0.1:${process.env.DSH_IM_SWITCH_PORT || '17863'}/`;

function readState() {
  try {
    const raw = JSON.parse(readFileSync(statePath, 'utf8'));
    return { direct: raw.direct !== false, group: raw.group !== false };
  } catch {
    return { direct: true, group: true };
  }
}

function writeState(patch) {
  const next = { ...readState(), ...patch };
  mkdirSync(dirname(statePath), { recursive: true });
  const payload = { version: 1, direct: next.direct, group: next.group, updatedAt: new Date().toISOString() };
  const tmp = `${statePath}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  renameSync(tmp, statePath);
  return next;
}

function flag(value) {
  const normalized = String(value ?? '').toLowerCase();
  if (['on', '1', 'true', 'open', '开'].includes(normalized)) return true;
  if (['off', '0', 'false', 'close', '关'].includes(normalized)) return false;
  return null;
}

function printStatus() {
  const state = readState();
  const paused = existsSync(pausePath);
  let updatedAt = '';
  try {
    updatedAt = statSync(statePath).mtime.toLocaleString('zh-CN', { hour12: false });
  } catch {
    updatedAt = '（还没设置过，默认全开）';
  }
  console.log(`私聊：${state.direct ? '开' : '关'}`);
  console.log(`群聊：${state.group ? '开' : '关'}`);
  console.log(`总开关（全局暂停）：${paused ? '已暂停（IM 全部离线，两侧开关暂不生效）' : '运行中'}`);
  console.log(`状态文件：${statePath}`);
  console.log(`最近修改：${updatedAt}`);
  console.log(`点击页面：${pageUrl}`);
}

const [command = 'status', target, value] = process.argv.slice(2);

if (command === 'status') {
  printStatus();
} else if (command === 'open') {
  if (process.platform === 'win32') {
    spawnSync('powershell.exe', ['-NoProfile', '-Command', `Start-Process '${pageUrl}'`], { stdio: 'ignore' });
  }
  console.log(pageUrl);
} else if (['direct', 'group', 'all'].includes(command)) {
  const desired = flag(target ?? value);
  if (desired === null) {
    console.error('用法：node im-switch.mjs direct|group|all on|off');
    process.exit(1);
  }
  const patch = command === 'all' ? { direct: desired, group: desired } : { [command]: desired };
  const state = writeState(patch);
  console.log(`已保存：私聊=${state.direct ? '开' : '关'}，群聊=${state.group ? '开' : '关'}`);
  console.log(`页面（DSH 重启后可用）：${pageUrl}`);
} else {
  console.error('未知命令。可用：status | direct on|off | group on|off | all on|off | open');
  process.exit(1);
}
