import { useEffect, useRef, type ReactNode } from 'react';
import { choiceLabel, effortLevels, resolveChoice, type ModelChoice, type State } from '@zhongshu/core';

export function Dialog(props: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (props.open && !d.open) d.showModal();
    if (!props.open && d.open) d.close();
  }, [props.open]);
  return (
    <dialog ref={ref} onClose={props.onClose} onCancel={props.onClose}>
      <div className="dh">
        <b>{props.title}</b>
        <span className="spacer" />
        <button className="btn ghost" onClick={props.onClose} aria-label="关闭">✕</button>
      </div>
      <div className="db">{props.children}</div>
      {props.footer && <div className="df">{props.footer}</div>}
    </dialog>
  );
}

const enc = (c: ModelChoice | null) => (!c ? '' : c.kind === 'model' ? `m|${c.ref.sourceId}|${c.ref.modelId}` : `g|${c.groupId}|${c.purpose}`);
const dec = (s: string): ModelChoice | null => {
  if (!s) return null;
  const [k, a, b] = s.split('|');
  return k === 'm' ? { kind: 'model', ref: { sourceId: a!, modelId: b! } } : { kind: 'group', groupId: a!, purpose: b! };
};

/** 选模型：可以选具体模型，也可以选“某组的某个用途” */
export function ModelPicker(props: { st: State; value: ModelChoice | null; onChange: (c: ModelChoice | null) => void; emptyLabel?: string; id?: string }) {
  const { st } = props;
  return (
    <select className="inp" id={props.id} value={enc(props.value)} onChange={(e) => props.onChange(dec(e.target.value))}>
      <option value="">{props.emptyLabel ?? '（不指定）'}</option>
      {Object.values(st.groups).map((g) => (
        <optgroup key={g.id} label={`分组：${g.name}`}>
          {g.roles.map((r) => (
            <option key={r.purpose} value={enc({ kind: 'group', groupId: g.id, purpose: r.purpose })}>{`${g.name} · ${r.purpose}`}</option>
          ))}
        </optgroup>
      ))}
      {Object.values(st.sources).map((s) => (
        <optgroup key={s.id} label={s.name}>
          {s.models.filter((m) => m.enabled).map((m) => (
            <option key={m.id} value={enc({ kind: 'model', ref: { sourceId: s.id, modelId: m.id } })}>{m.label}</option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

/** 思考强度挡位跟着模型走 */
export function EffortPicker(props: { st: State; choice: ModelChoice | null; value: string | undefined; onChange: (v: string) => void }) {
  const r = resolveChoice(props.choice, props.st.sources, props.st.groups);
  const levels = r ? effortLevels(`${r.model.id} ${r.model.label}`) : ['默认'];
  if (levels.length <= 1) return null;
  return (
    <select className="inp" aria-label="思考强度" value={props.value && levels.includes(props.value) ? props.value : levels.includes('高') ? '高' : levels[0]} onChange={(e) => props.onChange(e.target.value)}>
      {levels.map((l) => <option key={l}>{l}</option>)}
    </select>
  );
}

export const label = (st: State, c: ModelChoice | null) => choiceLabel(c, st.sources, st.groups);

export function time(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const hm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === now.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

export const STATUS_TEXT: Record<string, string> = { waiting: '等你', running: '进行中', idle: '空闲', resolved: '已解决', queue: '排队', run: '进行中', wait: '卡住', done: '完成', cancelled: '已取消' };
