import type { ModelSource } from '@zhongshu/core';
import type { SecretStore } from '../secrets/index.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { ProviderError, type ChatProvider } from './types.js';

export interface ProviderDeps {
  secrets: SecretStore;
  fetch?: typeof fetch;
  /** 测试时替换：transport 为 mock 的来源走这里 */
  mock?: ChatProvider;
}

/**
 * 按来源造出能直接对话的适配器。
 * 订阅类（cli-*）不能这样调用，只能交给对应 CLI 代跑，见 runners/cli。
 */
export async function providerFor(source: ModelSource, deps: ProviderDeps): Promise<ChatProvider> {
  const key = source.secretRef ? await deps.secrets.get(source.secretRef) : undefined;
  switch (source.transport) {
    case 'anthropic':
      if (!key) throw new ProviderError(`“${source.name}”还没填密钥`);
      return new AnthropicProvider({ apiKey: key, ...(source.baseUrl ? { baseUrl: source.baseUrl } : {}), ...(deps.fetch ? { fetch: deps.fetch } : {}) });
    case 'openai':
      if (!source.baseUrl) throw new ProviderError(`“${source.name}”没有填接口地址`);
      if (!key && source.kind !== 'local') throw new ProviderError(`“${source.name}”还没填密钥`);
      return new OpenAIProvider({ baseUrl: source.baseUrl, ...(key ? { apiKey: key } : {}), ...(deps.fetch ? { fetch: deps.fetch } : {}) });
    case 'mock':
      if (!deps.mock) throw new ProviderError('没有配置模拟模型');
      return deps.mock;
    default:
      throw new ProviderError(`“${source.name}”是订阅账号，只能通过它自己的 CLI 调用，不能当 API 用`);
  }
}
