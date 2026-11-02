import type { Approval, Thread, ThreadStatus } from '../model/types.js';

export function pendingApprovals(threadId: string, approvals: Record<string, Approval>): Approval[] {
  return Object.values(approvals).filter((a) => a.state === 'pending' && a.request.threadId === threadId);
}

/** 讨论串在列表里归哪一组：等你处理 / 进行中 / 空闲 / 已解决 */
export function threadStatus(t: Thread, approvals: Record<string, Approval>, opts: { waitingQuestion?: boolean } = {}): ThreadStatus {
  if (t.resolved) return 'resolved';
  if (opts.waitingQuestion || pendingApprovals(t.id, approvals).length || t.steps.some((s) => s.state === 'wait')) return 'waiting';
  if (t.steps.some((s) => s.state === 'run')) return 'running';
  return 'idle';
}

export interface AutoResolveInput {
  thread: Thread;
  approvals: Record<string, Approval>;
  autoResolveEnabled: boolean;
  /** 还有没合并的 PR */
  openPullRequests?: number;
  /** 协调者在等用户回答问题 */
  waitingQuestion?: boolean;
}

/**
 * 协调者能不能自动解决这个讨论串。照 Claude 的规则：事情做完、没人欠下一步才解决；拿不准就留着。
 * 返回 null 表示可以解决，否则返回不解决的原因。
 */
export function autoResolveBlocker(i: AutoResolveInput): string | null {
  const t = i.thread;
  if (t.resolved) return '已经解决了';
  if (!i.autoResolveEnabled) return '项目设置为只由你手动解决';
  if (t.keepOpen) return '你重新打开过它，协调者不再自动解决';
  const live = t.steps.filter((s) => s.state !== 'cancelled');
  if (!live.length) return '还没有计划';
  if (live.some((s) => s.state !== 'done')) return '计划还没做完';
  if (pendingApprovals(t.id, i.approvals).length) return '还有等你批准的事';
  if (i.waitingQuestion) return '还在等你回答';
  if (i.openPullRequests) return '还有没合并的 PR';
  return null;
}
