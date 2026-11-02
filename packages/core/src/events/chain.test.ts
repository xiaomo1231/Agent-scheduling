import { describe, it, expect } from 'vitest';
import { makeEvent, verifyChain } from './chain.js';
import type { ZEvent } from './types.js';

const me = { kind: 'user' as const, id: 'me' };

function chain(n: number): ZEvent[] {
  const out: ZEvent[] = [];
  for (let i = 0; i < n; i++) out.push(makeEvent(out[i - 1] ?? null, { type: 'system.emergencyStop', on: i % 2 === 0 }, me, 1000 + i));
  return out;
}

describe('事件哈希链', () => {
  it('连续生成的链能通过校验', () => {
    expect(verifyChain(chain(5))).toEqual({ ok: true });
  });
  it('改了某条事件的内容会被发现', () => {
    const c = chain(4);
    (c[2]!.body as { on: boolean }).on = !(c[2]!.body as { on: boolean }).on;
    const r = verifyChain(c);
    expect(r.ok).toBe(false);
    expect(r.brokenAt).toBe(3);
  });
  it('删掉中间一条会被发现', () => {
    const c = chain(4);
    c.splice(1, 1);
    expect(verifyChain(c).ok).toBe(false);
  });
});
