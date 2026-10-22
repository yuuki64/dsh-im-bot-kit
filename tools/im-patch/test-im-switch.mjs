// Offline self-test for the private/group IM switches (no DSH needed).
//
//   node tools/im-patch/test-im-switch.mjs
//
// Runs against a throwaway DSH_HOME: writes the state file, exercises the
// shared inbound gate, starts the loopback switch page on a test port and
// checks its API (including the "no cross-site form post" rules).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tempHome = mkdtempSync(join(tmpdir(), 'dsh-im-switch-'));
process.env.DSH_HOME = tempHome;
const port = String(18000 + Math.floor(Math.random() * 900));
process.env.DSH_IM_SWITCH_PORT = port;

const pluginRoot = process.env.DSH_PROFILE_DIR
  ? join(process.env.DSH_PROFILE_DIR, 'node_modules', '@xmanrui', 'dsh-im')
  : 'C:/Users/yuuki/.dsh/profiles/desktop/node_modules/@xmanrui/dsh-im';
const src = (...parts) => pathToFileURL(resolve(pluginRoot, ...parts)).href;

const failures = [];
function check(label, condition, detail = '') {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures.push(label);
}

try {
  const switches = await import(src('src/channels/shared/im-switch.mjs'));
  const { readSwitchState, writeSwitchState, chatSwitchDecision, imSwitchPath, switchSnapshot } = switches;

  const defaults = readSwitchState();
  check('defaults are both enabled', defaults.direct === true && defaults.group === true, JSON.stringify(defaults));
  check('missing state file keeps both enabled', chatSwitchDecision('direct') === null && chatSwitchDecision('group') === null);

  writeSwitchState({ direct: false });
  let persisted = JSON.parse(readFileSync(imSwitchPath(), 'utf8'));
  check('write persists direct=false, group stays true', persisted.direct === false && persisted.group === true, JSON.stringify(persisted));
  check('gate denies direct', chatSwitchDecision('direct')?.reason === 'chat-switch-off');
  check('gate allows group', chatSwitchDecision('group') === null);
  check('unknown conversation type is never gated', chatSwitchDecision('channel') === null);

  writeSwitchState({ direct: true, group: false });
  check('gate flipped', chatSwitchDecision('direct') === null && chatSwitchDecision('group')?.reason === 'chat-switch-off');
  check('one side on keeps the bot connected', switches.anyChatEnabled() === true);
  writeSwitchState({ direct: false, group: false });
  check('both sides off means offline', switches.anyChatEnabled() === false);
  writeSwitchState({ direct: true, group: false });

  const inboundAccess = await import(src('src/channels/shared/inbound-access.mjs'));
  const denyDecision = inboundAccess.evaluateInboundAccess(null, { conversationType: 'group', senderIds: 'x' });
  check('shared inbound gate returns the switch denial', denyDecision.allowed === false && denyDecision.reason === 'chat-switch-off', JSON.stringify(denyDecision));

  const { startImSwitchServer } = await import(src('src/channels/shared/im-switch-server.mjs'));
  const server = await startImSwitchServer({ logger: { info() {}, warn() {} } });
  check('switch server started', Boolean(server), server ? `port ${port}` : 'null');
  if (server) {
    const base = `http://127.0.0.1:${port}`;
    const page = await fetch(`${base}/`);
    const html = await page.text();
    check('page served', page.status === 200 && html.includes('IM 机器人开关') && html.includes('私聊') && html.includes('群聊'));

    const stateResponse = await fetch(`${base}/api/state`);
    const state = await stateResponse.json();
    check('state api reads file', stateResponse.status === 200 && state.direct === true && state.group === false, JSON.stringify(state));

    const post = await fetch(`${base}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ direct: false, group: true }),
    });
    const posted = await post.json();
    check('state api writes file', post.status === 200 && posted.direct === false && posted.group === true, JSON.stringify(posted));
    const onDisk = JSON.parse(readFileSync(imSwitchPath(), 'utf8'));
    check('posted state hit the disk', onDisk.direct === false && onDisk.group === true);

    const formPost = await fetch(`${base}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'direct=true',
    });
    check('non-JSON post rejected (415)', formPost.status === 415, String(formPost.status));

    const foreignOrigin = await fetch(`${base}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ group: false }),
    });
    check('foreign origin rejected (403)', foreignOrigin.status === 403, String(foreignOrigin.status));

    const missing = await fetch(`${base}/nope`);
    check('unknown route is 404', missing.status === 404, String(missing.status));

    writeSwitchState({ direct: true, group: true });
    const snapshot = switchSnapshot();
    check('snapshot reports both on', snapshot.direct === true && snapshot.group === true, JSON.stringify(snapshot));
    await new Promise((done) => server.close(done));
    check('switch server closed', true);
  }
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nall switch checks passed');
