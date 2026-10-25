// Import staged QQ stickers (with AI tags) directly into the sticker library.
// Uses the same `auto_<sha1-16>_<tags>.<ext>` naming as the plugin, but accepts JPG too
// (the plugin's saveSticker only accepts collectable gif/png/webp).
//
//   node tools/im-patch/sticker-import-run.mjs
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const pluginRoot = process.env.DSH_PROFILE_DIR
  ? join(process.env.DSH_PROFILE_DIR, 'node_modules', '@xmanrui', 'dsh-im')
  : join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', '@xmanrui', 'dsh-im');
const lib = await import(new URL(`file://${pluginRoot.replace(/\\/g, '/')}/src/channels/shared/sticker-library.mjs`).href);
const config = await lib.readStickerConfig();
const directory = config.dirs[0];
const stage = 'D:/project for deepseekharness/default-workspace/tools/im-patch/_sticker-import';
const candidates = JSON.parse(readFileSync(join(stage, 'candidates.json'), 'utf8'));
const tags = JSON.parse(readFileSync(join(stage, 'merged-tags.json'), 'utf8'));

const known = new Set(readdirSync(directory).filter((name) => name.startsWith('auto_')).map((name) => name.slice(5, 21)));
let saved = 0;
let duplicate = 0;
let skipped = 0;
const errors = [];
for (const item of candidates) {
  const bytes = readFileSync(item.path);
  if (bytes.length > 3 * 1024 * 1024) { skipped += 1; errors.push(`${item.file}:too-large`); continue; }
  const digest = createHash('sha1').update(bytes).digest('hex').slice(0, 16);
  if (known.has(digest)) { duplicate += 1; continue; }
  const cleanTags = (tags[item.md5] ?? ['随机']).slice(0, 2);
  const suffix = cleanTags.length ? `_${cleanTags.join('-')}` : '';
  const target = join(directory, `auto_${digest}${suffix}.${item.real}`);
  try {
    writeFileSync(target, bytes);
    known.add(digest);
    saved += 1;
  } catch (error) {
    skipped += 1;
    errors.push(`${item.file}:${error?.code ?? error?.message ?? 'write-failed'}`);
  }
}
console.log(JSON.stringify({ saved, duplicate, skipped, total: candidates.length, errors: errors.slice(0, 8), library: directory }, null, 1));
