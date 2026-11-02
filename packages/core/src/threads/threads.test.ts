import { describe, it, expect } from 'vitest';
import { autoResolveBlocker, threadStatus } from './index.js';
import type { Approval, Thread } from '../model/types.js';

const t = (patch: Partial<Thread> = {}): Thread => ({
  id: 'thr_1', projectId: 'prj_1', title: 't', createdAt: 0, updatedAt: 0, resolved: null, keepOpen: false, model: null,
  steps: [{ id: 's1', title: 'a', assignee: 'x', state: 'done' }], ...patch,
});
const ap = (state: Approval['state']): Record<string, Approval> => ({
  a: { id: 'a', request: { agentId: 'x', threadId: 'thr_1', kind: 'command', target: 'git push', cwd: '/', workspaceRoot: '/' }, fingerprint: 'f', reasons: [], risk: [], state, createdAt: 0 },
});

describe('自动解决规则', () => {
  it('全部做完、没人等，就能解决', () => {
    expect(autoResolveBlocker({ thread: t(), approvals: {}, autoResolveEnabled: true })).toBeNull();
  });
  it('有等批准的就不解决', () => {
    expect(autoResolveBlocker({ thread: t(), approvals: ap('pending'), autoResolveEnabled: true })).toContain('批准');
    expect(autoResolveBlocker({ thread: t(), approvals: ap('approved'), autoResolveEnabled: true })).toBeNull();
  });
  it('没合并的 PR、等回答、用户重开过、设置关掉，都不解决', () => {
    expect(autoResolveBlocker({ thread: t(), approvals: {}, autoResolveEnabled: true, openPullRequests: 1 })).toContain('PR');
    expect(autoResolveBlocker({ thread: t(), approvals: {}, autoResolveEnabled: true, waitingQuestion: true })).toContain('回答');
    expect(autoResolveBlocker({ thread: t({ keepOpen: true }), approvals: {}, autoResolveEnabled: true })).toContain('重新打开');
    expect(autoResolveBlocker({ thread: t(), approvals: {}, autoResolveEnabled: false })).toContain('手动');
  });
  it('计划没做完不解决；取消的步骤不算', () => {
    expect(autoResolveBlocker({ thread: t({ steps: [{ id: 's', title: 'a', assignee: 'x', state: 'run' }] }), approvals: {}, autoResolveEnabled: true })).toContain('没做完');
    expect(autoResolveBlocker({ thread: t({ steps: [{ id: 's', title: 'a', assignee: 'x', state: 'done' }, { id: 'c', title: 'b', assignee: 'x', state: 'cancelled' }] }), approvals: {}, autoResolveEnabled: true })).toBeNull();
  });
});

describe('threadStatus', () => {
  it('分组', () => {
    expect(threadStatus(t({ resolved: { by: 'user', at: 1, reason: '' } }), {})).toBe('resolved');
    expect(threadStatus(t(), ap('pending'))).toBe('waiting');
    expect(threadStatus(t({ steps: [{ id: 's', title: 'a', assignee: 'x', state: 'run' }] }), {})).toBe('running');
    expect(threadStatus(t(), {})).toBe('idle');
  });
});
