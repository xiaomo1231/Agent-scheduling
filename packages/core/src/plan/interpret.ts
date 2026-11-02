import type { Step } from '../model/types.js';
import type { PlanOp } from './ops.js';

/** 用户在讨论串里追加一句话时，判断它想怎么改计划。没有模型时的兜底，也给模型当提示。 */
export type Intent =
  | { kind: 'add'; ops: PlanOp[] }
  | { kind: 'reorder'; ops: PlanOp[] }
  | { kind: 'cancel'; ops: PlanOp[] }
  | { kind: 'split'; title: string }
  | { kind: 'chat' };

function bigrams(s: string): Set<string> {
  const t = s.replace(/\s+/g, '');
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

/** 找和这句话最像的步骤（按两字组重合度），不像就返回 null。 */
export function matchStep(text: string, steps: readonly Step[], opts: { skip?: RegExp } = {}): Step | null {
  const q = bigrams(text);
  let best: Step | null = null;
  let score = 0;
  for (const s of steps) {
    if (s.state === 'done' || s.state === 'cancelled') continue;
    if (opts.skip && opts.skip.test(s.title)) continue;
    const b = bigrams(s.title);
    let n = 0;
    for (const x of b) if (q.has(x)) n++;
    if (n > score) { score = n; best = s; }
  }
  return score >= 1 ? best : null;
}

const strip = (s: string) => s.replace(/^[，,。.\s]+|[，,。.!！?？\s]+$/g, '');

export function interpret(text: string, steps: readonly Step[]): Intent {
  const t = text.trim();
  let m = t.match(/^(另开|单独开|新开)(一个)?(讨论串|线程)?(来)?(做|搞|处理)?(.+)$/);
  if (m) return { kind: 'split', title: strip(m[6] ?? '') || '新讨论串' };

  m = t.match(/(不用|不要|取消|别)(做|再做|搞)?了?(.+?)(了|吧)?$/);
  if (m && /不用|不要|取消|别/.test(t.slice(0, 4))) {
    const s = matchStep(m[3] ?? t, steps);
    if (s) return { kind: 'cancel', ops: [{ op: 'cancel', stepId: s.id }] };
  }

  m = t.match(/^先(做|搞|弄)?(.+)$/);
  if (m) {
    const s = matchStep(m[2] ?? '', steps, { skip: /合并|发布|变更说明/ });
    if (s) return { kind: 'reorder', ops: [{ op: 'move', stepId: s.id, first: true }] };
  }

  m = t.match(/^(顺便|另外|再|还要|加上|加一个|也)(把|帮我)?(.+?)(也)?(做|跑|加|弄)?(一下)?[。.!！]*$/);
  if (m) {
    const title = strip((m[3] ?? '') + (m[5] && !/也/.test(m[3] ?? '') ? '' : '')).replace(/也$/, '');
    if (title) return { kind: 'add', ops: [{ op: 'add', title }] };
  }
  return { kind: 'chat' };
}
