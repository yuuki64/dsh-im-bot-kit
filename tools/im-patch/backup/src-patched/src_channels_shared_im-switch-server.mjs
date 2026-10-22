// Tiny loopback-only control page for the private/group IM switches.
//
// Started once by the plugin host (see plugin-src/host/channels/shared/startup.mjs).
// The page is plain HTML with two toggle buttons and talks to this same server:
//   GET  /api/state            -> current switch state
//   POST /api/state {json body} -> merge {direct?, group?} booleans
//
// Bound to 127.0.0.1 only; POSTs must be application/json and same-origin, so a
// random website cannot flip the bot's switches through a simple form post.
import { createServer } from 'node:http';
import {
  IM_CHAT_TYPES,
  imSwitchPath,
  readSwitchState,
  switchSnapshot,
  writeSwitchState,
} from './im-switch.mjs';

const DEFAULT_PORT = 17863;
const MAX_BODY_BYTES = 4096;

let switchServer = null;
let switchServerStarting = null;

const LOOPBACK_ORIGIN = /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/u;

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

function sendText(response, status, text, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(text);
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('body-too-large'), { code: 'body-too-large' }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8').trim();
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(Object.assign(new Error('invalid-json'), { code: 'invalid-json' }));
      }
    });
    request.on('error', reject);
  });
}

function pickSwitches(input) {
  const patch = {};
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    for (const type of IM_CHAT_TYPES) {
      if (typeof input[type] === 'boolean') patch[type] = input[type];
    }
  }
  return patch;
}

async function handleRequest(request, response, logger) {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const method = request.method ?? 'GET';

  if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    sendText(response, 200, SWITCH_PAGE, 'text/html; charset=utf-8');
    return;
  }
  if (url.pathname === '/api/state') {
    if (method === 'GET') {
      sendJson(response, 200, switchSnapshot());
      return;
    }
    if (method === 'POST') {
      const origin = request.headers.origin;
      if (origin && !LOOPBACK_ORIGIN.test(origin)) {
        sendJson(response, 403, { error: 'origin-not-allowed' });
        return;
      }
      const contentType = String(request.headers['content-type'] ?? '');
      if (!contentType.toLowerCase().startsWith('application/json')) {
        sendJson(response, 415, { error: 'json-body-required' });
        return;
      }
      try {
        const patch = pickSwitches(await readJsonBody(request));
        if (Object.keys(patch).length === 0) {
          sendJson(response, 400, { error: 'no-switch-in-body' });
          return;
        }
        const state = writeSwitchState(patch);
        logger?.info?.(`[dsh-im:switch] direct=${state.direct} group=${state.group}`);
        sendJson(response, 200, switchSnapshot());
      } catch (error) {
        const status = error?.code === 'body-too-large' ? 413 : 400;
        sendJson(response, status, { error: error?.code ?? 'invalid-request' });
      }
      return;
    }
    sendJson(response, 405, { error: 'method-not-allowed' });
    return;
  }
  sendJson(response, 404, { error: 'not-found' });
}

/**
 * Start the loopback switch page once per process. A port already in use means
 * another instance serves it, which is fine: log and keep running.
 */
export function startImSwitchServer({ logger = console } = {}) {
  if (switchServer) return switchServer;
  if (switchServerStarting) return switchServerStarting;
  const port = Number.parseInt(process.env.DSH_IM_SWITCH_PORT ?? '', 10) || DEFAULT_PORT;
  switchServerStarting = new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      switchServerStarting = null;
      resolve(value);
    };
    let server;
    try {
      server = createServer((request, response) => {
        Promise.resolve(handleRequest(request, response, logger)).catch((error) => {
          logger?.warn?.('[dsh-im:switch] request failed:', error?.message ?? error);
          try {
            sendJson(response, 500, { error: 'internal-error' });
          } catch {
            // response already closed
          }
        });
      });
    } catch (error) {
      logger?.warn?.('[dsh-im:switch] cannot create switch page server:', error?.message ?? error);
      settle(null);
      return;
    }
    server.on('error', (error) => {
      if (error?.code === 'EADDRINUSE') {
        logger?.warn?.(`[dsh-im:switch] port ${port} is busy; assuming another instance serves the switch page`);
      } else {
        logger?.warn?.('[dsh-im:switch] switch page server error:', error?.message ?? error);
      }
      settle(null);
    });
    server.listen(port, '127.0.0.1', () => {
      switchServer = server;
      logger?.info?.(`[dsh-im:switch] switch page ready: http://127.0.0.1:${port}/`);
      settle(server);
    });
    server.unref?.();
  });
  return switchServerStarting;
}

export function switchPageUrl() {
  const port = Number.parseInt(process.env.DSH_IM_SWITCH_PORT ?? '', 10) || DEFAULT_PORT;
  return `http://127.0.0.1:${port}/`;
}

export { imSwitchPath, readSwitchState };

const SWITCH_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>IM 机器人开关</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: radial-gradient(1200px 600px at 50% -10%, #1b2436 0%, #0d0f13 55%, #0a0b0e 100%);
    color: #e8ecf3; font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  }
  main { width: min(560px, calc(100vw - 40px)); padding: 28px 0 44px; }
  h1 { margin: 0 0 6px; font-size: 26px; font-weight: 650; letter-spacing: .5px; }
  .sub { margin: 0 0 26px; color: #8b94a7; font-size: 13px; line-height: 1.7; }
  .card {
    display: flex; align-items: center; justify-content: space-between; gap: 18px;
    padding: 22px 24px; margin-bottom: 14px; border-radius: 16px;
    background: linear-gradient(160deg, #181c24, #14171e);
    border: 1px solid #242a35; box-shadow: 0 8px 30px rgba(0,0,0,.35);
  }
  .card[data-on="1"] { border-color: #2b4a86; }
  .label { display: flex; align-items: center; gap: 14px; }
  .label .icon { font-size: 24px; line-height: 1; }
  .label strong { display: block; font-size: 17px; font-weight: 600; }
  .label small { display: block; margin-top: 4px; color: #8b94a7; font-size: 12px; }
  .switch {
    flex: none; width: 60px; height: 34px; border-radius: 999px; border: 0; padding: 0;
    background: #333a48; cursor: pointer; position: relative; transition: background .18s ease;
  }
  .switch::after {
    content: ""; position: absolute; top: 4px; left: 4px; width: 26px; height: 26px; border-radius: 50%;
    background: #eef2f9; transition: transform .18s ease; box-shadow: 0 2px 6px rgba(0,0,0,.4);
  }
  .switch[aria-checked="true"] { background: #3d7bfd; }
  .switch[aria-checked="true"]::after { transform: translateX(26px); }
  .switch:disabled { opacity: .55; cursor: wait; }
  .actions { display: flex; gap: 10px; margin: 22px 0 16px; }
  .actions button {
    flex: 1; padding: 11px 12px; border-radius: 11px; cursor: pointer; font-size: 13px;
    background: #171b22; color: #c9d2e0; border: 1px solid #2a3140;
  }
  .actions button:hover { background: #1d2330; }
  footer { display: flex; justify-content: space-between; gap: 12px; color: #7b8496; font-size: 12px; }
  footer .warn { color: #f0b35c; }
</style>
</head>
<body>
<main>
  <h1>IM 机器人开关</h1>
  <p class="sub">私聊和群聊分开控制。点一下立即生效，关掉的那一侧机器人完全不出声；两个都关掉时机器人会直接离线（DSH 工作区显示离线），再打开任意一侧就会自动重连。</p>

  <section class="card" data-type="direct" data-on="1">
    <div class="label"><span class="icon">💬</span><div><strong>私聊</strong><small>QQ / 微信 一对一会话</small></div></div>
    <button class="switch" role="switch" aria-checked="true" data-type="direct" aria-label="私聊开关"></button>
  </section>

  <section class="card" data-type="group" data-on="1">
    <div class="label"><span class="icon">👥</span><div><strong>群聊</strong><small>QQ 群 @机器人 的会话</small></div></div>
    <button class="switch" role="switch" aria-checked="true" data-type="group" aria-label="群聊开关"></button>
  </section>

  <div class="actions">
    <button data-act="on" type="button">两个都打开</button>
    <button data-act="off" type="button">两个都关掉</button>
  </div>

  <footer>
    <span id="global">总开关：读取中…</span>
    <span id="updated"></span>
  </footer>
</main>
<script>
(function () {
  var cards = Array.prototype.slice.call(document.querySelectorAll('section.card'));
  var switches = Array.prototype.slice.call(document.querySelectorAll('button.switch'));
  var globalEl = document.getElementById('global');
  var updatedEl = document.getElementById('updated');
  var state = { direct: true, group: true };

  function render(payload) {
    if (!payload) return;
    state.direct = payload.direct === true;
    state.group = payload.group === true;
    switches.forEach(function (button) {
      var on = state[button.getAttribute('data-type')] === true;
      button.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    cards.forEach(function (card) {
      var on = state[card.getAttribute('data-type')] === true;
      card.setAttribute('data-on', on ? '1' : '0');
    });
    globalEl.textContent = '总开关：' + (payload.globalPaused
      ? '已暂停（IM 全部离线，开关不生效）'
      : '运行中');
    globalEl.className = payload.globalPaused ? 'warn' : '';
    updatedEl.textContent = payload.updatedAt
      ? '最近修改 ' + new Date(payload.updatedAt).toLocaleString('zh-CN', { hour12: false })
      : '';
  }

  function request(patch) {
    return fetch('/api/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch)
    }).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    });
  }

  function refresh() {
    return fetch('/api/state').then(function (response) {
      return response.ok ? response.json() : null;
    }).then(render).catch(function () {});
  }

  switches.forEach(function (button) {
    button.addEventListener('click', function () {
      var type = button.getAttribute('data-type');
      var patch = {};
      patch[type] = state[type] !== true;
      button.disabled = true;
      request(patch).then(render).catch(function (error) {
        alert('保存失败：' + error.message);
      }).then(function () {
        button.disabled = false;
      });
    });
  });

  Array.prototype.slice.call(document.querySelectorAll('[data-act]')).forEach(function (button) {
    button.addEventListener('click', function () {
      var on = button.getAttribute('data-act') === 'on';
      button.disabled = true;
      request({ direct: on, group: on }).then(render).catch(function (error) {
        alert('保存失败：' + error.message);
      }).then(function () {
        button.disabled = false;
      });
    });
  });

  refresh();
  setInterval(refresh, 4000);
})();
</script>
</body>
</html>
`;
