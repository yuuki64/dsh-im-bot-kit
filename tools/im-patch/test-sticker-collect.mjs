// Offline self-test for sticker auto-collection (no DSH needed).
//
//   node tools/im-patch/test-sticker-collect.mjs
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tempHome = mkdtempSync(join(tmpdir(), 'dsh-im-sticker-'));
process.env.DSH_HOME = tempHome;

const pluginRoot = process.env.DSH_PROFILE_DIR
  ? join(process.env.DSH_PROFILE_DIR, 'node_modules', '@xmanrui', 'dsh-im')
  : join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', '@xmanrui', 'dsh-im');
const src = (...parts) => pathToFileURL(resolve(pluginRoot, ...parts)).href;

const failures = [];
function check(label, condition, detail = '') {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures.push(label);
}

function gifBytes(size = 3000, marker = 1) {
  const head = Buffer.from('GIF89a');
  const body = Buffer.alloc(Math.max(0, size - head.length - 1), marker & 0xff);
  return Buffer.concat([head, body]);
}

function pngBytes(size = 3000, marker = 2) {
  const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length), marker & 0xff)]);
}

try {
  const sticker = await import(src('src/channels/shared/sticker-library.mjs'));
  const {
    isCollectableSticker, saveSticker, allowStickerCollection, resetStickerCollectLog,
    autoStickerStats, MIN_COLLECT_BYTES,
  } = sticker;

  check('gif attachment is collectable', isCollectableSticker({ name: 'a.gif', mediaType: 'image/gif', size: 6000 }) === true);
  check('webp attachment is collectable', isCollectableSticker({ name: 'b.webp', mediaType: 'image/webp', size: 6000 }) === true);
  check('png attachment is collectable', isCollectableSticker({ name: 'c.png', mediaType: 'image/png', size: 6000 }) === true);
  check('photo jpg is not collectable', isCollectableSticker({ name: 'photo.jpg', mediaType: 'image/jpeg', size: 6000 }) === false);
  check('tiny image is not collectable', isCollectableSticker({ name: 'a.gif', mediaType: 'image/gif', size: 100 }) === false);
  check('huge image is not collectable', isCollectableSticker({ name: 'a.gif', mediaType: 'image/gif', size: 5 * 1024 * 1024 }) === false);
  check('type without extension still collectable', isCollectableSticker({ name: 'x', mediaType: 'image/png', size: 6000 }) === true);

  const libraryDir = join(tempHome, 'integrations', 'dsh-im', 'stickers');
  const first = await saveSticker({ bytes: gifBytes(3000, 1), name: 'funny.gif', dir: libraryDir, maxLibrary: 10 });
  check('first sticker saved', first.saved === true && Boolean(first.path), JSON.stringify(first));
  const duplicate = await saveSticker({ bytes: gifBytes(3000, 1), name: 'copy.gif', dir: libraryDir, maxLibrary: 10 });
  check('duplicate rejected by hash', duplicate.saved === false && duplicate.reason === 'duplicate', JSON.stringify(duplicate));
  const second = await saveSticker({ bytes: gifBytes(4000, 2), name: 'second.gif', dir: libraryDir, maxLibrary: 10 });
  check('second sticker saved', second.saved === true);
  let stats = await autoStickerStats({ dir: libraryDir });
  check('two auto stickers in library', stats.count === 2, JSON.stringify(stats));
  const tooSmall = await saveSticker({ bytes: Buffer.from('GIF89a'), name: 'tiny.gif', dir: libraryDir, maxLibrary: 10 });
  check('undersized buffer rejected', tooSmall.saved === false && tooSmall.reason === 'too-small', JSON.stringify(tooSmall));
  const sniffed = await saveSticker({ bytes: pngBytes(3500, 3), name: 'x.bin', dir: libraryDir, maxLibrary: 10 });
  check('PNG signature sniffed when extension is odd', sniffed.saved === true, JSON.stringify(sniffed));

  const capped = await saveSticker({ bytes: gifBytes(5000, 9), name: 'cap.gif', dir: libraryDir, maxLibrary: 2 });
  check('cap enforced', capped.saved === true);
  stats = await autoStickerStats({ dir: libraryDir });
  check('library capped to maxLibrary', stats.count <= 2, JSON.stringify(stats));
  const names = readdirSync(libraryDir);
  check('auto files use auto_ prefix', names.every((name) => name.startsWith('auto_')), names.join(','));

  resetStickerCollectLog();
  check('rate limit allows the first one', allowStickerCollection({ perMinute: 1, perHour: 10, perDay: 40 }) === true);
  check('per-minute limit blocks the second', allowStickerCollection({ perMinute: 1, perHour: 10, perDay: 40 }) === false);
  resetStickerCollectLog();
  check('per-hour limit allows first', allowStickerCollection({ perMinute: 10, perHour: 1, perDay: 40 }) === true);
  check('per-hour limit blocks second', allowStickerCollection({ perMinute: 10, perHour: 1, perDay: 40 }) === false);
  resetStickerCollectLog();
  check('per-day limit allows first', allowStickerCollection({ perMinute: 10, perHour: 10, perDay: 1 }) === true);
  check('per-day limit blocks second', allowStickerCollection({ perMinute: 10, perHour: 10, perDay: 1 }) === false);
  resetStickerCollectLog();

  check('minimum collect size is exported', MIN_COLLECT_BYTES === 2048);
} catch (error) {
  console.error(error);
  failures.push('import/run');
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nall sticker-collect checks passed');
