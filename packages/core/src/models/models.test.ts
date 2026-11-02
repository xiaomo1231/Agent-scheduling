import { describe, it, expect } from 'vitest';
import { effortLevels, normalizeEffort, effortToApi, resolveChoice } from './index.js';
import type { ModelGroup, ModelSource } from '../model/types.js';

describe('思考强度', () => {
  it('挡位跟着模型变', () => {
    expect(effortLevels('Opus')).toHaveLength(5);
    expect(effortLevels('GPT-6 Astra')).toContain('超高');
    expect(effortLevels('GLM-5.3')).toEqual(['快速', '深度思考']);
  });
  it('不合法的挡位落到默认', () => {
    expect(normalizeEffort('GLM-5.3', '最高')).toBe('快速');
    expect(normalizeEffort('Opus', undefined)).toBe('高');
  });
  it('翻译成 API 参数', () => {
    expect(effortToApi('Opus', '最高').anthropicEffort).toBe('max');
    expect(effortToApi('claude-opus-5-5', '超高').anthropicEffort).toBe('xhigh');
    expect(effortToApi('GPT-5 系列', '低').openaiEffort).toBe('low');
    expect(effortToApi('GLM-5.3', '深度思考').thinking).toBe(true);
  });
});

describe('resolveChoice', () => {
  const sources: Record<string, ModelSource> = {
    glm: { id: 'glm', kind: 'plan', name: 'GLM', transport: 'anthropic', models: [{ id: 'glm-5.3', label: 'GLM-5.3', vendor: '智谱', enabled: true }] },
    oc: { id: 'oc', kind: 'plan', name: 'OpenCode Go', transport: 'openai', models: [{ id: 'glm-5.3', label: 'GLM-5.3', vendor: '智谱', enabled: true }] },
  };
  const groups: Record<string, ModelGroup> = {
    g: { id: 'g', name: '代码', roles: [{ purpose: '执行', model: { sourceId: 'glm', modelId: 'glm-5.3' }, backup: { sourceId: 'oc', modelId: 'glm-5.3' }, effort: '快速' }] },
  };
  it('用途解析出主用和备用', () => {
    const r = resolveChoice({ kind: 'group', groupId: 'g', purpose: '执行' }, sources, groups)!;
    expect(r.source.id).toBe('glm');
    expect(r.backup?.source.id).toBe('oc');
    expect(r.effort).toBe('快速');
  });
  it('找不到返回 null', () => {
    expect(resolveChoice({ kind: 'model', ref: { sourceId: 'x', modelId: 'y' } }, sources, groups)).toBeNull();
  });
});
