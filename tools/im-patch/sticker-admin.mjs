// Sticker library admin: list / add / delete, using the plugin's own sticker-library module.
//
//   node tools/im-patch/sticker-admin.mjs list
//   node tools/im-patch/sticker-admin.mjs add "D:\some\folder" [--tags 开心,可爱] [--dry-run]
//   node tools/im-patch/sticker-admin.mjs delete --tag 无语 [--dry-run]
//   node tools/im-patch/sticker-admin.mjs delete --name auto_ [--older-than-days 30] [--dry-run]
//
// Uses the installed plugin (apply latest patches first). Never touches the QQ cache dirs.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const IMAGE_EXTENSIONS = new Set(['.gif', '.png', '.jpg', '.jpeg', '.webp', '.bmp']);
const pluginRoot = process.env.DSH_PROFILE_DIR
  ? join(process.env.DSH_PROFILE_DIR, 'node_modules', '@xmanrui', 'dsh-im')
  : join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', '@xmanrui', 'dsh-im');
const libUrl = pathToFileURL(join(pluginRoot, 'src', 'channels', 'shared', 'sticker-library.mjs')).href;

function fmtMB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function walkImages(directory, recursive = true, out = []) {
  let entries = [];
  try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (recursive) walkImages(full, recursive, out);
      continue;
    }
    if (!IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
    let size = 0;
    try { size = statSync(full).size; } catch { continue; }
    out.push({ path: full, name: entry.name, size });
  }
  return out;
}

const STICKER_TAG_WORDS = [
  '开心', '可爱', '无语', '生气', '难过', '震惊', '摆烂', '赞', '困', '谢谢', '晚安',
  '尴尬', '委屈', '害羞', '期待', '得意', '疑惑', '哭', '笑', '怒', '慌', '爽', '坏笑', '嘲讽',
  '猫', '狗', '柴犬', '兔子', '熊', '鱼',
];

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--dry-run') args.dryRun = true;
    else if (value === '--yes') args.yes = true;
    else if (value === '--include-manual') args.includeManual = true;
    else if (value === '--recursive') args.recursive = true;
    else if (value === '--tags') { args.tags = (argv[index + 1] ?? '').split(/[,，、\s]+/u).filter(Boolean); index += 1; } else if (value === '--tag') { args.tag = argv[index + 1] ?? ''; index += 1; } else if (value === '--name') { args.name = argv[index + 1] ?? ''; index += 1; } else if (value === '--order') { args.order = argv[index + 1] ?? 'oldest'; index += 1; } else if (value === '--older-than-days') { args.olderThanDays = Number(argv[index + 1]) || 0; index += 1; } else if (value === '--limit') { args.limit = Number(argv[index + 1]) || 0; index += 1; } else args._.push(value);
  }
  return args;
}

function inferTagsFromName(name) {
  const tags = [];
  for (const word of STICKER_TAG_WORDS) {
    if (name.includes(word) && !tags.includes(word)) tags.push(word);
  }
  return tags.slice(0, 2);
}

async function main() {
  const lib = await import(libUrl);
  const config = await lib.readStickerConfig();
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] ?? 'list';

  if (command === 'list' || command === 'stats') {
    const stickers = await lib.listStickers({ refresh: true });
    const managed = resolve(config.dirs[0]);
    const managedStickers = stickers.filter((sticker) => resolve(sticker.path).startsWith(`${managed}${process.platform === 'win32' ? '\\' : '/'}`) || resolve(sticker.path) === managed);
    const stats = managedStickers.map((sticker) => {
      const name = basename(sticker.path);
      const auto = name.startsWith('auto_');
      const match = /^auto_[0-9a-f]{8,40}(?:_([^.]+))?\./u.exec(name);
      const tags = match?.[1] ? match[1].split('-') : [];
      let size = 0;
      let mtime = 0;
      try { const info = statSync(sticker.path); size = info.size; mtime = info.mtimeMs; } catch {}
      return { ...sticker, name, auto, tags, size, mtime };
    });
    const auto = stats.filter((item) => item.auto);
    const manual = stats.filter((item) => !item.auto);
    console.log(`表情库目录：${managed}`);
    console.log(`总数：${stats.length} 张（${fmtMB(stats.reduce((sum, item) => sum + item.size, 0))}）｜自动收藏 ${auto.length}｜手动/其他 ${manual.length}`);
    const byExt = new Map();
    for (const item of stats) byExt.set(extname(item.name).toLowerCase(), (byExt.get(extname(item.name).toLowerCase()) ?? 0) + 1);
    console.log(`格式：${[...byExt.entries()].map(([ext, count]) => `${ext}:${count}`).join('  ')}`);
    const tags = new Map();
    for (const item of stats) for (const tag of item.tags) tags.set(tag, (tags.get(tag) ?? 0) + 1);
    console.log(`已有标签：${[...tags.entries()].sort((a, b) => b[1] - a[1]).map(([tag, count]) => `${tag}(${count})`).join(' ') || '（无）'}`);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const todayAuto = auto.filter((item) => item.mtime >= today.getTime()).length;
    console.log(`今天自动收藏：${todayAuto} 张`);
    const recent = [...auto].sort((a, b) => b.mtime - a.mtime).slice(0, 10);
    console.log('最近自动收藏：');
    for (const item of recent) console.log(`  ${new Date(item.mtime).toLocaleString('zh-CN')}  ${item.name}  ${(item.size / 1024).toFixed(0)}KB`);
    if (config.dirs[1]) {
      const others = walkImages(config.dirs[1], true);
      console.log(`另外的只读表情目录：${config.dirs[1]}（${others.length} 张，只读，不复制）`);
    }
    return;
  }

  if (command === 'add') {
    const directory = args._[1];
    if (!directory || !existsSync(directory)) throw new Error('用法：add <图片目录> [--tags 开心,可爱] [--dry-run]');
    const files = walkImages(directory, args.recursive ?? true);
    if (files.length === 0) throw new Error('目录里没有支持的图片');
    const picked = args.limit > 0 ? files.slice(0, args.limit) : files;
    let saved = 0;
    let duplicate = 0;
    let skipped = 0;
    for (const file of picked) {
      // 标签优先级：--tags > 文件名里的情绪词（如「无语_xxx.gif」）> 无标签（随机池）
      const tags = args.tags?.length ? args.tags : inferTagsFromName(file.name);
      if (args.dryRun) { console.log(`[dry-run] 将加入 ${file.name}${tags.length ? `（标签：${tags.join(',')}）` : ''}`); continue; }
      const bytes = readFileSync(file.path);
      const result = await lib.saveSticker({
        bytes,
        name: file.name,
        tags,
        maxLibrary: 800,
        dir: resolve(config.dirs[0]),
      });
      if (result.saved) { saved += 1; continue; }
      if (result.reason === 'duplicate') duplicate += 1;
      else { skipped += 1; console.log(`跳过 ${file.name}：${result.reason}`); }
    }
    console.log(`完成：新增 ${saved}，重复 ${duplicate}，跳过 ${skipped}（候选 ${picked.length}）`);
    return;
  }

  if (command === 'delete') {
    const stickers = await lib.listStickers({ refresh: true });
    const managed = resolve(config.dirs[0]);
    const now = Date.now();
    const candidates = stickers.map((sticker) => {
      const path = resolve(sticker.path);
      const info = existsSync(path) ? statSync(path) : null;
      const name = basename(path);
      const match = /^auto_[0-9a-f]{8,40}(?:_([^.]+))?\./u.exec(name);
      const tags = match?.[1] ? match[1].split('-') : [];
      return { path, name, size: info?.size ?? 0, mtime: info?.mtimeMs ?? 0, tags, auto: name.startsWith('auto_') };
    }).filter((item) => item.path.startsWith(managed) && (args.includeManual ? true : item.auto));
    let picked = candidates;
    if (args.tag) picked = picked.filter((item) => item.tags.includes(args.tag));
    if (args.name) picked = picked.filter((item) => item.name.includes(args.name));
    if (args.olderThanDays > 0) picked = picked.filter((item) => now - item.mtime >= args.olderThanDays * 24 * 60 * 60 * 1000);
    if (args.order === 'newest') picked = [...picked].sort((a, b) => b.mtime - a.mtime);
    else if (args.order === 'random') picked = [...picked].sort(() => Math.random() - 0.5);
    else picked = [...picked].sort((a, b) => a.mtime - b.mtime);
    if (args.limit > 0) picked = picked.slice(0, args.limit);
    if (picked.length === 0) { console.log('没有匹配的表情'); return; }
    console.log(`匹配 ${picked.length} 张（${fmtMB(picked.reduce((sum, item) => sum + item.size, 0))}）${args.includeManual ? '（包含手动/其他）' : '（仅自动收藏）'}`);
    if (args.dryRun || !args.yes) {
      for (const item of picked.slice(0, 30)) console.log(`  ${item.name}`);
      if (!args.dryRun) console.log('确认删除请加 --yes（先看清单，避免误删）');
      return;
    }
    let removed = 0;
    for (const item of picked) {
      let result;
      if (item.auto) result = await lib.removeSticker({ path: item.path });
      else {
        try { const { unlinkSync } = await import('node:fs'); unlinkSync(item.path); result = { removed: true }; }
        catch { result = { removed: false }; }
      }
      if (result.removed) removed += 1;
    }
    console.log(`已删除 ${removed} 张`);
    return;
  }

  throw new Error(`未知命令：${command}（list / add / delete）`);
}

main().catch((error) => { console.error(error?.message ?? error); process.exit(1); });
