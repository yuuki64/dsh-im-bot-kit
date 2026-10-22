#!/usr/bin/env node
// Push local commits to GitHub with a token kept OUT of the git config and out of chat.
//
//   node scripts/push-with-token.mjs [branch]
//
// Token lookup: GITHUB_TOKEN / GH_TOKEN env, else `.github-token` next to the repo root.
// Network: uses HTTPS_PROXY / HTTP_PROXY if set; otherwise probes common local proxy
// ports (127.0.0.1:7897 / 7890 / 1080) so pushes work on networks where github.com
// is only reachable through a proxy.
//
// The token is put into a temporary remote URL for this run only; the remote is always
// restored to the plain URL afterwards (even on failure). Output is redacted.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const positional = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const pushTags = process.argv.includes('--tags');
const branch = positional[0] ?? 'main';
const git = (args, env) => execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });

function readToken() {
  const fromEnv = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const file = join(repoRoot, '.github-token');
  if (existsSync(file)) {
    const value = readFileSync(file, 'utf8').trim();
    if (value) return value;
  }
  return null;
}

function probeProxy() {
  const candidates = [
    process.env.HTTPS_PROXY, process.env.https_proxy,
    process.env.HTTP_PROXY, process.env.http_proxy,
    'http://127.0.0.1:7897', 'http://127.0.0.1:7890', 'http://127.0.0.1:1080',
  ].filter(Boolean);
  return new Promise((resolve) => {
    let index = 0;
    const next = () => {
      const raw = candidates[index++];
      if (!raw) return resolve(null);
      let url;
      try { url = new URL(raw); } catch { return next(); }
      if (url.protocol !== 'http:') return resolve(raw); // assume api-level proxy works
      const socket = net.connect({ host: url.hostname, port: Number(url.port || 80) }, () => {
        socket.destroy();
        resolve(raw);
      });
      socket.setTimeout(400, () => { socket.destroy(); next(); });
      socket.on('error', () => next());
    };
    next();
  });
}

const token = readToken();
if (!token) {
  console.error('没有 token：设置 GITHUB_TOKEN/GH_TOKEN，或把 token 单行写进 ' + join(repoRoot, '.github-token'));
  process.exit(2);
}

const remote = git(['remote', 'get-url', 'origin']).trim();
const plain = remote.replace(/^https:\/\/[^@/]+@/, 'https://');
const url = new URL(plain);
const shadow = new URL(plain);

const mask = (text) => String(text ?? '').split(token).join('***').split(encodeURIComponent(token)).join('***');

const proxy = await probeProxy();
const env = { ...process.env };
if (proxy) {
  env.HTTPS_PROXY = proxy;
  env.HTTP_PROXY = proxy;
}

console.log(`remote: ${plain}`);
console.log(`proxy : ${proxy ?? '(直连)'}`);
console.log(`branch: ${branch}`);

let code = 0;
let lastDetail = '';
try {
  // Different token kinds want different credential forms. Try them in order and
  // keep the first one GitHub accepts (classic PAT / fine-grained PAT / app token).
  const credentialForms = [`x-access-token:${token}`, `oauth2:${token}`, `${token}:`, token];
  const remoteUrlFor = (cred) => `${url.protocol}//${cred}@${url.host}${url.pathname}`;
  let ok = false;
  for (const cred of credentialForms) {
    execFileSync('git', ['-C', repoRoot, 'remote', 'set-url', 'origin', remoteUrlFor(cred)], { env });
    try {
      const out = execFileSync('git', ['-C', repoRoot, 'push', 'origin', branch], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
      console.log('push ok');
      if (out.trim()) console.log(mask(out));
      if (pushTags) {
        const tagOut = execFileSync('git', ['-C', repoRoot, 'push', 'origin', '--tags'], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
        console.log('tags pushed');
        if (tagOut.trim()) console.log(mask(tagOut));
      }
      ok = true;
      break;
    } catch (err) {
      lastDetail = [err.stdout, err.stderr].filter(Boolean).map((b) => b.toString()).join('\n');
    }
  }
  if (!ok) {
    code = 1;
    console.error('push failed');
    console.error(mask(lastDetail).trim());
  }
} finally {
  execFileSync('git', ['-C', repoRoot, 'remote', 'set-url', 'origin', plain], { env });
  const restored = git(['remote', 'get-url', 'origin'], env).trim();
  console.log(restored === plain ? 'remote restored to plain URL' : 'WARN: remote not restored: ' + mask(restored));
  console.log(git(['status', '-sb'], env).trim());
}
process.exit(code);
