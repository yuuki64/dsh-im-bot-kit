// status.mjs — 一条命令看清"现在到底是哪份代码在跑"，并生成文档里的自动数字块。
//
// 用法：
//   node status.mjs                          # 人工可读
//   node status.mjs --json                   # 机器可读
//   node status.mjs --doc <md> [--write]     # 把实测值写进文档里的自动块（默认只打印，不写）
//
// 文档里用下面两行标记自动块，手写内容放标记外面；数字不再手抄，跑一次就会对齐：
//   <!-- dsh-im-status:begin -->  …  <!-- dsh-im-status:end -->
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BUILD_MANIFEST_FILE, LAST_VERIFIED, PATCH_FILE_COUNT, UPSTREAM, resolveEvidenceDir, resolvePluginRoot } from './manifest.mjs';
import { verify } from './verify-build.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');

const MARK_BEGIN = '<!-- dsh-im-status:begin -->';
const MARK_END = '<!-- dsh-im-status:end -->';

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** 当前开关/暂停状态，只读，不写任何文件。 */
async function readChannels() {
  const switches = await readJson(join(DSH_HOME, 'integrations', 'dsh-im', 'switches.json'));
  return {
    paused: existsSync(join(DSH_HOME, 'integrations', 'dsh-im', 'paused')),
    direct: switches?.direct,
    group: switches?.group,
    updatedAt: switches?.updatedAt,
  };
}

export async function collectStatus({ patchDir } = {}) {
  const pluginRoot = resolvePluginRoot();
  const installed = await readJson(join(pluginRoot, 'package.json'));
  const evidenceDir = patchDir ?? resolveEvidenceDir();
  const manifest = await readJson(join(evidenceDir, BUILD_MANIFEST_FILE));
  const result = await verify({ pluginRoot, patchDir: evidenceDir });
  const channels = await readChannels();
  return {
    today: new Date().toISOString(),
    lastVerified: LAST_VERIFIED,
    upstream: { ...UPSTREAM, installedVersion: installed?.version ?? null, pluginRoot },
    patchSet: { count: PATCH_FILE_COUNT, manifestCount: manifest?.patchSet?.files?.length ?? null },
    evidenceDir,
    evidenceLocal: evidenceDir === here,
    build: manifest
      ? {
          mode: manifest.mode,
          builtAt: manifest.builtAt,
          treeFiles: manifest.tree?.fileCount ?? null,
          treeSha256: manifest.tree?.sha256 ?? null,
          bundleBytes: manifest.bundle?.bytes ?? null,
          bundleSha256: manifest.bundle?.sha256 ?? null,
        }
      : null,
    verify: { code: result.code, codeLabel: result.codeLabel, gates: result.gates },
    runtimeConfirmed: result.gates.find((gate) => gate.id === 'runtime')?.ok === true,
    channels,
  };
}

/**
 * 构建证据目录：本目录没有清单时，退到本机权威补丁目录（镜像副本没有本机构建证据）。
 */

function formatHuman(status) {
  const lines = ['[dsh-im 当前状态]', ''];
  lines.push(`上游版本    ${status.upstream.name} ${status.upstream.installedVersion ?? '未安装'}（补丁集适配 ${status.upstream.version}）`);
  lines.push(`补丁清单    ${status.patchSet.count} 个文件`);
  if (status.build) {
    lines.push(`构建基线    ${status.build.mode} · builtAt ${status.build.builtAt}`);
    lines.push(`证据目录    ${status.evidenceDir}${status.evidenceLocal ? '' : '（本副本没有构建证据，用的是本机权威目录）'}`);
    lines.push(`构建输入    ${status.build.treeFiles} 个源文件 · ${status.build.treeSha256?.slice(0, 16)}`);
    lines.push(`产物 bundle ${status.build.bundleBytes?.toLocaleString('en-US')} B · ${status.build.bundleSha256?.slice(0, 16)}`);
  } else {
    lines.push('构建基线    未建立（没有 build-manifest.json；旧安装不能当作一致）');
  }
  lines.push(`核对结论    ${status.verify.codeLabel}`);
  for (const gate of status.verify.gates) {
    const mark = gate.ok === true ? 'OK  ' : gate.ok === false ? 'FAIL' : '未验证';
    lines.push(`  ${mark} ${gate.label}  ${gate.detail}`);
  }
  const direct = status.channels.direct === undefined ? '未知' : status.channels.direct ? '开' : '关';
  const group = status.channels.group === undefined ? '未知' : status.channels.group ? '开' : '关';
  lines.push(`通道开关    私聊=${direct} 群聊=${group}${status.channels.paused ? '（全局暂停中）' : ''}`);
  lines.push(`最后核验    ${status.lastVerified}`);
  return lines.join('\n');
}

function formatDocBlock(status) {
  const direct = status.channels.direct === undefined ? '未知' : status.channels.direct ? '开' : '关';
  const group = status.channels.group === undefined ? '未知' : status.channels.group ? '开' : '关';
  const evidenceNote = status.evidenceLocal ? '' : `（证据来自本机权威目录，不在本副本内）`;
  const rows = [
    ['项', '实测值'],
    ['上游版本', `${status.upstream.name} ${status.upstream.installedVersion ?? '未安装'}（补丁集适配 ${status.upstream.version}）`],
    ['补丁文件数', `${status.patchSet.count}（由 tools/im-patch/manifest.mjs 生成）`],
    status.build
      ? ['构建基线', `${status.build.mode} · ${status.build.builtAt}${evidenceNote}`]
      : ['构建基线', '未建立（没有 build-manifest.json；旧安装不能当作一致）'],
    status.build
      ? ['构建输入', `${status.build.treeFiles} 个源文件 · sha256 ${status.build.treeSha256?.slice(0, 16)}…`]
      : ['构建输入', '无'],
    status.build
      ? ['产物 bundle', `${status.build.bundleBytes?.toLocaleString('en-US')} B · sha256 ${status.build.bundleSha256?.slice(0, 16)}…`]
      : ['产物 bundle', '无'],
    ['核对结论', `\`${status.verify.codeLabel}\`（\`node tools/im-patch/verify-build.mjs\`）`],
    ['运行实例', status.runtimeConfirmed ? '已确认：进程启动时间晚于产物 mtime，加载的就是该 bundle' : '尚未确认'],
    ['通道开关', `私聊=${direct} 群聊=${group}${status.channels.paused ? '（全局暂停）' : ''}`],
    ['最后核验', status.lastVerified],
  ];
  const table = [`| ${rows[0][0]} | ${rows[0][1]} |`, '| --- | --- |', ...rows.slice(1).map(([k, v]) => `| ${k} | ${v} |`)];
  return [
    MARK_BEGIN,
    `<!-- 由 node tools/im-patch/status.mjs --doc 生成于 ${status.today}；数字来自代码清单与实测，不要手改 -->`,
    '',
    ...table,
    '',
    MARK_END,
  ].join('\n');
}

async function updateDoc(docPath, block, write) {
  const absolute = resolve(docPath);
  if (!existsSync(absolute)) {
    console.error(`ERROR 文档不存在：${absolute}`);
    process.exit(1);
  }
  const text = await readFile(absolute, 'utf8');
  const begin = text.indexOf(MARK_BEGIN);
  const end = text.indexOf(MARK_END);
  if (begin < 0 || end < begin) {
    console.error(`ERROR 文档里没有自动块标记（${MARK_BEGIN} / ${MARK_END}）：${absolute}`);
    process.exit(1);
  }
  const next = text.slice(0, begin) + block + text.slice(end + MARK_END.length);
  if (!write) {
    console.log(next.slice(begin, begin + block.length));
    console.log('');
    console.log('（只是预览；加 --write 才会写回文档）');
    return;
  }
  await writeFile(absolute, next, 'utf8');
  console.log(`updated ${absolute}`);
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const write = argv.includes('--write');
  const docIndex = argv.indexOf('--doc');
  const docPath = docIndex >= 0 ? argv[docIndex + 1] : undefined;
  const patchIndex = argv.indexOf('--patch-dir');
  const patchDir = patchIndex >= 0 ? resolve(argv[patchIndex + 1]) : undefined;

  const status = await collectStatus({ patchDir });
  if (json) console.log(JSON.stringify(status, null, 2));
  else if (docPath) {
    await updateDoc(docPath, formatDocBlock(status), write);
    process.exit(0);
  } else console.log(formatHuman(status));
  process.exit(status.verify.code === 0 ? 0 : 1);
}
