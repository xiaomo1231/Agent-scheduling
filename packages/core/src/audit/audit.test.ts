import { describe, it, expect } from 'vitest';
import { emptyState } from '../state/index.js';
import { securityAudit } from './index.js';

describe('securityAudit', () => {
  it('默认设置没有危险项', () => {
    expect(securityAudit(emptyState()).filter((f) => f.level === 'danger')).toEqual([]);
  });
  it('全部放行会标红并给出修法', () => {
    const s = emptyState();
    s.policy = { ...s.policy, commandMode: 'dangerouslyAllowAll', askFallback: 'allowlist' };
    const f = securityAudit(s);
    expect(f.find((x) => x.id === 'cmd.allowAll')?.fix).toEqual({ commandMode: 'allowlist' });
    expect(f.some((x) => x.id === 'ask.fallback')).toBe(true);
  });
});
