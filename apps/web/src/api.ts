import { emptyState, reduce, type State, type ZEvent } from '@zhongshu/core';

// 和本地网关说话。token 从地址栏 #token=… 读进来，存在本标签页里，随后从地址栏抹掉。
const KEY = 'zhongshu.token';

function readToken(): string {
  const m = location.hash.match(/token=([A-Za-z0-9_-]+)/);
  if (m) {
    try {
      sessionStorage.setItem(KEY, m[1]!);
    } catch {
      /* 无痕模式 */
    }
    history.replaceState(null, '', location.pathname + location.search + '#/');
    return m[1]!;
  }
  try {
    return sessionStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

export const token = readToken();

export class ApiError extends Error {}

export async function send<T = unknown>(cmd: { type: string } & Record<string, unknown>): Promise<T> {
  const res = await fetch('/api/commands', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(cmd),
  });
  const body = (await res.json().catch(() => ({ ok: false, error: `服务返回 ${res.status}` }))) as { ok: boolean; result?: T; error?: string };
  if (!body.ok) throw new ApiError(body.error ?? '出错了');
  return body.result as T;
}

export async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new ApiError(`服务返回 ${res.status}`);
  return (await res.json()) as T;
}

// ---------- 状态：快照 + 事件，用和后端同一个 reducer ----------
export type Conn = 'connecting' | 'online' | 'offline' | 'unauthorized';
let state: State = emptyState();
let conn: Conn = 'connecting';
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export const store = {
  get: () => state,
  conn: () => conn,
  subscribe(fn: () => void) {
    subs.add(fn);
    return () => subs.delete(fn);
  },
};

let retry = 500;
export function connect(): void {
  if (!token) {
    conn = 'unauthorized';
    emit();
    return;
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/api/events?token=${encodeURIComponent(token)}`);
  ws.onopen = () => {
    retry = 500;
  };
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data)) as { kind: 'snapshot'; state: State } | { kind: 'events'; events: ZEvent[] };
    if (m.kind === 'snapshot') state = m.state;
    else for (const e of m.events) if (e.seq > state.lastSeq) state = reduce(state, e);
    conn = 'online';
    emit();
  };
  ws.onclose = (ev) => {
    conn = ev.code === 1006 && conn === 'connecting' && retry > 4000 ? 'unauthorized' : 'offline';
    emit();
    setTimeout(connect, (retry = Math.min(retry * 2, 8000)));
  };
}
