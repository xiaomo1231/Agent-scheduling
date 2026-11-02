import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSecrets, localKeyCipher, redact } from './index.js';

describe('secrets', () => {
  it('文件里不出现明文，能读回来', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zs-'));
    const s = new FileSecrets(join(dir, 's.json'), localKeyCipher(join(dir, 'k')));
    await s.set('src_1', 'sk-very-secret-value-123');
    expect(readFileSync(join(dir, 's.json'), 'utf8')).not.toContain('very-secret');
    expect(await s.get('src_1')).toBe('sk-very-secret-value-123');
    await s.delete('src_1');
    expect(await s.has('src_1')).toBe(false);
  });
  it('打码已知密钥和常见格式', () => {
    expect(redact('api_key=abc123456 x', [])).toBe('api_key=•••• x');
    expect(redact('用 sk-abcdefghijklmnop 调用')).toBe('用 •••• 调用');
    expect(redact('Authorization: Bearer abcdefghijklmnop')).toContain('Bearer ••••');
    expect(redact('hello mysecretvalue', ['mysecretvalue'])).toBe('hello ••••');
  });
});
