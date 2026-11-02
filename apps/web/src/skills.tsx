import { useState } from 'react';
import type { GenericSkill, ScanFinding, State } from '@zhongshu/core';
import { send } from './api';
import { attempt, toast } from './toast';
import { time } from './ui';

type Preview = { skill: GenericSkill; files: Record<string, string>; source: string; changes: string[]; todo: string[]; scan: ScanFinding[]; issues: string[]; agentRewrote: boolean };
const PLATFORMS = [['claude-code', 'Claude Code'], ['codex', 'Codex'], ['gemini-cli', 'Gemini CLI'], ['opencode', 'OpenCode'], ['openclaw', 'OpenClaw']] as const;
const SOURCE: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', 'gemini-cli': 'Gemini CLI', opencode: 'OpenCode', openclaw: 'OpenClaw', zhongshu: '中枢通用模板', unknown: '认不出来' };

async function readFolder(list: FileList): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const arr = [...list];
  const prefix = arr[0]?.webkitRelativePath.split('/')[0] ?? '';
  for (const f of arr) {
    if (f.size > 400_000) continue;
    const rel = f.webkitRelativePath ? f.webkitRelativePath.slice(prefix.length + 1) : f.name;
    if (!rel || rel.startsWith('.')) continue;
    out[rel] = await f.text();
  }
  return out;
}

export function SkillsPage({ st }: { st: State }) {
  const [md, setMd] = useState('');
  const [files, setFiles] = useState<Record<string, string> | null>(null);
  const [pv, setPv] = useState<Preview | null>(null);
  const [useAgent, setUseAgent] = useState(true);
  const [accept, setAccept] = useState(false);
  const [busy, setBusy] = useState(false);
  const input = () => files ?? (md.trim() ? { 'SKILL.md': md } : null);
  const preview = async () => {
    const f = input();
    if (!f) return;
    setBusy(true);
    const r = await attempt(send<Preview>({ type: 'skill.preview', files: f, useAgent }));
    setBusy(false);
    if (r) { setPv(r); setAccept(false); }
  };
  const install = async () => {
    if (!pv) return;
    const extra = Object.fromEntries(Object.entries(input() ?? {}).filter(([k]) => !k.endsWith('.md') && !(k in pv.files)));
    const r = await attempt(send({ type: 'skill.install', files: { ...pv.files, ...extra }, acceptRisks: accept }), '装好了');
    if (r) { setPv(null); setMd(''); setFiles(null); }
  };
  const high = pv?.scan.filter((f) => f.level === 'high').length ?? 0;
  return (
    <div className="view">
      <h1>Skills</h1>
      <p className="sub">所有 skill 先转成中枢的通用模板再装：SKILL.md 开放标准 + metadata.zhongshu（权限、依赖、通用工具名），然后投放到各个 agent 自己的目录。skill 只能申请权限，实际权限不会超过 agent 本身。</p>

      <h2>已安装</h2>
      <div className="list">
        {Object.values(st.skills).length === 0 && <div className="empty">还没装 skill</div>}
        {Object.values(st.skills).map((s) => (
          <div key={s.name} className="it" style={{ flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 220 }}>
              <b>{s.name}</b> <span className="muted">v{s.version} · 来自 {SOURCE[s.source] ?? s.source} · {time(s.installedAt)}</span>
              <div className="muted" style={{ fontSize: 12.5 }}>{s.description}</div>
              <div style={{ fontSize: 12 }}>权限：文件 {s.permissions.files}{s.permissions.shell.length ? ` · 命令 ${s.permissions.shell.join(' ')}` : ''}{s.permissions.network.length ? ` · 网络 ${s.permissions.network.join(' ')}` : ''}{s.permissions.sendMessage ? ' · 发消息' : ''}</div>
            </div>
            <button className="btn sm" onClick={async () => { const r = await attempt(send<{ ok: boolean; changed: string[] }>({ type: 'skill.verify', name: s.name })); if (r) toast(r.ok ? '没被改过' : `被改过：${r.changed.join('、')}`, !r.ok); }}>校验</button>
            <select className="inp" aria-label="投放到" value="" onChange={async (e) => { const pf = e.target.value; if (!pf) return; const r = await attempt(send<{ path: string }>({ type: 'skill.deploy', name: s.name, platform: pf })); if (r) toast(`已投放到 ${r.path}`); }}>
              <option value="">投放到…</option>
              {PLATFORMS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <button className="btn bad sm" onClick={() => confirm(`卸载 ${s.name}？`) && attempt(send({ type: 'skill.remove', name: s.name }), '已卸载')}>卸载</button>
          </div>
        ))}
      </div>

      <h2>安装新的</h2>
      <div className="card stack">
        <div className="row">
          <label className="btn">选文件夹<input type="file" hidden {...({ webkitdirectory: '', directory: '' } as Record<string, string>)} multiple onChange={async (e) => { if (e.target.files?.length) { const f = await readFolder(e.target.files); setFiles(f); setMd(f['SKILL.md'] ?? ''); toast(`读到 ${Object.keys(f).length} 个文件`); } }} /></label>
          <span className="muted">或者直接粘贴 SKILL.md：</span>
          {files && <span className="pill">{Object.keys(files).length} 个文件 <button className="btn ghost sm" onClick={() => setFiles(null)} aria-label="清掉文件夹">✕</button></span>}
        </div>
        <textarea className="inp mono" rows={8} value={md} onChange={(e) => { setMd(e.target.value); if (files) setFiles({ ...files, 'SKILL.md': e.target.value }); }} placeholder={'---\nname: my-skill\ndescription: …\n---\n正文'} />
        <div className="row">
          <label className="chk"><input type="checkbox" checked={useAgent} onChange={(e) => setUseAgent(e.target.checked)} />派转换 agent 改写平台专属的说法（不给它任何工具）</label>
          <span className="spacer" />
          <button className="btn pri" disabled={busy || !input()} onClick={preview}>{busy ? '转换中…' : '检查并转换'}</button>
        </div>
      </div>

      {pv && (
        <div className="card stack" style={{ marginTop: 12 }}>
          <div className="row"><b>{pv.skill.name || '（没有名字）'}</b><span className="pill">原格式：{SOURCE[pv.source] ?? pv.source}</span>{pv.agentRewrote && <span className="pill">转换 agent 改写过</span>}</div>
          <div className="muted">{pv.skill.description}</div>
          {pv.issues.map((i) => <div key={i} className="find danger">{i}</div>)}
          {pv.scan.map((f, i) => <div key={i} className={'find ' + f.level}><b>{f.level === 'high' ? '高风险' : f.level === 'medium' ? '注意' : '提示'}</b> {f.file}:{f.line} {f.message}</div>)}
          {pv.changes.length > 0 && <div><b>自动改了：</b><ul style={{ margin: '4px 0' }}>{pv.changes.map((c) => <li key={c}>{c}</li>)}</ul></div>}
          {pv.todo.length > 0 && <div><b>还需要留意：</b><ul style={{ margin: '4px 0' }}>{pv.todo.map((c) => <li key={c}>{c}</li>)}</ul></div>}
          <div>申请的权限：文件 {pv.skill.meta.permissions.files} · 命令 {pv.skill.meta.permissions.shell.join(' ') || '无'} · 网络 {pv.skill.meta.permissions.network.join(' ') || '无'}{pv.skill.meta.requires.bins.length ? ` · 需要装 ${pv.skill.meta.requires.bins.join('、')}` : ''}</div>
          <details><summary>转换后的 SKILL.md</summary><pre className="code">{pv.files['SKILL.md']}</pre></details>
          {high > 0 && <label className="chk"><input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} />我看过上面 {high} 处高风险内容，仍然要装</label>}
          <div className="row"><span className="spacer" /><button className="btn" onClick={() => setPv(null)}>不装了</button><button className="btn pri" disabled={pv.issues.length > 0 || (high > 0 && !accept)} onClick={install}>安装</button></div>
        </div>
      )}
    </div>
  );
}
