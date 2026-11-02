import { ProviderError, type ChatProvider, type ChatRequest, type ChatResult } from './types.js';

/** 记账和额度处理的钩子，由 App 接到事件日志上 */
export interface Meter {
  record(u: { projectId: string; sourceId: string; model: string; input: number; output: number }): void;
  /** 碰到额度上限：until 是预计恢复时间 */
  waiting(sourceId: string, until: number, reason: string): void;
  recovered(sourceId: string): void;
  /** 这个项目是否允许等额度恢复后自动继续 */
  autoContinue(projectId: string): boolean;
  /** 第一次等待多久（毫秒），之后翻倍；测试时调小 */
  baseDelayMs?: number;
  maxWaits?: number;
}

const MAX_WAIT_MS = 5 * 60 * 60 * 1000; // 订阅额度一般 5 小时一个窗口

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((ok, fail) => {
    if (signal?.aborted) return fail(new ProviderError('已停止'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      ok();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      fail(new ProviderError('已停止'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 包一层：每次调用记用量；碰到 429 时按项目设置等恢复再自动重试。 */
export class MeteredProvider implements ChatProvider {
  readonly kind: string;
  constructor(
    private readonly inner: ChatProvider,
    private readonly sourceId: string,
    private readonly projectId: string,
    private readonly meter: Meter,
  ) {
    this.kind = inner.kind;
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const base = this.meter.baseDelayMs ?? 60_000;
    const maxWaits = this.meter.maxWaits ?? 8;
    let waited = false;
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await this.inner.chat(req);
        if (waited) this.meter.recovered(this.sourceId);
        this.meter.record({ projectId: this.projectId, sourceId: this.sourceId, model: r.servedBy ?? req.model, input: r.usage?.input ?? 0, output: r.usage?.output ?? 0 });
        return r;
      } catch (e) {
        const quota = e instanceof ProviderError && e.status === 429;
        if (!quota || attempt >= maxWaits || !this.meter.autoContinue(this.projectId)) {
          if (waited) this.meter.recovered(this.sourceId);
          throw e;
        }
        const ms = Math.min((e as ProviderError).retryAfterMs ?? base * 2 ** attempt, MAX_WAIT_MS);
        this.meter.waiting(this.sourceId, Date.now() + ms, (e as Error).message);
        waited = true;
        await sleep(ms, req.signal);
      }
    }
  }
}

/** 解析 Retry-After（秒数或 HTTP 日期） */
export function parseRetryAfter(v: string | null | undefined, now = Date.now()): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  if (Number.isFinite(n) && n >= 0) return n * 1000;
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - now) : undefined;
}
