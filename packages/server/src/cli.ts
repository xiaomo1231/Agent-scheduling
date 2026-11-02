#!/usr/bin/env node
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from './app/index.js';
import { startGateway } from './gateway/index.js';

/** 命令行启动：zhongshu-server [--data 目录] [--port 端口] [--simulate] [--static 目录] [--dev-origin http://localhost:5173] */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(arg('--data') ?? process.env.ZHONGSHU_DATA ?? join(homedir(), '.zhongshu'));
const guessStatic = [resolve(here, '../../../apps/web/dist'), resolve(here, '../../apps/web/dist')].find((p) => existsSync(join(p, 'index.html')));
const staticDir = arg('--static') ?? guessStatic;

const app = createApp({ dataDir, simulate: process.argv.includes('--simulate') });
const devOrigin = arg('--dev-origin');
const gw = await startGateway(app, {
  port: Number(arg('--port') ?? process.env.ZHONGSHU_PORT ?? 0),
  ...(staticDir ? { staticDir } : {}),
  ...(process.env.ZHONGSHU_TOKEN ? { token: process.env.ZHONGSHU_TOKEN } : {}),
  ...(devOrigin ? { devOrigin } : {}),
});

console.log(`中枢已启动\n  数据目录：${dataDir}\n  打开：${gw.openUrl}${staticDir ? '' : '\n  （没找到前端页面，先运行 npm run build -w @zhongshu/web）'}`);
const stop = async () => {
  app.close();
  await gw.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
