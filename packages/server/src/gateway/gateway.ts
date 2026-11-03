import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { LAYOUT_PRESETS, PROVIDER_PRESETS, effortLevels, type ZEvent } from '@zhongshu/core';
import type { App } from '../app/index.js';

export interface GatewayOptions {
  port?: number;
  /** 前端构建产物目录，有就顺便提供静态页面 */
  staticDir?: string;
  /** 固定 token（测试用）；默认每次启动随机生成 */
  token?: string;
  /** 开发时前端跑在 Vite 上，允许这个来源 */
  devOrigin?: string;
}

export interface Gateway {
  url: string;
  port: number;
  token: string;
  /** 带 token 的打开地址（token 放在 # 后面，不会发给服务器日志） */
  openUrl: string;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json',
};

function eqToken(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, limit = 4 * 1024 * 1024): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error('请求太大');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * 本地网关：只绑 127.0.0.1；API 必须带 token；校验 Host 防 DNS 重绑定；校验 Origin 防跨站。
 */
export async function startGateway(app: App, o: GatewayOptions = {}): Promise<Gateway> {
  const token = o.token ?? randomBytes(24).toString('base64url');
  let port = o.port ?? 0;
  const allowedHosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const allowedOrigins = () => new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...(o.devOrigin ? [o.devOrigin] : [])]);

  const authed = (req: IncomingMessage, url: URL) => {
    const h = req.headers.authorization ?? '';
    const t = h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('token') ?? '';
    return t.length > 0 && eqToken(t, token);
  };
  const originOk = (req: IncomingMessage) => {
    const origin = req.headers.origin;
    return !origin || allowedOrigins().has(origin);
  };

  const server: Server = createServer(async (req, res) => {
    try {
      if (!allowedHosts().has(req.headers.host ?? '')) return send(res, 421, { ok: false, error: 'Host 不对' });
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      if (url.pathname.startsWith('/api/')) {
        if (o.devOrigin && req.headers.origin === o.devOrigin) {
          res.setHeader('access-control-allow-origin', o.devOrigin);
          res.setHeader('access-control-allow-headers', 'authorization, content-type');
          res.setHeader('access-control-allow-methods', 'GET, POST');
          if (req.method === 'OPTIONS') return void res.writeHead(204).end();
        }
        if (!originOk(req)) return send(res, 403, { ok: false, error: '来源不对' });
        if (!authed(req, url)) return send(res, 401, { ok: false, error: '缺少或错误的 token' });
        if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, app.ws.current);
        if (req.method === 'GET' && url.pathname === '/api/audit') return send(res, 200, app.audit());
        if (req.method === 'GET' && url.pathname === '/api/run-file') {
          try {
            return send(res, 200, { ok: true, ...(await app.readRunFile(url.searchParams.get('thread') ?? '', url.searchParams.get('path') ?? '')) });
          } catch (e) {
            return send(res, 400, { ok: false, error: (e as Error).message });
          }
        }
        if (req.method === 'GET' && url.pathname === '/api/log') {
          const n = Math.min(1000, Number(url.searchParams.get('limit') ?? 200) || 200);
          return send(res, 200, app.ws.allEvents().slice(-n));
        }
        if (req.method === 'GET' && url.pathname === '/api/meta') {
          return send(res, 200, { providers: PROVIDER_PRESETS, layouts: Object.fromEntries(Object.entries(LAYOUT_PRESETS).map(([k, v]) => [k, v.label])), efforts: Object.fromEntries(['opus', 'haiku', 'gpt-6', 'gpt-5', 'gemini', 'doubao', 'glm', 'other'].map((m) => [m, effortLevels(m)])) });
        }
        if (req.method === 'POST' && url.pathname === '/api/commands') {
          if (!(req.headers['content-type'] ?? '').includes('application/json')) return send(res, 415, { ok: false, error: '只接受 JSON' });
          let body: unknown;
          try {
            body = JSON.parse(await readBody(req));
          } catch (e) {
            return send(res, 400, { ok: false, error: `看不懂请求：${(e as Error).message}` });
          }
          const r = await app.handle(body);
          return send(res, r.ok ? 200 : 400, r);
        }
        return send(res, 404, { ok: false, error: '没有这个接口' });
      }
      if (!o.staticDir || (req.method !== 'GET' && req.method !== 'HEAD')) return send(res, 404, { ok: false, error: '没有这个页面' });
      const root = resolve(o.staticDir);
      let file = resolve(root, '.' + decodeURIComponent(url.pathname));
      if (!file.startsWith(root + sep) && file !== root) return send(res, 403, { ok: false, error: '路径越界' });
      const st = await stat(file).catch(() => null);
      if (!st || st.isDirectory()) file = join(root, 'index.html'); // 单页应用
      const data = await readFile(file);
      res.writeHead(200, {
        'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'x-frame-options': 'DENY',
        'content-security-policy': `default-src 'self'; connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port}; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
        'cache-control': extname(file) === '.html' ? 'no-store' : 'public, max-age=31536000, immutable',
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch (err) {
      send(res, 500, { ok: false, error: `服务出错：${(err as Error).message}` });
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const clients = new Set<WebSocket>();
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (url.pathname !== '/api/events' || !allowedHosts().has(req.headers.host ?? '') || !originOk(req) || !authed(req, url)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      ws.on('close', () => clients.delete(ws));
      ws.on('message', () => { /* 只推送，不收消息；命令走 HTTP */ });
      ws.send(JSON.stringify({ kind: 'snapshot', state: app.ws.current }));
    });
  });
  const unsub = app.ws.subscribe((events: ZEvent[]) => {
    const msg = JSON.stringify({ kind: 'events', events });
    for (const c of clients) if (c.readyState === c.OPEN) c.send(msg);
  });

  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => ok());
  });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : port;
  const url = `http://127.0.0.1:${port}`;
  return {
    url, port, token, openUrl: `${url}/#token=${token}`,
    close: () =>
      new Promise<void>((ok) => {
        unsub();
        for (const c of clients) c.terminate();
        wss.close();
        server.close(() => ok());
        server.closeAllConnections?.();
      }),
  };
}
