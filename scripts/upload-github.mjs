#!/usr/bin/env node
// Upload the working tree to a GitHub repository through the REST contents API.
// Used when `git push` cannot reach github.com (its smart-HTTP endpoint is
// unreachable here), while api.github.com still works.
//
// Token lookup: env GITHUB_TOKEN / GH_TOKEN, or a single-line `.github-token`.
// Usage: node scripts/upload-github.mjs [owner/repo]
//
// Existing files are updated (one commit per file) so re-running is idempotent.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);
const git = process.env.GIT_EXE ?? 'git';

function run(args) {
  return execFileSync(git, args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function pickToken() {
  const env = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (env?.trim()) return env.trim();
  const file = join(repoRoot, '.github-token');
  if (existsSync(file)) {
    const value = readFileSync(file, 'utf8').trim();
    if (value) return value;
  }
  return null;
}

const token = pickToken();
if (!token) {
  console.error('No token. Set GITHUB_TOKEN or write it to .github-token.');
  process.exit(2);
}

const api = async (path, init = {}) => {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'dsh-im-bot-kit-uploader',
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, ok: response.ok, body };
};

const target = process.argv[2];
let ownerRepo = target;
if (!ownerRepo) {
  const user = await api('/user');
  if (!user.ok) {
    console.error(`token rejected (${user.status})`);
    process.exit(3);
  }
  ownerRepo = `${user.body.login}/dsh-im-bot-kit`;
  const existing = await api(`/repos/${ownerRepo}`);
  if (existing.status === 404) {
    const created = await api('/user/repos', {
      method: 'POST',
      body: JSON.stringify({ name: 'dsh-im-bot-kit', private: true, has_wiki: false, has_projects: false,
        description: 'DSH IM bot kit: patched dsh-im plugin, anime TTS sidecars, personas and maintenance docs' }),
    });
    if (!created.ok) {
      console.error(`create repo failed (${created.status}): ${JSON.stringify(created.body).slice(0, 200)}`);
      process.exit(4);
    }
    console.log(`created private repo ${ownerRepo}`);
  } else {
    console.log(`using repo ${ownerRepo}`);
  }
}

const files = run(['ls-files', '-z']).split('\0').filter(Boolean);
console.log(`uploading ${files.length} files to ${ownerRepo}`);
let uploaded = 0;
for (const path of files) {
  const content = readFileSync(join(repoRoot, path));
  if (content.length > 900_000) {
    console.warn(`skip large file: ${path} (${content.length} bytes)`);
    continue;
  }
  const encoded = content.toString('base64');
  let sha;
  const head = await api(`/repos/${ownerRepo}/contents/${encodeURIComponent(path).replaceAll('%2F', '/')}`);
  if (head.ok && head.body?.sha) sha = head.body.sha;
  const body = { message: `sync ${path}`, content: encoded, ...(sha ? { sha } : {}) };
  const put = await api(`/repos/${ownerRepo}/contents/${encodeURIComponent(path).replaceAll('%2F', '/')}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  if (!put.ok) {
    console.error(`FAILED ${path} (${put.status}): ${JSON.stringify(put.body).slice(0, 160)}`);
    continue;
  }
  uploaded += 1;
  if (uploaded % 10 === 0) console.log(`  ${uploaded}/${files.length}`);
}
console.log(`done: ${uploaded}/${files.length} files`);
console.log(`https://github.com/${ownerRepo}`);
if (existsSync(join(repoRoot, '.github-token'))) rmSync(join(repoRoot, '.github-token'));
