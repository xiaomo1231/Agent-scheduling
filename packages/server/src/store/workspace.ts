import { emptyState, makeEvent, reduce, verifyChain, type Actor, type EventBody, type State, type ZEvent } from '@zhongshu/core';
import type { EventLog } from './log.js';

export type Listener = (events: ZEvent[], state: State) => void;

/**
 * 工作区：事件日志 + 内存里的当前状态。
 * 所有状态变化都经过 commit()，它负责编号、算哈希、写盘、通知订阅者。
 */
export class Workspace {
  private state: State;
  private events: ZEvent[];
  private listeners = new Set<Listener>();

  private constructor(private readonly log: EventLog, events: ZEvent[], private readonly now: () => number) {
    this.events = events;
    this.state = events.reduce(reduce, emptyState());
  }

  static open(log: EventLog, opts: { now?: () => number } = {}): Workspace {
    const events = log.readAll();
    const check = verifyChain(events);
    if (!check.ok) throw new Error(`留痕记录对不上（第 ${check.brokenAt} 条）：${check.reason}。为安全起见没有打开工作区。`);
    return new Workspace(log, events, opts.now ?? Date.now);
  }

  get current(): State {
    return this.state;
  }

  allEvents(): readonly ZEvent[] {
    return this.events;
  }

  eventsSince(seq: number): ZEvent[] {
    return this.events.filter((e) => e.seq > seq);
  }

  commit(bodies: EventBody | readonly EventBody[], actor: Actor): ZEvent[] {
    const list = Array.isArray(bodies) ? (bodies as EventBody[]) : [bodies as EventBody];
    if (!list.length) return [];
    const out: ZEvent[] = [];
    let prev: Pick<ZEvent, 'seq' | 'hash'> | null = this.state.lastSeq ? { seq: this.state.lastSeq, hash: this.state.lastHash } : null;
    let st = this.state;
    const ts = this.now();
    for (const b of list) {
      const e = makeEvent(prev, b, actor, ts);
      st = reduce(st, e);
      out.push(e);
      prev = e;
    }
    this.log.append(out); // 先落盘，再改内存
    this.events.push(...out);
    this.state = st;
    for (const l of this.listeners) {
      try {
        l(out, st);
      } catch {
        /* 订阅者出错不影响写入 */
      }
    }
    return out;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
