import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import WebSocket from 'ws';
import { createApp, startGateway, MockProvider, type App, type Gateway } from '../packages/server/src/index.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 3000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('等太久了');
    await wait(10);
  }
}

let app: App | undefined;
let gw: Gateway | undefined;
afterEach(async () => {
  app?.close();
  await gw?.close();
  app = gw = undefined;
});

async function cmd(a: App, c: unknown) {
  const r = await a.handle(c);
  if (!r.ok) throw new Error(r.error);
  return r.result as any;
}

describe('端到端：没配模型时规则协调 + 模拟运行', () => {
  it('一句话开讨论串、跑完、自动解决；发消息重新打开', async () => {
    app = createApp({ dataDir: mkdtempSync(join(tmpdir(), 'zs-')), simulate: true, simDelayMs: 5 });
    const { projectId, coordThreadId } = await cmd(app, { type: 'project.create', name: '官网改版' });
    expect(app.ws.current.projects[projectId]!.layout.length).toBeGreaterThan(0);
    await cmd(app, { type: 'message.send', threadId: coordThreadId, text: '帮我把首页改成深色主题' });
    await app.coordinator.idle();
    const work = Object.values(app.ws.current.threads).find((t) => t.kind === 'work')!;
    expect(work.steps).toHaveLength(3);
    await until(() => !!app!.ws.current.threads[work.id]!.resolved);
    expect(app.ws.current.threads[work.id]!.resolved!.by).toBe('coordinator');
    expect(app.ws.current.threads[work.id]!.steps.every((s) => s.state === 'done')).toBe(true);

    await cmd(app, { type: 'message.send', threadId: work.id, text: '再加一步：补上暗色截图' });
    await app.coordinator.idle();
    expect(app.ws.current.threads[work.id]!.steps).toHaveLength(4);
    await until(() => !!app!.ws.current.threads[work.id]!.resolved);
  });

  it('用户手动解决、重开后协调者不再自动解决', async () => {
    app = createApp({ simulate: true, simDelayMs: 5 });
    const { projectId } = await cmd(app, { type: 'project.create', name: 'p' });
    const { threadId } = await cmd(app, { type: 'thread.create', projectId, title: '修登录' });
    await cmd(app, { type: 'plan.apply', threadId, ops: [{ op: 'add', title: '复现' }] });
    await cmd(app, { type: 'thread.resolve', threadId });
    expect(app.ws.current.threads[threadId]!.resolved!.by).toBe('user');
    await cmd(app, { type: 'thread.reopen', threadId });
    expect(app.ws.current.threads[threadId]!.keepOpen).toBe(true);
    await cmd(app, { type: 'thread.continue', threadId });
    await until(() => app!.ws.current.threads[threadId]!.steps[0]!.state === 'done');
    await wait(30);
    expect(app.ws.current.threads[threadId]!.resolved).toBeNull();
  });
});

describe('端到端：模型协调 + 内置 agent', () => {
  it('协调模型用工具开讨论串，执行模型跑步骤', async () => {
    const mock = new MockProvider((req) => {
      const isCoord = req.tools?.some((t) => t.name === 'create_thread');
      const last = req.turns.at(-1)!;
      if (isCoord) {
        if (last.role === 'tool') return { text: '', toolCalls: [], stop: 'end' };
        return { text: '好，我开个讨论串。', toolCalls: [{ id: 'c1', name: 'create_thread', input: { title: '写 README', steps: [{ title: '写初稿', assignee: '@writer' }], start: true } }], stop: 'tool' };
      }
      if (last.role === 'tool') return { text: 'README 写好了', toolCalls: [], stop: 'end' };
      return { text: '', toolCalls: [{ id: 'w1', name: 'write_file', input: { path: 'README.md', content: '# 你好' } }], stop: 'tool' };
    });
    const dir = mkdtempSync(join(tmpdir(), 'zs-'));
    app = createApp({ dataDir: dir, mockProvider: mock });
    await cmd(app, { type: 'source.save', source: { id: 'src_mock01', kind: 'apikey', name: '模拟', transport: 'mock', models: [{ id: 'mock-1', label: 'Mock', vendor: 'x', enabled: true }] }, secret: 'sk-test-should-not-leak-123' });
    const { projectId, coordThreadId } = await cmd(app, { type: 'project.create', name: 'docs' });
    const choice = { kind: 'model', ref: { sourceId: 'src_mock01', modelId: 'mock-1' } };
    await cmd(app, { type: 'project.update', projectId, patch: { settings: { coordinator: { model: choice, effort: '高' }, threadDefault: { model: choice } } } });
    await cmd(app, { type: 'message.send', threadId: coordThreadId, text: '写个 README' });
    await app.coordinator.idle();
    const work = Object.values(app.ws.current.threads).find((t) => t.kind === 'work')!;
    await until(() => !!app!.ws.current.threads[work.id]!.resolved);
    expect(readFileSync(join(dir, 'workspaces', projectId, 'README.md'), 'utf8')).toBe('# 你好');
    expect(app.ws.current.messages[work.id]!.some((m) => m.text === 'README 写好了')).toBe(true);
    expect(readFileSync(join(dir, 'events.jsonl'), 'utf8')).not.toContain('should-not-leak');
    expect(JSON.stringify(app.ws.current)).not.toContain('should-not-leak');
  });
});

function http(port: number, path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; body: string }>((ok, fail) => {
    const r = request({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: opts.headers ?? {} }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => ok({ status: res.statusCode ?? 0, body: b }));
    });
    r.on('error', fail);
    r.end(opts.body);
  });
}

describe('网关', () => {
  it('token、Host、Origin 校验；命令和事件推送', async () => {
    app = createApp();
    gw = await startGateway(app, { token: 'tok_test_123456' });
    const auth = { authorization: 'Bearer tok_test_123456' };
    expect((await http(gw.port, '/api/state')).status).toBe(401);
    expect((await http(gw.port, '/api/state', { headers: { ...auth, host: 'evil.example' } })).status).toBe(421);
    expect((await http(gw.port, '/api/state', { headers: { ...auth, origin: 'https://evil.example' } })).status).toBe(403);
    expect((await http(gw.port, '/api/state', { headers: auth })).status).toBe(200);

    const ws = new WebSocket(`ws://127.0.0.1:${gw.port}/api/events?token=tok_test_123456`);
    const got: any[] = [];
    ws.on('message', (d) => got.push(JSON.parse(String(d))));
    await until(() => got.length > 0);
    expect(got[0].kind).toBe('snapshot');

    const r = await http(gw.port, '/api/commands', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'project.create', name: '新项目' }) });
    expect(r.status).toBe(200);
    await until(() => got.some((m) => m.kind === 'events'));
    expect(got.find((m) => m.kind === 'events').events[0].body.type).toBe('project.created');

    const bad = await http(gw.port, '/api/commands', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'project.create' }) });
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.body).error).toMatch(/格式不对/);

    const noTok = new WebSocket(`ws://127.0.0.1:${gw.port}/api/events`);
    await new Promise((r) => noTok.on('error', r));
    ws.close();
  });
});

describe('审查模式', () => {
  it('审查模型说 allow 就放行，否则交给你', async () => {
    const mock = new MockProvider((req) => ({ text: req.turns[0]!.role === 'user' && (req.turns[0] as any).text.includes('make clean') ? 'allow' : 'ask', toolCalls: [], stop: 'end' }));
    app = createApp({ mockProvider: mock });
    await cmd(app, { type: 'source.save', source: { id: 'src_mock02', kind: 'apikey', name: '模拟', transport: 'mock', models: [{ id: 'm', label: 'M', vendor: 'x', enabled: true }] } });
    await cmd(app, { type: 'policy.set', policy: { ...app.ws.current.policy, commandMode: 'review' } });
    const req = (target: string) => ({ agentId: 'a', threadId: 'thr_x', kind: 'command' as const, target, cwd: '/w', workspaceRoot: '/w' });
    expect((await app.approvals.gate(req('make clean'), { kind: 'agent', id: 'a' })).ok).toBe(true);
    void app.approvals.gate(req('make deploy'), { kind: 'agent', id: 'a' });
    await until(() => Object.values(app!.ws.current.approvals).some((a) => a.state === 'pending'));
  });
});
