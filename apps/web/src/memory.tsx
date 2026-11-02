import { useEffect, useState } from 'react';
import { DESK_LIMIT, type State } from '@zhongshu/core';
import { send } from './api';
import { attempt, toast } from './toast';
import { time } from './ui';

const bytes = (s: string) => new TextEncoder().encode(s).length;

/** 项目记忆：桌面页（每次都带上）+ 记忆条目（按相关度挑着带） */
export function MemoryPanel({ st, projectId }: { st: State; projectId: string }) {
  const mem = st.memory[projectId] ?? { desk: '', entries: [] };
  const [desk, setDesk] = useState(mem.desk);
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setDesk(mem.desk), [mem.desk]);
  const n = bytes(desk);
  const list = [...mem.entries].reverse().filter((e) => !q || e.text.includes(q) || e.tags.some((t) => t.includes(q)));
  return (
    <div className="stack" style={{ padding: 10 }}>
      <div>
        <div className="row"><b>桌面页</b><span className="spacer" /><span className={'muted' + (n > DESK_LIMIT ? ' bad' : '')} style={{ fontSize: 12 }}>{n} / {DESK_LIMIT} 字节</span></div>
        <textarea className="inp" rows={4} value={desk} onChange={(e) => setDesk(e.target.value)} placeholder="项目里每次都该知道的事：技术栈、约定、别碰的地方" aria-label="桌面页" />
        {desk !== mem.desk && <div className="row" style={{ marginTop: 4 }}><button className="btn pri sm" disabled={n > DESK_LIMIT} onClick={() => attempt(send({ type: 'memory.desk', projectId, desk }), '存好了')}>保存桌面页</button><button className="btn sm" onClick={() => setDesk(mem.desk)}>还原</button></div>}
      </div>
      <div className="row">
        <b>记忆 {mem.entries.length}</b>
        <span className="muted" style={{ fontSize: 12 }}>{mem.consolidatedAt ? `上次整理 ${time(mem.consolidatedAt)}` : '还没整理过'}</span>
        <span className="spacer" />
        <button className="btn sm" disabled={busy || !mem.entries.length} onClick={async () => {
          setBusy(true);
          const r = await attempt(send<{ before: number; after: number; byModel: boolean }>({ type: 'memory.consolidate', projectId }));
          setBusy(false);
          if (r) toast(`整理完：${r.before} 条 → ${r.after} 条${r.byModel ? '' : '（没有可用模型，只去了重）'}`);
        }}>{busy ? '整理中…' : '现在整理'}</button>
      </div>
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (text.trim()) void attempt(send({ type: 'memory.add', projectId, text: text.trim() })).then(() => setText('')); }}>
        <input className="inp" style={{ flex: 1 }} value={text} onChange={(e) => setText(e.target.value)} placeholder="记一条：比如“部署走 fly.io”" aria-label="新记忆" />
        <button className="btn sm" disabled={!text.trim()}>记下</button>
      </form>
      {mem.entries.length > 6 && <input className="inp" value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜记忆" aria-label="搜记忆" />}
      <div className="list">
        {list.length === 0 && <div className="empty">还没有记忆。agent 和协调者觉得以后用得上的事会自己记下来。</div>}
        {list.map((e) => (
          <div key={e.id} className="it">
            <div style={{ flex: 1, minWidth: 0 }}>
              <div>{e.pinned && <span className="pill">置顶</span>} {e.text}</div>
              <div className="muted" style={{ fontSize: 12 }}>{e.by === 'user' ? '你' : e.by === 'coordinator' ? '协调者' : e.by === 'consolidate' ? '整理' : e.by} · {time(e.at)}{e.tags.length ? ` · ${e.tags.join('、')}` : ''}</div>
            </div>
            {!e.pinned && <button className="btn ghost sm" title="置顶：整理时不会被删改" onClick={() => attempt(send({ type: 'memory.add', projectId, text: e.text, tags: e.tags, pinned: true }).then(() => send({ type: 'memory.remove', projectId, entryId: e.id })))}>置顶</button>}
            <button className="btn ghost sm" aria-label="删掉这条" onClick={() => attempt(send({ type: 'memory.remove', projectId, entryId: e.id }))}>✕</button>
          </div>
        ))}
      </div>
    </div>
  );
}
