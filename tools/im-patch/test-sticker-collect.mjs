// Offline self-test for sticker auto-collection (no DSH needed).
//
//   node tools/im-patch/test-sticker-collect.mjs
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
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
    autoStickerStats, MIN_COLLECT_BYTES, inferStickerTags, sanitizeStickerTags, expandStickerTokens,
    tagSticker, removeSticker,
  } = sticker;

  check('gif attachment is collectable', isCollectableSticker({ name: 'a.gif', mediaType: 'image/gif', size: 6000 }) === true);
  check('webp attachment is collectable', isCollectableSticker({ name: 'b.webp', mediaType: 'image/webp', size: 6000 }) === true);
  check('png attachment is collectable', isCollectableSticker({ name: 'c.png', mediaType: 'image/png', size: 6000 }) === true);
  check('photo jpg is not collectable', isCollectableSticker({ name: 'photo.jpg', mediaType: 'image/jpeg', size: 6000 }) === false);
  check('tiny image is not collectable', isCollectableSticker({ name: 'a.gif', mediaType: 'image/gif', size: 100 }) === false);
  check('huge image is not collectable', isCollectableSticker({ name: 'a.gif', mediaType: 'image/gif', size: 5 * 1024 * 1024 }) === false);
  check('type without extension still collectable', isCollectableSticker({ name: 'x', mediaType: 'image/png', size: 6000 }) === true);

  check('infer tags from laughing text', JSON.stringify(inferStickerTags('笑死我了哈哈哈哈')) === JSON.stringify(['开心']), JSON.stringify(inferStickerTags('笑死我了哈哈哈哈')));
  check('infer tags from annoyed text', JSON.stringify(inferStickerTags('服了，这也太离谱')) === JSON.stringify(['无语']), JSON.stringify(inferStickerTags('服了，这也太离谱')));
  check('infer tags falls back to random', JSON.stringify(inferStickerTags('')) === JSON.stringify(['随机']));
  check('infer tags capped', inferStickerTags('笑死 离谱 生气 哭', { max: 2 }).length === 2, JSON.stringify(inferStickerTags('笑死 离谱 生气 哭', { max: 2 })));
  check('sanitize tags drops bad chars', JSON.stringify(sanitizeStickerTags([' 无/语 ', '可爱', '非常非常长的标签'])) === JSON.stringify(['无语', '可爱']),
    JSON.stringify(sanitizeStickerTags([' 无/语 ', '可爱', '非常非常长的标签'])));
  check('expand synonyms for mood query', expandStickerTokens(['开心']).includes('乐') && expandStickerTokens(['无语']).includes('离谱'),
    JSON.stringify(expandStickerTokens(['开心'])));

  const libraryDir = join(tempHome, 'integrations', 'dsh-im', 'stickers');
  const first = await saveSticker({ bytes: gifBytes(3000, 1), name: 'funny.gif', tags: ['开心'], dir: libraryDir, maxLibrary: 10 });
  check('first sticker saved', first.saved === true && Boolean(first.path), JSON.stringify(first));
  check('auto file name carries tags', first.path.includes('auto_') && first.path.includes('_开心'), first.path);
  const duplicate = await saveSticker({ bytes: gifBytes(3000, 1), name: 'copy.gif', dir: libraryDir, maxLibrary: 10 });
  check('duplicate rejected by hash', duplicate.saved === false && duplicate.reason === 'duplicate', JSON.stringify(duplicate));
  const duplicateOtherTag = await saveSticker({ bytes: gifBytes(3000, 1), name: 'copy.gif', tags: ['无语'], dir: libraryDir, maxLibrary: 10 });
  check('duplicate found even when tags differ', duplicateOtherTag.saved === false && duplicateOtherTag.reason === 'duplicate', JSON.stringify(duplicateOtherTag));
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

  // AI 识图后补标签 / 拒收（tagSticker / removeSticker）。
  const tagTest = await saveSticker({ bytes: gifBytes(3100, 7), name: 'tag.gif', dir: libraryDir, maxLibrary: 10 });
  check('sticker saved without tags for tagging test', tagTest.saved === true, JSON.stringify(tagTest));
  const tagged = await tagSticker({ path: tagTest.path, tags: ['无语', '离谱'] });
  check('tagSticker renames the file with tags', tagged.tagged === true && tagged.path.includes('_无语-离谱'), JSON.stringify(tagged));
  const duplicateAfterTag = await saveSticker({ bytes: gifBytes(3100, 7), name: 'again.gif', dir: libraryDir, maxLibrary: 10 });
  check('dedupe still works after tagging', duplicateAfterTag.saved === false && duplicateAfterTag.reason === 'duplicate', JSON.stringify(duplicateAfterTag));
  const removed = await removeSticker({ path: tagged.path });
  check('removeSticker deletes the auto sticker', removed.removed === true, JSON.stringify(removed));
  check('removed sticker is gone from the library', !readdirSync(libraryDir).includes(basename(tagged.path)));
  const removedAgain = await removeSticker({ path: tagged.path });
  check('removing twice reports missing', removedAgain.removed === false && removedAgain.reason === 'missing', JSON.stringify(removedAgain));

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
