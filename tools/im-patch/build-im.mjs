// 从插件自身的 plugin-src/host + src 重新打包 lib/index.js，并写一份构建证据
// （build-manifest.json），让"源码 / 产物 / 运行实例"三者可以互相对上。
//
// 用法：
//   node build-im.mjs                 # 打包到插件 lib/index.js 并写 build-manifest.json
//   node build-im.mjs --out <file>    # 只打包到指定文件（确定性对比、发布前预览），不写清单
//   node build-im.mjs --adopt         # 不覆盖产物：先打包到临时文件，与现有 lib/index.js 比哈希，
//                                     # 一致就用现有产物的信息建立基线（适用于"产物已存在但没有清单"）
//   node build-im.mjs --no-manifest   # 打包但不写清单
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';

import {
  BUILD_MANIFEST_FILE,
  FILES,
  UPSTREAM,
  resolvePatchTarget,
  resolvePluginRoot,
} from './manifest.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const valueOf = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

const pluginRoot = resolvePluginRoot();
const sourceDirectory = resolve(pluginRoot, 'plugin-src/host');
const outputPath = resolve(pluginRoot, 'lib/index.js');
const outOverride = valueOf('--out');
const adopt = flag('--adopt');
const writeManifest = !flag('--no-manifest') && !outOverride;

const { larkSdkHandshakePatch } = await import(
  pathToFileURL(resolve(sourceDirectory, 'lark-sdk-handshake-patch.mjs')).href
);

const externalRuntimePackages = [
  '@tencent-connect/qqbot-connector',
  '@tencent-connect/qqbot-nodejs',
  '@wecom/aibot-node-sdk',
  'dingtalk-stream',
  'imapflow',
  'mailparser',
  'nodemailer',
  'qrcode',
  'sharp',
  'silk-wasm',
  'undici',
];
const external = externalRuntimePackages.flatMap((name) => [name, `${name}/*`]);

async function runBuild(outfile) {
  await mkdir(dirname(outfile), { recursive: true });
  await build({
    entryPoints: [resolve(sourceDirectory, 'index.mjs')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: ['node22'],
    mainFields: ['module', 'main'],
    external,
    nodePaths: [resolve(here, 'node_modules')],
    plugins: [larkSdkHandshakePatch],
    outfile,
    banner: {
      js: [
        "import { createRequire as __dshCreateRequire } from 'node:module';",
        "import { dirname as __dshDirname } from 'node:path';",
        "import { fileURLToPath as __dshFileURLToPath } from 'node:url';",
        'const require = __dshCreateRequire(import.meta.url);',
        'const __filename = __dshFileURLToPath(import.meta.url);',
        'const __dirname = __dshDirname(__filename);',
      ].join('\n'),
    },
    sourcemap: false,
    minify: true,
    legalComments: 'eof',
  });
}

/** @returns {Promise<string>} sha256 hex */
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

/** 构建输入的树哈希：排序后的"相对路径 + 文件哈希"再取一次哈希。 */
async function treeHash(roots) {
  const entries = [];
  for (const [label, root] of roots) {
    for (const file of await listFiles(root)) {
      const rel = `${label}/${file.slice(root.length + 1).split('\\').join('/')}`;
      entries.push(`${rel}\0${await sha256File(file)}`);
    }
  }
  const sha256 = createHash('sha256').update(entries.join('\n')).digest('hex');
  return { sha256, fileCount: entries.length };
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

async function esbuildVersion() {
  const pkg = await readJson(resolve(here, 'node_modules/esbuild/package.json'));
  return pkg?.version ?? 'unknown';
}

async function collectManifest({ bundlePath, mode, builtAt }) {
  const bundleStat = await stat(bundlePath);
  const patchFiles = [];
  for (const [name, rel, base] of FILES) {
    const path = join(here, 'backup', 'src-patched', name);
    patchFiles.push({
      name,
      target: `${base ? `${base}/` : 'src/'}${rel}`,
      sha256: await sha256File(path),
      bytes: (await stat(path)).size,
    });
  }
  const packageJsonPath = join(pluginRoot, 'package.json');
  const lockfile = join(here, 'package-lock.json');
  const pristineTarball = join(here, `xmanrui-dsh-im-${UPSTREAM.version}.tgz`);
  return {
    schemaVersion: 1,
    upstream: {
      name: UPSTREAM.name,
      version: UPSTREAM.version,
      packageJsonSha256: await sha256File(packageJsonPath),
    },
    builtAt,
    mode,
    tree: {
      roots: ['plugin-src/host', 'src'],
      ...(await treeHash([
        ['plugin-src/host', resolve(pluginRoot, 'plugin-src/host')],
        ['src', resolve(pluginRoot, 'src')],
      ])),
    },
    bundle: {
      path: bundlePath,
      sha256: await sha256File(bundlePath),
      bytes: bundleStat.size,
      mtime: bundleStat.mtime.toISOString(),
    },
    patchSet: {
      count: patchFiles.length,
      sha256: createHash('sha256')
        .update(JSON.stringify(patchFiles.map(({ name, sha256: hash }) => ({ name, sha256: hash }))))
        .digest('hex'),
      files: patchFiles,
      backupDir: 'backup/src-patched',
    },
    toolchain: {
      node: process.version,
      esbuild: await esbuildVersion(),
      lockfileSha256: (await readJson(lockfile)) ? await sha256File(lockfile) : null,
      pristineTarballSha256: await sha256File(pristineTarball).catch(() => null),
    },
    coverage: [
      '已覆盖：插件 plugin-src/host + src 全树哈希（即 esbuild 的源码输入）、补丁清单逐文件哈希、',
      '产物哈希、Node/esbuild 版本、tools/im-patch 锁文件哈希、上游 5.2.0 原包哈希。',
      '未覆盖：profile 里 node_modules 的运行期依赖（silk-wasm 等以 external 方式留在产物外）、',
      'esbuild 自身实现细节、启动参数与环境变量。因此本清单能证明"源码→产物"，',
      '不能单独证明"运行时行为"。运行时是否加载了这份产物见 verify-build.mjs 的运行实例门。',
    ].join(''),
  };
}

async function writeBuildManifest(manifest) {
  const path = join(here, BUILD_MANIFEST_FILE);
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return path;
}

if (adopt) {
  const tempBundle = join(tmpdir(), `dsh-im-adopt-${Date.now()}.js`);
  await runBuild(tempBundle);
  const current = await sha256File(outputPath).catch(() => null);
  const rebuilt = await sha256File(tempBundle);
  if (current === null) {
    console.error('ERROR adopt 失败：插件里没有 lib/index.js，请直接跑 node build-im.mjs');
    process.exit(1);
  }
  if (current !== rebuilt) {
    console.error('ERROR adopt 失败：现有产物与从当前源码重新打包的结果不一致');
    console.error(`  现有 lib/index.js  : ${current}`);
    console.error(`  源码重新打包结果  : ${rebuilt}`);
    console.error('  说明产物不是当前源码生成的；需要跑 node apply.mjs 重建并重启 DSH，不能靠 adopt 掩盖。');
    process.exit(1);
  }
  const bundleStat = await stat(outputPath);
  const manifest = await collectManifest({
    bundlePath: outputPath,
    mode: 'adopt',
    builtAt: bundleStat.mtime.toISOString(),
  });
  const path = await writeBuildManifest(manifest);
  console.log(`adopted ${outputPath} (${manifest.bundle.bytes} B)`);
  console.log(`sha256  ${manifest.bundle.sha256}`);
  console.log(`wrote   ${path}（mode=adopt，builtAt 取现有产物 mtime）`);
  process.exit(0);
}

const target = outOverride ? resolve(outOverride) : outputPath;
await runBuild(target);
const bundleStat = await stat(target);
console.log(`Wrote ${target} (${bundleStat.size} B) from ${here}`);

if (writeManifest) {
  const manifest = await collectManifest({
    bundlePath: target,
    mode: 'build',
    builtAt: new Date().toISOString(),
  });
  const path = await writeBuildManifest(manifest);
  console.log(`wrote   ${path}`);
  console.log(`  tree ${manifest.tree.sha256.slice(0, 12)} (${manifest.tree.fileCount} files)`);
  console.log(`  bundle ${manifest.bundle.sha256.slice(0, 12)}`);
}
