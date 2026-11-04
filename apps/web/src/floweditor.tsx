import { useEffect, useMemo, useRef, useState, type PointerEvent as RPE } from 'react';
import { NODE_KINDS, newId, validateFlow, type FlowDef, type FlowInput, type FlowNode, type FlowNodeKind, type State, type ToolName } from '@zhongshu/core';
import { send } from './api';
import { attempt, toast } from './toast';
import { ModelPicker } from './ui';
import { StartDialog, flowById } from './flows';

const W = 176;
const H = 60;
const TOOL_LABEL: Record<ToolName, string> = { read_file: '读文件', write_file: '写文件', edit_file: '改文件', list_files: '列目录', run_command: '跑命令（高风险）', web_fetch: '读网页', web_search: '搜索', send_message: '发消息' };

type Drag = { kind: 'move'; id: string; dx: number; dy: number } | { kind: 'link'; from: string; x: number; y: number };

function blankNode(kind: FlowNodeKind, x: number, y: number): FlowNode {
  const base = { id: newId('nod'), title: NODE_KINDS[kind].label, x, y };
  switch (kind) {
    case 'input': return { ...base, kind, config: { key: '' } };
    case 'search': return { ...base, kind, config: { queries: [''], limit: 8, recency: 'any' } };
    case 'agent': return { ...base, kind, config: { instruction: '', tools: [], output: 'text' } };
    case 'human': return { ...base, kind, config: { ask: '' } };
    case 'export': return { ...base, kind, config: { filename: '结果.md' } };
  }
}

const port = (n: FlowNode, side: 'in' | 'out') => ({ x: n.x + (side === 'out' ? W : 0), y: n.y + H / 2 });
const curve = (a: { x: number; y: number }, b: { x: number; y: number }) => {
  const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
  return `M${a.x} ${a.y} C${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
};

/**
 * 编排编辑器：节点是卡片，拖标题移动；从右边的圆点拖到另一个节点的左边圆点就是连线。
 * 点节点在右侧改参数；点连线可以删。保存前后都跑同一个 validateFlow。
 */
export function FlowEditorPage({ st, flowId, projectId }: { st: State; flowId: string; projectId: string | null }) {
  const source = flowId === 'new' ? null : flowById(st, flowId);
  const [def, setDef] = useState<FlowDef>(() => source ? structuredClone(source) : { id: newId('flo'), name: '我的工作流', description: '', inputs: [], nodes: [], edges: [] });
  const [sel, setSel] = useState<{ node?: string; edge?: number } | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [saved, setSaved] = useState<FlowDef | null>(source ?? null);
  const [starting, setStarting] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const readOnly = !!def.builtin;
  useEffect(() => {
    if (source && source.id !== def.id) { setDef(structuredClone(source)); setSaved(source); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source?.id]);
  const issues = useMemo(() => validateFlow(def), [def]);
  const dirty = JSON.stringify(def) !== JSON.stringify(saved);
  const node = sel?.node ? def.nodes.find((n) => n.id === sel.node) : undefined;
  const update = (f: (d: FlowDef) => FlowDef) => { if (!readOnly) setDef((d) => f(d)); };
  const patchNode = (id: string, p: Partial<FlowNode> | ((n: FlowNode) => FlowNode)) => update((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === id ? (typeof p === 'function' ? p(n) : ({ ...n, ...p } as FlowNode)) : n)) }));

  const local = (e: { clientX: number; clientY: number }) => {
    const r = box.current!.getBoundingClientRect();
    return { x: e.clientX - r.left + box.current!.scrollLeft, y: e.clientY - r.top + box.current!.scrollTop };
  };
  const downNode = (e: RPE, n: FlowNode) => {
    if (readOnly) return setSel({ node: n.id });
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    const p = local(e);
    setDrag({ kind: 'move', id: n.id, dx: p.x - n.x, dy: p.y - n.y });
    setSel({ node: n.id });
  };
  const downPort = (e: RPE, n: FlowNode) => {
    if (readOnly) return;
    e.stopPropagation();
    e.preventDefault();
    const p = local(e);
    setDrag({ kind: 'link', from: n.id, x: p.x, y: p.y });
  };
  const move = (e: RPE) => {
    if (!drag) return;
    const p = local(e);
    if (drag.kind === 'move') patchNode(drag.id, { x: Math.max(0, Math.round((p.x - drag.dx) / 8) * 8), y: Math.max(0, Math.round((p.y - drag.dy) / 8) * 8) });
    else setDrag({ ...drag, x: p.x, y: p.y });
  };
  const up = (e: RPE) => {
    if (drag?.kind === 'link') {
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-node]');
      const to = el?.dataset.node;
      if (to && to !== drag.from) {
        if (def.edges.some((x) => x.from === drag.from && x.to === to)) toast('已经连过了');
        else update((d) => ({ ...d, edges: [...d.edges, { from: drag.from, to }] }));
      }
    }
    setDrag(null);
  };
  const addNode = (kind: FlowNodeKind) => {
    const x = def.nodes.length ? Math.max(...def.nodes.map((n) => n.x)) + W + 56 : 40;
    const n = blankNode(kind, x, 80);
    update((d) => ({ ...d, nodes: [...d.nodes, n], ...(sel?.node && kind !== 'input' ? { edges: [...d.edges, { from: sel.node, to: n.id }] } : {}) }));
    setSel({ node: n.id });
  };
  const removeNode = (id: string) => { update((d) => ({ ...d, nodes: d.nodes.filter((n) => n.id !== id), edges: d.edges.filter((e) => e.from !== id && e.to !== id) })); setSel(null); };
  const save = async (asCopy = false) => {
    const flow: FlowDef = asCopy ? { ...def, id: newId('flo'), name: def.builtin ? `${def.name}（我的）` : def.name, builtin: false } : def;
    const r = await attempt(send<{ flow: FlowDef }>({ type: 'flow.save', flow }), '已保存');
    if (r) { setSaved(r.flow); setDef(r.flow); if (asCopy) location.hash = `#/flow/${r.flow.id}${projectId ? `?p=${projectId}` : ''}`; }
  };
  const back = projectId ? `#/p/${projectId}` : '#/';
  const width = Math.max(800, ...def.nodes.map((n) => n.x + W + 80));
  const height = Math.max(420, ...def.nodes.map((n) => n.y + H + 80));

  return (
    <div className="view full">
      <div className="row" style={{ marginBottom: 8 }}>
        <a className="btn ghost sm" href={back}>← 返回</a>
        <input className="inp" style={{ fontWeight: 600, width: 220 }} value={def.name} disabled={readOnly} onChange={(e) => update((d) => ({ ...d, name: e.target.value }))} aria-label="工作流名字" />
        <input className="inp" style={{ flex: 1, minWidth: 200 }} value={def.description} disabled={readOnly} placeholder="一句话说明：给谁用、做什么" onChange={(e) => update((d) => ({ ...d, description: e.target.value }))} aria-label="说明" />
        {readOnly ? <span className="pill">内置预设，只读</span> : issues.length ? <span className="pill wait" title={issues.join('\n')}>{issues.length} 个问题</span> : <span className="pill done">可以运行</span>}
        {readOnly ? <button className="btn pri" onClick={() => save(true)}>复制一份改</button> : (
          <>
            <button className="btn" onClick={() => save(true)}>另存为</button>
            <button className="btn pri" disabled={!dirty || issues.length > 0} onClick={() => save(false)}>保存</button>
          </>
        )}
        {projectId && <button className="btn" disabled={issues.length > 0 || (dirty && !readOnly)} title={dirty && !readOnly ? '先保存' : ''} onClick={() => setStarting(true)}>发起运行</button>}
      </div>
      {issues.length > 0 && !readOnly && <div className="find warn" style={{ marginBottom: 8 }}>{issues.join('；')}</div>}
      <div className="row" style={{ marginBottom: 8 }}>
        <span className="muted">添加节点：</span>
        {(Object.keys(NODE_KINDS) as FlowNodeKind[]).map((k) => <button key={k} className="btn sm" disabled={readOnly} title={NODE_KINDS[k].hint} onClick={() => addNode(k)}>+ {NODE_KINDS[k].label}</button>)}
        <span className="muted" style={{ fontSize: 12 }}>选中一个节点再添加，会自动连上。从右边的圆点拖到另一个节点就是连线。</span>
      </div>
      <div className="floweditor">
        <div ref={box} className="flowcanvas" onPointerMove={move} onPointerUp={up} onPointerCancel={() => setDrag(null)} onPointerDown={() => setSel(null)}>
          <div style={{ position: 'relative', width, height }}>
            <svg className="edges" width={width} height={height}>
              <defs><marker id="fe-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="currentColor" /></marker></defs>
              {def.edges.map((e, i) => {
                const a = def.nodes.find((n) => n.id === e.from), b = def.nodes.find((n) => n.id === e.to);
                if (!a || !b) return null;
                const on = sel?.edge === i;
                return <path key={i} d={curve(port(a, 'out'), port(b, 'in'))} className={'edge' + (on ? ' on' : '')} markerEnd="url(#fe-arrow)" onPointerDown={(ev) => { ev.stopPropagation(); setSel({ edge: i }); }} />;
              })}
              {drag?.kind === 'link' && (() => { const a = def.nodes.find((n) => n.id === drag.from); return a ? <path d={curve(port(a, 'out'), { x: drag.x, y: drag.y })} className="edge ghost" /> : null; })()}
            </svg>
            {def.nodes.map((n) => (
              <div key={n.id} data-node={n.id} className={`fnode k-${n.kind}` + (sel?.node === n.id ? ' on' : '')} style={{ left: n.x, top: n.y, width: W, height: H }} onPointerDown={(e) => downNode(e, n)}>
                <span className="kind">{NODE_KINDS[n.kind].label}</span>
                <b>{n.title}</b>
                {n.kind !== 'input' && <span className="port in" data-node={n.id} />}
                <span className="port out" onPointerDown={(e) => downPort(e, n)} title="拖到另一个节点上连线" />
              </div>
            ))}
            {def.nodes.length === 0 && <div className="empty" style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>从上面添加第一个节点</div>}
          </div>
        </div>
        <aside className="flowside">
          {sel?.edge !== undefined && def.edges[sel.edge] && (
            <div className="stack">
              <b>连线</b>
              <div>{def.nodes.find((n) => n.id === def.edges[sel.edge!]!.from)?.title} → {def.nodes.find((n) => n.id === def.edges[sel.edge!]!.to)?.title}</div>
              <button className="btn bad sm" disabled={readOnly} onClick={() => { update((d) => ({ ...d, edges: d.edges.filter((_, i) => i !== sel.edge) })); setSel(null); }}>删除这条线</button>
            </div>
          )}
          {node && <NodeForm st={st} def={def} node={node} readOnly={readOnly} onChange={(p) => patchNode(node.id, p)} onRemove={() => removeNode(node.id)} />}
          {!node && sel?.edge === undefined && <InputsForm def={def} readOnly={readOnly} onChange={(inputs) => update((d) => ({ ...d, inputs }))} />}
        </aside>
      </div>
      {projectId && <StartDialog st={st} projectId={projectId} flow={starting ? def : null} open={starting} onClose={() => setStarting(false)} onStarted={(id) => { location.hash = `#/p/${projectId}/${id}`; }} />}
    </div>
  );
}

function InputsForm({ def, readOnly, onChange }: { def: FlowDef; readOnly: boolean; onChange: (inputs: FlowInput[]) => void }) {
  const set = (i: number, p: Partial<FlowInput>) => onChange(def.inputs.map((x, k) => (k === i ? { ...x, ...p } : x)));
  return (
    <div className="stack">
      <div className="row"><b>发起表单</b><span className="muted" style={{ fontSize: 12 }}>用户发起时要填的格</span><span className="spacer" />{!readOnly && <button className="btn sm" onClick={() => onChange([...def.inputs, { key: `字段${def.inputs.length + 1}`, label: '新字段', kind: 'text' }])}>+ 加一格</button>}</div>
      {def.inputs.length === 0 && <div className="muted" style={{ fontSize: 12.5 }}>没有表单字段。节点说明里可以用 {'{{inputs.字段键}}'} 引用。</div>}
      {def.inputs.map((i, k) => (
        <div key={k} className="card stack" style={{ gap: 6, padding: 8 }}>
          <div className="row">
            <input className="inp" style={{ width: 90 }} value={i.key} disabled={readOnly} onChange={(e) => set(k, { key: e.target.value })} aria-label="键" title="键：节点说明里用 {{inputs.键}} 引用" />
            <input className="inp" style={{ flex: 1 }} value={i.label} disabled={readOnly} onChange={(e) => set(k, { label: e.target.value })} aria-label="标题" />
            <select className="inp" value={i.kind} disabled={readOnly} onChange={(e) => set(k, { kind: e.target.value as FlowInput['kind'] })}>
              <option value="text">一行文字</option><option value="longtext">多行文字</option><option value="number">数字</option><option value="select">下拉选</option><option value="file">表格 / 文件</option>
            </select>
          </div>
          <div className="row">
            <label className="chk"><input type="checkbox" checked={!!i.required} disabled={readOnly} onChange={(e) => set(k, { required: e.target.checked })} />必填</label>
            <input className="inp" style={{ flex: 1 }} value={i.hint ?? ''} disabled={readOnly} placeholder="提示" onChange={(e) => set(k, { hint: e.target.value })} aria-label="提示" />
            <input className="inp" style={{ width: 90 }} value={i.default ?? ''} disabled={readOnly} placeholder="默认值" onChange={(e) => set(k, { default: e.target.value })} aria-label="默认值" />
            {!readOnly && <button className="btn ghost sm" onClick={() => onChange(def.inputs.filter((_, j) => j !== k))} aria-label="删除字段">✕</button>}
          </div>
          {i.kind === 'select' && <input className="inp" value={(i.options ?? []).join(' / ')} disabled={readOnly} placeholder="选项，用 / 分开" onChange={(e) => set(k, { options: e.target.value.split('/').map((s) => s.trim()).filter(Boolean) })} aria-label="选项" />}
        </div>
      ))}
    </div>
  );
}

function NodeForm({ st, def, node: n, readOnly, onChange, onRemove }: { st: State; def: FlowDef; node: FlowNode; readOnly: boolean; onChange: (p: (n: FlowNode) => FlowNode) => void; onRemove: () => void }) {
  const cfg = <K extends FlowNode['kind']>(kind: K, p: Partial<Extract<FlowNode, { kind: K }>['config']>) => onChange((x) => (x.kind === kind ? ({ ...x, config: { ...x.config, ...p } } as FlowNode) : x));
  const ups = def.edges.filter((e) => e.to === n.id).map((e) => def.nodes.find((x) => x.id === e.from)?.title).filter(Boolean);
  return (
    <div className="stack">
      <div className="row"><span className="pill">{NODE_KINDS[n.kind].label}</span><span className="spacer" />{!readOnly && <button className="btn ghost sm bad" onClick={onRemove}>删除节点</button>}</div>
      <label className="f">名字<input className="inp" value={n.title} disabled={readOnly} onChange={(e) => onChange((x) => ({ ...x, title: e.target.value }))} /></label>
      <div className="muted" style={{ fontSize: 12 }}>{ups.length ? `上游：${ups.join('、')}` : '没有上游'}</div>
      {n.kind === 'input' && (
        <label className="f">用表单里的哪一格
          <select className="inp" value={n.config.key} disabled={readOnly} onChange={(e) => cfg('input', { key: e.target.value })}>
            <option value="">（选一个）</option>
            {def.inputs.map((i) => <option key={i.key} value={i.key}>{i.label}（{i.key}）</option>)}
          </select>
        </label>
      )}
      {n.kind === 'search' && (
        <>
          <label className="f">查询词（一行一个，可以写 {'{{inputs.键}}'}）<textarea className="inp" rows={3} value={n.config.queries.join('\n')} disabled={readOnly} onChange={(e) => cfg('search', { queries: e.target.value.split('\n') })} /></label>
          <label className="f">或者从上游表格的这一列取查询词<input className="inp" value={n.config.queriesFrom ?? ''} disabled={readOnly} placeholder="列名，如 搜索词" onChange={(e) => cfg('search', { queriesFrom: e.target.value || undefined })} /></label>
          <div className="row">
            <label className="f">每个词取几条<input className="inp" type="number" min={1} max={20} value={n.config.limit ?? 8} disabled={readOnly} onChange={(e) => cfg('search', { limit: Number(e.target.value) || 8 })} /></label>
            <label className="f">时间范围<select className="inp" value={n.config.recency ?? 'any'} disabled={readOnly} onChange={(e) => cfg('search', { recency: e.target.value as 'any' })}><option value="day">一天内</option><option value="week">一周内</option><option value="month">一月内</option><option value="year">一年内</option><option value="any">不限</option></select></label>
          </div>
        </>
      )}
      {n.kind === 'agent' && (
        <>
          <label className="f">要它做什么（会自动附上表单输入和上游结果）<textarea className="inp" rows={7} value={n.config.instruction} disabled={readOnly} onChange={(e) => cfg('agent', { instruction: e.target.value })} /></label>
          <label className="f">要它输出<select className="inp" value={n.config.output} disabled={readOnly} onChange={(e) => cfg('agent', { output: e.target.value as 'text' | 'table' })}><option value="text">一段文字</option><option value="table">一张表（会要求它用 csv 代码块）</option></select></label>
          <div className="f">能用的工具
            <div className="row">{(Object.keys(TOOL_LABEL) as ToolName[]).filter((t) => t !== 'send_message').map((t) => (
              <label key={t} className={'chk' + (t === 'run_command' ? ' bad' : '')}><input type="checkbox" disabled={readOnly} checked={n.config.tools.includes(t)} onChange={(e) => cfg('agent', { tools: e.target.checked ? [...n.config.tools, t] : n.config.tools.filter((x) => x !== t) })} />{TOOL_LABEL[t]}</label>
            ))}</div>
            {n.config.tools.includes('run_command') && <div className="find warn" style={{ fontSize: 12 }}>跑命令的每一条仍要你批准；不是在做代码相关的事就别勾。</div>}
          </div>
          <label className="chk"><input type="checkbox" disabled={readOnly} checked={!!n.config.each} onChange={(e) => cfg('agent', { each: e.target.checked ? { rows: 50 } : undefined })} />对上游表格的每一批分别做（并行，再合并）</label>
          {n.config.each && (
            <div className="row">
              <label className="f">每批几行（可写 {'{{inputs.键}}'}）<input className="inp" value={String(n.config.each.rows)} disabled={readOnly} onChange={(e) => cfg('agent', { each: { ...n.config.each!, rows: /^\d+$/.test(e.target.value) ? Number(e.target.value) : e.target.value } })} /></label>
              <label className="f">切哪个上游<select className="inp" value={n.config.each.from ?? ''} disabled={readOnly} onChange={(e) => cfg('agent', { each: { ...n.config.each!, ...(e.target.value ? { from: e.target.value } : { from: undefined }) } })}><option value="">最大的那张表</option>{def.edges.filter((e) => e.to === n.id).map((e) => <option key={e.from} value={e.from}>{def.nodes.find((x) => x.id === e.from)?.title}</option>)}</select></label>
            </div>
          )}
          <label className="f">上游表格只给前几行（定口径时用，空着就是全部）<input className="inp" type="number" min={1} value={n.config.sample ?? ''} disabled={readOnly} onChange={(e) => cfg('agent', { sample: e.target.value ? Number(e.target.value) : undefined })} /></label>
          <div className="f">模型（空着跟项目默认）<ModelPicker st={st} value={n.config.model ?? null} emptyLabel="（跟项目默认）" onChange={(c) => cfg('agent', { model: c })} /></div>
        </>
      )}
      {n.kind === 'human' && (
        <>
          <label className="f">要你确认什么<textarea className="inp" rows={3} value={n.config.ask} disabled={readOnly} onChange={(e) => cfg('human', { ask: e.target.value })} /></label>
          <label className="chk"><input type="checkbox" disabled={readOnly} checked={!!n.config.pick} onChange={(e) => cfg('human', { pick: e.target.checked })} />上游是表格时让我勾选行，只把勾选的传给下游</label>
        </>
      )}
      {n.kind === 'export' && <label className="f">文件名（.md 或 .csv）<input className="inp" value={n.config.filename} disabled={readOnly} onChange={(e) => cfg('export', { filename: e.target.value })} /></label>}
    </div>
  );
}
