// 把主进程和它用到的 server / core / 第三方库打成一个文件，安装包里就不用带 node_modules。
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
await build({
  entryPoints: [root + 'src/main.ts'],
  outfile: root + 'bundle/main.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['electron', 'bufferutil', 'utf-8-validate'],
  // 打进来的 CommonJS 库（如 ws）需要 require
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  alias: { '@zhongshu/core': fileURLToPath(new URL('../../../packages/core/src/index.ts', import.meta.url)), '@zhongshu/server': fileURLToPath(new URL('../../../packages/server/src/index.ts', import.meta.url)) },
  legalComments: 'none',
  logLevel: 'warning',
});
console.log('bundle/main.mjs');
