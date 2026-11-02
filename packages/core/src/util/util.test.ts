import { describe, it, expect } from 'vitest';
import { sha256Hex } from './sha256.js';
import { canonicalJson } from './canonical.js';
import { newId, seededRandom } from './ids.js';
import { createHash } from 'node:crypto';
const h = (s: string) => createHash('sha256').update(s).digest('hex');

describe('sha256', () => {
  it('和标准结果一致', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('中枢')).toBe(h('中枢'));
    const long = 'x'.repeat(1000);
    expect(sha256Hex(long)).toBe(h(long));
  });
});

describe('canonicalJson', () => {
  it('键顺序不影响结果，undefined 被忽略', () => {
    expect(canonicalJson({ b: 1, a: [1, { d: 2, c: 3 }], u: undefined })).toBe(canonicalJson({ a: [1, { c: 3, d: 2 }], b: 1 }));
  });
});

describe('newId', () => {
  it('带前缀，种子相同结果相同', () => {
    expect(newId('thr', seededRandom(7))).toBe(newId('thr', seededRandom(7)));
    expect(newId('thr')).toMatch(/^thr_[0-9a-z]{12}$/);
  });
});
