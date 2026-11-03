import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../app/index.js';
import { MockProvider } from '../providers/index.js';

/** 像模型一样回答：定口径给一张规则表；按批处理时按输入行数回一张加了列的表；其余给文字 */
function brain() {
  return new MockProvider((req) => {
    const user = req.turns.find((t) => t.role === 'user');
    const text = user && user.role === 'user' ? user.text : '';
    if (/按已确认的口径处理/.test(text)) {
      const seg = text.split('### ').find((x) => x.startsWith('读取数据')) ?? '';
      const rows = seg.split('\n').filter((l) => /^\| /.test(l)).length - 2;
      return { text: '```csv\n评论,情感\n' + Array.from({ length: rows }, (_, i) => `第${i + 1}条,${i % 2 ? '负面' : '正面'}`).join('\n') + '\n```', toolCalls: [], stop: 'end' };
    }
    if (/定口径|处理口径/.test(text)) return { text: '```csv\n新增列,含义,取值规则,示例\n情感,正负面,含“差”为负面,负面\n```', toolCalls: [], stop: 'end' };
    if (/```csv 代码块/.test(text)) return { text: '```csv\n选题,热度\n加班文化,高\n```', toolCalls: [], stop: 'end' };
    return { text: `汇总：收到 ${text.length} 字的材料。`, toolCalls: [], stop: 'end' };
  });
}

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'zs-flow-'));
  const app = createApp({ dataDir, mockProvider: brain(), background: false, random: Math.random });
  const src = { id: 'src_mock', kind: 'apikey' as const, name: '模拟', transport: 'mock' as const, models: [{ id: 'm1', label: '模拟模型', vendor: 'mock', enabled: true }] };
  expect((await app.handle({ type: 'source.save', source: src, secret: 'x' })).ok).toBe(true);
  const r = await app.handle({ type: 'project.create', name: '测试', folder: join(dataDir, 'work') });
  const projectId = (r as { ok: true; result: { projectId: string } }).result.projectId;
  await app.handle({ type: 'project.update', projectId, patch: { settings: { threadDefault: { model: { kind: 'model', ref: { sourceId: 'src_mock', modelId: 'm1' } } } } } });
  return { app, projectId, dataDir };
}

describe('工作流执行器', () => {
  it('批量数据处理：定口径 → 等人确认 → 分批并行 → 汇总 → 导出', async () => {
    const { app, projectId, dataDir } = await setup();
    const csv = '评论\n' + Array.from({ length: 7 }, (_, i) => `这是第${i + 1}条评论${i % 2 ? '，差评' : ''}`).join('\n');
    const r = await app.handle({ type: 'flow.start', projectId, flowId: 'flo_preset_batch_data', inputs: { 数据: csv, 要做什么: '分正负面', 每批行数: '3' } });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const threadId = (r as { ok: true; result: { threadId: string } }).result.threadId;
    await app.flows.idle();
    let t = app.ws.current.threads[threadId]!;
    expect(t.kind).toBe('flow');
    expect(t.run!.nodes.n_data.state).toBe('done');
    expect(t.run!.nodes.n_spec.state).toBe('done');
    expect(t.run!.nodes.n_confirm.state).toBe('wait');
    expect(t.run!.nodes.n_process.state).toBe('queue'); // 另一个上游还没好
    expect(t.steps.find((s) => s.id === 'n_confirm')!.state).toBe('wait'); // 步骤跟着节点走
    // 先打回一次：口径节点重跑
    expect((await app.handle({ type: 'flow.decide', threadId, nodeId: 'n_confirm', approve: false })).ok).toBe(false); // 打回必须写意见
    expect((await app.handle({ type: 'flow.decide', threadId, nodeId: 'n_confirm', approve: false, note: '再加一列原因' })).ok).toBe(true);
    await app.flows.idle();
    t = app.ws.current.threads[threadId]!;
    expect(t.run!.rejects).toBe(1);
    expect(t.run!.nodes.n_spec.attempts).toBe(2);
    expect(t.run!.nodes.n_confirm.state).toBe('wait');
    // 通过
    expect((await app.handle({ type: 'flow.decide', threadId, nodeId: 'n_confirm', approve: true })).ok).toBe(true);
    await app.flows.idle();
    t = app.ws.current.threads[threadId]!;
    expect(Object.values(t.run!.nodes).every((n) => n.state === 'done')).toBe(true);
    expect(t.run!.nodes.n_process.output!.rows).toBe(7); // 3 批合并回 7 行
    expect(t.resolved?.reason).toBe('工作流跑完了');
    const dir = join(dataDir, 'work', t.run!.dir);
    expect(existsSync(join(dir, '结果.csv'))).toBe(true);
    expect(existsSync(join(dir, '汇总.md'))).toBe(true);
    expect(readFileSync(join(dir, '结果.csv'), 'utf8').split('\n')).toHaveLength(8);
    // 产出文件只能在运行目录里读
    expect((await app.readRunFile(threadId, '结果.csv')).content).toContain('情感');
    await expect(app.readRunFile(threadId, '../../x')).rejects.toThrow(/只能看/);
    app.close();
  });

  it('要搜索的工作流没配搜索服务时不让发起；模拟模式下能走通', async () => {
    const { app, projectId, dataDir } = await setup();
    const r = await app.handle({ type: 'flow.start', projectId, flowId: 'flo_preset_hot_video', inputs: { 赛道: '职场' } });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/搜索服务/);
    app.close();
    const sim = createApp({ dataDir, mockProvider: brain(), background: false, simulate: true });
    const r2 = await sim.handle({ type: 'flow.start', projectId, flowId: 'flo_preset_hot_video', inputs: { 赛道: '职场' } });
    expect(r2.ok, JSON.stringify(r2)).toBe(true);
    const threadId = (r2 as { ok: true; result: { threadId: string } }).result.threadId;
    await sim.flows.idle();
    const t = sim.ws.current.threads[threadId]!;
    expect(t.run!.nodes.n_search.output!.external).toBe(true);
    expect(t.run!.nodes.n_pick.state).toBe('wait');
    // 勾选行：模拟模型的表只有一行，勾第 0 行
    expect((await sim.handle({ type: 'flow.decide', threadId, nodeId: 'n_pick', approve: true, picked: [0] })).ok).toBe(true);
    await sim.flows.idle();
    expect(sim.ws.current.threads[threadId]!.run!.nodes.n_script.state).toBe('done');
    sim.close();
  });

  it('自建工作流要过校验，内置预设不能改', async () => {
    const { app } = await setup();
    const preset = app.flows.get('flo_preset_weekly')!;
    expect((await app.handle({ type: 'flow.save', flow: preset })).ok).toBe(false);
    const mine = { ...preset, id: 'flo_mine', builtin: undefined, edges: [...preset.edges, { from: 'n_out', to: 'n_material' }] };
    const bad = await app.handle({ type: 'flow.save', flow: mine });
    expect(bad.ok).toBe(false);
    expect((bad as { error: string }).error).toMatch(/圈/);
    const good = await app.handle({ type: 'flow.save', flow: { ...mine, edges: preset.edges } });
    expect(good.ok).toBe(true);
    expect(app.ws.current.flows.flo_mine?.name).toBe(preset.name);
    expect((await app.handle({ type: 'flow.remove', flowId: 'flo_mine' })).ok).toBe(true);
    expect(app.ws.current.flows.flo_mine).toBeUndefined();
    app.close();
  });
});
