import type { SearchProviderKind, SearchSettings } from '@zhongshu/core';
import type { Workspace } from '../store/index.js';
import type { SecretStore } from '../secrets/index.js';

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  date?: string;
  source?: string;
}

export type Recency = 'day' | 'week' | 'month' | 'year' | 'any';

export const SEARCH_PROVIDERS: Record<SearchProviderKind, { label: string; hint: string; keyUrl: string }> = {
  bocha: { label: '博查 Bocha', hint: '国内直连，中文结果好，按次计费', keyUrl: 'https://open.bochaai.com' },
  tavily: { label: 'Tavily', hint: '海外常用，每月有免费额度', keyUrl: 'https://app.tavily.com' },
  brave: { label: 'Brave Search', hint: '海外，有免费档', keyUrl: 'https://brave.com/search/api/' },
};

const HOSTS: Record<SearchProviderKind, string> = { bocha: 'https://api.bochaai.com/v1/web-search', tavily: 'https://api.tavily.com/search', brave: 'https://api.search.brave.com/res/v1/web/search' };

/** 通用搜索服务：一个 key、一个 HTTPS 接口。结果一律按外部内容处理，调用方负责包起来。 */
export class SearchService {
  constructor(private readonly ws: Workspace, private readonly secrets: SecretStore, private readonly f: typeof fetch = fetch) {}

  settings(): SearchSettings | null {
    return this.ws.current.search;
  }

  configured(): boolean {
    return !!this.ws.current.search?.secretRef;
  }

  async search(query: string, opts: { limit?: number; recency?: Recency; signal?: AbortSignal } = {}): Promise<SearchHit[]> {
    const s = this.ws.current.search;
    if (!s?.secretRef) throw new Error('还没接搜索服务。到“模型”页的“搜索服务”里选一家并填 key。');
    const key = await this.secrets.get(s.secretRef);
    if (!key) throw new Error('搜索服务的 key 不见了，重新填一次');
    const limit = Math.min(20, Math.max(1, opts.limit ?? 8));
    const recency = opts.recency ?? 'any';
    const init: RequestInit = { signal: opts.signal ?? null, redirect: 'error' };
    let res: Response;
    let hits: SearchHit[] = [];
    if (s.provider === 'bocha') {
      const freshness = ({ day: 'oneDay', week: 'oneWeek', month: 'oneMonth', year: 'oneYear', any: 'noLimit' } as const)[recency];
      res = await this.f(HOSTS.bocha, { ...init, method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ query, count: limit, freshness, summary: true }) });
      const j = (await res.json().catch(() => ({}))) as { code?: number; msg?: string; data?: { webPages?: { value?: { name?: string; url?: string; snippet?: string; summary?: string; datePublished?: string; siteName?: string }[] } } };
      if (!res.ok || (j.code && j.code !== 200)) throw new Error(`博查返回 ${j.code ?? res.status}：${j.msg ?? ''}`.trim());
      hits = (j.data?.webPages?.value ?? []).map((x) => ({ title: x.name ?? '', url: x.url ?? '', snippet: x.summary || x.snippet || '', ...(x.datePublished ? { date: x.datePublished.slice(0, 10) } : {}), ...(x.siteName ? { source: x.siteName } : {}) }));
    } else if (s.provider === 'tavily') {
      res = await this.f(HOSTS.tavily, { ...init, method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ query, max_results: limit, ...(recency !== 'any' ? { time_range: recency } : {}) }) });
      const j = (await res.json().catch(() => ({}))) as { detail?: unknown; results?: { title?: string; url?: string; content?: string; published_date?: string }[] };
      if (!res.ok) throw new Error(`Tavily 返回 ${res.status}：${typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail ?? '')}`.slice(0, 200));
      hits = (j.results ?? []).map((x) => ({ title: x.title ?? '', url: x.url ?? '', snippet: x.content ?? '', ...(x.published_date ? { date: x.published_date.slice(0, 10) } : {}) }));
    } else {
      const freshness = ({ day: 'pd', week: 'pw', month: 'pm', year: 'py', any: '' } as const)[recency];
      const u = new URL(HOSTS.brave);
      u.searchParams.set('q', query);
      u.searchParams.set('count', String(limit));
      if (freshness) u.searchParams.set('freshness', freshness);
      res = await this.f(u, { ...init, headers: { 'x-subscription-token': key, accept: 'application/json' } });
      const j = (await res.json().catch(() => ({}))) as { message?: string; web?: { results?: { title?: string; url?: string; description?: string; page_age?: string; profile?: { name?: string } }[] } };
      if (!res.ok) throw new Error(`Brave 返回 ${res.status}：${j.message ?? ''}`.trim());
      hits = (j.web?.results ?? []).map((x) => ({ title: x.title ?? '', url: x.url ?? '', snippet: x.description ?? '', ...(x.page_age ? { date: x.page_age.slice(0, 10) } : {}), ...(x.profile?.name ? { source: x.profile.name } : {}) }));
    }
    return hits.filter((h) => /^https?:\/\//i.test(h.url)).slice(0, limit).map((h) => ({ ...h, title: clean(h.title, 200), snippet: clean(h.snippet, 600) }));
  }

  async test(): Promise<string> {
    const hits = await this.search('中枢 AI agent', { limit: 3 });
    return hits.length ? `通了，试搜到 ${hits.length} 条，第一条：${hits[0]!.title}` : '通了，但没有搜到结果';
  }
}

function clean(s: string, max: number): string {
  return s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** 搜索结果变成给模型看的文字（调用方再包 untrusted） */
export function hitsToText(hits: SearchHit[]): string {
  return hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}${h.date ? `（${h.date}）` : ''}\n   ${h.snippet}`).join('\n');
}
