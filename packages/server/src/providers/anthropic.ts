import Anthropic from '@anthropic-ai/sdk';
import { effortToApi } from '@zhongshu/core';
import { ProviderError, type ChatProvider, type ChatRequest, type ChatResult, type ChatTurn, type ToolCall } from './types.js';

export interface AnthropicOptions {
  apiKey: string;
  /** 智谱、Kimi 等 Anthropic 兼容地址；空表示官方 */
  baseUrl?: string;
  fetch?: typeof fetch;
}

const OFFICIAL = /^https:\/\/api\.anthropic\.com\/?$/;
/** 这些模型官方建议默认打开服务端兜底：被安全分类器拒绝时自动换模型重答 */
const FALLBACK_MODELS = /^claude-(fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/;

function toMessages(turns: readonly ChatTurn[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const t of turns) {
    if (t.role === 'user') out.push({ role: 'user', content: t.text });
    else if (t.role === 'assistant') {
      if (Array.isArray(t.raw)) out.push({ role: 'assistant', content: t.raw as Anthropic.ContentBlockParam[] });
      else {
        const blocks: Anthropic.ContentBlockParam[] = [];
        if (t.text) blocks.push({ type: 'text', text: t.text });
        for (const c of t.toolCalls) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input });
        out.push({ role: 'assistant', content: blocks });
      }
    } else {
      // 所有工具结果放在同一条 user 消息里
      out.push({
        role: 'user',
        content: t.results.map((r) => ({ type: 'tool_result' as const, tool_use_id: r.id, content: r.content, ...(r.isError ? { is_error: true } : {}) })),
      });
    }
  }
  return out;
}

/** Anthropic 官方 API 和 Anthropic 兼容的 Coding Plan（智谱、Kimi 等）。 */
export class AnthropicProvider implements ChatProvider {
  readonly kind = 'anthropic';
  private client: Anthropic;
  private official: boolean;

  constructor(opts: AnthropicOptions) {
    this.official = !opts.baseUrl || OFFICIAL.test(opts.baseUrl);
    this.client = new Anthropic({ apiKey: opts.apiKey, ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}), ...(opts.fetch ? { fetch: opts.fetch } : {}), maxRetries: 2 });
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const isClaude = /claude|opus|sonnet|haiku|fable|mythos/i.test(req.model);
    const params: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens ?? 16000,
      system: req.system,
      messages: toMessages(req.turns),
    };
    if (req.tools?.length) params.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    // 第三方兼容接口不一定认识这些参数，只对官方 Claude 发
    if (this.official && isClaude) {
      params.thinking = { type: 'adaptive' };
      const e = effortToApi(req.model, req.effort ?? '高').anthropicEffort;
      if (e) params.output_config = { effort: e };
    }
    let msg: Anthropic.Message;
    try {
      if (this.official && FALLBACK_MODELS.test(req.model)) {
        msg = (await this.client.beta.messages.create(
          { ...(params as unknown as Anthropic.Beta.MessageCreateParamsNonStreaming), betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' },
          { signal: req.signal },
        )) as unknown as Anthropic.Message;
      } else {
        msg = await this.client.messages.create(params as unknown as Anthropic.MessageCreateParamsNonStreaming, { signal: req.signal });
      }
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) throw new ProviderError('密钥不对或已失效，去模型来源里重新填一下', 401);
      if (err instanceof Anthropic.RateLimitError) throw new ProviderError('额度或频率到上限了，稍后会再试', 429, true);
      if (err instanceof Anthropic.APIError) throw new ProviderError(`模型服务返回错误（${err.status ?? '无状态码'}）：${err.message}`, err.status, (err.status ?? 0) >= 500);
      throw new ProviderError(`连不上模型服务：${(err as Error).message}`, undefined, true);
    }
    const text = msg.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('');
    const toolCalls: ToolCall[] = msg.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> }));
    const stop = msg.stop_reason === 'tool_use' ? 'tool' : msg.stop_reason === 'max_tokens' ? 'length' : msg.stop_reason === 'refusal' ? 'refusal' : 'end';
    return { text, toolCalls, stop, raw: msg.content, servedBy: msg.model, usage: { input: msg.usage.input_tokens, output: msg.usage.output_tokens } };
  }
}
