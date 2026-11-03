import { useEffect, useMemo, useState } from 'react';
import { FLOW_PRESETS, NODE_KINDS, parseCsv, pendingApprovals, runStatus, upstreamOf, type FlowDef, type FlowInput, type NodeOutput, type State, type Thread } from '@zhongshu/core';
import { get, send } from './api';
import { attempt, toast } from './toast';
import { ApprovalsPanel } from './threads';
import { Dialog, time } from './ui';

export function allFlows(st: State): FlowDef[] {
  return [...FLOW_PRESETS, ...Object.values(st.flows)];
}
export function flowById(st: State, id: string): FlowDef | undefined {
  return st.flows[id] ?? FLOW_PRESETS.find((f) => f.id === id);
}
export const flowRuns = (st: State, projectId: string): Thread[] =>
  Object.values(st.threads).filter((t) => t.projectId === projectId && t.kind === 'flow' && t.run).sort((a, b) => b.updatedAt - a.updatedAt);

const RUN_TEXT: Record<string, string> = { running: '进行中', waiting: '等你', failed: '卡住', done: '完成' };
const RUN_PILL: Record<string, string> = { running: 'running', waiting: 'waiting', failed: 'wait', done: 'done' };

// ---------- 发起表单 ----------

export function StartDialog({ st, projectId, flow, initial, open, onClose, onStarted }: { st: State; projectId: string; flow: FlowDef | null; initial?: Record<string, string>; open: boolean; onClose: () => void; onStarted: (threadId: string) => void }) {
  const [vals, setVals] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (flow) setVals(Object.fromEntries(flow.inputs.map((i) => [i.key, initial?.[i.key] ?? i.default ?? ''])));
  }, [flow, initial, open]);
  if (!flow) return null;
  const needsSearch = flow.nodes.some((n) => n.kind === 'search') && !st.search?.secretRef;
  const field = (i: FlowInput) => {
    const v = vals[i.key] ?? '';
    const set = (x: string) => setVals({ ...vals, [i.key]: x });
    const label = <>{i.label}{i.required && <span className="bad"> *</span>}{i.hint && <span className="muted"> · {i.hint}</span>}</>;
    if (i.kind === 'select') return <label key={i.key} className="f">{label}<select className="inp" value={v} onChange={(e) => set(e.target.value)}>{(i.options ?? []).map((o) => <option key={o}>{o}</option>)}</select></label>;
    if (i.kind === 'longtext' || i.kind === 'file') return <label key={i.key} className="f">{label}<textarea className="inp" rows={i.kind === 'file' ? 6 : 4} value={v} onChange={(e) => set(e.target.value)} placeholder={i.kind === 'file' ? '把表格内容粘贴进来（CSV），或者填工作区里的文件路径，如 数据/评论.csv' : ''} /></label>;
    return <label key={i.key} className="f">{label}<input className="inp" type={i.kind === 'number' ? 'number' : 'text'} value={v} onChange={(e) => set(e.target.value)} /></label>;
  };
  const start = async () => {
    setBusy(true);
    const r = await attempt(send<{ threadId: string }>({ type: 'flow.start', projectId, flowId: flow.id, inputs: vals }));
    setBusy(false);
    if (r) { onClose(); onStarted(r.threadId); }
  };
  return (
    <Dialog open={open} onClose={onClose} title={`发起：${flow.name}`} footer={<><button className="btn" onClick={onClose}>取消</button><button className="btn pri" disabled={busy || needsSearch} onClick={start}>开始</button></>}>
      <p className="muted" style={{ margin: 0 }}>{flow.description}</p>
      {needsSearch && <div className="find warn">这个工作流要搜索。先到 <a href="#/models">模型 › 搜索服务</a> 里选一家并填 key。</div>}
      {flow.inputs.map(field)}
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>流程：{flow.nodes.map((n) => n.title).join(' → ')}。需要你确认的地方会出现在待办收件箱。</p>
    </Dialog>
  );
}

// ---------- 工作流台 ----------

export function FlowsPanel({ st, projectId, onOpen }: { st: State; projectId: string; onOpen: (threadId: string) => void }) {
  const [starting, setStarting] = useState<FlowDef | null>(null);
  const flows = allFlows(st);
  const runs = flowRuns(st, projectId);
  const active = runs.filter((t) => !t.resolved);
  return (
    <>
      <header><b>工作流台</b><span className="muted" style={{ fontSize: 12 }}>选一个，填表，开始</span><span className="spacer" /><a className="btn sm" href={`#/flow/new?p=${projectId}`}>+ 自建</a></header>
      <div className="body">
        <div className="stack" style={{ padding: 10 }}>
          {flows.map((f) => (
            <div key={f.id} className="card flowcard">
              <div className="row"><b>{f.name}</b>{f.audience && <span className="pill">{f.audience}</span>}{!f.builtin && <span className="pill">自建</span>}</div>
              <div className="muted" style={{ fontSize: 12.5, margin: '4px 0 6px' }}>{f.description}</div>
              <div className="row">
                <button className="btn pri sm" onClick={() => setStarting(f)}>发起</button>
                <a className="btn sm" href={`#/flow/${f.id}?p=${projectId}`}>{f.builtin ? '看编排 / 复制一份改' : '编辑编排'}</a>
                {!f.builtin && <button className="btn sm bad" onClick={() => confirm(`删除工作流“${f.name}”？已经跑过的记录还在。`) && attempt(send({ type: 'flow.remove', flowId: f.id }), '已删除')}>删除</button>}
              </div>
            </div>
          ))}
        </div>
        <div style={{ padding: '0 10px 10px' }}>
          <h3 style={{ margin: '6px 0' }}>运行中 {active.length}</h3>
          {active.length === 0 && <div className="muted" style={{ fontSize: 12.5 }}>没有正在跑的工作流</div>}
          {active.map((t) => <RunRow key={t.id} t={t} onOpen={onOpen} />)}
        </div>
      </div>
      <StartDialog st={st} projectId={projectId} flow={starting} open={!!starting} onClose={() => setStarting(null)} onStarted={onOpen} />
    </>
  );
}

function RunRow({ t, onOpen }: { t: Thread; onOpen: (id: string) => void }) {
  const run = t.run!;
  const s = runStatus(run);
  const nodes = Object.values(run.nodes);
  const done = nodes.filter((n) => n.state === 'done').length;
  return (
    <button className="th" style={{ width: '100%', border: 0, borderBottom: '1px solid var(--line-2)' }} onClick={() => onOpen(t.id)}>
      <div className="row"><b style={{ flex: 1, minWidth: 0 }}>{t.title}</b><span className={'pill ' + RUN_PILL[s]}>{RUN_TEXT[s]}</span></div>
      <div className="progress"><i style={{ width: `${(done / Math.max(1, nodes.length)) * 100}%` }} /></div>
      <div className="muted" style={{ fontSize: 12 }}>{done}/{nodes.length} 步 · {time(t.updatedAt)}</div>
    </button>
  );
}

// ---------- 待办收件箱 ----------

interface Pending { t: Thread; nodeId: string; kind: 'checkpoint' | 'failed' }

export function pendingFlowItems(st: State, projectId?: string): Pending[] {
  const out: Pending[] = [];
  for (const t of Object.values(st.threads)) {
    if (!t.run || t.resolved || (projectId && t.projectId !== projectId)) continue;
    for (const [nodeId, n] of Object.entries(t.run.nodes)) {
      if (n.state === 'wait') out.push({ t, nodeId, kind: 'checkpoint' });
      else if (n.state === 'failed') out.push({ t, nodeId, kind: 'failed' });
    }
  }
  return out.sort((a, b) => b.t.updatedAt - a.t.updatedAt);
}

export function InboxPanel({ st, projectId, onOpen }: { st: State; projectId: string; onOpen: (threadId: string) => void }) {
  const items = pendingFlowItems(st, projectId);
  const approvals = Object.values(st.approvals).filter((a) => a.state === 'pending' && st.threads[a.request.threadId]?.projectId === projectId);
  return (
    <>
      <header><b>待办收件箱</b><span className="muted" style={{ fontSize: 12 }}>{items.length + approvals.length ? `${items.length + approvals.length} 件等你` : '都处理完了'}</span></header>
      <div className="body">
        {items.map((it) => (it.kind === 'checkpoint' ? <CheckpointCard key={it.t.id + it.nodeId} st={st} t={it.t} nodeId={it.nodeId} onOpen={onOpen} /> : <FailedCard key={it.t.id + it.nodeId} t={it.t} nodeId={it.nodeId} onOpen={onOpen} />))}
        {approvals.length > 0 && <div className="muted" style={{ padding: '8px 10px 0', fontSize: 12 }}>要你批准的动作</div>}
        <ApprovalsPanel st={st} projectId={projectId} />
      </div>
    </>
  );
}

function FailedCard({ t, nodeId, onOpen }: { t: Thread; nodeId: string; onOpen: (id: string) => void }) {
  const n = t.run!.nodes[nodeId]!;
  const title = t.steps.find((s) => s.id === nodeId)?.title ?? nodeId;
  return (
    <div className="mcard ask" style={{ margin: 10 }}>
      <div className="row"><b>「{title}」卡住了</b><span className="muted">{t.title}</span></div>
      <div style={{ margin: '4px 0' }}>{n.note}</div>
      <div className="row">
        <button className="btn pri sm" onClick={() => attempt(send({ type: 'flow.retry', threadId: t.id }), '重新排队了')}>重试</button>
        <button className="btn sm" onClick={() => onOpen(t.id)}>看运行记录</button>
      </div>
    </div>
  );
}

/** 读一个节点结果的正文（文字或表格） */
export function useOutput(threadId: string, out: NodeOutput | undefined) {
  const [data, setData] = useState<{ text?: string; rows?: Record<string, string>[]; error?: string } | null>(null);
  useEffect(() => {
    setData(null);
    if (!out?.path || out.kind === 'files') return;
    let live = true;
    get<{ content: string }>(`/api/run-file?thread=${encodeURIComponent(threadId)}&path=${encodeURIComponent(out.path)}`)
      .then((r) => live && setData(out.kind === 'table' ? { rows: parseCsv(r.content) } : { text: r.content }))
      .catch((e: Error) => live && setData({ error: e.message }));
    return () => { live = false; };
  }, [threadId, out?.path, out?.sha256]);
  return data;
}

export function OutputView({ threadId, out, pick, picked, onPick }: { threadId: string; out: NodeOutput | undefined; pick?: boolean; picked?: Set<number>; onPick?: (i: number, on: boolean) => void }) {
  const data = useOutput(threadId, out);
  if (!out) return <div className="muted">（还没有结果）</div>;
  if (out.kind === 'files') return <div className="muted">文件：{out.preview}</div>;
  if (!data) return <div className="muted">读取中…</div>;
  if (data.error) return <div className="bad">{data.error}</div>;
  if (data.rows) {
    const rows = data.rows;
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    const shown = rows.slice(0, 200);
    return (
      <div className="tablewrap">
        <table className="tbl">
          <thead><tr>{pick && <th><input type="checkbox" aria-label="全选" checked={!!picked && picked.size === rows.length} onChange={(e) => rows.forEach((_, i) => onPick?.(i, e.target.checked))} /></th>}{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={i} className={picked?.has(i) ? 'on' : ''}>
                {pick && <td><input type="checkbox" checked={picked?.has(i) ?? false} onChange={(e) => onPick?.(i, e.target.checked)} /></td>}
                {cols.map((c) => <td key={c}>{/^https?:\/\//.test(r[c] ?? '') ? <a href={r[c]} target="_blank" rel="noreferrer noopener">{r[c]}</a> : r[c]}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length > shown.length && <div className="muted" style={{ fontSize: 12 }}>共 {rows.length} 行，只显示前 {shown.length} 行</div>}
      </div>
    );
  }
  return <pre className="code" style={{ maxHeight: 360 }}>{data.text}</pre>;
}

function CheckpointCard({ st, t, nodeId, onOpen }: { st: State; t: Thread; nodeId: string; onOpen: (id: string) => void }) {
  const run = t.run!;
  const def = flowById(st, run.flowId);
  const node = def?.nodes.find((n) => n.id === nodeId);
  const n = run.nodes[nodeId]!;
  const ups = useMemo(() => (def ? upstreamOf(def, nodeId) : []), [def, nodeId]);
  const pick = node?.kind === 'human' && !!node.config.pick;
  const tableUp = ups.find((u) => run.nodes[u.id]?.output?.kind === 'table');
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [note, setNote] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const decide = async (approve: boolean) => {
    const r = await attempt(send({ type: 'flow.decide', threadId: t.id, nodeId, approve, ...(note.trim() ? { note: note.trim() } : {}), ...(pick && approve ? { picked: [...picked].sort((a, b) => a - b) } : {}) }), approve ? '已通过' : '已打回');
    if (r !== undefined) { setNote(''); setRejecting(false); }
  };
  return (
    <div className="mcard ask" style={{ margin: 10 }}>
      <div className="row"><b>等你确认：{node?.title ?? nodeId}</b><span className="muted">{t.title} · {time(t.updatedAt)}</span><span className="spacer" /><button className="btn ghost sm" onClick={() => onOpen(t.id)}>运行记录</button></div>
      <div style={{ margin: '4px 0 8px' }}>{n.note}</div>
      {ups.map((u) => (
        <details key={u.id} open={ups.length === 1 || u.id === tableUp?.id}>
          <summary className="muted">{u.title}{run.nodes[u.id]?.output?.kind === 'table' ? `（${run.nodes[u.id]!.output!.rows} 行）` : ''}</summary>
          <OutputView threadId={t.id} out={run.nodes[u.id]?.output} pick={pick && u.id === tableUp?.id} picked={picked} onPick={(i, on) => setPicked((s) => { const x = new Set(s); if (on) x.add(i); else x.delete(i); return x; })} />
        </details>
      ))}
      {rejecting ? (
        <div className="stack" style={{ marginTop: 8 }}>
          <textarea className="inp" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="哪里不对、要怎么改。模型会按这个重做。" autoFocus />
          <div className="row"><button className="btn bad sm" disabled={!note.trim()} onClick={() => decide(false)}>确认打回</button><button className="btn sm" onClick={() => setRejecting(false)}>算了</button></div>
        </div>
      ) : (
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn pri sm" disabled={pick && picked.size === 0} onClick={() => decide(true)}>{pick ? `通过（已勾 ${picked.size} 行）` : '通过'}</button>
          <button className="btn sm" onClick={() => setRejecting(true)}>打回并写意见</button>
          <input className="inp" style={{ flex: 1, minWidth: 120 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="给下一步的一句话（可不填）" aria-label="备注" />
        </div>
      )}
    </div>
  );
}

// ---------- 产出 ----------

export function OutputsPanel({ st, projectId, onOpen }: { st: State; projectId: string; onOpen: (threadId: string) => void }) {
  const runs = flowRuns(st, projectId);
  const [view, setView] = useState<{ t: Thread; out: NodeOutput; title: string } | null>(null);
  const [redo, setRedo] = useState<Thread | null>(null);
  const redoFlow = redo ? flowById(st, redo.run!.flowId) ?? null : null;
  const download = async (t: Thread, path: string) => {
    try {
      const r = await get<{ content: string }>(`/api/run-file?thread=${encodeURIComponent(t.id)}&path=${encodeURIComponent(path)}`);
      const blob = new Blob([path.endsWith('.csv') ? '﻿' + r.content : r.content], { type: 'text/plain;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = path.split('/').pop() ?? path;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <>
      <header><b>产出</b><span className="muted" style={{ fontSize: 12 }}>工作流生成的表格和文档</span></header>
      <div className="body">
        {runs.length === 0 && <div className="empty">还没有产出。从工作流台发起一个试试。</div>}
        {runs.map((t) => {
          const run = t.run!;
          const def = flowById(st, run.flowId);
          const files = Object.entries(run.nodes).flatMap(([id, n]) => (n.output?.kind === 'files' && n.output.path ? n.output.path.split(',').map((p) => ({ id, p })) : []));
          const mids = Object.entries(run.nodes).filter(([, n]) => n.output && n.output.kind !== 'files');
          const s = runStatus(run);
          return (
            <div key={t.id} className="outrun">
              <div className="row"><b style={{ flex: 1, minWidth: 0 }}>{t.title}</b><span className={'pill ' + RUN_PILL[s]}>{RUN_TEXT[s]}</span></div>
              <div className="muted" style={{ fontSize: 12 }}>{time(t.createdAt)} · {run.dir}</div>
              {files.length > 0 && (
                <div className="stack" style={{ gap: 4, margin: '6px 0' }}>
                  {files.map(({ id, p }) => (
                    <div key={p} className="row">
                      <span className="mono">{p}</span>
                      <span className="spacer" />
                      <button className="btn sm" onClick={() => setView({ t, out: { kind: p.endsWith('.csv') ? 'table' : 'text', path: p, preview: '' }, title: p })}>查看</button>
                      <button className="btn sm" onClick={() => download(t, p)}>下载</button>
                      <span className="muted" style={{ fontSize: 11 }}>{t.steps.find((x) => x.id === id)?.title}</span>
                    </div>
                  ))}
                </div>
              )}
              {mids.length > 0 && (
                <details><summary className="muted" style={{ fontSize: 12 }}>中间结果 {mids.length} 个</summary>
                  <div className="stack" style={{ gap: 4, marginTop: 4 }}>
                    {mids.map(([id, n]) => <div key={id} className="row"><span>{t.steps.find((x) => x.id === id)?.title}</span><span className="muted" style={{ fontSize: 12 }}>{n.output!.kind === 'table' ? `${n.output!.rows} 行` : '文字'}</span><span className="spacer" /><button className="btn sm" onClick={() => setView({ t, out: n.output!, title: t.steps.find((x) => x.id === id)?.title ?? id })}>查看</button></div>)}
                  </div>
                </details>
              )}
              <div className="row" style={{ marginTop: 4 }}>
                <button className="btn ghost sm" onClick={() => onOpen(t.id)}>运行记录</button>
                {def && <button className="btn ghost sm" onClick={() => setRedo(t)}>用同样的表单再跑一次</button>}
              </div>
            </div>
          );
        })}
      </div>
      <Dialog open={!!view} onClose={() => setView(null)} title={view?.title ?? ''} footer={view && view.out.path ? <><button className="btn" onClick={() => download(view.t, view.out.path!)}>下载</button><button className="btn pri" onClick={() => setView(null)}>关闭</button></> : undefined}>
        {view && <OutputView threadId={view.t.id} out={view.out} />}
      </Dialog>
      <StartDialog st={st} projectId={projectId} flow={redoFlow} initial={redo?.run!.inputs} open={!!redo && !!redoFlow} onClose={() => setRedo(null)} onStarted={onOpen} />
    </>
  );
}

export { NODE_KINDS };
