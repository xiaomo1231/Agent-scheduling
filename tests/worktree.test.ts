import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, MockProvider, type App } from '../packages/server/src/index.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 5000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('等太久了');
    await wait(10);
  }
}
async function cmd(a: App, c: unknown) {
  const r = await a.handle(c);
  if (!r.ok) throw new Error(r.error);
  return r.result as any;
}
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });

let app: App | undefined;
afterEach(() => {
  app?.close();
  app = undefined;
});

function repo() {
  const r = mkdtempSync(join(tmpdir(), 'zs-repo-'));
  git(r, 'init', '-q', '-b', 'main');
  writeFileSync(join(r, 'a.txt'), 'a\n');
  git(r, 'add', '.');
  git(r, 'commit', '-qm', 'init');
  return r;
}

async function setup(folder: string, file: string) {
  const mock = new MockProvider((req) => {
    if (req.tools?.some((t) => t.name === 'create_thread')) return { text: '', toolCalls: [], stop: 'end' };
    if (req.turns.at(-1)!.role === 'tool') return { text: '改好了', toolCalls: [], stop: 'end' };
    return { text: '', toolCalls: [{ id: 'w1', name: 'write_file', input: { path: file, content: 'new\n' } }], stop: 'tool' };
  });
  app = createApp({ dataDir: mkdtempSync(join(tmpdir(), 'zs-')), mockProvider: mock });
  await cmd(app, { type: 'source.save', source: { id: 'src_mockwt', kind: 'apikey', name: 'm', transport: 'mock', models: [{ id: 'm', label: 'M', vendor: 'x', enabled: true }] } });
  const { projectId } = await cmd(app, { type: 'project.create', name: 'wt', folder });
  const choice = { kind: 'model', ref: { sourceId: 'src_mockwt', modelId: 'm' } };
  await cmd(app, { type: 'project.update', projectId, patch: { settings: { threadDefault: { model: choice } } } });
  const { threadId } = await cmd(app, { type: 'thread.create', projectId, title: '改文件' });
  await cmd(app, { type: 'plan.apply', threadId, ops: [{ op: 'add', title: '写 b.txt' }] });
  await cmd(app, { type: 'thread.continue', threadId });
  await until(() => app!.ws.current.threads[threadId]!.worktree?.state === 'ready' || app!.ws.current.threads[threadId]!.worktree?.state === 'discarded');
  return threadId;
}

describe('独立工作区（git worktree）', () => {
  it('在独立分支上改，合并回 base', async () => {
    const r = repo();
    const threadId = await setup(r, 'b.txt');
    const w = app!.ws.current.threads[threadId]!.worktree!;
    expect(w.branch).toMatch(/^zhongshu\//);
    expect(w.summary).toContain('b.txt');
    expect(existsSync(join(r, 'b.txt'))).toBe(false); // 主目录还没动
    expect(app!.ws.current.threads[threadId]!.resolved).toBeNull(); // 没合并前不自动解决
    await cmd(app!, { type: 'thread.merge', threadId });
    expect(readFileSync(join(r, 'b.txt'), 'utf8')).toBe('new\n');
    expect(app!.ws.current.threads[threadId]!.worktree!.state).toBe('merged');
    expect(git(r, 'branch', '--list', 'zhongshu/*').trim()).toBe('');
  });

  it('丢弃：分支和工作区都删掉，主目录不变', async () => {
    const r = repo();
    const threadId = await setup(r, 'c.txt');
    const path = app!.ws.current.threads[threadId]!.worktree!.path;
    await cmd(app!, { type: 'thread.discard', threadId });
    expect(existsSync(path)).toBe(false);
    expect(existsSync(join(r, 'c.txt'))).toBe(false);
    expect(app!.ws.current.threads[threadId]!.worktree!.state).toBe('discarded');
  });

  it('不是 git 仓库就直接在目录里改', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zs-plain-'));
    const mock = new MockProvider((req) => {
      if (req.turns.at(-1)!.role === 'tool') return { text: '好了', toolCalls: [], stop: 'end' };
      return { text: '', toolCalls: [{ id: 'w1', name: 'write_file', input: { path: 'x.txt', content: 'x' } }], stop: 'tool' };
    });
    app = createApp({ dataDir: mkdtempSync(join(tmpdir(), 'zs-')), mockProvider: mock });
    await cmd(app, { type: 'source.save', source: { id: 'src_mockwu', kind: 'apikey', name: 'm', transport: 'mock', models: [{ id: 'm', label: 'M', vendor: 'x', enabled: true }] } });
    const { projectId } = await cmd(app, { type: 'project.create', name: 'p', folder: dir });
    await cmd(app, { type: 'project.update', projectId, patch: { settings: { threadDefault: { model: { kind: 'model', ref: { sourceId: 'src_mockwu', modelId: 'm' } } } } } });
    const { threadId } = await cmd(app, { type: 'thread.create', projectId, title: 't' });
    await cmd(app, { type: 'plan.apply', threadId, ops: [{ op: 'add', title: 's' }] });
    await cmd(app, { type: 'thread.continue', threadId });
    await until(() => !!app!.ws.current.threads[threadId]!.resolved);
    expect(readFileSync(join(dir, 'x.txt'), 'utf8')).toBe('x');
    expect(app!.ws.current.threads[threadId]!.worktree).toBeUndefined();
  });
});
