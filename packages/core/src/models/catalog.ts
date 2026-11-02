import type { ModelChoice, ModelEntry, ModelGroup, ModelRef, ModelSource, Purpose, SourceKind, ModelTransport } from '../model/types.js';

/** 思考强度挡位跟着模型走，每家叫法不一样。 */
export function effortLevels(modelLabelOrId: string): string[] {
  const m = modelLabelOrId;
  if (/opus|fable|sonnet|haiku|mythos/i.test(m)) return ['低', '中', '高', '超高', '最高'];
  if (/gpt-6/i.test(m)) return ['最少', '低', '中', '高', '超高'];
  if (/gpt-5|o\d/i.test(m)) return ['最少', '低', '中', '高'];
  if (/gemini/i.test(m)) return ['低', '高'];
  if (/doubao/i.test(m)) return ['不思考', '自动', '深度思考'];
  if (/deepseek|glm|kimi|qwen|mimo|minimax/i.test(m)) return ['快速', '深度思考'];
  return ['默认'];
}

export function normalizeEffort(model: string, wanted: string | undefined): string {
  const L = effortLevels(model);
  if (wanted && L.includes(wanted)) return wanted;
  return L.includes('高') ? '高' : L[0]!;
}

/** 把中文挡位翻译成各家 API 的参数。 */
export type AnthropicEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/**
 * 把中文挡位翻译成各家 API 的参数。
 * Claude 现行模型用自适应思考 + output_config.effort（固定思考预算已被淘汰）。
 */
export function effortToApi(model: string, effort: string): { anthropicEffort?: AnthropicEffort; openaiEffort?: 'minimal' | 'low' | 'medium' | 'high'; thinking?: boolean } {
  const e = normalizeEffort(model, effort);
  if (/opus|fable|sonnet|haiku|mythos/i.test(model)) {
    const map: Record<string, AnthropicEffort> = { 低: 'low', 中: 'medium', 高: 'high', 超高: 'xhigh', 最高: 'max' };
    return { anthropicEffort: map[e] ?? 'high' };
  }
  if (/gpt|o\d/i.test(model)) {
    const map: Record<string, 'minimal' | 'low' | 'medium' | 'high'> = { 最少: 'minimal', 低: 'low', 中: 'medium', 高: 'high', 超高: 'high' };
    return { openaiEffort: map[e] ?? 'medium' };
  }
  return { thinking: e === '深度思考' || e === '自动' };
}

export interface ResolvedModel {
  source: ModelSource;
  model: ModelEntry;
  backup?: { source: ModelSource; model: ModelEntry };
  effort?: string;
}

function find(sources: Record<string, ModelSource>, ref: ModelRef | null): { source: ModelSource; model: ModelEntry } | null {
  if (!ref) return null;
  const source = sources[ref.sourceId];
  const model = source?.models.find((m) => m.id === ref.modelId);
  return source && model ? { source, model } : null;
}

/** 把“具体模型”或“某组的某个用途”解析成真正要调用的模型（带备用）。 */
export function resolveChoice(choice: ModelChoice | null, sources: Record<string, ModelSource>, groups: Record<string, ModelGroup>): ResolvedModel | null {
  if (!choice) return null;
  if (choice.kind === 'model') return find(sources, choice.ref);
  const g = groups[choice.groupId];
  const role = g?.roles.find((r) => r.purpose === choice.purpose);
  if (!role) return null;
  const main = find(sources, role.model);
  if (!main) return null;
  const backup = find(sources, role.backup) ?? undefined;
  return { ...main, ...(backup ? { backup } : {}), ...(role.effort ? { effort: role.effort } : {}) };
}

export function choiceLabel(choice: ModelChoice | null, sources: Record<string, ModelSource>, groups: Record<string, ModelGroup>): string {
  if (!choice) return '未选';
  if (choice.kind === 'group') {
    const g = groups[choice.groupId];
    const r = resolveChoice(choice, sources, groups);
    return `${g?.name ?? '?'}组 · ${choice.purpose}${r ? `（${r.model.label}）` : ''}`;
  }
  const r = find(sources, choice.ref);
  return r ? `${r.model.label}（${r.source.name}）` : '已失效的模型';
}

/** 用订阅额度的模型由官方 CLI 代跑，只能派活。 */
export function runsViaCli(t: ModelTransport): boolean {
  return t.startsWith('cli-');
}

export interface ProviderPreset {
  name: string;
  kind: SourceKind;
  transport: ModelTransport;
  baseUrl?: string;
  multiVendor?: boolean;
  models: [id: string, label: string, vendor: string][];
  note?: string;
}

/** 添加来源时可选的常见服务。地址和模型名以各家文档为准，用户可改。 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  { name: 'Claude Pro / Max（Claude Code 登录）', kind: 'subscription', transport: 'cli-claude', models: [['opus', 'Opus', 'Anthropic'], ['fable', 'Fable', 'Anthropic'], ['sonnet', 'Sonnet', 'Anthropic'], ['haiku', 'Haiku', 'Anthropic']] },
  { name: 'ChatGPT Plus / Pro（Codex CLI 登录）', kind: 'subscription', transport: 'cli-codex', models: [['gpt-6-astra', 'GPT-6 Astra', 'OpenAI'], ['gpt-5', 'GPT-5 系列', 'OpenAI'], ['gpt-5-codex', 'GPT-5 Codex', 'OpenAI']] },
  { name: 'Google AI Pro（Gemini CLI 登录）', kind: 'subscription', transport: 'cli-gemini', models: [['gemini-pro', 'Gemini Pro', 'Google'], ['gemini-flash', 'Gemini Flash', 'Google']] },
  { name: '智谱 GLM Coding Plan', kind: 'plan', transport: 'anthropic', baseUrl: 'https://open.bigmodel.cn/api/anthropic', models: [['glm-5.3', 'GLM-5.3', '智谱'], ['glm-5.3-flash', 'GLM-5.3-Flash', '智谱']] },
  { name: 'Kimi Code Plan', kind: 'plan', transport: 'anthropic', baseUrl: 'https://api.kimi.com/coding', models: [['kimi-k3', 'Kimi K3', '月之暗面']] },
  { name: 'OpenCode Go（多家模型）', kind: 'plan', transport: 'openai', baseUrl: 'https://opencode.ai/zen/go/v1', multiVendor: true, models: [['deepseek-v4-pro', 'DeepSeek V4 Pro', 'DeepSeek'], ['deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', 'DeepSeek'], ['kimi-k3', 'Kimi K3', '月之暗面'], ['glm-5.3', 'GLM-5.3', '智谱'], ['qwen3.8-max', 'Qwen3.8 Max', '阿里'], ['minimax-m3', 'MiniMax M3', 'MiniMax']] },
  { name: '火山方舟 Coding Plan（多家模型）', kind: 'plan', transport: 'openai', baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3', multiVendor: true, models: [['doubao-seed-code', 'Doubao', '字节'], ['glm-5.3', 'GLM-5.3', '智谱'], ['kimi-k3', 'Kimi K3', '月之暗面'], ['deepseek-v4.1', 'DeepSeek V4.1', 'DeepSeek']] },
  { name: '阿里云百炼 Coding Plan（多家模型）', kind: 'plan', transport: 'openai', baseUrl: 'https://coding.dashscope.aliyuncs.com/v1', multiVendor: true, models: [['qwen3.8-max', 'Qwen3.8 Max', '阿里'], ['deepseek-v4-pro', 'DeepSeek V4 Pro', 'DeepSeek']] },
  { name: 'DeepSeek API', kind: 'apikey', transport: 'openai', baseUrl: 'https://api.deepseek.com/v1', models: [['deepseek-v4-pro', 'DeepSeek V4 Pro', 'DeepSeek'], ['deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', 'DeepSeek']], note: 'DeepSeek 官方没有 Coding Plan，包月请选 OpenCode Go、火山方舟或百炼' },
  { name: 'Anthropic API', kind: 'apikey', transport: 'anthropic', baseUrl: 'https://api.anthropic.com', models: [['claude-fable-5-1', 'Fable', 'Anthropic'], ['claude-opus-5-5', 'Opus', 'Anthropic'], ['claude-sonnet-5-5', 'Sonnet', 'Anthropic'], ['claude-haiku-5-5', 'Haiku', 'Anthropic']] },
  { name: 'OpenAI API', kind: 'apikey', transport: 'openai', baseUrl: 'https://api.openai.com/v1', models: [['gpt-5', 'GPT-5 系列', 'OpenAI']] },
  { name: 'OpenRouter（多家模型）', kind: 'apikey', transport: 'openai', baseUrl: 'https://openrouter.ai/api/v1', multiVendor: true, models: [] },
  { name: '自定义（OpenAI 兼容）', kind: 'apikey', transport: 'openai', models: [] },
  { name: 'Ollama（本地）', kind: 'local', transport: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', models: [] },
  { name: 'LM Studio（本地）', kind: 'local', transport: 'openai', baseUrl: 'http://127.0.0.1:1234/v1', models: [] },
];

export const PURPOSES: Purpose[] = ['协调', '写提示词', '执行', '审查', '整理', '摘要', '测试'];
