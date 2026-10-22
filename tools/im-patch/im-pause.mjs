// Pause / resume every IM channel without deleting any credentials.
//
//   node im-pause.mjs on      -> disconnect all IM bots and stop voice sidecars
//   node im-pause.mjs off     -> reconnect them (voice sidecars start on demand)
//   node im-pause.mjs status  -> print current state
//
// The plugin polls the marker file every 5 seconds, so no DSH restart is
// needed once this build is loaded. The marker lives at:
//   <DSH_HOME>/integrations/dsh-im/paused
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const marker = join(home, 'integrations', 'dsh-im', 'paused');
const action = (process.argv[2] ?? 'status').toLowerCase();

const VOICE_SIDECARS = [
  ['gpt-sovits', 'http://127.0.0.1:17862'],
  ['f5', 'http://127.0.0.1:17861'],
];

async function stopVoiceSidecars() {
  for (const [name, url] of VOICE_SIDECARS) {
    try {
      const response = await fetch(`${url}/shutdown`, { method: 'POST', signal: AbortSignal.timeout(3000) });
      console.log(`  voice ${name}: ${response.ok ? 'stopped' : `HTTP ${response.status}`}`);
    } catch {
      console.log(`  voice ${name}: not running`);
    }
  }
}

if (action === 'on' || action === 'pause' || action === 'stop') {
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, `paused at ${new Date().toISOString()}\n`, 'utf8');
  console.log(`paused: ${marker} (IM bots disconnect within ~5s, credentials kept)`);
  await stopVoiceSidecars();
} else if (action === 'off' || action === 'resume' || action === 'start') {
  rmSync(marker, { force: true });
  console.log('resumed: IM bots reconnect within ~5s; voice sidecars start on next voice use');
} else {
  console.log(existsSync(marker) ? 'paused' : 'running');
}
