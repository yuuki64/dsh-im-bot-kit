// verify-build.mjs — 用构建清单核对四个状态，而不是只查字符串标记：
//
//   1. 补丁清单      ：backup/src-patched 是否还是清单里的那份（权威补丁没被改过）
//   2. 源码已同步    ：已安装插件的 plugin-src/host + src 是否等于清单记录的树哈希
//   3. 产物已构建    ：lib/index.js 是否等于清单记录的产物哈希
//   4. 进程已重启    ：正在监听开关页端口的进程，启动时间是否晚于产物 mtime
//
// "运行行为已验证"（真机收发消息）不在本脚本判定范围内，只如实标注为未验证。
//
// 用法：
//   node verify-build.mjs                      # 人工可读报告，退出码见 EXIT
//   node verify-build.mjs --json               # 机器可读
//   node verify-build.mjs --self-test          # 用临时测试副本跑全部负例，不碰生产目录
// 可选参数：--manifest <path> --patch-dir <path> --process-start <ISO|unknown>
//           --allow-unknown-runtime  --port <17863>
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BUILD_MANIFEST_FILE, UPSTREAM, resolveEvidenceDir, resolvePatchTarget, resolvePluginRoot } from './manifest.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/** 退出码：调用方可以据此区分失败原因，不要只看"非 0"。 */
export const EXIT = Object.freeze({
  OK: 0,
  INTERNAL_ERROR: 1,
  VERSION_MISMATCH: 2,
  NO_BASELINE: 3,
  SRC_DRIFT: 4,
  BUNDLE_DRIFT: 5,
  RUNTIME_NOT_RESTARTED: 6,
  RUNTIME_UNKNOWN: 7,
  MANIFEST_INVALID: 8,
  PATCH_DRIFT: 9,
});

const EXIT_LABEL = {
  0: 'OK',
  1: 'INTERNAL_ERROR',
  2: 'VERSION_MISMATCH',
  3: 'NO_BASELINE',
  4: 'SRC_DRIFT',
  5: 'BUNDLE_DRIFT',
  6: 'RUNTIME_NOT_RESTARTED',
  7: 'RUNTIME_UNKNOWN',
  8: 'MANIFEST_INVALID',
  9: 'PATCH_DRIFT',
};

const IS_WINDOWS = process.platform === 'win32';

function shortHash(hash) {
  return typeof hash === 'string' ? hash.slice(0, 16) : '-';
}

async function sha256File(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function listFiles(root) {
  const out = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  await walk(root);
  return out.sort();
}

/** 与 build-im.mjs 同一算法：排序后的"相对路径 + 文件哈希"再取哈希。 */
export async function treeHash(roots) {
  const entries = [];
  for (const [label, root] of roots) {
    if (!existsSync(root)) continue;
    for (const file of await listFiles(root)) {
      const rel = `${label}/${file.slice(root.length + 1).split('\\').join('/')}`;
      entries.push(`${rel}\0${await sha256File(file)}`);
    }
  }
  return {
    sha256: createHash('sha256').update(entries.join('\n')).digest('hex'),
    fileCount: entries.length,
  };
}

/**
 * 找"正在提供开关页的进程"——它就是加载了当前 lib/index.js 的 DSH 实例。
 * 拿不到证据返回 null，绝不猜。
 */
export function detectRuntimeProcess({ port = 17863 } = {}) {
  if (!IS_WINDOWS) return null;
  let netstat;
  try {
    netstat = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', timeout: 10000 });
  } catch {
    return null;
  }
  const pids = new Set();
  for (const line of netstat.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 5) continue;
    const [, localAddress, , state, pid] = columns;
    if (!localAddress?.endsWith(`:${port}`)) continue;
    if (state !== 'LISTENING') continue;
    if (!/^\d+$/.test(pid)) continue;
    pids.add(Number(pid));
  }
  const processes = [];
  for (const pid of pids) {
    try {
      const raw = execFileSync(
        'powershell',
        ['-NoProfile', '-Command', `$p = Get-Process -Id ${pid} -ErrorAction Stop; $p.StartTime.ToString('o')`],
        { encoding: 'utf8', timeout: 15000 },
      ).trim();
      processes.push({ pid, startedAt: new Date(raw).toISOString() });
    } catch {
      processes.push({ pid, startedAt: null });
    }
  }
  return processes.length ? processes : null;
}

/**
 * 核对四道门。返回 { code, codeLabel, gates, evidence }，不直接退出进程，
 * 便于 status.mjs 与 --self-test 复用。
 */
export async function verify({
  pluginRoot = resolvePluginRoot(),
  patchDir,
  manifestPath,
  processStart,
  allowUnknownRuntime = false,
  port = 17863,
  processes,
} = {}) {
  const gates = [];
  const evidence = {};
  const add = (id, label, ok, detail) => gates.push({ id, label, ok, detail });
  const finish = (code) => ({ code, codeLabel: EXIT_LABEL[code] ?? 'UNKNOWN', gates, evidence });

  const evidenceDir = patchDir ?? resolveEvidenceDir();
  const manifestFile = manifestPath ?? join(evidenceDir, BUILD_MANIFEST_FILE);
  if (evidenceDir !== here) evidence.evidenceDir = evidenceDir;
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  } catch (error) {
    const missing = error?.code === 'ENOENT';
    add(
      'manifest',
      '构建清单',
      false,
      missing
        ? `未建立基线：${manifestFile} 不存在（旧安装没有清单，不能当作一致）`
        : `清单无法解析：${error?.message ?? error}`,
    );
    return finish(missing ? EXIT.NO_BASELINE : EXIT.MANIFEST_INVALID);
  }

  if (manifest?.schemaVersion !== 1 || !manifest?.upstream?.version || !manifest?.tree?.sha256 || !manifest?.bundle?.sha256) {
    add('manifest', '构建清单', false, '清单字段不完整或 schemaVersion 不受支持（期望 1）');
    return finish(EXIT.MANIFEST_INVALID);
  }
  evidence.manifest = { path: manifestFile, builtAt: manifest.builtAt, mode: manifest.mode };
  add(
    'manifest',
    '构建清单',
    true,
    `${manifest.mode === 'adopt' ? 'adopt（基线取自现有产物）' : 'build'} · builtAt ${manifest.builtAt}`,
  );

  // 1. 上游版本
  const installedPackageJson = join(pluginRoot, 'package.json');
  let installedPackage;
  try {
    installedPackage = JSON.parse(await readFile(installedPackageJson, 'utf8'));
  } catch {
    add('upstream', '上游版本', false, `找不到已安装插件：${installedPackageJson}`);
    return finish(EXIT.VERSION_MISMATCH);
  }
  evidence.installedVersion = installedPackage.version;
  if (installedPackage.version !== manifest.upstream.version) {
    add(
      'upstream',
      '上游版本',
      false,
      `已安装 ${installedPackage.version}，清单是 ${manifest.upstream.version}；补丁集只对 ${UPSTREAM.version} 有效`,
    );
    return finish(EXIT.VERSION_MISMATCH);
  }
  const packageJsonSha = await sha256File(installedPackageJson);
  if (manifest.upstream.packageJsonSha256 && packageJsonSha !== manifest.upstream.packageJsonSha256) {
    add('upstream', '上游版本', false, 'package.json 内容与清单不一致（同一版本号但包被改过）');
    return finish(EXIT.VERSION_MISMATCH);
  }
  add('upstream', '上游版本', true, `${manifest.upstream.name} ${manifest.upstream.version}`);

  // 2. 权威补丁清单没被改过
  const patchDrift = [];
  for (const entry of manifest.patchSet?.files ?? []) {
    const path = join(evidenceDir, manifest.patchSet.backupDir ?? 'backup/src-patched', entry.name);
    const actual = await sha256File(path).catch(() => null);
    if (actual !== entry.sha256) patchDrift.push({ name: entry.name, expected: entry.sha256, actual });
  }
  if (patchDrift.length) {
    add(
      'patchSet',
      '补丁清单',
      false,
      `${patchDrift.length} 个补丁源文件与清单不一致：${patchDrift.map((f) => f.name).join(', ')}`,
    );
    return finish(EXIT.PATCH_DRIFT);
  }
  add('patchSet', '补丁清单', true, `${manifest.patchSet.files.length} 个文件哈希一致`);

  // 3. 已安装源码 = 清单记录的构建输入
  const installedTree = await treeHash([
    ['plugin-src/host', resolve(pluginRoot, 'plugin-src/host')],
    ['src', resolve(pluginRoot, 'src')],
  ]);
  evidence.tree = installedTree;
  if (installedTree.sha256 !== manifest.tree.sha256) {
    const unsynced = [];
    for (const entry of manifest.patchSet?.files ?? []) {
      const base = entry.target.startsWith('plugin-src/host/') ? 'plugin-src/host' : 'src';
      const rel = entry.target.slice(base === 'src' ? 4 : 'plugin-src/host/'.length);
      const live = resolvePatchTarget(pluginRoot, [entry.name, rel, base]);
      const actual = await sha256File(live).catch(() => null);
      if (actual !== entry.sha256) unsynced.push(entry.target);
    }
    add(
      'source',
      '源码已同步',
      false,
      `构建输入树哈希不一致（盘上 ${shortHash(installedTree.sha256)} / 清单 ${shortHash(manifest.tree.sha256)}）` +
        (unsynced.length
          ? `；补丁文件没同步：${unsynced.join(', ')}`
          : '；补丁文件都在，差异来自补丁以外的源码改动'),
    );
    return finish(EXIT.SRC_DRIFT);
  }
  add('source', '源码已同步', true, `${installedTree.fileCount} 个源文件 · ${shortHash(installedTree.sha256)}`);

  // 4. 产物 = 清单记录的产物
  const bundlePath = join(pluginRoot, 'lib/index.js');
  const bundleStat = await stat(bundlePath).catch(() => null);
  if (!bundleStat) {
    add('bundle', '产物已构建', false, `找不到产物：${bundlePath}`);
    return finish(EXIT.BUNDLE_DRIFT);
  }
  const bundleSha = await sha256File(bundlePath);
  evidence.bundle = { path: bundlePath, sha256: bundleSha, bytes: bundleStat.size, mtime: bundleStat.mtime.toISOString() };
  if (bundleSha !== manifest.bundle.sha256) {
    add(
      'bundle',
      '产物已构建',
      false,
      `产物与清单不一致（盘上 ${shortHash(bundleSha)} / 清单 ${shortHash(manifest.bundle.sha256)}）；源码改过但没重新打包，或产物被替换过`,
    );
    return finish(EXIT.BUNDLE_DRIFT);
  }
  add('bundle', '产物已构建', true, `${bundleStat.size.toLocaleString('en-US')} B · ${shortHash(bundleSha)}`);

  // 5. 进程已重启：加载这份产物的实例，启动时间必须晚于产物 mtime
  const runtimeProcesses = processes ?? (processStart ? null : detectRuntimeProcess({ port }));
  const bundleMtimeMs = bundleStat.mtime.getTime();
  const slackMs = 2000;
  let runtimeDetail;
  let runtimeOk;
  let runtimeCode = EXIT.OK;
  if (processStart === 'unknown' || (processStart === undefined && runtimeProcesses === null)) {
    runtimeOk = allowUnknownRuntime ? true : false;
    runtimeCode = allowUnknownRuntime ? EXIT.OK : EXIT.RUNTIME_UNKNOWN;
    runtimeDetail = '运行版本尚未确认：找不到监听开关页端口的进程（可加 --allow-unknown-runtime 或 --process-start）';
  } else {
    const candidates = processStart
      ? [{ pid: null, startedAt: new Date(processStart).toISOString() }]
      : runtimeProcesses;
    const stale = candidates.filter((p) => !p.startedAt || new Date(p.startedAt).getTime() < bundleMtimeMs - slackMs);
    if (stale.length || candidates.length === 0) {
      runtimeOk = false;
      runtimeCode = EXIT.RUNTIME_NOT_RESTARTED;
      runtimeDetail =
        `进程启动早于产物 mtime：${stale.map((p) => `PID ${p.pid ?? '-'} @ ${p.startedAt ?? 'unknown'}`).join(', ')}` +
        ` < ${new Date(bundleMtimeMs).toISOString()}；产物改了但没重启，运行中的还是旧代码`;
    } else {
      runtimeOk = true;
      runtimeDetail = candidates
        .map((p) => `PID ${p.pid ?? '-'} 起于 ${p.startedAt} > 产物 mtime ${new Date(bundleMtimeMs).toISOString()}`)
        .join('；');
    }
  }
  evidence.runtime = { processes: runtimeProcesses ?? processStart, code: runtimeCode };
  add('runtime', '进程已重启', runtimeOk, runtimeDetail);
  if (!runtimeOk) return finish(runtimeCode);

  add('behavior', '运行行为已验证', null, '需真机收发消息验证；本脚本不做行为判定，不把它算作通过');
  return finish(EXIT.OK);
}

function entryTargetText(base, rel) {
  return `${base ? `${base}/` : 'src/'}${rel}`;
}

function formatReport(result) {
  const lines = ['[dsh-im 构建 / 运行核对]', ''];
  if (result.evidence?.evidenceDir) {
    lines.push(`证据目录  ${result.evidence.evidenceDir}（本副本没有构建证据，用的是本机权威目录）`);
    lines.push('');
  }
  for (const gate of result.gates) {
    const mark = gate.ok === true ? 'OK  ' : gate.ok === false ? 'FAIL' : '未验证';
    lines.push(`${mark.padEnd(6)} ${gate.label.padEnd(12)} ${gate.detail}`);
  }
  lines.push('');
  lines.push(`结论：${result.codeLabel}${result.code === 0 ? '' : `（exit ${result.code}）`}`);
  return lines.join('\n');
}

function parseArgs(argv) {
  const options = { json: false, selfTest: false, allowUnknownRuntime: false, port: 17863 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--self-test') options.selfTest = true;
    else if (arg === '--allow-unknown-runtime') options.allowUnknownRuntime = true;
    else if (arg === '--manifest') options.manifestPath = resolve(argv[++i]);
    else if (arg === '--patch-dir') options.patchDir = resolve(argv[++i]);
    else if (arg === '--process-start') options.processStart = argv[++i];
    else if (arg === '--port') options.port = Number(argv[++i]);
    else throw new Error(`未知参数：${arg}`);
  }
  return options;
}

async function selfTest() {
  const cases = await buildSelfTestCases();
  let failed = 0;
  for (const testCase of cases) {
    const result = await verify(testCase.options);
    const pass = result.code === testCase.expect;
    if (!pass) failed += 1;
    const mark = pass ? 'PASS' : 'FAIL';
    console.log(
      `${mark}  ${testCase.name.padEnd(34)} 期望 ${testCase.expect}(${EXIT_LABEL[testCase.expect]}) 实际 ${result.code}(${result.codeLabel})`,
    );
    if (!pass) {
      for (const gate of result.gates) console.log(`        · ${gate.label}: ${gate.detail}`);
    }
  }
  console.log('');
  console.log(failed === 0 ? `自测通过：${cases.length} 个用例（含缺清单、版本不符、源码/产物漂移、未重启等负例）` : `自测失败：${failed}/${cases.length}`);
  process.exit(failed === 0 ? 0 : 1);
}

/** 在临时目录里造一个假的插件安装 + 补丁目录，用来验证每道门都能准确失败。 */
async function buildSelfTestCases() {
  const { mkdir, writeFile, rm } = await import('node:fs/promises');
  const root = join(tmpdir(), `dsh-im-verify-selftest-${Date.now()}`);
  const makeFixture = async (name) => {
    const dir = join(root, name);
    const profileDir = join(dir, 'profile');
    const pluginRoot = join(profileDir, 'node_modules', '@xmanrui', 'dsh-im');
    const patchDir = join(dir, 'patch');
    await mkdir(join(pluginRoot, 'src', 'channels'), { recursive: true });
    await mkdir(join(pluginRoot, 'plugin-src', 'host'), { recursive: true });
    await mkdir(join(pluginRoot, 'lib'), { recursive: true });
    await mkdir(join(patchDir, 'backup', 'src-patched'), { recursive: true });
    await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({ name: '@xmanrui/dsh-im', version: '5.2.0' }, null, 2));
    await writeFile(join(pluginRoot, 'src', 'channels', 'a.mjs'), 'export const a = 1;\n');
    await writeFile(join(pluginRoot, 'src', 'channels', 'b.mjs'), 'export const b = 2;\n');
    await writeFile(join(pluginRoot, 'plugin-src', 'host', 'index.mjs'), 'export const host = true;\n');
    await writeFile(join(pluginRoot, 'lib', 'index.js'), '// fake bundle\n');
    await writeFile(join(patchDir, 'backup', 'src-patched', 'a.mjs'), 'export const a = 1;\n');
    await writeFile(join(patchDir, 'backup', 'src-patched', 'b.mjs'), 'export const b = 2;\n');
    const patchFiles = [];
    for (const [name, target] of [
      ['a.mjs', 'src/channels/a.mjs'],
      ['b.mjs', 'src/channels/b.mjs'],
    ]) {
      const path = join(patchDir, 'backup', 'src-patched', name);
      patchFiles.push({ name, target, sha256: await sha256File(path), bytes: (await stat(path)).size });
    }
    const tree = await treeHash([
      ['plugin-src/host', join(pluginRoot, 'plugin-src', 'host')],
      ['src', join(pluginRoot, 'src')],
    ]);
    const bundleStat = await stat(join(pluginRoot, 'lib', 'index.js'));
    const manifest = {
      schemaVersion: 1,
      upstream: {
        name: '@xmanrui/dsh-im',
        version: '5.2.0',
        packageJsonSha256: await sha256File(join(pluginRoot, 'package.json')),
      },
      builtAt: bundleStat.mtime.toISOString(),
      mode: 'build',
      tree: { roots: ['plugin-src/host', 'src'], ...tree },
      bundle: {
        path: join(pluginRoot, 'lib', 'index.js'),
        sha256: await sha256File(join(pluginRoot, 'lib', 'index.js')),
        bytes: bundleStat.size,
        mtime: bundleStat.mtime.toISOString(),
      },
      patchSet: { count: patchFiles.length, files: patchFiles, backupDir: 'backup/src-patched' },
    };
    const manifestPath = join(patchDir, BUILD_MANIFEST_FILE);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return { dir, profileDir, pluginRoot, patchDir, manifestPath, bundleStat, manifest };
  };

  const cases = [];
  const base = async (name) => makeFixture(name);
  const laterThan = (date, seconds) => new Date(date.getTime() + seconds * 1000).toISOString();

  {
    const f = await base('ok');
    cases.push({
      name: '全部门通过',
      expect: 0,
      options: {
        pluginRoot: f.pluginRoot,
        patchDir: f.patchDir,
        manifestPath: f.manifestPath,
        processStart: laterThan(f.bundleStat.mtime, 60),
      },
    });
  }
  {
    const f = await base('src-drift');
    const { appendFile } = await import('node:fs/promises');
    await appendFile(join(f.pluginRoot, 'src', 'channels', 'a.mjs'), '// local edit\n');
    cases.push({
      name: '源码改过没重新打包',
      expect: EXIT.SRC_DRIFT,
      options: { pluginRoot: f.pluginRoot, patchDir: f.patchDir, manifestPath: f.manifestPath, processStart: laterThan(f.bundleStat.mtime, 60) },
    });
  }
  {
    const f = await base('bundle-drift');
    const { appendFile } = await import('node:fs/promises');
    await appendFile(join(f.pluginRoot, 'lib', 'index.js'), '// replaced\n');
    cases.push({
      name: '产物被替换',
      expect: EXIT.BUNDLE_DRIFT,
      options: { pluginRoot: f.pluginRoot, patchDir: f.patchDir, manifestPath: f.manifestPath, processStart: laterThan(f.bundleStat.mtime, 60) },
    });
  }
  {
    const f = await base('no-baseline');
    const { rm } = await import('node:fs/promises');
    await rm(f.manifestPath);
    cases.push({
      name: '缺清单（未建立基线）',
      expect: EXIT.NO_BASELINE,
      options: { pluginRoot: f.pluginRoot, patchDir: f.patchDir, manifestPath: f.manifestPath },
    });
  }
  {
    const f = await base('patch-drift');
    const { appendFile } = await import('node:fs/promises');
    await appendFile(join(f.patchDir, 'backup', 'src-patched', 'b.mjs'), '// patch edited\n');
    cases.push({
      name: '权威补丁被改',
      expect: EXIT.PATCH_DRIFT,
      options: { pluginRoot: f.pluginRoot, patchDir: f.patchDir, manifestPath: f.manifestPath, processStart: laterThan(f.bundleStat.mtime, 60) },
    });
  }
  {
    const f = await base('version-mismatch');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(f.pluginRoot, 'package.json'), JSON.stringify({ name: '@xmanrui/dsh-im', version: '5.3.0' }, null, 2));
    cases.push({
      name: '插件版本不符',
      expect: EXIT.VERSION_MISMATCH,
      options: { pluginRoot: f.pluginRoot, patchDir: f.patchDir, manifestPath: f.manifestPath, processStart: laterThan(f.bundleStat.mtime, 60) },
    });
  }
  {
    const f = await base('not-restarted');
    cases.push({
      name: '产物改了没重启',
      expect: EXIT.RUNTIME_NOT_RESTARTED,
      options: { pluginRoot: f.pluginRoot, patchDir: f.patchDir, manifestPath: f.manifestPath, processStart: laterThan(f.bundleStat.mtime, -60) },
    });
  }
  {
    const f = await base('runtime-unknown');
    cases.push({
      name: '拿不到运行实例证据',
      expect: EXIT.RUNTIME_UNKNOWN,
      options: { pluginRoot: f.pluginRoot, patchDir: f.patchDir, manifestPath: f.manifestPath, processStart: 'unknown' },
    });
  }
  {
    const f = await base('runtime-unknown-allowed');
    cases.push({
      name: '拿不到证据但显式允许',
      expect: 0,
      options: {
        pluginRoot: f.pluginRoot,
        patchDir: f.patchDir,
        manifestPath: f.manifestPath,
        processStart: 'unknown',
        allowUnknownRuntime: true,
      },
    });
  }
  {
    const f = await base('manifest-invalid');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(f.manifestPath, '{ "schemaVersion": 1, ');
    cases.push({
      name: '清单损坏',
      expect: EXIT.MANIFEST_INVALID,
      options: { pluginRoot: f.pluginRoot, patchDir: f.patchDir, manifestPath: f.manifestPath },
    });
  }
  return cases;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) {
    await selfTest();
  } else {
    const result = await verify(options);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else console.log(formatReport(result));
    process.exit(result.code);
  }
}
