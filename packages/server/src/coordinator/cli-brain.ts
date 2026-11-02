import type { ModelTransport } from '@zhongshu/core';
import type { ChatProvider, ChatRequest, ChatResult, ToolCall } from '../providers/index.js';
import { cliInvocation, type ExecFile } from '../runners/index.js';

/**
 * 订阅账号当协调者：通过官方 CLI 的无界面模式问一次，让它按约定输出 JSON 形式的工具调用。
 * CLI 本身不认识中枢的工具，所以这里把工具清单写进提示词，只解析、不让 CLI 执行任何东西。
 */
export class CliBrain implements ChatProvider {
  readonly kind = 'cli';
  constructor(private readonly transport: ModelTransport, private readonly exec: ExecFile, private readonly cwd: string) {}

  async chat(req: ChatRequest): Promise<ChatResult> {
    const convo = req.turns
      .map((t) => (t.role === 'user' ? `用户：${t.text}` : t.role === 'assistant' ? `你：${t.text}${t.toolCalls.length ? `\n（调用了 ${t.toolCalls.map((c) => c.name).join('、')}）` : ''}` : `工具结果：${t.results.map((r) => r.content).join('\n')}`))
      .join('\n\n');
    const prompt = [
      req.system,
      '\n可用工具（JSON Schema）：',
      JSON.stringify(req.tools ?? [], null, 0),
      '\n对话：',
      convo,
      '\n只输出一个 JSON 对象，不要别的文字：{"text":"给用户的话","tool_calls":[{"name":"工具名","input":{...}}]}。不需要工具时 tool_calls 为空数组。',
    ].join('\n');
    const inv = cliInvocation(this.transport, req.model, prompt);
    if (!inv) throw new Error('不是 CLI 来源');
    const r = await this.exec(inv.program, inv.args, { cwd: this.cwd, timeoutMs: 5 * 60_000, ...(req.signal ? { signal: req.signal } : {}) });
    if (r.code !== 0) throw new Error(`${inv.program} 退出码 ${r.code}：${r.stderr.slice(0, 300)}`);
    const out = inv.parse(r.stdout);
    const m = out.match(/\{[\s\S]*\}/);
    if (!m) return { text: out.trim(), toolCalls: [], stop: 'end' };
    try {
      const j = JSON.parse(m[0]) as { text?: string; tool_calls?: { name: string; input?: Record<string, unknown> }[] };
      const toolCalls: ToolCall[] = (j.tool_calls ?? []).filter((c) => typeof c?.name === 'string').map((c, i) => ({ id: `cli_${Date.now()}_${i}`, name: c.name, input: c.input ?? {} }));
      return { text: j.text ?? '', toolCalls, stop: toolCalls.length ? 'tool' : 'end' };
    } catch {
      return { text: out.trim(), toolCalls: [], stop: 'end' };
    }
  }
}
