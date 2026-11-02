import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { State } from '@zhongshu/core';
import { store, type Conn } from './api';

export function useStore(): State {
  return useSyncExternalStore(store.subscribe, store.get);
}
export function useConn(): Conn {
  return useSyncExternalStore(store.subscribe, store.conn);
}

/** 简单的 hash 路由：#/p/<项目>/<讨论串>、#/models、#/security、#/skills、#/log */
export function useRoute(): [string[], (path: string) => void] {
  const read = () => location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const [r, setR] = useState(read);
  useEffect(() => {
    const f = () => setR(read());
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);
  const go = useCallback((p: string) => {
    location.hash = '#/' + p.replace(/^\//, '');
  }, []);
  return [r, go];
}

/** 本机偏好（布局里不重要的东西），读写都包 try/catch */
export function useLocal<T>(key: string, init: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const s = localStorage.getItem('zs.' + key);
      return s ? (JSON.parse(s) as T) : init;
    } catch {
      return init;
    }
  });
  const set = useCallback((nv: T) => {
    setV(nv);
    try {
      localStorage.setItem('zs.' + key, JSON.stringify(nv));
    } catch {
      /* 忽略 */
    }
  }, [key]);
  return [v, set];
}
