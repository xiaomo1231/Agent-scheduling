import type { Step } from '../model/types.js';

/** 协调者改计划用的操作。LLM 的工具调用和规则解析都产出这个。 */
export type PlanOp =
  | { op: 'add'; title: string; assignee?: string; after?: string; before?: string }
  | { op: 'move'; stepId: string; before?: string; after?: string; first?: boolean }
  | { op: 'cancel'; stepId: string }
  | { op: 'rename'; stepId: string; title: string }
  | { op: 'assign'; stepId: string; assignee: string }
  | { op: 'state'; stepId: string; state: Step['state'] };

export interface PlanChange {
  steps: Step[];
  /** 给人看的一句话说明，如“新增 T6 夜间回归；T4 移到最前” */
  summary: string;
  added: string[];
}

function label(steps: Step[], id: string): string {
  const i = steps.findIndex((s) => s.id === id);
  const s = steps[i];
  return s ? `T${i + 1} ${s.title}` : id;
}

/** 按顺序应用一串操作。找不到的步骤会被跳过并写进说明，不抛错。 */
export function applyPlanOps(steps: readonly Step[], ops: readonly PlanOp[], newStepId: () => string): PlanChange {
  let cur = steps.map((s) => ({ ...s }));
  const notes: string[] = [];
  const added: string[] = [];
  const idx = (id: string) => cur.findIndex((s) => s.id === id);
  for (const o of ops) {
    if (o.op === 'add') {
      const s: Step = { id: newStepId(), title: o.title.trim(), assignee: o.assignee ?? '待分配', state: 'queue' };
      let at = cur.length;
      if (o.after && idx(o.after) >= 0) at = idx(o.after) + 1;
      else if (o.before && idx(o.before) >= 0) at = idx(o.before);
      else {
        // 默认放在第一个“收尾”类步骤（合并、发布、说明）前面
        const tail = cur.findIndex((x) => x.state !== 'done' && /合并|发布|变更说明|上线/.test(x.title));
        if (tail >= 0) at = tail;
      }
      cur.splice(at, 0, s);
      added.push(s.id);
      notes.push(`新增“${s.title}”`);
      continue;
    }
    const i = idx(o.stepId);
    if (i < 0) { notes.push(`没找到步骤 ${o.stepId}，跳过`); continue; }
    const s = cur[i]!;
    switch (o.op) {
      case 'move': {
        const before = label(cur, s.id);
        cur.splice(i, 1);
        let at = cur.length;
        if (o.first) at = cur.findIndex((x) => x.state !== 'done');
        else if (o.before && idx(o.before) >= 0) at = idx(o.before);
        else if (o.after && idx(o.after) >= 0) at = idx(o.after) + 1;
        if (at < 0) at = cur.length;
        cur.splice(at, 0, s);
        notes.push(`${before} 调整到第 ${at + 1} 步`);
        break;
      }
      case 'cancel':
        if (s.state === 'done') { notes.push(`“${s.title}”已经做完，不能取消`); break; }
        cur[i] = { ...s, state: 'cancelled' };
        notes.push(`取消“${s.title}”`);
        break;
      case 'rename':
        cur[i] = { ...s, title: o.title };
        notes.push(`“${s.title}”改名为“${o.title}”`);
        break;
      case 'assign':
        cur[i] = { ...s, assignee: o.assignee };
        notes.push(`“${s.title}”交给 ${o.assignee}`);
        break;
      case 'state':
        cur[i] = { ...s, state: o.state };
        break;
    }
  }
  cur = cur.filter((s) => s.state !== 'cancelled' || steps.some((x) => x.id === s.id));
  return { steps: cur, summary: notes.join('；'), added };
}
