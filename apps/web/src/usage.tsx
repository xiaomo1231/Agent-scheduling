import { useState } from 'react';
import type { State } from '@zhongshu/core';
import { time } from './ui';

const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

export function UsagePage({ st }: { st: State }) {
  const [days, setDays] = useState(7);
  const [by, setBy] = useState<'model' | 'project' | 'day'>('model');
  const since = new Date(Date.now() - (days - 1) * 86400000);
  const from = `${since.getFullYear()}-${String(since.getMonth() + 1).padStart(2, '0')}-${String(since.getDate()).padStart(2, '0')}`;
  const rows = Object.values(st.usage).filter((r) => r.day >= from);
  const groups = new Map<string, { calls: number; input: number; output: number }>();
  for (const r of rows) {
    const k = by === 'day' ? r.day : by === 'project' ? (st.projects[r.projectId]?.name ?? (r.projectId ? '已删除的项目' : '（不属于项目：审查、整理等）')) : `${st.sources[r.sourceId]?.name ?? '已删除的来源'} · ${r.model}`;
    const g = groups.get(k) ?? { calls: 0, input: 0, output: 0 };
    g.calls += r.calls; g.input += r.input; g.output += r.output;
    groups.set(k, g);
  }
  const list = [...groups.entries()].sort((a, b) => (by === 'day' ? b[0].localeCompare(a[0]) : b[1].input + b[1].output - (a[1].input + a[1].output)));
  const total = list.reduce((s, [, g]) => ({ calls: s.calls + g.calls, input: s.input + g.input, output: s.output + g.output }), { calls: 0, input: 0, output: 0 });
  const max = Math.max(1, ...list.map(([, g]) => g.input + g.output));
  const waits = Object.values(st.quota);
  return (
    <div className="view">
      <h1>用量</h1>
      <p className="sub">每次通过 API 调模型都会记下 token 数。订阅账号走官方 CLI，用量在它们自己那边看。碰到额度上限时，项目设置里开了“额度恢复后自动继续”的会等着，恢复后接着干。</p>
      {waits.length > 0 && (
        <div className="card" style={{ borderColor: 'var(--warn)', background: 'var(--warn-soft)', marginBottom: 12 }}>
          {waits.map((w) => <div key={w.sourceId}><b>{st.sources[w.sourceId]?.name ?? w.sourceId}</b> 额度到上限，预计 {time(w.until)} 后自动继续。<span className="muted">{w.reason}</span></div>)}
        </div>
      )}
      <div className="row" style={{ marginBottom: 10 }}>
        <div className="tabs" role="tablist">
          {([['model', '按模型'], ['project', '按项目'], ['day', '按天']] as const).map(([k, l]) => <button key={k} role="tab" aria-selected={by === k} className={by === k ? 'on' : ''} onClick={() => setBy(k)}>{l}</button>)}
        </div>
        <select className="inp" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="时间范围">
          <option value={1}>今天</option><option value={7}>最近 7 天</option><option value={30}>最近 30 天</option><option value={3650}>全部</option>
        </select>
      </div>
      <div className="grid2" style={{ marginBottom: 12 }}>
        <div className="card"><div className="muted">调用</div><b style={{ fontSize: 22 }}>{fmt(total.calls)}</b></div>
        <div className="card"><div className="muted">输入 / 输出 token</div><b style={{ fontSize: 22 }}>{fmt(total.input)} / {fmt(total.output)}</b></div>
      </div>
      <div className="list">
        {list.length === 0 && <div className="empty">这段时间没有调用</div>}
        {list.map(([k, g]) => (
          <div key={k} className="it" style={{ flexWrap: 'wrap' }}>
            <span style={{ flex: '1 1 200px', minWidth: 0 }}>{k}</span>
            <span className="mono muted" style={{ fontSize: 12 }}>{g.calls} 次 · 入 {fmt(g.input)} · 出 {fmt(g.output)}</span>
            <span style={{ flexBasis: '100%', height: 4, background: 'var(--line-2)', borderRadius: 2 }}>
              <span style={{ display: 'block', height: 4, width: `${((g.input + g.output) / max) * 100}%`, background: 'var(--accent)', borderRadius: 2 }} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
