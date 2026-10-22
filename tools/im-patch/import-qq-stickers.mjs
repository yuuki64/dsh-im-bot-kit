// Import the user's QQ saved stickers into the dsh-im sticker library.
//
// Sources (QQ NT on this machine):
//   <QQ data>/nt_qq/nt_data/Emoji/personal_emoji/Ori/*.gif     (收藏的表情)
//   <QQ data>/nt_qq/nt_data/Emoji/emoji-related/emoji/*/*.{gif,png,webp}  (商城表情包)
//
// The library lives outside the QQ data dir so QQ can clean its cache freely:
//   <DSH_HOME>/integrations/dsh-im/stickers/
//
// Usage: node import-qq-stickers.mjs [--qq-dir "<Tencent Files>/<uin>"]
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const LIBRARY = process.env.DSH_STICKER_DIR ?? join(DSH_HOME, 'integrations', 'dsh-im', 'stickers');
const DEFAULT_QQ_USER = process.env.DSH_QQ_USER_DIR ?? '';

const args = process.argv.slice(2);
const qqIndex = args.indexOf('--qq-dir');
const QQ_USER = qqIndex >= 0 ? args[qqIndex + 1] : DEFAULT_QQ_USER;
if (!QQ_USER) {
  console.error('缺少 QQ 数据目录。用法：node import-qq-stickers.mjs --qq-dir "<Tencent Files>/<QQ号>"');
  console.error('或设置环境变量 DSH_QQ_USER_DIR。');
  process.exit(2);
}

const IMAGE_EXTENSIONS = new Set(['.gif', '.png', '.webp', '.jpg', '.jpeg']);
const MAX_BYTES = 3 * 1024 * 1024;
const MIN_BYTES = 2 * 1024;

function extOf(name) {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
}

async function collectFiles(root, filter) {
  const out = [];
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...await collectFiles(full, filter));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!IMAGE_EXTENSIONS.has(extOf(entry.name))) continue;
    if (filter && !filter(full)) continue;
    out.push(full);
  }
  return out;
}

function sha1(buffer) {
  return createHash('sha1').update(buffer).digest('hex');
}

await mkdir(LIBRARY, { recursive: true });

const existing = new Map();
for (const file of await collectFiles(LIBRARY)) {
  try { existing.set(sha1(await readFile(file)), file); } catch { /* ignore unreadable */ }
}

const sources = [];
const personalDir = join(QQ_USER, 'nt_qq', 'nt_data', 'Emoji', 'personal_emoji', 'Ori');
sources.push(...await collectFiles(personalDir, (file) => extOf(file) === '.gif'));
const marketDir = join(QQ_USER, 'nt_qq', 'nt_data', 'Emoji', 'emoji-related', 'emoji');
sources.push(...await collectFiles(marketDir, (file) => {
  const extension = extOf(file);
  return extension === '.gif' || extension === '.png' || extension === '.webp';
}));

let imported = 0;
let skipped = 0;
for (const source of sources) {
  let bytes;
  try { bytes = await readFile(source); } catch { skipped += 1; continue; }
  if (bytes.length < MIN_BYTES || bytes.length > MAX_BYTES) { skipped += 1; continue; }
  const digest = sha1(bytes);
  if (existing.has(digest)) { skipped += 1; continue; }
  const extension = extOf(source) || '.gif';
  const target = join(LIBRARY, `qq_${digest.slice(0, 16)}${extension}`);
  await copyFile(source, target);
  existing.set(digest, target);
  imported += 1;
}

const total = (await readdir(LIBRARY)).filter((name) => IMAGE_EXTENSIONS.has(extOf(name))).length;
console.log(`source=${QQ_USER}`);
console.log(`library=${LIBRARY}`);
console.log(`imported=${imported} skipped=${skipped} total=${total}`);
