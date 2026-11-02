import { useState } from 'react';
import { newId, type Channel, type ChannelKind, type State } from '@zhongshu/core';
import { send } from './api';
import { attempt } from './toast';
import { Dialog, time } from './ui';

const KIND: Record<ChannelKind, { name: string; secret: string; hint: string }> = {
  telegram: { name: 'Telegram', secret: 'Bot token', hint: '找 @BotFather 建一个机器人，把它给的 token 填进来。不需要公网地址：中枢自己去拉消息。可以收通知、点按钮批准、直接跟协调者说话。' },
  feishu: { name: '飞书', secret: 'Webhook 地址', hint: '群设置 → 群机器人 → 自定义机器人，复制 Webhook 地址。只能往群里发通知。' },
  dingtalk: { name: '钉钉', secret: 'Webhook 地址', hint: '群设置 → 智能群助手 → 自定义机器人。安全设置选“自定义关键词”并填“中枢”。只能发通知。' },
  wecom: { name: '企业微信', secret: 'Webhook 地址', hint: '群聊 → 添加群机器人，复制 Webhook 地址。只能发通知。' },
};

function Edit({ st, ch, onClose }: { st: State; ch: Channel | null; onClose: () => void }) {
  const [kind, setKind] = useState<ChannelKind>(ch?.kind ?? 'telegram');
  const [name, setName] = useState(ch?.name ?? '');
  const [secret, setSecret] = useState('');
  const [projectId, setProjectId] = useState(ch?.projectId ?? '');
  const [ap, setAp] = useState(ch?.notify.approvals ?? true);
  const [res, setRes] = useState(ch?.notify.results ?? true);
  const save = async () => {
    const channel = { id: ch?.id ?? newId('chn'), kind, name: name.trim() || KIND[kind].name, enabled: ch?.enabled ?? true, ...(projectId ? { projectId } : {}), notify: { approvals: ap, results: res } };
    const ok = await attempt(send({ type: 'channel.save', channel, ...(secret.trim() ? { secret: secret.trim() } : {}) }).then(() => true), '存好了');
    if (ok) onClose();
  };
  return (
    <Dialog open onClose={onClose} title={ch ? `编辑 ${ch.name}` : '加一个渠道'} footer={<><button className="btn" onClick={onClose}>取消</button><button className="btn pri" disabled={!ch && !secret.trim()} onClick={save}>保存</button></>}>
      {!ch && <label className="f">种类<select className="inp" value={kind} onChange={(e) => setKind(e.target.value as ChannelKind)}>{Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v.name}</option>)}</select></label>}
      <p className="muted" style={{ margin: 0 }}>{KIND[kind].hint}</p>
      <label className="f">名字<input className="inp" value={name} onChange={(e) => setName(e.target.value)} placeholder={KIND[kind].name} /></label>
      <label className="f">{KIND[kind].secret}{ch?.secretRef && '（已保存，留空不改）'}<input className="inp mono" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" /></label>
      <label className="f">只管哪个项目<select className="inp" value={projectId} onChange={(e) => setProjectId(e.target.value)}><option value="">全部项目</option>{Object.values(st.projects).filter((p) => !p.archived).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <label className="chk"><input type="checkbox" checked={ap} onChange={(e) => setAp(e.target.checked)} />有事要批准时通知{kind === 'telegram' ? '（带批准 / 拒绝按钮）' : ''}</label>
      <label className="chk"><input type="checkbox" checked={res} onChange={(e) => setRes(e.target.checked)} />讨论串做完时通知</label>
    </Dialog>
  );
}

export function ChannelsPage({ st }: { st: State }) {
  const [edit, setEdit] = useState<Channel | null | 'new'>(null);
  const [code, setCode] = useState<{ id: string; code: string } | null>(null);
  const list = Object.values(st.channels);
  const toggle = (c: Channel) => attempt(send({ type: 'channel.save', channel: { id: c.id, kind: c.kind, name: c.name, enabled: !c.enabled, ...(c.projectId ? { projectId: c.projectId } : {}), notify: c.notify } }));
  return (
    <div className="view">
      <h1>消息渠道</h1>
      <p className="sub">离开电脑时也能知道进展、批准操作。token 和 Webhook 地址加密存在本机，不进日志。</p>
      <div className="row" style={{ marginBottom: 12 }}><button className="btn pri" onClick={() => setEdit('new')}>加一个渠道</button></div>
      <div className="list">
        {list.length === 0 && <div className="empty">还没有渠道</div>}
        {list.map((c) => (
          <div key={c.id} className="it" style={{ flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 220px', minWidth: 0 }}>
              <b>{c.name}</b> <span className="muted">{KIND[c.kind].name}</span> {!c.enabled && <span className="pill">已停用</span>}
              <div className="muted" style={{ fontSize: 12 }}>
                {c.projectId ? st.projects[c.projectId]?.name ?? '项目已删' : '全部项目'}
                {c.kind === 'telegram' && (c.paired ? ` · 已配对 ${c.paired.name ?? c.paired.chatId}（${time(c.paired.at)}）` : ' · 还没配对')}
              </div>
              {code?.id === c.id && <div className="mcard ask">在 Telegram 里私聊你的机器人，发：<b className="mono">/pair {code.code}</b>（10 分钟内有效）</div>}
            </div>
            {c.kind === 'telegram' && (c.paired
              ? <button className="btn sm" onClick={() => { if (confirm('解除配对？之后这个聊天收不到通知，也不能批准。')) void attempt(send({ type: 'channel.unpair', channelId: c.id }), '已解除'); }}>解除配对</button>
              : <button className="btn sm pri" onClick={() => attempt(send<{ code: string }>({ type: 'channel.pair', channelId: c.id })).then((r) => r && setCode({ id: c.id, code: r.code }))}>配对</button>)}
            <button className="btn sm" onClick={() => attempt(send({ type: 'channel.test', channelId: c.id }), '发出去了，看看收到没')}>测试</button>
            <button className="btn sm" onClick={() => toggle(c)}>{c.enabled ? '停用' : '启用'}</button>
            <button className="btn sm" onClick={() => setEdit(c)}>编辑</button>
            <button className="btn sm bad" onClick={() => { if (confirm(`删掉“${c.name}”？`)) void attempt(send({ type: 'channel.remove', channelId: c.id }), '已删'); }}>删除</button>
          </div>
        ))}
      </div>
      {edit && <Edit st={st} ch={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </div>
  );
}
