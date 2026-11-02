import type { ChatProvider, ChatRequest, ChatResult } from './types.js';

/** 测试和离线演示用：按顺序吐出预设的回答，或用函数现算。 */
export class MockProvider implements ChatProvider {
  readonly kind = 'mock';
  readonly calls: ChatRequest[] = [];
  constructor(private readonly script: ChatResult[] | ((req: ChatRequest, i: number) => ChatResult)) {}
  async chat(req: ChatRequest): Promise<ChatResult> {
    const i = this.calls.length;
    this.calls.push(req);
    if (typeof this.script === 'function') return this.script(req, i);
    return this.script[i] ?? { text: '（没有更多预设回答）', toolCalls: [], stop: 'end' };
  }
}
