import { useEffect, useState } from 'react';
import { newId, type CommandMode, type Finding, type Policy, type State, type ZEvent } from '@zhongshu/core';
import { get, send } from './api';
import { attempt } from './toast';
import { ApprovalsPanel } from './threads';
import { time } from './ui';

const MODES: [CommandMode, string][] = [
  ['ask', '白名单直接跑，其余问我（推荐）'],
  ['allowlist', '只跑白名单，其余直接拒绝'],
  ['review', '白名单直接跑，其余先让审查模型看，拿不准再问我'],
  ['deny', '不允许执行任何命令'],
  ['dangerouslyAllowAll', '全部放行（危险）'],
];
const RISK: [keyof Policy['highRisk'], string][] = [
  ['deleteFiles', '删除文件'], ['database', '改数据库'], ['pushOrRelease', '推送代码 / 发布'], ['install', '安装依赖'], ['externalWrite', '往外发消息、写外部系统'],
];

export function SecurityPage({ st }: { st: State }) {
  const p = st.policy;
  const [audit, setAudit] = useState<Finding[] | null>(null);
  const [prog, setProg] = useState('');
  const [args, setArgs] = useState('');
  useEffect(() => {
    get<Finding[]>('/api/audit').then(setAudit).catch(() => setAudit([]));
  }, [st.lastSeq]);
  const set = (patch: Partial<Policy>) => attempt(send({ type: 'policy.set', policy: { ...p, ...patch } }), '已保存');
  return (
    <div className="view">
      <h1>权限与安全</h1>
      <p className="sub">默认就安全：agent 跑命令、写文件、联网、发消息都先过这里的规则；问你的事没人回应时按拒绝处理。放松安全的选项会在体检里标出来。</p>
      <div className="row">
        <button className={'stop' + (st.emergencyStop ? ' on' : '')} onClick={() => attempt(send({ type: 'system.emergencyStop', on: !st.emergencyStop }))}>{st.emergencyStop ? '已紧急停止，点这里恢复' : '紧急停止'}</button>
        <span className="muted">停下所有 agent，拒绝所有待批准的事</span>
      </div>

      <h2>待批准</h2>
      <div className="card" style={{ padding: 0 }}><ApprovalsPanel st={st} /></div>

      <h2>体检</h2>
      <div className="stack">
        {audit === null && <div className="muted">检查中…</div>}
        {audit?.length === 0 && <div className="find">没发现问题</div>}
        {audit?.map((f) => (
          <div key={f.id} className={'find ' + f.level}>
            <div className="row"><b>{f.title}</b><span className="spacer" />{f.fix && <button className="btn sm" onClick={() => attempt(send({ type: 'audit.fix', findingId: f.id }), '已修复')}>一键修复</button>}</div>
            <div className="muted">{f.detail}</div>
          </div>
        ))}
      </div>

      <h2>命令</h2>
      <div className="card stack">
        <label className="f">执行策略<select className="inp" value={p.commandMode} onChange={(e) => set({ commandMode: e.target.value as CommandMode })}>{MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        <label className="chk"><input type="checkbox" checked={p.strictInlineEval} onChange={(e) => set({ strictInlineEval: e.target.checked })} />python -c、node -e 这类内联代码一律问我</label>
        <div className="row">
          <label className="f">没人审批时<select className="inp" value={p.askFallback} onChange={(e) => set({ askFallback: e.target.value as Policy['askFallback'] })}><option value="deny">拒绝（推荐）</option><option value="allowlist">按白名单处理</option></select></label>
          <label className="f">等多久算没人审批（分钟）<input className="inp" type="number" min={1} max={1440} value={Math.round(p.approvalTimeoutSec / 60)} onChange={(e) => set({ approvalTimeoutSec: Math.max(1, Number(e.target.value)) * 60 })} /></label>
        </div>
        <div className="f">这些动作无论策略如何都要问我
          <div className="row">{RISK.map(([k, l]) => <label key={k} className="chk"><input type="checkbox" checked={p.highRisk[k] as boolean} onChange={(e) => set({ highRisk: { ...p.highRisk, [k]: e.target.checked } })} />{l}</label>)}</div>
        </div>
        <label className="chk"><input type="checkbox" checked={p.separateNetworkAndExec} onChange={(e) => set({ separateNetworkAndExec: e.target.checked })} />联网和执行分开（读过网页的 agent 不能直接跑命令）</label>
      </div>

      <h2>白名单</h2>
      <table className="t">
        <thead><tr><th>程序</th><th>参数（正则）</th><th>谁能用</th><th>来源</th><th /></tr></thead>
        <tbody>
          {p.allowlist.map((r) => (
            <tr key={r.id}>
              <td className="mono">{r.program}</td>
              <td className="mono" style={{ wordBreak: 'break-all' }}>{r.args ?? '任意'}</td>
              <td>{r.agents === '*' ? '所有 agent' : r.agents.join('、')}</td>
              <td className="muted">{{ default: '默认', always: '“以后都允许”', user: '你加的' }[r.source]}</td>
              <td><button className="btn ghost sm" aria-label="删掉这条" onClick={() => set({ allowlist: p.allowlist.filter((x) => x.id !== r.id) })}>✕</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <form className="row" style={{ marginTop: 8 }} onSubmit={(e) => { e.preventDefault(); if (!prog.trim()) return; void set({ allowlist: [...p.allowlist, { id: newId('rul'), program: prog.trim(), ...(args.trim() ? { args: args.trim() } : {}), agents: '*', source: 'user' }] }).then(() => { setProg(''); setArgs(''); }); }}>
        <input className="inp mono" placeholder="程序名，如 pnpm" value={prog} onChange={(e) => setProg(e.target.value)} aria-label="程序名" />
        <input className="inp mono" style={{ flex: 1 }} placeholder="参数正则，如 ^(test|lint)$（空着表示任意参数）" value={args} onChange={(e) => setArgs(e.target.value)} aria-label="参数正则" />
        <button className="btn">加一条</button>
      </form>
    </div>
  );
}

export function LogPage({ st }: { st: State }) {
  const [events, setEvents] = useState<ZEvent[]>([]);
  useEffect(() => {
    get<ZEvent[]>('/api/log?limit=300').then((e) => setEvents(e.reverse())).catch(() => {});
  }, [st.lastSeq]);
  return (
    <div className="view">
      <h1>留痕</h1>
      <p className="sub">每一件事都记成一条事件，前后用哈希串起来，改过一条就对不上。体检会自动校验整条链。这里显示最近 300 条。</p>
      <table className="t">
        <thead><tr><th>#</th><th>时间</th><th>谁</th><th>什么</th><th>哈希</th></tr></thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.seq}>
              <td className="mono">{e.seq}</td>
              <td className="mono">{time(e.ts)}</td>
              <td>{e.actor.kind === 'user' ? '你' : e.actor.kind === 'coordinator' ? '协调者' : e.actor.kind === 'agent' ? e.actor.id : '系统'}</td>
              <td className="mono">{e.body.type}</td>
              <td className="mono muted">{e.hash.slice(0, 10)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
