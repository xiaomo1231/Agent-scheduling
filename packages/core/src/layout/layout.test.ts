import { describe, it, expect } from 'vitest';
import { placeWidget, addWidget, presetLayout, validateLayout } from './index.js';

let n = 0;
const nid = () => `w${++n}`;

describe('画布布局', () => {
  it('所有预设都合法', () => {
    for (const k of ['claude', 'stack', 'quad', 'workbench', 'three', 'threadsOnly']) expect(validateLayout(presetLayout(k, nid))).toEqual([]);
  });
  it('铺满时把左边拖到右边 = 对调', () => {
    const L = presetLayout('claude', nid);
    const coord = L.find((w) => w.k === 'coord')!;
    const r = placeWidget(L, coord.id, { x: 6, y: 0, w: 5, h: 8 })!;
    expect(r).not.toBeNull();
    expect(r.find((w) => w.k === 'threads')).toMatchObject({ x: 0, w: 5 });
    expect(r.find((w) => w.k === 'coord')).toMatchObject({ x: 5, w: 7 });
    expect(validateLayout(r)).toEqual([]);
  });
  it('缩小后能腾出空间加模块，挡路的会让位', () => {
    let L = presetLayout('claude', nid);
    const th = L.find((w) => w.k === 'threads')!;
    L = placeWidget(L, th.id, { x: 5, y: 0, w: 7, h: 5 })!;
    const added = addWidget(L, { id: 'x', k: 'm:term', w: 6, h: 4 })!;
    expect(added).not.toBeNull();
    expect(validateLayout(added)).toEqual([]);
  });
  it('超出画布返回 null', () => {
    const L = presetLayout('claude', nid);
    expect(placeWidget(L, L[0]!.id, { x: 10, y: 0, w: 5, h: 8 })).toBeNull();
  });
  it('同一种模块不能加两次', () => {
    expect(addWidget(presetLayout('claude', nid), { id: 'y', k: 'coord', w: 4, h: 3 })).toBeNull();
  });
});

describe('addWidget 挤位置', () => {
  it('画布满了时从最大的模块底部让出位置', () => {
    const full = presetLayout('claude', (() => { let i = 0; return () => `w${i++}`; })());
    const next = addWidget(full, { id: 'a', k: 'approvals', w: 4, h: 3 })!;
    expect(next).not.toBeNull();
    expect(validateLayout(next)).toEqual([]);
    expect(next.find((x) => x.k === 'approvals')).toBeTruthy();
  });
});
