// local-config.mjs — 个人值（botId / QQ 数据目录 / 主人身份标识）的唯一读取口。
//
// 值放仓库根目录的 config.local.json（已在 .gitignore 里，永远不会提交），
// 键名与假值见 config.local.example.json。
//
// 环境变量优先，方便临时覆盖；没有覆盖时读本地配置。读不到返回 null，由调用方决定是跳过还是报错。
//
//   import { localValue } from './local-config.mjs';
//   const botId = localValue('botIdHiro', 'BOT_ID_HIRO');
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONFIG_PATH = process.env.IM_BOT_KIT_CONFIG || join(REPO_ROOT, 'config.local.json');

let cached;
export function localConfig() {
  if (cached !== undefined) return cached;
  if (!existsSync(CONFIG_PATH)) {
    cached = null;
    return cached;
  }
  try {
    cached = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch (error) {
    throw new Error(`${CONFIG_PATH} 不是合法 JSON：${error.message}`);
  }
  return cached;
}

export function localValue(key, envName) {
  const fromEnv = envName ? process.env[envName] : undefined;
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim();
  const value = localConfig()?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function localConfigPath() {
  return CONFIG_PATH;
}
