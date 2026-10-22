// Rebuild @xmanrui/dsh-im 5.2.0's host bundle from its shipped source after the
// local patches (quoted-media cache + QQ voice). Uses the isolated esbuild in
// this folder so the profile's pnpm tree stays untouched.
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = 'C:/Users/yuuki/.dsh/profiles/desktop/node_modules/@xmanrui/dsh-im';
const sourceDirectory = resolve(pluginRoot, 'plugin-src/host');
const outputPath = resolve(pluginRoot, 'lib/index.js');
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

await mkdir(dirname(outputPath), { recursive: true });
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
  outfile: outputPath,
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
console.log(`Wrote ${outputPath} from ${here}`);
