import { describe, it, expect } from 'vitest';
import { clipBytes, memoryPrompt, searchMemory, terms } from './memory.js';
import { emptyState, reduce } from '../state/reduce.js';
import type { EventBody, ZEvent } from '../events/types.js';

const ev = (seq: number, body: EventBody): ZEvent => ({ seq, ts: seq, actor: { kind: 'user', id: 'me' }, prevHash: '', hash: String(seq), body });

describe('记忆', () => {
  it('截断不切坏汉字', () => {
    expect(clipBytes('你好世界', 7)).toBe('你好');
    expect(clipBytes('abc', 10)).toBe('abc');
  });
  it('中文按两字切词', () => {
    expect(terms('部署脚本')).toEqual(expect.arrayContaining(['部署', '署脚', '脚本']));
  });
  it('按相关度挑条目，置顶的总在', () => {
    const e = (id: string, text: string, pinned = false) => ({ id, text, tags: [], by: 'a', at: 1, pinned });
    const r = searchMemory([e('1', '部署用 fly.io'), e('2', '颜色用暖色'), e('3', '密钥不要提交', true)], '怎么部署', 2);
    expect(r.map((x) => x.id)).toEqual(['3', '1']);
    expect(searchMemory([e('1', 'a'), e('2', 'b')], '无关').length).toBe(2);
  });
  it('提示词段标为参考', () => {
    expect(memoryPrompt(undefined, 'x')).toBe('');
    expect(memoryPrompt({ desk: '用 pnpm', entries: [] }, 'x')).toContain('<project-memory');
  });
  it('reducer：桌面页、条目、整理', () => {
    let s = emptyState();
    s = reduce(s, ev(1, { type: 'memory.desk', projectId: 'p', desk: 'd' }));
    s = reduce(s, ev(2, { type: 'memory.added', projectId: 'p', entry: { id: 'm1', text: 't', tags: [], by: 'a', at: 1 } }));
    expect(s.memory.p!.entries).toHaveLength(1);
    s = reduce(s, ev(3, { type: 'memory.consolidated', projectId: 'p', desk: 'd2', entries: [] }));
    expect(s.memory.p).toEqual({ desk: 'd2', entries: [], consolidatedAt: 3 });
  });
  it('reducer：用量累加、额度等待', () => {
    let s = emptyState();
    const u = { type: 'usage.recorded' as const, day: '2026-11-02', projectId: 'p', sourceId: 's', model: 'm', input: 10, output: 5 };
    s = reduce(reduce(s, ev(1, u)), ev(2, u));
    expect(Object.values(s.usage)[0]).toMatchObject({ calls: 2, input: 20, output: 10 });
    s = reduce(s, ev(3, { type: 'source.quota', sourceId: 's', until: 99, reason: '429' }));
    expect(s.quota.s!.until).toBe(99);
    s = reduce(s, ev(4, { type: 'source.quota', sourceId: 's', until: null }));
    expect(s.quota).toEqual({});
  });
});
