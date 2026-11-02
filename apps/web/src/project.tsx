import { useState } from 'react';
import { LAYOUT_PRESETS, type ProjectSettings, type State } from '@zhongshu/core';
import { send } from './api';
import { attempt } from './toast';
import { Canvas } from './canvas';
import { Dialog, EffortPicker, ModelPicker } from './ui';

export function Home({ st, go }: { st: State; go: (p: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [preset, setPreset] = useState('claude');
  const [folder, setFolder] = useState('');
  const projects = Object.values(st.projects).filter((p) => !p.archived).sort((a, b) => b.createdAt - a.createdAt);
  const waiting = Object.values(st.approvals).filter((a) => a.state === 'pending').length;
  const create = async () => {
    const r = await attempt(send<{ projectId: string }>({ type: 'project.create', name: name.trim(), goal: goal.trim(), preset, ...(folder.trim() ? { folder: folder.trim() } : {}) }));
    if (r) {
      setOpen(false);
      setName(''); setGoal(''); setFolder('');
      go(`p/${r.projectId}`);
    }
  };
  return (
    <div className="view">
      <h1>首页</h1>
      <p className="sub">每个项目有一个协调者：你说要做什么，它开讨论串、排计划、派 agent 去做，需要你拍板时会停下来问。</p>
      <div className="row">
        <button className="btn pri" onClick={() => setOpen(true)}>新建项目</button>
        {Object.keys(st.sources).length === 0 && <span className="muted">还没有接模型。没有模型时协调者用规则调度，agent 无法真正执行。<a href="#/models">去接模型</a></span>}
        {waiting > 0 && <a href="#/security" className="pill wait">{waiting} 件事等你批准</a>}
      </div>
      <h2>项目</h2>
      {projects.length === 0 ? <div className="card empty">还没有项目</div> : (
        <div className="grid2">
          {projects.map((p) => {
            const ths = Object.values(st.threads).filter((t) => t.projectId === p.id && t.kind !== 'coord');
            const active = ths.filter((t) => !t.resolved).length;
            return (
              <a key={p.id} className="card" href={`#/p/${p.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
                <div className="row"><span style={{ width: 10, height: 10, borderRadius: 3, background: p.color }} /><b>{p.name}</b></div>
                <div className="muted" style={{ margin: '4px 0' }}>{p.goal || '没写目标'}</div>
                <div className="muted" style={{ fontSize: 12 }}>{active} 个进行中 · {ths.length - active} 个已解决</div>
              </a>
            );
          })}
        </div>
      )}
      <Dialog open={open} onClose={() => setOpen(false)} title="新建项目" footer={<><button className="btn" onClick={() => setOpen(false)}>取消</button><button className="btn pri" disabled={!name.trim()} onClick={create}>创建</button></>}>
        <label className="f">名字<input className="inp" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></label>
        <label className="f">目标（协调者会参考）<input className="inp" value={goal} onChange={(e) => setGoal(e.target.value)} /></label>
        <label className="f">工作目录（agent 只能在这里读写；空着就用中枢的数据目录）<input className="inp mono" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="/Users/你/code/项目" /></label>
        <label className="f">布局<select className="inp" value={preset} onChange={(e) => setPreset(e.target.value)}>{Object.entries(LAYOUT_PRESETS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></label>
      </Dialog>
    </div>
  );
}

function ProjectSettingsDialog({ st, projectId, open, onClose }: { st: State; projectId: string; open: boolean; onClose: () => void }) {
  const p = st.projects[projectId]!;
  const s = p.settings;
  const save = (patch: Partial<ProjectSettings> & Record<string, unknown>) => attempt(send({ type: 'project.update', projectId, patch: { settings: patch } }));
  const dual = s.coordinator.dual ?? { enabled: false, mode: 'review' as const, model: null };
  const [instr, setInstr] = useState(s.instructions);
  return (
    <Dialog open={open} onClose={onClose} title="项目设置" footer={<button className="btn pri" onClick={onClose}>好了</button>}>
      <h2 style={{ margin: 0 }}>协调者</h2>
      <div className="row">
        <ModelPicker st={st} value={s.coordinator.model} emptyLabel="规则模式（不用模型）" onChange={(c) => save({ coordinator: { ...s.coordinator, model: c } })} />
        <EffortPicker st={st} choice={s.coordinator.model} value={s.coordinator.effort} onChange={(v) => save({ coordinator: { ...s.coordinator, effort: v } })} />
      </div>
      <p className="muted" style={{ margin: 0 }}>订阅账号（Claude Pro/Max、ChatGPT 等）当协调者时通过官方 CLI 调用，每条消息问一次；API 和 Coding Plan 可以多轮调工具。</p>
      <label className="chk"><input type="checkbox" checked={dual.enabled} onChange={(e) => save({ coordinator: { ...s.coordinator, dual: { ...dual, enabled: e.target.checked } } })} />双脑</label>
      {dual.enabled && (
        <div className="row">
          <select className="inp" value={dual.mode} onChange={(e) => save({ coordinator: { ...s.coordinator, dual: { ...dual, mode: e.target.value as 'review' | 'backup' } } })}>
            <option value="review">副脑复核：主脑改计划前，副脑看一眼，有意见会说</option>
            <option value="backup">备用接手：主脑出错或额度用完时，副脑接着干</option>
          </select>
          <ModelPicker st={st} value={dual.model} emptyLabel="选副脑模型" onChange={(c) => save({ coordinator: { ...s.coordinator, dual: { ...dual, model: c } } })} />
        </div>
      )}
      <h2 style={{ margin: 0 }}>讨论串默认执行模型</h2>
      <div className="row">
        <ModelPicker st={st} value={s.threadDefault.model} emptyLabel="（不指定）" onChange={(c) => save({ threadDefault: { ...s.threadDefault, model: c } })} />
        <EffortPicker st={st} choice={s.threadDefault.model} value={s.threadDefault.effort} onChange={(v) => save({ threadDefault: { ...s.threadDefault, effort: v } })} />
      </div>
      <h2 style={{ margin: 0 }}>解决</h2>
      <label className="chk"><input type="checkbox" checked={s.autoResolve} onChange={(e) => save({ autoResolve: e.target.checked })} />计划都做完、没有待批准、不用等你回答时，协调者自动把讨论串放到已解决</label>
      <h2 style={{ margin: 0 }}>项目说明</h2>
      <textarea className="inp" rows={5} value={instr} onChange={(e) => setInstr(e.target.value)} onBlur={() => instr !== s.instructions && save({ instructions: instr })} placeholder="比如：用 pnpm；提交前跑测试；代码风格看 CONTRIBUTING.md" />
      <h2 style={{ margin: 0 }}>危险操作</h2>
      <div className="row">
        <button className="btn" onClick={() => attempt(send({ type: 'project.update', projectId, patch: { archived: true } }), '已归档').then(onClose)}>归档项目</button>
        <button className="btn bad" onClick={() => { if (confirm(`删除“${p.name}”？讨论串都会消失（留痕记录里还在）。`)) void attempt(send({ type: 'project.delete', projectId }), '已删除').then(() => { onClose(); location.hash = '#/'; }); }}>删除项目</button>
      </div>
    </Dialog>
  );
}

export function ProjectPage({ st, projectId, thread, go }: { st: State; projectId: string; thread: string | null; go: (p: string) => void }) {
  const [open, setOpen] = useState(false);
  const p = st.projects[projectId];
  if (!p) return <div className="view"><div className="empty">找不到这个项目。<a href="#/">回首页</a></div></div>;
  return (
    <div className="view full">
      <Canvas
        st={st} projectId={projectId} thread={thread} openThread={(id) => go(id ? `p/${projectId}/${id}` : `p/${projectId}`)}
        head={<>
          <span style={{ width: 12, height: 12, borderRadius: 3, background: p.color }} />
          <h1>{p.name}</h1>
          <span className="muted">{p.goal}</span>
          <span className="spacer" />
          <button className="btn" onClick={() => setOpen(true)}>项目设置</button>
        </>}
      />
      <ProjectSettingsDialog st={st} projectId={projectId} open={open} onClose={() => setOpen(false)} />
    </div>
  );
}
