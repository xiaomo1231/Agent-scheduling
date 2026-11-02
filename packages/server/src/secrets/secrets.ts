import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

/** 密钥存取。事件里只存引用名（secretRef），明文只在这里。 */
export interface SecretStore {
  get(ref: string): Promise<string | undefined>;
  set(ref: string, value: string): Promise<void>;
  delete(ref: string): Promise<void>;
  has(ref: string): Promise<boolean>;
}

export class MemorySecrets implements SecretStore {
  private m = new Map<string, string>();
  async get(ref: string) {
    return this.m.get(ref);
  }
  async set(ref: string, value: string) {
    this.m.set(ref, value);
  }
  async delete(ref: string) {
    this.m.delete(ref);
  }
  async has(ref: string) {
    return this.m.has(ref);
  }
}

/** 加解密方式。桌面版用系统钥匙串（Electron safeStorage），命令行版用本地密钥文件。 */
export interface Cipher {
  encrypt(plain: string): string;
  decrypt(data: string): string;
}

/** AES-256-GCM，密钥放在只有自己能读的文件里。比明文好，但不如系统钥匙串。 */
export function localKeyCipher(keyFile: string): Cipher {
  mkdirSync(dirname(keyFile), { recursive: true });
  if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32).toString('base64'), { mode: 0o600 });
  const key = Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'base64');
  if (key.length !== 32) throw new Error(`密钥文件格式不对：${keyFile}`);
  return {
    encrypt(plain) {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
    },
    decrypt(data) {
      const raw = Buffer.from(data, 'base64');
      const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
      d.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
    },
  };
}

/** 加密后存在一个 JSON 文件里，权限 600。 */
export class FileSecrets implements SecretStore {
  constructor(private readonly file: string, private readonly cipher: Cipher) {
    mkdirSync(dirname(file), { recursive: true });
  }
  private read(): Record<string, string> {
    if (!existsSync(this.file)) return {};
    return JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, string>;
  }
  private write(m: Record<string, string>) {
    writeFileSync(this.file, JSON.stringify(m, null, 1), { mode: 0o600 });
    try {
      chmodSync(this.file, 0o600);
    } catch {
      /* Windows 上没有这个概念 */
    }
  }
  async get(ref: string) {
    const v = this.read()[ref];
    return v === undefined ? undefined : this.cipher.decrypt(v);
  }
  async set(ref: string, value: string) {
    const m = this.read();
    m[ref] = this.cipher.encrypt(value);
    this.write(m);
  }
  async delete(ref: string) {
    const m = this.read();
    delete m[ref];
    this.write(m);
  }
  async has(ref: string) {
    return ref in this.read();
  }
}

const PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{12,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{12,}/g,
  /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{16,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
  /((?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?)[^\s"']{6,}/gi,
];

/** 日志、错误信息、发给前端的文字统一过一遍，把已知密钥和常见密钥格式打码。 */
export function redact(text: string, known: readonly string[] = []): string {
  let out = text;
  for (const k of known) if (k && k.length >= 6) out = out.split(k).join('••••');
  for (const re of PATTERNS) out = out.replace(re, (m, p1: unknown) => (typeof p1 === 'string' && m.startsWith(p1) ? p1 + '••••' : '••••'));
  return out;
}
