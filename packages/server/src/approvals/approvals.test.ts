import { describe, it, expect, vi, afterEach } from 'vitest';
import { defaultPolicy, seededRandom, type ActionRequest } from '@zhongshu/core';
import { MemoryLog, Workspace } from '../store/index.js';
import { Approvals } from './index.js';

const agent = { kind: 'agent' as const, id: 'agt_a' };
const me = { kind: 'user' as const, id: 'me' };
const req = (target: string): ActionRequest => ({ agentId: 'agt_a', threadId: 'thr_1', kind: 'command', target, cwd: '/w', workspaceRoot: '/w' });

function setup() {
  const ws = Workspace.open(new MemoryLog());
  return { ws, ap: new Approvals(ws, { random: seededRandom(1) }) };
}
afterEach(() => vi.useRealTimers());

describe('Approvals', () => {
  it('白名单里的命令直接放行', async () => {
    const { ap } = setup();
    expect((await ap.gate(req('git status'), agent)).ok).toBe(true);
  });

  it('要审批的命令等用户批准；“以后都允许”加一条精确规则', async () => {
    const { ws, ap } = setup();
    const p = ap.gate(req('rm -rf build'), agent);
    const a = Object.values(ws.current.approvals)[0]!;
    expect(a.state).toBe('pending');
    expect(ap.decide(a.id, true, me, { always: true }).ok).toBe(true);
    expect((await p).ok).toBe(true);
    expect(ws.current.approvals[a.id]!.state).toBe('approved');
    const rule = ws.current.policy.allowlist.at(-1)!;
    expect(rule.program).toBe('rm');
    expect(rule.agents).toEqual(['agt_a']);
  });

  it('超时按拒绝处理', async () => {
    vi.useFakeTimers();
    const { ws, ap } = setup();
    ws.commit({ type: 'policy.changed', policy: { ...defaultPolicy(), approvalTimeoutSec: 5 } }, me);
    const p = ap.gate(req('rm -rf build'), agent);
    vi.advanceTimersByTime(5001);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(Object.values(ws.current.approvals)[0]!.state).toBe('expired');
  });

  it('紧急停止时一律拒绝', async () => {
    const { ws, ap } = setup();
    ws.commit({ type: 'system.emergencyStop', on: true }, me);
    expect((await ap.gate(req('git status'), agent)).ok).toBe(false);
  });

  it('重启后遗留的待审批被作废', () => {
    const log = new MemoryLog();
    const ws = Workspace.open(log);
    const ap = new Approvals(ws);
    void ap.gate(req('rm -rf x'), agent);
    ap.close();
    const ws2 = Workspace.open(log);
    new Approvals(ws2);
    expect(Object.values(ws2.current.approvals)[0]!.state).toBe('invalidated');
  });
});
