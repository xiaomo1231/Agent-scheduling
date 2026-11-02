import { interpret, type Step, type Thread } from '@zhongshu/core';
import type { ChatProvider, ChatRequest, ChatResult, ToolCall } from '../providers/index.js';

/**
 * 不用模型的协调者：用规则理解“新增 / 先做 / 取消 / 另开”。
 * 没配模型、模型挂了、或者订阅额度用完时兜底，保证基本的调度还能用。
 */
export class RuleBrain implements ChatProvider {
  readonly kind = 'rules';
  private n = 0;
  constructor(private readonly ctx: { thread: Thread; text: string }) {}

  async chat(_req: ChatRequest): Promise<ChatResult> {
    if (this.n++ > 0) return { text: '', toolCalls: [], stop: 'end' };
    const { thread, text } = this.ctx;
    const call = (name: string, input: Record<string, unknown>): ToolCall => ({ id: `rule_${this.n}_${name}`, name, input });

    if (thread.kind === 'coord') {
      const t = text.trim();
      if (!t || /^(你好|在吗|谢谢|好的?|ok)$/i.test(t)) return { text: '在的。直接告诉我要做什么，我来开讨论串、排计划。', toolCalls: [], stop: 'end' };
      const title = t.replace(/^(帮我|请|麻烦你?|我想|我要)/, '').replace(/[。.!！?？].*$/s, '').slice(0, 18) || '新任务';
      const steps = [{ title: `理清“${title}”的需求`, assignee: '@planner' }, { title: '动手实现', assignee: '@builder' }, { title: '检查结果', assignee: '@reviewer' }];
      return { text: `好，开了讨论串“${title}”，先按三步走，随时可以在讨论串里改。`, toolCalls: [call('create_thread', { title, steps, start: true })], stop: 'tool' };
    }

    const intent = interpret(text, thread.steps);
    switch (intent.kind) {
      case 'add':
      case 'reorder':
      case 'cancel':
        return { text: '', toolCalls: [call('update_plan', { thread_id: thread.id, ops: intent.ops }), call('dispatch', { thread_id: thread.id })], stop: 'tool' };
      case 'split':
        return { text: `这件事另开一个讨论串来做。`, toolCalls: [call('create_thread', { title: intent.title, steps: [{ title: intent.title, assignee: '@builder' }], start: false })], stop: 'tool' };
      default: {
        const live = thread.steps.filter((s: Step) => s.state !== 'cancelled' && s.state !== 'done');
        return { text: live.length ? `收到。现在还剩 ${live.length} 步，正在做的是“${(live.find((s) => s.state === 'run') ?? live[0])!.title}”。` : '收到。计划里的步骤都做完了。', toolCalls: [], stop: 'end' };
      }
    }
  }
}
