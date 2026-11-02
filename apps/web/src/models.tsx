import { useEffect, useState } from 'react';
import { PROVIDER_PRESETS, PURPOSES, effortLevels, newId, type ModelGroup, type ModelRef, type ModelSource, type State } from '@zhongshu/core';
import { send } from './api';
import { attempt, toast } from './toast';
import { Dialog } from './ui';

const KIND: Record<string, string> = { subscription: '订阅', plan: 'Coding Plan', apikey: 'API Key', local: '本地' };

function SourceDialog({ initial, open, onClose }: { initial: ModelSource | null; open: boolean; onClose: () => void }) {
  const [presetIdx, setPresetIdx] = useState(0);
  const [src, setSrc] = useState<ModelSource | null>(initial);
  const [secret, setSecret] = useState('');
  const [newModel, setNewModel] = useState('');
  useEffect(() => {
    setSrc(initial);
    setSecret('');
  }, [initial, open]);
  const fromPreset = (i: number) => {
    const p = PROVIDER_PRESETS[i]!;
    setPresetIdx(i);
    setSrc({ id: newId('src'), kind: p.kind, name: p.name, transport: p.transport, ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}), ...(p.multiVendor ? { multiVendor: true } : {}), models: p.models.map(([id, label, vendor]) => ({ id, label, vendor, enabled: true })) });
  };
  const s = src;
  const cli = s?.transport.startsWith('cli-');
  const save = async () => {
    if (!s) return;
    try {
      const { secretRef: _r, ...rest } = s;
      const source = { ...rest, ...(s.baseUrl?.trim() ? { baseUrl: s.baseUrl.trim() } : { baseUrl: undefined }) };
      await send({ type: 'source.save', source, ...(secret ? { secret } : {}) });
      toast('已保存');
      onClose();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title={initial ? '编辑模型来源' : '添加模型来源'} footer={<><button className="btn" onClick={onClose}>取消</button><button className="btn pri" disabled={!s || !s.name} onClick={save}>保存</button></>}>
      {!initial && (
        <label className="f">从常见服务开始
          <select className="inp" value={s ? presetIdx : ''} onChange={(e) => fromPreset(Number(e.target.value))}>
            <option value="" disabled>选一个…</option>
            {PROVIDER_PRESETS.map((p, i) => <option key={p.name} value={i}>{p.name}</option>)}
          </select>
        </label>
      )}
      {s && (
        <>
          {!initial && PROVIDER_PRESETS[presetIdx]?.note && <div className="find warn">{PROVIDER_PRESETS[presetIdx]!.note}</div>}
          <label className="f">名字<input className="inp" value={s.name} onChange={(e) => setSrc({ ...s, name: e.target.value })} /></label>
          {!cli && <label className="f">接口地址（以服务方文档为准）<input className="inp mono" value={s.baseUrl ?? ''} onChange={(e) => setSrc({ ...s, baseUrl: e.target.value })} /></label>}
          {!cli && s.kind !== 'local' && (
            <label className="f">密钥{s.secretRef ? '（已保存，留空不改）' : ''}
              <input className="inp mono" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={s.secretRef ? '••••••••' : '粘贴 API Key'} />
            </label>
          )}
          {cli && <div className="find">订阅账号不填密钥。先在终端里装好对应 CLI 并登录一次，中枢会调用它的无界面模式，用你的订阅额度。</div>}
          <div className="f">模型
            <div className="list">
              {s.models.map((m, i) => (
                <div key={m.id} className="it">
                  <label className="chk" style={{ flex: 1 }}><input type="checkbox" checked={m.enabled} onChange={(e) => setSrc({ ...s, models: s.models.map((x, j) => (j === i ? { ...x, enabled: e.target.checked } : x)) })} />{m.label} <span className="mono muted">{m.id}</span></label>
                  <span className="muted" style={{ fontSize: 12 }}>{effortLevels(`${m.id} ${m.label}`).join(' / ')}</span>
                  <button className="btn ghost sm" aria-label="删掉这个模型" onClick={() => setSrc({ ...s, models: s.models.filter((_, j) => j !== i) })}>✕</button>
                </div>
              ))}
              <form className="it" onSubmit={(e) => { e.preventDefault(); const id = newModel.trim(); if (id && !s.models.some((m) => m.id === id)) setSrc({ ...s, models: [...s.models, { id, label: id, vendor: '', enabled: true }] }); setNewModel(''); }}>
                <input className="inp mono" style={{ flex: 1 }} placeholder="手动加模型名，如 glm-5.3" value={newModel} onChange={(e) => setNewModel(e.target.value)} />
                <button className="btn sm">加</button>
              </form>
            </div>
          </div>
        </>
      )}
    </Dialog>
  );
}

function GroupEditor({ st, g, onDone }: { st: State; g: ModelGroup; onDone: () => void }) {
  const [grp, setGrp] = useState(g);
  const opts = Object.values(st.sources).flatMap((s) => s.models.filter((m) => m.enabled).map((m) => ({ v: `${s.id}|${m.id}`, l: `${s.name} · ${m.label}` })));
  const enc = (r: ModelRef | null) => (r ? `${r.sourceId}|${r.modelId}` : '');
  const dec = (v: string): ModelRef | null => (v ? { sourceId: v.split('|')[0]!, modelId: v.split('|').slice(1).join('|') } : null);
  const ensure = PURPOSES.filter((p) => !grp.roles.some((r) => r.purpose === p));
  const modelLabel = (r: ModelRef | null) => (r ? st.sources[r.sourceId]?.models.find((m) => m.id === r.modelId) : undefined);
  return (
    <div className="card stack">
      <div className="row"><input className="inp" value={grp.name} onChange={(e) => setGrp({ ...grp, name: e.target.value })} aria-label="分组名" /><span className="spacer" /><button className="btn" onClick={onDone}>收起</button><button className="btn pri" onClick={() => attempt(send({ type: 'group.save', group: grp }), '分组已保存')}>保存</button></div>
      <table className="t">
        <thead><tr><th>用途</th><th>模型</th><th>备用</th><th>强度</th><th /></tr></thead>
        <tbody>
          {grp.roles.map((r, i) => {
            const m = modelLabel(r.model);
            const lv = m ? effortLevels(`${m.id} ${m.label}`) : [];
            const set = (patch: Partial<typeof r>) => setGrp({ ...grp, roles: grp.roles.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
            return (
              <tr key={i}>
                <td>{r.purpose}</td>
                <td><select className="inp" value={enc(r.model)} onChange={(e) => set({ model: dec(e.target.value) })}><option value="">（无）</option>{opts.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}</select></td>
                <td><select className="inp" value={enc(r.backup)} onChange={(e) => set({ backup: dec(e.target.value) })}><option value="">（无）</option>{opts.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}</select></td>
                <td>{lv.length > 1 && <select className="inp" value={r.effort ?? ''} onChange={(e) => set({ effort: e.target.value })}><option value="">默认</option>{lv.map((l) => <option key={l}>{l}</option>)}</select>}</td>
                <td><button className="btn ghost sm" aria-label="删掉" onClick={() => setGrp({ ...grp, roles: grp.roles.filter((_, j) => j !== i) })}>✕</button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {ensure.length > 0 && <div className="row"><span className="muted">加用途：</span>{ensure.map((p) => <button key={p} className="btn sm" onClick={() => setGrp({ ...grp, roles: [...grp.roles, { purpose: p, model: null, backup: null }] })}>{p}</button>)}</div>}
    </div>
  );
}

export function ModelsPage({ st }: { st: State }) {
  const [edit, setEdit] = useState<ModelSource | null>(null);
  const [open, setOpen] = useState(false);
  const [grp, setGrp] = useState<string | null>(null);
  const sources = Object.values(st.sources);
  const test = async (s: ModelSource) => {
    toast(`在测试 ${s.name}…`);
    const r = await attempt(send<{ text: string; servedBy?: string }>({ type: 'source.test', sourceId: s.id }));
    if (r) toast(`${s.name}：${r.text}${r.servedBy ? `（${r.servedBy}）` : ''}`);
  };
  return (
    <div className="view">
      <h1>模型</h1>
      <p className="sub">接入你的订阅、Coding Plan、API Key 和本地模型。密钥加密存在本机，不会出现在界面、日志和留痕记录里。</p>
      <div className="row"><button className="btn pri" onClick={() => { setEdit(null); setOpen(true); }}>添加来源</button></div>
      <h2>来源</h2>
      {sources.length === 0 ? <div className="card empty">还没有来源</div> : (
        <div className="grid2">
          {sources.map((s) => (
            <div key={s.id} className="card stack">
              <div className="row"><b>{s.name}</b><span className="pill">{KIND[s.kind]}</span>{s.multiVendor && <span className="pill">多家模型</span>}</div>
              <div className="muted" style={{ fontSize: 12 }}>{s.transport.startsWith('cli-') ? `通过 ${s.transport.slice(4)} CLI 调用` : s.baseUrl}{!s.transport.startsWith('cli-') && s.kind !== 'local' && (s.secretRef ? ' · 已存密钥' : ' · 还没填密钥')}</div>
              <div style={{ fontSize: 12.5 }}>{s.models.filter((m) => m.enabled).map((m) => m.label).join('、') || '没有启用的模型'}</div>
              <div className="row">
                <button className="btn sm" onClick={() => test(s)}>测试连接</button>
                <button className="btn sm" onClick={() => { setEdit(s); setOpen(true); }}>编辑</button>
                <button className="btn bad sm" onClick={() => confirm(`删掉“${s.name}”和它的密钥？`) && attempt(send({ type: 'source.remove', sourceId: s.id }), '已删除')}>删除</button>
              </div>
            </div>
          ))}
        </div>
      )}
      <h2>分组</h2>
      <p className="muted" style={{ marginTop: 0 }}>按用途选模型：比如“协调”用 Opus 高强度，“执行”用 GLM，“审查”用另一家。讨论串和协调者可以直接选“某组的某个用途”，换模型只改这里。</p>
      <div className="stack">
        {Object.values(st.groups).map((g) => grp === g.id
          ? <GroupEditor key={g.id} st={st} g={g} onDone={() => setGrp(null)} />
          : (
            <div key={g.id} className="card row">
              <b>{g.name}</b>
              <span className="muted">{g.roles.map((r) => r.purpose).join('、')}</span>
              <span className="spacer" />
              <button className="btn sm" onClick={() => setGrp(g.id)}>编辑</button>
              <button className="btn bad sm" onClick={() => attempt(send({ type: 'group.remove', groupId: g.id }))}>删除</button>
            </div>
          ))}
        <div><button className="btn" onClick={() => { const g: ModelGroup = { id: newId('grp'), name: '新分组', roles: PURPOSES.slice(0, 4).map((p) => ({ purpose: p, model: null, backup: null })) }; void attempt(send({ type: 'group.save', group: g })).then(() => setGrp(g.id)); }}>新建分组</button></div>
      </div>
      <SourceDialog initial={edit} open={open} onClose={() => setOpen(false)} />
    </div>
  );
}
