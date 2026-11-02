import { useEffect, useRef, useState } from 'react';
import { pendingApprovals, threadStatus, type Approval, type Message, type State, type Thread } from '@zhongshu/core';
import { send } from './api';
import { attempt, toast } from './toast';
import { EffortPicker, ModelPicker, STATUS_TEXT, label, time } from './ui';

function ApprovalCard({ a }: { a: Approval }) {
  const decide = (approve: boolean, always = false) => attempt(send({ type: 'approval.decide', approvalId: a.id, approve, always }), approve ? '已批准' : '已拒绝');
  const pending = a.state === 'pending';
  return (
    <div className={'mcard' + (pending ? ' ask' : '')}>
      <div className="row">
        <b>{pending ? '要你批准' : ({ approved: '已批准', denied: '已拒绝', expired: '超时未批，已拒绝', invalidated: '已作废' } as Record<string, string>)[a.state]}</b>
        <span className="muted">{a.request.agentId}</span>
      </div>
      <div className="mono" style={{ margin: '4px 0', wordBreak: 'break-all' }}>{a.request.target}</div>
      {a.reasons.length > 0 && <div className="muted">原因：{a.reasons.join('、')}</div>}
      {pending && (
        <div className="row" style={{ marginTop: 6 }}>
          <button className="btn pri sm" onClick={() => decide(true)}>批准这一次</button>
          {a.request.kind === 'command' && <button className="btn sm" onClick={() => decide(true, true)} title="只放行这条命令（同样的参数、同一个 agent）">以后都允许</button>}
          <button className="btn bad sm" onClick={() => decide(false)}>拒绝</button>
        </div>
      )}
    </div>
  );
}

function MessageView({ m, st, onOpen }: { m: Message; st: State; onOpen: (threadId: string) => void }) {
  const me = m.author.kind === 'user';
  const sys = m.author.kind === 'system';
  return (
    <div className={'msg' + (me ? ' me' : sys ? ' sys' : '')}>
      {!me && (
        <div className="who">
          <span>{m.authorLabel}</span>
          <span>{time(m.ts)}</span>
        </div>
      )}
      {m.text && <div className="txt">{m.text}</div>}
      {m.cards?.map((c, i) => {
        if (c.kind === 'approval') {
          const a = st.approvals[c.approvalId];
          return a ? <ApprovalCard key={i} a={a} /> : null;
        }
        if (c.kind === 'thread') {
          const t = st.threads[c.threadId];
          return t ? (
            <button key={i} className="mcard" style={{ display: 'block', textAlign: 'left', width: '100%' }} onClick={() => onOpen(t.id)}>
              <div className="row"><b>开了讨论串：{t.title}</b><span className="spacer" /><span className={'pill ' + threadStatus(t, st.approvals)}>{STATUS_TEXT[threadStatus(t, st.approvals)]}</span></div>
              <div className="muted">{t.steps.length} 步 · 点开看</div>
            </button>
          ) : null;
        }
        if (c.kind === 'worktree') {
          const w = st.threads[c.threadId]?.worktree;
          if (!w) return null;
          const STATE: Record<string, string> = { active: '正在改', ready: '等你决定', merged: '已合并', discarded: '已丢弃' };
          return (
            <div key={i} className={'mcard' + (w.state === 'ready' ? ' ask' : '')}>
              <div className="row"><b>独立工作区 · {STATE[w.state]}</b><span className="spacer" /><span className="mono muted">{w.branch} → {w.base}</span></div>
              {w.summary && <pre className="mono" style={{ margin: '4px 0', whiteSpace: 'pre-wrap', fontSize: 12 }}>{w.summary}</pre>}
              {w.state === 'ready' && (
                <div className="row" style={{ marginTop: 6 }}>
                  <button className="btn pri sm" onClick={() => attempt(send({ type: 'thread.merge', threadId: c.threadId }), '已合并')}>合并到 {w.base}</button>
                  <button className="btn bad sm" onClick={() => { if (confirm('丢弃这些改动？丢了找不回来。')) void attempt(send({ type: 'thread.discard', threadId: c.threadId }), '已丢弃'); }}>丢弃</button>
                </div>
              )}
            </div>
          );
        }
        if (c.kind !== 'planDiff') return null;
        const seq = c.undoToken ? Number(c.undoToken.split(':')[1]) : 0;
        return (
          <div key={i} className="mcard row">
            <span>计划调整：{c.summary}</span>
            <span className="spacer" />
            {seq > 0 && <button className="btn sm" onClick={() => attempt(send({ type: 'plan.undo', threadId: m.threadId, seq }), '已撤销')}>撤销</button>}
          </div>
        );
      })}
    </div>
  );
}

export function Messages({ st, threadId, onOpen }: { st: State; threadId: string; onOpen: (id: string) => void }) {
  const list = st.messages[threadId] ?? [];
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [list.length]);
  return (
    <div className="msgs">
      {list.length === 0 && <div className="empty">还没有消息</div>}
      {list.map((m) => <MessageView key={m.id} m={m} st={st} onOpen={onOpen} />)}
      <div ref={end} />
    </div>
  );
}

export function Composer({ threadId, placeholder }: { threadId: string; placeholder: string }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      await send({ type: 'message.send', threadId, text: t });
      setText('');
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="composer">
      <textarea
        className="inp" rows={1} value={text} placeholder={placeholder} aria-label="消息"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <button className="btn pri" onClick={submit} disabled={busy || !text.trim()}>发送</button>
    </div>
  );
}

export function CoordPanel({ st, projectId, onOpen }: { st: State; projectId: string; onOpen: (id: string) => void }) {
  const coord = Object.values(st.threads).find((t) => t.projectId === projectId && t.kind === 'coord');
  const p = st.projects[projectId]!;
  if (!coord) return <div className="empty">没有协调者对话</div>;
  return (
    <>
      <header>
        <b>协调者</b>
        <span className="muted" style={{ fontSize: 12 }}>{p.settings.coordinator.model ? label(st, p.settings.coordinator.model) : '规则模式（还没选模型）'}</span>
        {p.settings.coordinator.dual?.enabled && <span className="pill">双脑 · {p.settings.coordinator.dual.mode === 'review' ? '副脑复核' : '备用接手'}</span>}
      </header>
      <div className="body"><Messages st={st} threadId={coord.id} onOpen={onOpen} /></div>
      <Composer threadId={coord.id} placeholder="告诉协调者要做什么，回车发送" />
    </>
  );
}

export function ThreadList({ st, projectId, selected, onOpen }: { st: State; projectId: string; selected: string | null; onOpen: (id: string) => void }) {
  const [tab, setTab] = useState<'active' | 'resolved'>('active');
  const all = Object.values(st.threads).filter((t) => t.projectId === projectId && t.kind !== 'coord').sort((a, b) => b.updatedAt - a.updatedAt);
  const active = all.filter((t) => !t.resolved);
  const resolved = all.filter((t) => t.resolved);
  const list = tab === 'active' ? active : resolved;
  const [title, setTitle] = useState('');
  return (
    <div className="thl">
      <div className="row" style={{ padding: '6px 10px', borderBottom: '1px solid var(--line-2)' }}>
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'active'} className={tab === 'active' ? 'on' : ''} onClick={() => setTab('active')}>进行中 {active.length}</button>
          <button role="tab" aria-selected={tab === 'resolved'} className={tab === 'resolved' ? 'on' : ''} onClick={() => setTab('resolved')}>已解决 {resolved.length}</button>
        </div>
      </div>
      {list.length === 0 && <div className="empty">{tab === 'active' ? '没有进行中的讨论串。跟协调者说一句话就会开一个。' : '还没有已解决的讨论串'}</div>}
      {list.map((t) => {
        const s = threadStatus(t, st.approvals);
        const done = t.steps.filter((x) => x.state === 'done').length;
        const live = t.steps.filter((x) => x.state !== 'cancelled').length;
        return (
          <button key={t.id} className={'th' + (selected === t.id ? ' on' : '')} onClick={() => onOpen(t.id)}>
            <div className="row"><b style={{ flex: 1, minWidth: 0 }}>{t.title}</b><span className={'pill ' + s}>{STATUS_TEXT[s]}</span></div>
            <div className="muted" style={{ fontSize: 12 }}>
              {live ? `${done}/${live} 步` : '还没有计划'} · {time(t.updatedAt)}
              {t.resolved && ` · ${t.resolved.by === 'user' ? '你解决的' : '协调者解决的'}`}
            </div>
          </button>
        );
      })}
      {tab === 'active' && (
        <form className="row" style={{ padding: 10 }} onSubmit={(e) => {
          e.preventDefault();
          if (!title.trim()) return;
          void attempt(send<{ threadId: string }>({ type: 'thread.create', projectId, title: title.trim() })).then((r) => { if (r) { setTitle(''); onOpen(r.threadId); } });
        }}>
          <input className="inp" style={{ flex: 1 }} placeholder="手动开一个讨论串" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="新讨论串标题" />
          <button className="btn" disabled={!title.trim()}>开</button>
        </form>
      )}
    </div>
  );
}

function Plan({ t }: { t: Thread }) {
  const apply = (ops: unknown[]) => attempt(send({ type: 'plan.apply', threadId: t.id, ops }));
  const [add, setAdd] = useState('');
  return (
    <div className="steps">
      {t.steps.map((s, i) => (
        <div key={s.id} className={'step ' + s.state}>
          <span className="tn">T{i + 1}</span>
          <span className="tt">{s.title} <span className="muted">{s.assignee}</span></span>
          <span className="acts">
            {i > 0 && <button className="btn ghost sm" title="往前挪" aria-label="往前挪" onClick={() => apply([{ op: 'move', stepId: s.id, before: t.steps[i - 1]!.id }])}>↑</button>}
            {i < t.steps.length - 1 && <button className="btn ghost sm" title="往后挪" aria-label="往后挪" onClick={() => apply([{ op: 'move', stepId: s.id, after: t.steps[i + 1]!.id }])}>↓</button>}
            {s.state !== 'cancelled' && s.state !== 'done' && <button className="btn ghost sm" title="取消这一步" aria-label="取消这一步" onClick={() => apply([{ op: 'cancel', stepId: s.id }])}>✕</button>}
          </span>
          <span className={'pill ' + s.state}>{STATUS_TEXT[s.state]}</span>
        </div>
      ))}
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (add.trim()) void apply([{ op: 'add', title: add.trim() }]).then(() => setAdd('')); }}>
        <input className="inp" style={{ flex: 1 }} placeholder="加一步（加在合并/发布之前）" value={add} onChange={(e) => setAdd(e.target.value)} aria-label="新步骤" />
        <button className="btn sm" disabled={!add.trim()}>加</button>
      </form>
    </div>
  );
}

export function ThreadView({ st, threadId, onBack, onOpen }: { st: State; threadId: string; onBack?: () => void; onOpen: (id: string) => void }) {
  const t = st.threads[threadId];
  const [showSet, setShowSet] = useState(false);
  if (!t) return <div className="empty">讨论串不见了</div>;
  const s = threadStatus(t, st.approvals);
  const p = st.projects[t.projectId]!;
  const choice = t.model ?? p.settings.threadDefault.model;
  const hasWait = t.steps.some((x) => x.state === 'wait' || x.state === 'queue');
  return (
    <>
      <header>
        {onBack && <button className="btn ghost sm" onClick={onBack} aria-label="返回列表">←</button>}
        <b style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</b>
        <span className={'pill ' + s}>{STATUS_TEXT[s]}</span>
        <button className="btn ghost sm" onClick={() => setShowSet(!showSet)} aria-expanded={showSet}>模型</button>
        {!t.resolved && hasWait && <button className="btn sm" onClick={() => attempt(send({ type: 'thread.continue', threadId: t.id }))}>继续</button>}
        {t.resolved
          ? <button className="btn sm" onClick={() => attempt(send({ type: 'thread.reopen', threadId: t.id }), '已重新打开')}>重新打开</button>
          : <button className="btn sm" onClick={() => attempt(send({ type: 'thread.resolve', threadId: t.id }), '已放到已解决')}>解决</button>}
      </header>
      {showSet && (
        <div className="row" style={{ padding: '8px 10px', borderBottom: '1px solid var(--line-2)' }}>
          <span className="muted">执行模型</span>
          <ModelPicker st={st} value={choice} emptyLabel="（跟项目默认）" onChange={(c) => attempt(send({ type: 'thread.settings', threadId: t.id, model: c }))} />
          <EffortPicker st={st} choice={choice} value={t.effort} onChange={(v) => attempt(send({ type: 'thread.settings', threadId: t.id, effort: v }))} />
          <button className="btn sm" onClick={() => attempt(send({ type: 'thread.stop', threadId: t.id }), '已停下')}>停止运行</button>
        </div>
      )}
      <div className="body">
        <Plan t={t} />
        {t.resolved && <div className="muted" style={{ padding: '6px 12px' }}>{t.resolved.by === 'user' ? '你' : '协调者'}在 {time(t.resolved.at)} 解决了它：{t.resolved.reason}。发消息会重新打开。</div>}
        <Messages st={st} threadId={t.id} onOpen={onOpen} />
      </div>
      <Composer threadId={t.id} placeholder="追加要求：“再加一步…”“先做 T3”“取消 T2”，回车发送" />
    </>
  );
}

export function ApprovalsPanel({ st, projectId }: { st: State; projectId?: string }) {
  const list = Object.values(st.approvals).filter((a) => a.state === 'pending' && (!projectId || st.threads[a.request.threadId]?.projectId === projectId));
  return (
    <div style={{ padding: 10 }} className="stack">
      {list.length === 0 && <div className="empty">没有等你批准的事</div>}
      {list.map((a) => (
        <div key={a.id}>
          <div className="muted" style={{ fontSize: 12 }}>{st.threads[a.request.threadId]?.title ?? ''}</div>
          <ApprovalCard a={a} />
        </div>
      ))}
    </div>
  );
}

export function ActivityPanel({ st, projectId, onOpen }: { st: State; projectId: string; onOpen: (id: string) => void }) {
  const msgs = Object.values(st.threads)
    .filter((t) => t.projectId === projectId)
    .flatMap((t) => (st.messages[t.id] ?? []).map((m) => ({ m, t })))
    .sort((a, b) => b.m.ts - a.m.ts)
    .slice(0, 40);
  return (
    <div className="list" style={{ border: 0, borderRadius: 0 }}>
      {msgs.length === 0 && <div className="empty">还没有动态</div>}
      {msgs.map(({ m, t }) => (
        <button key={m.id} className="it" style={{ border: 0, borderTop: '1px solid var(--line-2)', background: 'transparent', textAlign: 'left', width: '100%' }} onClick={() => t.kind !== 'coord' && onOpen(t.id)}>
          <span className="mono muted">{time(m.ts)}</span>
          <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            <b>{m.authorLabel}</b> · {t.kind === 'coord' ? '协调者' : t.title}：{m.text || (m.cards?.[0]?.kind === 'approval' ? '请求批准' : '（卡片）')}
          </span>
        </button>
      ))}
    </div>
  );
}

export { pendingApprovals };
