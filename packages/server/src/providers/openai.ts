import { effortToApi } from '@zhongshu/core';
import { ProviderError, type ChatProvider, type ChatRequest, type ChatResult, type ChatTurn, type ToolCall } from './types.js';

export interface OpenAIOptions {
  apiKey?: string;
  baseUrl: string;
  fetch?: typeof fetch;
}

interface OaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

function toMessages(system: string, turns: readonly ChatTurn[]): OaMessage[] {
  const out: OaMessage[] = [{ role: 'system', content: system }];
  for (const t of turns) {
    if (t.role === 'user') out.push({ role: 'user', content: t.text });
    else if (t.role === 'assistant')
      out.push({
        role: 'assistant',
        content: t.text || null,
        ...(t.toolCalls.length ? { tool_calls: t.toolCalls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: JSON.stringify(c.input) } })) } : {}),
      });
    else for (const r of t.results) out.push({ role: 'tool', tool_call_id: r.id, content: r.isError ? `出错：${r.content}` : r.content });
  }
  return out;
}

/**
 * OpenAI 兼容接口：OpenAI、DeepSeek、OpenCode Go、火山方舟、百炼、OpenRouter、Ollama、LM Studio。
 * 各家都实现了 /chat/completions，这里只用最通用的那部分。
 */
export class OpenAIProvider implements ChatProvider {
  readonly kind = 'openai';
  private f: typeof fetch;
  constructor(private readonly opts: OpenAIOptions) {
    this.f = opts.fetch ?? fetch;
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const body: Record<string, unknown> = { model: req.model, messages: toMessages(req.system, req.turns), max_tokens: req.maxTokens ?? 8000 };
    if (req.tools?.length) body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    const api = effortToApi(req.model, req.effort ?? '');
    if (api.openaiEffort) body.reasoning_effort = api.openaiEffort;
    const url = this.opts.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    let res: Response;
    try {
      res = await this.f(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}) },
        body: JSON.stringify(body),
        signal: req.signal ?? null,
      });
    } catch (err) {
      throw new ProviderError(`连不上 ${new URL(url).host}：${(err as Error).message}`, undefined, true);
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      if (res.status === 401 || res.status === 403) throw new ProviderError('密钥不对或没有权限，去模型来源里检查一下', res.status);
      if (res.status === 429) throw new ProviderError('额度或频率到上限了，稍后会再试', 429, true);
      throw new ProviderError(`模型服务返回 ${res.status}：${detail}`, res.status, res.status >= 500);
    }
    const data = (await res.json()) as {
      model?: string;
      choices?: { finish_reason?: string; message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const choice = data.choices?.[0];
    if (!choice?.message) throw new ProviderError('模型服务返回的内容看不懂');
    const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((c) => {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(c.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        input = { _invalid: c.function.arguments };
      }
      return { id: c.id, name: c.function.name, input };
    });
    const fr = choice.finish_reason;
    const stop = toolCalls.length || fr === 'tool_calls' ? 'tool' : fr === 'length' ? 'length' : fr === 'content_filter' ? 'refusal' : 'end';
    return {
      text: choice.message.content ?? '',
      toolCalls,
      stop,
      ...(data.model ? { servedBy: data.model } : {}),
      usage: { input: data.usage?.prompt_tokens ?? 0, output: data.usage?.completion_tokens ?? 0 },
    };
  }
}
