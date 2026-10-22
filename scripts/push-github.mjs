#!/usr/bin/env node
// Create (or reuse) a GitHub repository and push the local commits.
//
// Token lookup order:
//   1. env GITHUB_TOKEN / GH_TOKEN
//   2. file `.github-token` next to this script's repo root (deleted after use)
//
// The token is used only for this process: it is put into a temporary remote URL
// and the remote is rewritten to the plain URL afterwards.
//
// Usage: node scripts/push-github.mjs [repoName] [--public]

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);
const git = process.env.GIT_EXE ?? 'git';

function run(args, options = {}) {
  return execFileSync(git, args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
}

function pickToken() {
  const fromEnv = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const file = join(repoRoot, '.github-token');
  if (existsSync(file)) {
    const value = readFileSync(file, 'utf8').trim();
    if (value) return value;
  }
  return null;
}

const token = pickToken();
if (!token) {
  console.error('No token. Set GITHUB_TOKEN or write it to .github-token (single line).');
  process.exit(2);
}

const args = process.argv.slice(2);
const isPublic = args.includes('--public');
const name = args.find((value) => !value.startsWith('--')) ?? 'dsh-im-bot-kit';

const api = async (path, init = {}) => {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'dsh-im-bot-kit',
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, ok: response.ok, body };
};

const user = await api('/user');
if (!user.ok) {
  console.error(`token rejected (${user.status}): ${JSON.stringify(user.body).slice(0, 200)}`);
  process.exit(3);
}
const login = user.body.login;
console.log(`authenticated as ${login}`);

let repo = await api(`/repos/${login}/${name}`);
if (repo.status === 404) {
  repo = await api('/user/repos', {
    method: 'POST',
    body: JSON.stringify({
      name,
      description: 'DSH IM bot kit: patched dsh-im plugin, anime TTS sidecars, personas and maintenance docs',
      private: !isPublic,
      has_wiki: false,
      has_projects: false,
    }),
  });
  if (!repo.ok) {
    console.error(`create repo failed (${repo.status}): ${JSON.stringify(repo.body).slice(0, 300)}`);
    process.exit(4);
  }
  console.log(`created ${isPublic ? 'public' : 'private'} repo ${login}/${name}`);
} else if (repo.ok) {
  console.log(`repo already exists: ${login}/${name}`);
} else {
  console.error(`repo lookup failed (${repo.status})`);
  process.exit(5);
}

const url = `https://github.com/${login}/${name}.git`;
const authUrl = `https://x-access-token:${token}@github.com/${login}/${name}.git`;

try { run(['remote', 'remove', 'origin'], { stdio: 'ignore' }); } catch { /* no remote yet */ }
run(['remote', 'add', 'origin', authUrl]);
try {
  console.log('pushing main...');
  run(['push', '-u', 'origin', 'main'], { stdio: 'inherit' });
} finally {
  run(['remote', 'set-url', 'origin', url]);
  if (existsSync(join(repoRoot, '.github-token'))) rmSync(join(repoRoot, '.github-token'));
}
console.log(`done: ${url}`);
