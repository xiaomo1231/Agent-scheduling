import { describe, it, expect } from 'vitest';
import { FLOW_PRESETS, validateFlow, topoOrder, readyNodes, emptyRun, stepsForFlow, rejectTargets, renderTemplate, chunkRows, parseCsv, toCsv, extractTable, tableToMarkdown, runStatus } from './index.js';
import type { FlowDef } from './types.js';

const tiny: FlowDef = {
  id: 'flo_t', name: '测试', description: '', inputs: [{ key: 'k', label: 'K', kind: 'text' }],
  nodes: [
    { id: 'a', kind: 'agent', title: '想', x: 0, y: 0, config: { instruction: '做 {{inputs.k}}', tools: [], output: 'text' } },
    { id: 'h', kind: 'human', title: '看', x: 0, y: 0, config: { ask: '行吗' } },
    { id: 'e', kind: 'export', title: '出', x: 0, y: 0, config: { filename: 'x.md' } },
  ],
  edges: [{ from: 'a', to: 'h' }, { from: 'h', to: 'e' }],
};

describe('workflow 校验与排序', () => {
  it('四个内置预设都能通过校验', () => {
    for (const f of FLOW_PRESETS) expect(validateFlow(f), f.name).toEqual([]);
  });
  it('有环、断线、缺字段会被指出', () => {
    const bad: FlowDef = { ...tiny, edges: [...tiny.edges, { from: 'e', to: 'a' }, { from: 'zz', to: 'a' }] };
    const issues = validateFlow(bad);
    expect(issues.join('\n')).toMatch(/圈/);
    expect(issues.join('\n')).toMatch(/不存在/);
    expect(validateFlow({ ...tiny, nodes: [{ id: 'x', kind: 'input', title: '读', x: 0, y: 0, config: { key: 'nope' } }], edges: [] }).join('')).toMatch(/nope/);
  });
  it('拓扑排序与就绪节点', () => {
    expect(topoOrder(tiny)).toEqual(['a', 'h', 'e']);
    const run = emptyRun(tiny, { k: '1' }, 'd');
    expect(readyNodes(tiny, run).map((n) => n.id)).toEqual(['a']);
    run.nodes.a = { state: 'done' };
    expect(readyNodes(tiny, run).map((n) => n.id)).toEqual(['h']);
    expect(runStatus(run)).toBe('running');
    run.nodes.h = { state: 'wait' };
    expect(runStatus(run)).toBe('waiting');
  });
  it('步骤编号就是节点编号', () => {
    expect(stepsForFlow(tiny).map((s) => [s.id, s.assignee])).toEqual([['a', '@agent'], ['h', '你'], ['e', '中枢']]);
  });
  it('打回时找最近的上游模型节点并重置它的下游', () => {
    const data = FLOW_PRESETS.find((f) => f.id === 'flo_preset_batch_data')!;
    const r = rejectTargets(data, 'n_confirm')!;
    expect(r.rerun).toBe('n_spec');
    expect(r.reset).toContain('n_confirm');
    expect(r.reset).toContain('n_process');
    expect(r.reset).not.toContain('n_data');
  });
});

describe('模板与表格', () => {
  it('只替换认识的变量', () => {
    expect(renderTemplate('{{inputs.a}} 和 {{b}} 和 {{c}}', { a: '1', b: '2' })).toBe('1 和 2 和 {{c}}');
  });
  it('切批', () => {
    expect(chunkRows([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
  it('CSV 来回不丢引号、逗号、换行', () => {
    const rows = [{ a: 'x,y', b: '他说"好"', c: '两\n行' }, { a: '', b: '1', c: '2' }];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
    expect(parseCsv('﻿a,b\r\n1,2\r\n')).toEqual([{ a: '1', b: '2' }]);
  });
  it('从模型回答里抠表格', () => {
    expect(extractTable('好的：\n```csv\n选题,热度\n加班,高\n```\n完')).toEqual([{ 选题: '加班', 热度: '高' }]);
    expect(extractTable('| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |')).toEqual([{ a: '1', b: '2' }, { a: '3', b: '4' }]);
    expect(extractTable('没有表')).toBeNull();
    expect(tableToMarkdown([{ a: '1|2' }])).toContain('1\\|2');
  });
});
