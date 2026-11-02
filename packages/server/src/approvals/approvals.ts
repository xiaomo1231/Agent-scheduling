import { decide, fingerprint, newId, ruleFromCommand, RISK_LABEL, type ActionRequest, type Actor, type Approval } from '@zhongshu/core';
import type { Workspace } from '../store/index.js';

export interface GateResult {
  ok: boolean;
  reason: string;
  approvalId?: string;
}

/** 审查模型（命令策略为 review 时）：返回 allow 就直接放行，其余交给用户 */
export type Reviewer = (req: ActionRequest) => Promise<'allow' | 'ask'>;

interface Pending {
  req: ActionRequest;
  resolve: (r: GateResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ApprovalOptions {
  random?: () => number;
  reviewer?: Reviewer;
}

/**
 * 审批队列。所有会产生副作用的动作都走 gate()：
 * allow 直接做；deny 直接拒；ask 生成审批并等用户决定，超时按 askFallback（默认拒绝）。
 * 用户批准后，执行前重算指纹，对不上就作废。
 */
export class Approvals {
  private pending = new Map<string, Pending>();
  private rnd: () => number;

  constructor(private readonly ws: Workspace, private readonly opts: ApprovalOptions = {}) {
    this.rnd = opts.random ?? Math.random;
    // 上次运行留下的待审批已经没有人在等了，作废掉
    const stale = Object.values(ws.current.approvals).filter((a) => a.state === 'pending');
    if (stale.length) ws.commit(stale.map((a) => ({ type: 'approval.decided' as const, approvalId: a.id, state: 'invalidated' as const })), { kind: 'system', id: 'startup' });
  }

  async gate(req: ActionRequest, actor: Actor): Promise<GateResult> {
    const st = this.ws.current;
    const d = decide(req, st.policy, { emergencyStop: st.emergencyStop });
    if (d.decision === 'allow') return { ok: true, reason: '' };
    if (d.decision === 'deny') return { ok: false, reason: d.reasons.join('；') || '策略不允许' };
    if (d.review && this.opts.reviewer) {
      try {
        if ((await this.opts.reviewer(req)) === 'allow') return { ok: true, reason: '审查模型放行' };
      } catch {
        /* 审查失败就交给用户 */
      }
    }
    const risk = d.risk;
    const approval: Approval = {
      id: newId('apv', this.rnd),
      request: req,
      fingerprint: fingerprint(req),
      reasons: d.reasons,
      risk: risk.map((r) => RISK_LABEL[r] ?? r),
      state: 'pending',
      createdAt: Date.now(),
    };
    this.ws.commit(
      [
        { type: 'approval.requested', approval },
        {
          type: 'thread.message',
          message: {
            id: newId('msg', this.rnd), threadId: req.threadId, author: actor, authorLabel: actor.id, ts: Date.now(),
            text: `想${req.kind === 'command' ? '运行' : req.kind === 'send_message' ? '发送' : '访问'}：${req.target}`,
            cards: [{ kind: 'approval', approvalId: approval.id }],
          },
        },
      ],
      actor,
    );
    return new Promise<GateResult>((resolve) => {
      const timer = setTimeout(() => this.expire(approval.id), Math.max(1, st.policy.approvalTimeoutSec) * 1000);
      this.pending.set(approval.id, { req, resolve, timer });
    });
  }

  /** 用户（或协调者代用户）做决定。always=true 时按这条命令生成一条精确白名单。 */
  decide(approvalId: string, approve: boolean, actor: Actor, opts: { always?: boolean } = {}): { ok: boolean; error?: string } {
    const a = this.ws.current.approvals[approvalId];
    if (!a) return { ok: false, error: '找不到这条审批' };
    if (a.state !== 'pending') return { ok: false, error: '这条审批已经处理过了' };
    const p = this.pending.get(approvalId);
    if (approve && p && fingerprint(p.req) !== a.fingerprint) {
      this.finish(approvalId, 'invalidated', actor, { ok: false, reason: '命令在等待期间变了，审批作废' });
      return { ok: false, error: '命令在等待期间变了，审批作废' };
    }
    const rule = approve && opts.always && a.request.kind === 'command' ? ruleFromCommand(a.request.target, a.request.agentId, newId('rul', this.rnd)) : null;
    this.finish(approvalId, approve ? 'approved' : 'denied', actor, approve ? { ok: true, reason: '你批准了', approvalId } : { ok: false, reason: '你拒绝了', approvalId }, rule ?? undefined);
    return { ok: true };
  }

  /** 紧急停止：所有等待中的审批一律拒绝 */
  denyAll(actor: Actor): void {
    for (const id of [...this.pending.keys()]) this.finish(id, 'denied', actor, { ok: false, reason: '已紧急停止' });
  }

  private expire(id: string) {
    const fallback = this.ws.current.policy.askFallback;
    this.finish(id, 'expired', { kind: 'system', id: 'timeout' }, { ok: false, reason: fallback === 'deny' ? '没人审批，超时按拒绝处理' : '没人审批，超时且不在白名单里，按拒绝处理' });
  }

  private finish(id: string, state: 'approved' | 'denied' | 'expired' | 'invalidated', actor: Actor, result: GateResult, addRule?: ReturnType<typeof ruleFromCommand>) {
    const p = this.pending.get(id);
    if (p) clearTimeout(p.timer);
    this.pending.delete(id);
    if (this.ws.current.approvals[id]?.state === 'pending') {
      this.ws.commit({ type: 'approval.decided', approvalId: id, state, ...(addRule ? { addRule } : {}) }, actor);
    }
    p?.resolve(result);
  }

  close(): void {
    for (const p of this.pending.values()) clearTimeout(p.timer);
  }
}
