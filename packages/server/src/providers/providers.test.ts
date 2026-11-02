import { describe, it, expect } from 'vitest';
import { OpenAIProvider, AnthropicProvider } from './index.js';

function fakeFetch(handler: (url: string, body: any, headers: Record<string, string>) => unknown, status = 200) {
  const calls: { url: string; body: any; headers: Record<string, string> }[] = [];
  const f = (async (input: any, init: any) => {
    const url = typeof input === 'string' ? input : input.url;
    const body = JSON.parse(init.body);
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    calls.push({ url, body, headers });
    return new Response(JSON.stringify(handler(url, body, headers)), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { f, calls };
}

describe('OpenAIProvider', () => {
  it('翻译工具调用和思考强度', async () => {
    const { f, calls } = fakeFetch(() => ({
      model: 'gpt-5',
      choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] } }],
    }));
    const p = new OpenAIProvider({ baseUrl: 'https://x.test/v1/', apiKey: 'k', fetch: f });
    const r = await p.chat({ model: 'gpt-5', system: 's', turns: [{ role: 'user', text: 'hi' }], tools: [{ name: 'read_file', description: 'd', parameters: { type: 'object' } }], effort: '低' });
    expect(calls[0]!.url).toBe('https://x.test/v1/chat/completions');
    expect(calls[0]!.headers.authorization).toBe('Bearer k');
    expect(calls[0]!.body.reasoning_effort).toBe('low');
    expect(r.stop).toBe('tool');
    expect(r.toolCalls[0]).toEqual({ id: 'c1', name: 'read_file', input: { path: 'a.ts' } });
  });
  it('401 给出能看懂的错误', async () => {
    const { f } = fakeFetch(() => ({ error: 'bad' }), 401);
    const p = new OpenAIProvider({ baseUrl: 'https://x.test/v1', apiKey: 'k', fetch: f });
    await expect(p.chat({ model: 'm', system: '', turns: [] })).rejects.toThrow(/密钥/);
  });
});

describe('AnthropicProvider', () => {
  const reply = { id: 'm1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'tool_use', usage: { input_tokens: 3, output_tokens: 4 },
    content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'tool_use', id: 't1', name: 'update_plan', input: { ops: [] } }] };

  it('官方 Claude：自适应思考 + effort + 服务端兜底；思考块原样带回', async () => {
    const { f, calls } = fakeFetch(() => reply);
    const p = new AnthropicProvider({ apiKey: 'k', fetch: f });
    const r = await p.chat({ model: 'claude-opus-5-5', system: 's', turns: [{ role: 'user', text: 'hi' }], effort: '超高' });
    expect(calls[0]!.body.thinking).toEqual({ type: 'adaptive' });
    expect(calls[0]!.body.output_config).toEqual({ effort: 'xhigh' });
    expect(calls[0]!.body.fallbacks).toBe('default');
    expect(calls[0]!.headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
    expect(r.toolCalls[0]!.name).toBe('update_plan');
    await p.chat({ model: 'claude-opus-5-5', system: 's', turns: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: '', toolCalls: r.toolCalls, raw: r.raw }, { role: 'tool', results: [{ id: 't1', content: 'ok' }] }] });
    const msgs = calls[1]!.body.messages;
    expect(msgs[1].content[0].type).toBe('thinking');
    expect(msgs[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't1' });
  });

  it('第三方兼容地址不发思考参数', async () => {
    const { f, calls } = fakeFetch(() => ({ ...reply, model: 'glm-5.3', content: [{ type: 'text', text: '好' }], stop_reason: 'end_turn' }));
    const p = new AnthropicProvider({ apiKey: 'k', baseUrl: 'https://open.bigmodel.cn/api/anthropic', fetch: f });
    const r = await p.chat({ model: 'glm-5.3', system: 's', turns: [{ role: 'user', text: 'hi' }] });
    expect(calls[0]!.body.thinking).toBeUndefined();
    expect(calls[0]!.url).toContain('open.bigmodel.cn/api/anthropic/v1/messages');
    expect(r.text).toBe('好');
  });
});
