import { describe, it, expect } from 'vitest';
import { mkdtempSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultPolicy } from '@zhongshu/core';
import { JsonlLog, MemoryLog, Workspace } from './index.js';

const me = { kind: 'user' as const, id: 'me' };

describe('Workspace', () => {
  it('提交事件后状态更新并通知订阅者', () => {
    const ws = Workspace.open(new MemoryLog(), { now: () => 1 });
    let seen = 0;
    ws.subscribe((ev) => (seen += ev.length));
    ws.commit([{ type: 'system.emergencyStop', on: true }, { type: 'system.emergencyStop', on: false }], me);
    expect(ws.current.lastSeq).toBe(2);
    expect(ws.current.emergencyStop).toBe(false);
    expect(seen).toBe(2);
  });

  it('写盘后重新打开能回放出同样的状态', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'zs-')), 'events.jsonl');
    const ws = Workspace.open(new JsonlLog(file));
    ws.commit({ type: 'policy.changed', policy: { ...defaultPolicy(), approvalTimeoutSec: 99 } }, me);
    const again = Workspace.open(new JsonlLog(file));
    expect(again.current.policy.approvalTimeoutSec).toBe(99);
    expect(again.current.lastHash).toBe(ws.current.lastHash);
  });

  it('最后一行写坏了会被忽略', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'zs-')), 'events.jsonl');
    Workspace.open(new JsonlLog(file)).commit({ type: 'system.emergencyStop', on: true }, me);
    appendFileSync(file, '{"seq":2,');
    expect(Workspace.open(new JsonlLog(file)).current.emergencyStop).toBe(true);
  });

  it('记录被改过就拒绝打开', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'zs-')), 'events.jsonl');
    Workspace.open(new JsonlLog(file)).commit({ type: 'system.emergencyStop', on: true }, me);
    writeFileSync(file, readFileSync(file, 'utf8').replace('"on":true', '"on":false'));
    expect(() => Workspace.open(new JsonlLog(file))).toThrow(/对不上/);
  });
});
