import { describe, it, expect } from 'vitest';
import { applyPlanOps, interpret } from './index.js';
import type { Step } from '../model/types.js';

const steps: Step[] = [
  { id: 's1', title: '数据库迁移：加 phone_verified_at', assignee: '@backend', state: 'wait' },
  { id: 's2', title: '短信发送与校验接口', assignee: '@backend', state: 'done' },
  { id: 's3', title: '登录页手机号表单', assignee: '@frontend', state: 'run' },
  { id: 's4', title: '端到端测试', assignee: '@qa', state: 'queue' },
  { id: 's5', title: '合并与变更说明', assignee: '@coord', state: 'queue' },
];
let n = 0;
const nid = () => `n${++n}`;

describe('applyPlanOps', () => {
  it('新增默认插在收尾步骤前面', () => {
    const r = applyPlanOps(steps, [{ op: 'add', title: '夜间回归' }], nid);
    expect(r.steps.map((s) => s.title).slice(-2)).toEqual(['夜间回归', '合并与变更说明']);
    expect(r.summary).toContain('新增');
  });
  it('移到最前会排在第一个没做完的位置', () => {
    const r = applyPlanOps(steps, [{ op: 'move', stepId: 's4', first: true }], nid);
    expect(r.steps[0]!.id).toBe('s4');
  });
  it('做完的步骤不能取消', () => {
    const r = applyPlanOps(steps, [{ op: 'cancel', stepId: 's2' }], nid);
    expect(r.steps.find((s) => s.id === 's2')!.state).toBe('done');
    expect(r.summary).toContain('不能取消');
  });
  it('找不到的步骤跳过不报错', () => {
    expect(applyPlanOps(steps, [{ op: 'cancel', stepId: 'zz' }], nid).summary).toContain('跳过');
  });
});

describe('interpret', () => {
  it('顺便……= 新增', () => {
    const r = interpret('顺便把夜间回归也跑一下', steps);
    expect(r.kind).toBe('add');
    if (r.kind === 'add') expect(r.ops[0]).toMatchObject({ op: 'add', title: '夜间回归' });
  });
  it('先做前端 = 调整顺序，命中登录页表单而不是合并', () => {
    const r = interpret('先做登录页表单', steps);
    expect(r).toMatchObject({ kind: 'reorder', ops: [{ op: 'move', stepId: 's3', first: true }] });
  });
  it('不用做端到端测试了 = 取消', () => {
    expect(interpret('不用做端到端测试了', steps)).toMatchObject({ kind: 'cancel', ops: [{ stepId: 's4' }] });
  });
  it('另开一个讨论串做埋点 = 拆分', () => {
    expect(interpret('另开一个讨论串做埋点', steps)).toEqual({ kind: 'split', title: '埋点' });
  });
  it('普通聊天', () => {
    expect(interpret('这个接口为什么要限流？', steps).kind).toBe('chat');
  });
});
