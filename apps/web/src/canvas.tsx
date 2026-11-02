import { useRef, useState, type PointerEvent as RPE, type ReactNode } from 'react';
import { GRID_COLS, GRID_ROWS, LAYOUT_PRESETS, MIN_H, MIN_W, WIDGET_KINDS, addWidget, newId, placeWidget, presetLayout, type State, type Widget } from '@zhongshu/core';
import { send } from './api';
import { attempt, toast } from './toast';
import { ActivityPanel, ApprovalsPanel, CoordPanel, ThreadList, ThreadView } from './threads';

type Drag = { id: string; mode: 'move' | 'resize'; sx: number; sy: number; orig: Widget; cw: number; ch: number };

/**
 * 项目画布：12 × 8 的格子，像 iOS 主屏幕一样调整。
 * 长按或点“调整布局”进入编辑：拖标题栏移动，拖右下角改大小，挡路的模块自动让位，放不下就对调。
 */
export function Canvas({ st, projectId, thread, openThread, head }: { st: State; projectId: string; thread: string | null; openThread: (id: string | null) => void; head?: ReactNode }) {
  const p = st.projects[projectId]!;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Widget[] | null>(null);
  const [ghost, setGhost] = useState<Widget | null>(null);
  const drag = useRef<Drag | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const press = useRef<ReturnType<typeof setTimeout> | null>(null);
  const layout = draft ?? p.layout;
  const hasThreadWidget = layout.some((w) => w.k === 'thread');

  const begin = () => {
    setDraft(p.layout.map((w) => ({ ...w })));
    setEditing(true);
  };
  const finish = async () => {
    if (draft) await attempt(send({ type: 'project.layout', projectId, layout: draft }), '布局已保存');
    setDraft(null);
    setEditing(false);
  };
  const cancel = () => {
    setDraft(null);
    setEditing(false);
  };

  const down = (e: RPE, w: Widget, mode: Drag['mode']) => {
    if (!editing || !box.current) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const r = box.current.getBoundingClientRect();
    drag.current = { id: w.id, mode, sx: e.clientX, sy: e.clientY, orig: { ...w }, cw: r.width / GRID_COLS, ch: r.height / GRID_ROWS };
  };
  const move = (e: RPE) => {
    const d = drag.current;
    if (!d) return;
    const dx = Math.round((e.clientX - d.sx) / d.cw), dy = Math.round((e.clientY - d.sy) / d.ch);
    const o = d.orig;
    const to = d.mode === 'move'
      ? { x: Math.max(0, Math.min(GRID_COLS - o.w, o.x + dx)), y: Math.max(0, Math.min(GRID_ROWS - o.h, o.y + dy)), w: o.w, h: o.h }
      : { x: o.x, y: o.y, w: Math.max(MIN_W, Math.min(GRID_COLS - o.x, o.w + dx)), h: Math.max(MIN_H, Math.min(GRID_ROWS - o.y, o.h + dy)) };
    setGhost({ ...o, ...to });
  };
  const up = () => {
    const d = drag.current;
    drag.current = null;
    if (!d || !ghost || !draft) return setGhost(null);
    const next = placeWidget(draft, d.id, { x: ghost.x, y: ghost.y, w: ghost.w, h: ghost.h });
    if (next) setDraft(next);
    else toast('那里放不下，换个位置或先缩小别的模块', true);
    setGhost(null);
  };

  const body = (w: Widget) => {
    switch (w.k) {
      case 'coord':
        return <CoordPanel st={st} projectId={projectId} onOpen={(id) => openThread(id)} />;
      case 'threads':
        if (thread && !hasThreadWidget && st.threads[thread]) return <ThreadView st={st} threadId={thread} onBack={() => openThread(null)} onOpen={openThread} />;
        return (<><header><b>讨论串</b></header><div className="body"><ThreadList st={st} projectId={projectId} selected={thread} onOpen={openThread} /></div></>);
      case 'thread':
        return thread && st.threads[thread]
          ? <ThreadView st={st} threadId={thread} onOpen={openThread} />
          : (<><header><b>当前讨论串</b></header><div className="body"><div className="empty">在讨论串列表里点一个</div></div></>);
      case 'approvals':
        return (<><header><b>待批准</b></header><div className="body"><ApprovalsPanel st={st} projectId={projectId} /></div></>);
      case 'activity':
        return (<><header><b>动态</b></header><div className="body"><ActivityPanel st={st} projectId={projectId} onOpen={openThread} /></div></>);
      default:
        return (<><header><b>{w.k}</b></header><div className="body"><div className="empty">这个模块还没接上，可以在调整布局时移除</div></div></>);
    }
  };

  const missing = Object.entries(WIDGET_KINDS).filter(([k]) => !layout.some((w) => w.k === k));

  return (
    <>
      <div className="row" style={{ marginBottom: 10 }}>
        {editing ? (
          <>
            <b>调整布局</b>
            <span className="muted">拖标题栏移动，拖右下角改大小</span>
            <span className="spacer" />
            <select className="inp" aria-label="套用预设" value="" onChange={(e) => e.target.value && setDraft(presetLayout(e.target.value, () => newId('wdg')))}>
              <option value="">套用预设…</option>
              {Object.entries(LAYOUT_PRESETS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
            <button className="btn" onClick={cancel}>取消</button>
            <button className="btn pri" onClick={finish}>完成</button>
          </>
        ) : (
          <>
            {head}
            {!head && <span className="spacer" />}
            <button className="btn" onClick={begin}>调整布局</button>
          </>
        )}
      </div>
      {editing && missing.length > 0 && (
        <div className="gallery">
          <span className="muted">添加：</span>
          {missing.map(([k, v]) => (
            <button key={k} className="btn sm" onClick={() => {
              const next = addWidget(draft ?? [], { id: newId('wdg'), k, w: v.w, h: v.h });
              if (next) setDraft(next);
              else toast('画布满了，先缩小或移除一个模块', true);
            }}>+ {v.label}</button>
          ))}
        </div>
      )}
      <div ref={box} className={'canvas' + (editing ? ' editing' : '')} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        {layout.map((w) => (
          <section
            key={w.id}
            className="w"
            aria-label={WIDGET_KINDS[w.k]?.label ?? w.k}
            style={{ gridColumn: `${w.x + 1} / span ${w.w}`, gridRow: `${w.y + 1} / span ${w.h}`, opacity: ghost?.id === w.id ? 0.4 : 1 }}
            onPointerDown={(e) => {
              if (editing) return down(e, w, 'move');
              if (e.pointerType === 'touch' && (e.target as HTMLElement).closest('header')) press.current = setTimeout(begin, 550);
            }}
            onPointerUp={() => press.current && clearTimeout(press.current)}
            onPointerLeave={() => press.current && clearTimeout(press.current)}
          >
            {body(w)}
            {editing && (
              <>
                <button className="x" aria-label={`移除${WIDGET_KINDS[w.k]?.label ?? ''}`} onPointerDown={(e) => e.stopPropagation()} onClick={() => setDraft((draft ?? []).filter((x) => x.id !== w.id))}>×</button>
                <span className="rs" aria-hidden onPointerDown={(e) => down(e, w, 'resize')} />
              </>
            )}
          </section>
        ))}
        {ghost && <div className="dropg" style={{ gridColumn: `${ghost.x + 1} / span ${ghost.w}`, gridRow: `${ghost.y + 1} / span ${ghost.h}` }} />}
      </div>
    </>
  );
}
