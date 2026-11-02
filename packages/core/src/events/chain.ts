import { canonicalJson } from '../util/canonical.js';
import { sha256Hex } from '../util/sha256.js';
import type { Actor } from '../model/types.js';
import type { EventBody, ZEvent } from './types.js';

export const GENESIS_HASH = '0'.repeat(64);

export function hashEvent(e: Omit<ZEvent, 'hash'>): string {
  return sha256Hex(canonicalJson({ seq: e.seq, ts: e.ts, actor: e.actor, prevHash: e.prevHash, body: e.body }));
}

/** 在链尾接一条事件。prev 为空表示第一条。 */
export function makeEvent(prev: Pick<ZEvent, 'seq' | 'hash'> | null, body: EventBody, actor: Actor, ts: number): ZEvent {
  const base = { seq: prev ? prev.seq + 1 : 1, ts, actor, prevHash: prev ? prev.hash : GENESIS_HASH, body };
  return { ...base, hash: hashEvent(base) };
}

export interface ChainCheck {
  ok: boolean;
  /** 第一条对不上的事件序号 */
  brokenAt?: number;
  reason?: string;
}

/** 校验整条链：序号连续、前后哈希相接、内容没被改过。 */
export function verifyChain(events: readonly ZEvent[]): ChainCheck {
  let prevHash = GENESIS_HASH;
  let prevSeq = 0;
  for (const e of events) {
    if (e.seq !== prevSeq + 1) return { ok: false, brokenAt: e.seq, reason: `序号不连续：期望 ${prevSeq + 1}，实际 ${e.seq}` };
    if (e.prevHash !== prevHash) return { ok: false, brokenAt: e.seq, reason: '和上一条事件接不上' };
    if (hashEvent(e) !== e.hash) return { ok: false, brokenAt: e.seq, reason: '内容被改过' };
    prevHash = e.hash;
    prevSeq = e.seq;
  }
  return { ok: true };
}
