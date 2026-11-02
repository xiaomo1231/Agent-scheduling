/** 中枢内部统一的对话格式。各家适配器负责翻译成自己的协议。 */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema（object） */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type ChatTurn =
  | { role: 'user'; text: string }
  /** raw 是服务方原样返回的内容（含思考块），下一轮原样传回去 */
  | { role: 'assistant'; text: string; toolCalls: ToolCall[]; raw?: unknown }
  | { role: 'tool'; results: { id: string; content: string; isError?: boolean }[] };

export interface ChatRequest {
  model: string;
  system: string;
  turns: ChatTurn[];
  tools?: ToolSpec[];
  /** 中文挡位，如 “高”“超高”“深度思考” */
  effort?: string;
  maxTokens?: number;
  signal?: AbortSignal;
}

export type StopKind = 'end' | 'tool' | 'length' | 'refusal';

export interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
  stop: StopKind;
  raw?: unknown;
  /** 实际回答的模型（服务端兜底换了模型时会不同） */
  servedBy?: string;
  usage?: { input: number; output: number };
}

export interface ChatProvider {
  readonly kind: string;
  chat(req: ChatRequest): Promise<ChatResult>;
}

export class ProviderError extends Error {
  constructor(message: string, readonly status?: number, readonly retryable = false) {
    super(message);
  }
}
