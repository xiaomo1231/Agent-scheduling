import type { Step } from '../model/types.js';
import { NODE_KINDS, type FlowDef, type FlowNode, type FlowRun, type RunNodeState } from './types.js';

/** 校验一张工作流：返回问题列表，空数组表示能跑 */
export function validateFlow(def: FlowDef): string[] {
  const issues: string[] = [];
  if (!def.name.trim()) issues.push('没有名字');
  if (!def.nodes.length) issues.push('一个节点都没有');
  const ids = new Set<string>();
  for (const n of def.nodes) {
    if (ids.has(n.id)) issues.push(`节点编号重复：${n.id}`);
    ids.add(n.id);
    if (!n.title.trim()) issues.push(`有个${NODE_KINDS[n.kind].label}节点没写名字`);
    switch (n.kind) {
      case 'input':
        if (!def.inputs.some((i) => i.key === n.config.key)) issues.push(`“${n.title}”引用的表单字段 ${n.config.key} 不存在`);
        break;
      case 'search':
        if (!n.config.queriesFrom && !n.config.queries.some((q) => q.trim())) issues.push(`“${n.title}”没有查询词`);
        break;
      case 'agent':
        if (!n.config.instruction.trim()) issues.push(`“${n.title}”没写要模型做什么`);
        if (n.config.each && (typeof n.config.each.rows === 'number' ? n.config.each.rows < 1 : !n.config.each.rows)) issues.push(`“${n.title}”的每批行数不对`);
        break;
      case 'human':
        if (!n.config.ask.trim()) issues.push(`“${n.title}”没写要确认什么`);
        break;
      case 'export':
        if (!/^[^/\\]+$/.test(n.config.filename.trim())) issues.push(`“${n.title}”的文件名不能带路径`);
        break;
    }
  }
  const keys = new Set<string>();
  for (const i of def.inputs) {
    if (!i.key.trim() || !i.label.trim()) issues.push('表单字段缺键名或标题');
    if (keys.has(i.key)) issues.push(`表单字段重复：${i.key}`);
    keys.add(i.key);
    if (i.kind === 'select' && !i.options?.length) issues.push(`“${i.label}”是下拉框但没有选项`);
  }
  for (const e of def.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) issues.push(`有条连线的一端不存在（${e.from} → ${e.to}）`);
    if (e.from === e.to) issues.push('节点不能连到自己');
  }
  if (!topoOrder(def)) issues.push('连线绕成了圈，去掉一条');
  for (const n of def.nodes) if (n.kind !== 'input' && !def.edges.some((e) => e.to === n.id) && n.kind !== 'search' && n.kind !== 'agent') issues.push(`“${n.title}”没有上游，不知道处理什么`);
  return issues;
}

export function upstreamOf(def: FlowDef, id: string): FlowNode[] {
  const from = def.edges.filter((e) => e.to === id).map((e) => e.from);
  return def.nodes.filter((n) => from.includes(n.id));
}

export function downstreamOf(def: FlowDef, id: string): FlowNode[] {
  const to = def.edges.filter((e) => e.from === id).map((e) => e.to);
  return def.nodes.filter((n) => to.includes(n.id));
}

/** 拓扑排序；有环返回 null。同一层按节点在数组里的顺序。 */
export function topoOrder(def: FlowDef): string[] | null {
  const indeg = new Map<string, number>(def.nodes.map((n) => [n.id, 0]));
  for (const e of def.edges) if (indeg.has(e.to) && indeg.has(e.from)) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  const out: string[] = [];
  const ready = def.nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const seen = new Set<string>();
  while (ready.length) {
    const id = ready.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    for (const e of def.edges.filter((x) => x.from === id)) {
      const d = (indeg.get(e.to) ?? 0) - 1;
      indeg.set(e.to, d);
      if (d === 0) ready.push(e.to);
    }
  }
  return out.length === def.nodes.length ? out : null;
}

/** 所有上游都 done 且自己还在排队的节点 */
export function readyNodes(def: FlowDef, run: FlowRun): FlowNode[] {
  return def.nodes.filter((n) => run.nodes[n.id]?.state === 'queue' && upstreamOf(def, n.id).every((u) => run.nodes[u.id]?.state === 'done'));
}

/** 整个运行到哪一步了 */
export function runStatus(run: FlowRun): 'running' | 'waiting' | 'failed' | 'done' {
  const states = Object.values(run.nodes).map((n) => n.state);
  if (states.some((s) => s === 'wait')) return 'waiting';
  if (states.some((s) => s === 'failed')) return 'failed';
  if (states.every((s) => s === 'done' || s === 'skipped')) return 'done';
  return 'running';
}

/** 把节点变成讨论串里的步骤，编号就是节点编号，这样界面不用改 */
export function stepsForFlow(def: FlowDef): Step[] {
  const order = topoOrder(def) ?? def.nodes.map((n) => n.id);
  const who: Record<FlowNode['kind'], string> = { input: '中枢', search: '搜索', agent: '@agent', human: '你', export: '中枢' };
  return order.map((id) => {
    const n = def.nodes.find((x) => x.id === id)!;
    return { id, title: n.title, assignee: who[n.kind], state: 'queue' as const };
  });
}

export function stepStateFor(s: RunNodeState): Step['state'] {
  return s === 'failed' ? 'wait' : s === 'skipped' ? 'cancelled' : s;
}

export function emptyRun(def: FlowDef, inputs: Record<string, string>, dir: string): FlowRun {
  return { flowId: def.id, flowName: def.name, inputs, dir, nodes: Object.fromEntries(def.nodes.map((n) => [n.id, { state: 'queue' as const }])), rejects: 0 };
}

/** 打回时要重跑哪些节点：最近的上游模型节点，以及它和这个人工节点之间的所有节点 */
export function rejectTargets(def: FlowDef, humanId: string): { rerun: string; reset: string[] } | null {
  // 往上游找第一个 agent
  const queue = [humanId];
  const seen = new Set<string>();
  let rerun: string | null = null;
  while (queue.length && !rerun) {
    const id = queue.shift()!;
    for (const u of upstreamOf(def, id)) {
      if (seen.has(u.id)) continue;
      seen.add(u.id);
      if (u.kind === 'agent') { rerun = u.id; break; }
      queue.push(u.id);
    }
  }
  if (!rerun) return null;
  // rerun 的所有下游（直到 humanId 以及更后面的）都要重置
  const reset = new Set<string>();
  const walk = (id: string) => { for (const d of downstreamOf(def, id)) if (!reset.has(d.id)) { reset.add(d.id); walk(d.id); } };
  walk(rerun);
  return { rerun, reset: [...reset] };
}
