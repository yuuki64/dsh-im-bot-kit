#!/usr/bin/env node
// check-mirror-sync.mjs — 只读核对"开源镜像 == 本机权威补丁目录"。
//
// 方向是单向的：权威目录（<WORKSPACE>\tools\im-patch）是真身，镜像只是副本。
// 本脚本只读，不复制、不覆盖、不改 git 状态；差异由人判断后再同步。
//
// 用法：
//   node scripts/check-mirror-sync.mjs                  # 人工可读
//   node scripts/check-mirror-sync.mjs --json           # 机器可读
//   node scripts/check-mirror-sync.mjs --auth <dir>     # 指定权威补丁目录
//   node scripts/check-mirror-sync.mjs --strict-eol     # 把"只有换行差异"也算失败
//   node scripts/check-mirror-sync.mjs --self-test      # 用临时副本跑负例
//
// 退出码：0 一致 / 1 有需要处理的差异 / 2 环境问题（权威目录不存在等）
//
// 三条口径（不要用"整文件忽略"来消灭告警）：
//   1. 换行差异：CRLF/LF 归一化后再比；默认只警告（仓库有 .gitattributes 强制 LF）。
//   2. 脱敏差异：只允许 REDACTIONS 里显式声明的规则，且必须写明原因；目前补丁源码范围内为空。
//   3. 缺文件、真内容差异、镜像多出来的文件：一律失败。
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '..');

/** 只在权威目录存在的本机文件：不参与比较，也不会进镜像。 */
const LOCAL_ONLY_IN_AUTH = new Set([
  'build-manifest.json', // 本机构建证据，含绝对路径
  'encode-test.mjs',
  'build-pristine.mjs',
  'pristine',
  'pristine-build',
  'reference',
  'test.wav',
  'test.silk',
  'xmanrui-dsh-im-5.2.0.tgz', // npm 原包，体积大且不属自有代码
  '新会话开场白.md',
]);

/** 镜像里允许存在的额外文件（相对 tools/im-patch）。 */
const MIRROR_ALLOWED_EXTRA = new Set([]);

/**
 * 显式脱敏规则：权威 → 镜像比较前替换掉机器相关信息。
 * 加规则必须写原因；不要用"忽略整个文件"代替。
 */
const REDACTIONS = [
  // 目前 tools/im-patch 范围没有需要脱敏的内容（纯源码 + 文档，路径已用 <WORKSPACE> 占位）。
  // 若将来把带本机路径的文档放进这个范围，在这里加 { pattern, replacement, reason }，而不是跳过整文件。
];

/** 不允许被提交的路径（凭据、依赖、模型、聊天库、本机音频）。 */
const FORBIDDEN_TRACKED = [
  { pattern: /(^|\/)\.github-token$/, reason: '推送 token' },
  { pattern: /(^|\/)node_modules\//, reason: '依赖目录' },
  { pattern: /\.(sqlite|sqlite-wal|sqlite-shm)$/, reason: '聊天库' },
  { pattern: /\.tgz$/, reason: '上游原包' },
  { pattern: /(^|\/)(test\.wav|test\.silk)$/, reason: '本机测试音频' },
  { pattern: /(^|\/)\.env(\.|$)/, reason: '环境变量/凭据' },
];

const STATUS = Object.freeze({
  OK: 'OK',
  LINE_ENDING_ONLY: 'LINE_ENDING_ONLY',
  REDACTED_OK: 'REDACTED_OK',
  CONTENT_DIFF: 'CONTENT_DIFF',
  MISSING_IN_MIRROR: 'MISSING_IN_MIRROR',
  MIRROR_ONLY: 'MIRROR_ONLY',
});

function normalize(text) {
  const hadCRLF = text.includes('\r\n');
  return { text: text.replace(/\r\n/g, '\n'), hadCRLF };
}

function applyRedactions(text, rules) {
  const applied = [];
  let output = text;
  for (const rule of rules) {
    const next = output.replace(rule.pattern, rule.replacement);
    if (next !== output) applied.push(rule.reason);
    output = next;
  }
  return { text: output, applied };
}

/** 找出两份文本第一处差异所在行号，最多给 3 处，便于人工定位。 */
function diffHints(left, right) {
  const a = left.split('\n');
  const b = right.split('\n');
  const hints = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max && hints.length < 3; i += 1) {
    if ((a[i] ?? null) !== (b[i] ?? null)) {
      hints.push({
        line: i + 1,
        auth: (a[i] ?? '<缺失>').slice(0, 120),
        mirror: (b[i] ?? '<缺失>').slice(0, 120),
      });
    }
  }
  return { hints, authLines: a.length, mirrorLines: b.length };
}

async function listFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    out.push(entry.name);
  }
  return out.sort();
}

/**
 * 核心比较。文件清单显式传入，便于自测用临时目录；不读 git、不写文件。
 * @returns {{ok:boolean, rows:object[], counts:object}}
 */
export async function runCheck({ authDir, mirrorDir, toolingFiles, patchFiles, strictEol = false, redactions = REDACTIONS }) {
  const rows = [];
  const compareOne = async (relPath) => {
    const authPath = join(authDir, relPath);
    const mirrorPath = join(mirrorDir, relPath);
    const authExists = existsSync(authPath);
    const mirrorExists = existsSync(mirrorPath);
    if (!authExists && !mirrorExists) return;
    if (!authExists) {
      rows.push({ path: relPath, status: STATUS.MIRROR_ONLY, detail: '镜像有、权威没有（来源不明）' });
      return;
    }
    if (!mirrorExists) {
      rows.push({ path: relPath, status: STATUS.MISSING_IN_MIRROR, detail: '权威有、镜像缺' });
      return;
    }
    const authRaw = await readFile(authPath, 'utf8');
    const mirrorRaw = await readFile(mirrorPath, 'utf8');
    const authNorm = normalize(authRaw);
    const mirrorNorm = normalize(mirrorRaw);
    const auth = applyRedactions(authNorm.text, redactions);
    const mirror = applyRedactions(mirrorNorm.text, redactions);
    if (auth.text === mirror.text) {
      const redacted = auth.applied.length > 0;
      const lineEnding = authNorm.hadCRLF !== mirrorNorm.hadCRLF;
      if (redacted) {
        rows.push({ path: relPath, status: STATUS.REDACTED_OK, detail: `按声明规则脱敏后一致（${auth.applied.join('、')}）` });
      } else if (lineEnding) {
        rows.push({
          path: relPath,
          status: STATUS.LINE_ENDING_ONLY,
          detail: `仅换行差异（权威 ${authNorm.hadCRLF ? 'CRLF' : 'LF'} / 镜像 ${mirrorNorm.hadCRLF ? 'CRLF' : 'LF'}）`,
        });
      } else {
        rows.push({ path: relPath, status: STATUS.OK, detail: '逐字节一致' });
      }
      return;
    }
    const hints = diffHints(auth.text, mirror.text);
    rows.push({
      path: relPath,
      status: STATUS.CONTENT_DIFF,
      detail: `内容不同（权威 ${hints.authLines} 行 / 镜像 ${hints.mirrorLines} 行）`,
      hints: hints.hints,
    });
  };

  for (const name of toolingFiles) await compareOne(name);
  for (const name of patchFiles) await compareOne(join('backup', 'src-patched', name));

  const counts = {
    total: rows.length,
    ok: rows.filter((row) => row.status === STATUS.OK).length,
    lineEndingOnly: rows.filter((row) => row.status === STATUS.LINE_ENDING_ONLY).length,
    redacted: rows.filter((row) => row.status === STATUS.REDACTED_OK).length,
    contentDiff: rows.filter((row) => row.status === STATUS.CONTENT_DIFF).length,
    missing: rows.filter((row) => row.status === STATUS.MISSING_IN_MIRROR).length,
    mirrorOnly: rows.filter((row) => row.status === STATUS.MIRROR_ONLY).length,
  };
  const failures = counts.contentDiff + counts.missing + counts.mirrorOnly + (strictEol ? counts.lineEndingOnly : 0);
  return { ok: failures === 0, counts, rows };
}

/** 不许进提交的路径：读 `git ls-files`，只报告，不改索引。 */
export function checkForbiddenTracked(repoRoot) {
  let tracked;
  try {
    tracked = execFileSync('git', ['-C', repoRoot, 'ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch {
    return { available: false, hits: [] };
  }
  const hits = [];
  for (const file of tracked) {
    for (const rule of FORBIDDEN_TRACKED) {
      if (rule.pattern.test(file)) hits.push({ file, reason: rule.reason });
    }
  }
  return { available: true, hits, trackedCount: tracked.length };
}

function formatReport(result, forbidden, context) {
  const lines = [`[镜像同步核对] 权威：${context.authDir}`, `               镜像：${context.mirrorDir}`, ''];
  const bad = result.rows.filter(
    (row) => row.status !== STATUS.OK && row.status !== STATUS.REDACTED_OK && row.status !== STATUS.LINE_ENDING_ONLY,
  );
  for (const row of result.rows) {
    if (row.status === STATUS.OK) continue;
    const mark = row.status === STATUS.LINE_ENDING_ONLY ? 'WARN' : 'FAIL';
    lines.push(`${mark}  ${row.path}`);
    lines.push(`      ${row.detail}`);
    for (const hint of row.hints ?? []) {
      lines.push(`      L${hint.line}`);
      lines.push(`        权威: ${hint.auth}`);
      lines.push(`        镜像: ${hint.mirror}`);
    }
  }
  if (bad.length === 0 && result.counts.lineEndingOnly === 0) lines.push('OK    所有纳入对照的文件逐字节一致');
  lines.push('');
  lines.push(
    `合计 ${result.counts.total} 个文件：一致 ${result.counts.ok}，仅换行差异 ${result.counts.lineEndingOnly}，` +
      `脱敏后一致 ${result.counts.redacted}，内容差异 ${result.counts.contentDiff}，镜像缺文件 ${result.counts.missing}，来源不明 ${result.counts.mirrorOnly}`,
  );
  lines.push(`未纳入对照（本机无权威副本，另行维护）：tools/voice、configs、docs、本仓库脚本`);
  if (forbidden.available) {
    if (forbidden.hits.length) {
      lines.push('');
      for (const hit of forbidden.hits) lines.push(`FAIL  不该提交的文件：${hit.file}（${hit.reason}）`);
    } else {
      lines.push(`提交清单    ${forbidden.trackedCount} 个跟踪文件，无凭据/依赖/聊天库/本机音频`);
    }
  } else {
    lines.push('提交清单    未检查（不是 git 仓库或没有 git）');
  }
  lines.push('');
  lines.push(`结论：${result.ok && forbidden.hits.length === 0 ? '一致（exit 0）' : '有差异需要处理（exit 1）'}`);
  return lines.join('\n');
}

async function loadPatchFileNames(authDir) {
  const manifestPath = join(authDir, 'manifest.mjs');
  if (!existsSync(manifestPath)) throw new Error(`权威目录里没有 manifest.mjs：${manifestPath}`);
  const module = await import(`file://${manifestPath.replace(/\\/g, '/')}`);
  return module.FILES.map(([name]) => name);
}

async function selfTest() {
  const root = join(tmpdir(), `dsh-mirror-sync-selftest-${Date.now()}`);
  const cases = [];
  const makeDirs = async (name) => {
    const authDir = join(root, name, 'auth');
    const mirrorDir = join(root, name, 'mirror');
    await mkdir(join(authDir, 'backup', 'src-patched'), { recursive: true });
    await mkdir(join(mirrorDir, 'backup', 'src-patched'), { recursive: true });
    return { authDir, mirrorDir };
  };
  const writeBoth = async ({ authDir, mirrorDir }, rel, authText, mirrorText) => {
    await mkdir(dirname(join(authDir, rel)), { recursive: true });
    await mkdir(dirname(join(mirrorDir, rel)), { recursive: true });
    if (authText !== null) await writeFile(join(authDir, rel), authText);
    if (mirrorText !== null) await writeFile(join(mirrorDir, rel), mirrorText);
  };
  const baseFiles = ['a.mjs', 'b.mjs'];
  const basePatch = ['p1.mjs'];

  {
    const dirs = await makeDirs('identical');
    await writeBoth(dirs, 'a.mjs', 'export const a = 1;\n', 'export const a = 1;\n');
    await writeBoth(dirs, 'b.mjs', '# 文档\n', '# 文档\n');
    await writeBoth(dirs, 'backup/src-patched/p1.mjs', 'x\n', 'x\n');
    cases.push({
      name: '完全一致',
      dirs,
      expectOk: true,
      strictEol: false,
      files: baseFiles,
      patch: basePatch,
    });
  }
  {
    const dirs = await makeDirs('missing');
    await writeBoth(dirs, 'a.mjs', 'export const a = 1;\n', 'export const a = 1;\n');
    await writeBoth(dirs, 'b.mjs', '# 文档\n', null);
    await writeBoth(dirs, 'backup/src-patched/p1.mjs', 'x\n', 'x\n');
    cases.push({ name: '镜像缺文件', dirs, expectOk: false, files: baseFiles, patch: basePatch });
  }
  {
    const dirs = await makeDirs('content-diff');
    await writeBoth(dirs, 'a.mjs', 'export const a = 1;\n', 'export const a = 2;\n');
    await writeBoth(dirs, 'b.mjs', '# 文档\n', '# 文档\n');
    await writeBoth(dirs, 'backup/src-patched/p1.mjs', 'x\n', 'x\n');
    cases.push({ name: '真实内容差异', dirs, expectOk: false, files: baseFiles, patch: basePatch });
  }
  {
    const dirs = await makeDirs('crlf');
    await writeBoth(dirs, 'a.mjs', 'line1\nline2\n', 'line1\r\nline2\r\n');
    await writeBoth(dirs, 'b.mjs', '# 文档\n', '# 文档\n');
    await writeBoth(dirs, 'backup/src-patched/p1.mjs', 'x\n', 'x\r\n');
    cases.push({ name: '只差换行（默认放行）', dirs, expectOk: true, strictEol: false, files: baseFiles, patch: basePatch });
    cases.push({ name: '只差换行（--strict-eol 失败）', dirs, expectOk: false, strictEol: true, files: baseFiles, patch: basePatch });
  }
  {
    const dirs = await makeDirs('mirror-only');
    await writeBoth(dirs, 'a.mjs', 'export const a = 1;\n', 'export const a = 1;\n');
    await writeBoth(dirs, 'b.mjs', '# 文档\n', '# 文档\n');
    await writeBoth(dirs, 'backup/src-patched/p1.mjs', 'x\n', 'x\n');
    await writeFile(join(dirs.mirrorDir, 'stray.mjs'), '// 来源不明\n');
    cases.push({ name: '镜像多出文件', dirs, expectOk: true, files: baseFiles, patch: basePatch });
  }
  {
    const dirs = await makeDirs('patch-missing');
    await writeBoth(dirs, 'a.mjs', 'export const a = 1;\n', 'export const a = 1;\n');
    await writeBoth(dirs, 'b.mjs', '# 文档\n', '# 文档\n');
    await writeBoth(dirs, 'backup/src-patched/p1.mjs', 'x\n', null);
    cases.push({ name: '补丁清单文件缺失', dirs, expectOk: false, files: baseFiles, patch: basePatch });
  }
  {
    // 声明的脱敏规则：权威里是本机绝对路径，镜像里是占位符；规则命中 → 可接受。
    const dirs = await makeDirs('redacted');
    const redactions = [{ pattern: /C:\\Users\\someone/g, replacement: '<WORKSPACE>', reason: '机器路径占位化' }];
    await writeBoth(dirs, 'a.mjs', 'cwd: "C:\\Users\\someone\\ws"\n', 'cwd: "<WORKSPACE>\\ws"\n');
    await writeBoth(dirs, 'b.mjs', '# 文档\n', '# 文档\n');
    await writeBoth(dirs, 'backup/src-patched/p1.mjs', 'x\n', 'x\n');
    cases.push({ name: '声明的脱敏差异（放行）', dirs, expectOk: true, files: baseFiles, patch: basePatch, redactions, expectStatus: 'REDACTED_OK' });
    cases.push({
      name: '未命中的脱敏规则（仍失败）',
      dirs,
      expectOk: false,
      files: baseFiles,
      patch: basePatch,
      redactions: [{ pattern: /C:\\Users\\nobody/g, replacement: '<X>', reason: '不命中' }],
    });
  }

  let failed = 0;
  for (const testCase of cases) {
    const result = await runCheck({
      authDir: testCase.dirs.authDir,
      mirrorDir: testCase.dirs.mirrorDir,
      toolingFiles: testCase.files,
      patchFiles: testCase.patch,
      strictEol: Boolean(testCase.strictEol),
      redactions: testCase.redactions,
    });
    const statusOk = testCase.expectStatus ? result.rows.some((row) => row.status === testCase.expectStatus) : true;
    const pass = result.ok === testCase.expectOk && statusOk;
    if (!pass) failed += 1;
    console.log(
      `${pass ? 'PASS' : 'FAIL'}  ${testCase.name.padEnd(24)} 期望 ok=${testCase.expectOk} 实际 ok=${result.ok}` +
        (testCase.expectStatus ? `（期望状态 ${testCase.expectStatus}：${statusOk ? '命中' : '未命中'}）` : ''),
    );
    if (!pass) console.log('        ', JSON.stringify(result.counts));
  }
  await rm(root, { recursive: true, force: true });
  console.log('');
  console.log(failed === 0 ? `自测通过：${cases.length} 个用例` : `自测失败：${failed}/${cases.length}`);
  process.exit(failed === 0 ? 0 : 1);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) return selfTest();

  const authIndex = argv.indexOf('--auth');
  const authDir = authIndex >= 0 ? resolve(argv[authIndex + 1]) : resolve(REPO_ROOT, '..', 'tools', 'im-patch');
  const mirrorDir = join(REPO_ROOT, 'tools', 'im-patch');
  const strictEol = argv.includes('--strict-eol');
  const json = argv.includes('--json');

  if (!existsSync(authDir)) {
    console.error(`ERROR 权威补丁目录不存在：${authDir}`);
    console.error('      本机用 --auth <dir> 或环境变量 IM_PATCH_AUTH 指定；没有权威副本时无法核对镜像。');
    process.exit(2);
  }

  const patchFiles = await loadPatchFileNames(authDir);
  const authTop = await listFiles(authDir);
  const toolingFiles = authTop.filter((name) => !LOCAL_ONLY_IN_AUTH.has(name));
  const mirrorTop = await listFiles(mirrorDir);
  const extra = mirrorTop.filter((name) => !toolingFiles.includes(name) && !MIRROR_ALLOWED_EXTRA.has(name));

  const result = await runCheck({ authDir, mirrorDir, toolingFiles, patchFiles, strictEol });
  for (const name of extra) {
    result.rows.push({ path: name, status: STATUS.MIRROR_ONLY, detail: '镜像有、权威没有（来源不明）' });
  }
  result.counts.mirrorOnly += extra.length;
  result.counts.total += extra.length;
  result.ok = result.counts.contentDiff + result.counts.missing + result.counts.mirrorOnly + (strictEol ? result.counts.lineEndingOnly : 0) === 0;

  const forbidden = checkForbiddenTracked(REPO_ROOT);
  if (json) {
    console.log(JSON.stringify({ ok: result.ok && forbidden.hits.length === 0, counts: result.counts, rows: result.rows, forbidden }, null, 2));
  } else {
    console.log(formatReport(result, forbidden, { authDir, mirrorDir }));
  }
  process.exit(result.ok && forbidden.hits.length === 0 ? 0 : 1);
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) await main();
