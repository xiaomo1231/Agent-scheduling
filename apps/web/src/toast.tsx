import { useSyncExternalStore } from 'react';

type T = { id: number; text: string; bad?: boolean };
let list: T[] = [];
const subs = new Set<() => void>();
let n = 0;

export function toast(text: string, bad = false) {
  const t = { id: ++n, text, bad };
  list = [...list, t];
  subs.forEach((f) => f());
  setTimeout(() => {
    list = list.filter((x) => x.id !== t.id);
    subs.forEach((f) => f());
  }, bad ? 6000 : 2600);
}

/** 包一层：命令出错时弹出原因 */
export async function attempt<R>(p: Promise<R>, ok?: string): Promise<R | undefined> {
  try {
    const r = await p;
    if (ok) toast(ok);
    return r;
  } catch (e) {
    toast((e as Error).message, true);
    return undefined;
  }
}

export function Toasts() {
  const items = useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => list,
  );
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={'toast' + (t.bad ? ' bad' : '')}>{t.text}</div>
      ))}
    </div>
  );
}
