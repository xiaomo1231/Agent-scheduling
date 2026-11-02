import { useState } from 'react';
import { REVIEW_PRESETS, type ModelChoice, type State } from '@zhongshu/core';
import { send } from './api';
import { attempt } from './toast';
import { Dialog, ModelPicker } from './ui';

/** 开一次群评审 */
export function ReviewDialog({ st, projectId, open, onClose, onOpen }: { st: State; projectId: string; open: boolean; onClose: () => void; onOpen: (id: string) => void }) {
  const [q, setQ] = useState('');
  const [preset, setPreset] = useState('design');
  const [rounds, setRounds] = useState(2);
  const [decider, setDecider] = useState<ModelChoice | null>(null);
  const p = REVIEW_PRESETS.find((x) => x.id === preset)!;
  const start = async () => {
    const r = await attempt(send<{ threadId: string }>({ type: 'review.start', projectId, question: q.trim(), preset, rounds, decider }), '评审开始了');
    if (r) {
      setQ('');
      onClose();
      onOpen(r.threadId);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="群评审" footer={<><button className="btn" onClick={onClose}>取消</button><button className="btn pri" disabled={!q.trim()} onClick={start}>开始</button></>}>
      <p className="muted" style={{ margin: 0 }}>几个角色轮流发言，其中一个专门唱反调；最后由拍板的模型给结论。需要至少一个 API 或本地模型。</p>
      <label className="f">要评审什么（带上背景）<textarea className="inp" rows={4} value={q} onChange={(e) => setQ(e.target.value)} autoFocus /></label>
      <label className="f">班子
        <select className="inp" value={preset} onChange={(e) => setPreset(e.target.value)}>
          {REVIEW_PRESETS.map((x) => <option key={x.id} value={x.id}>{x.name}：{x.hint}</option>)}
        </select>
      </label>
      <div className="muted" style={{ fontSize: 12 }}>{p.roles.map((r) => `${r.devil ? '😈 ' : ''}${r.name}`).join(' · ')}</div>
      <div className="row">
        <label className="f" style={{ flex: 1 }}>讨论几轮<select className="inp" value={rounds} onChange={(e) => setRounds(Number(e.target.value))}>{[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n} 轮</option>)}</select></label>
        <label className="f" style={{ flex: 2 }}>拍板模型<ModelPicker st={st} value={decider} onChange={setDecider} emptyLabel="（用协调者模型）" /></label>
      </div>
    </Dialog>
  );
}
