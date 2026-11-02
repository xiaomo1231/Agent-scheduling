import { spawn } from 'node:child_process';

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ExecOptions {
  cwd: string;
  timeoutMs?: number;
  input?: string;
  env?: Record<string, string | undefined>;
  /** 输出超过这么多字就截断，防止撑爆上下文 */
  maxOutput?: number;
  signal?: AbortSignal;
}

/** 跑一个程序（参数数组，不经过 shell）。 */
export type ExecFile = (program: string, args: readonly string[], opts: ExecOptions) => Promise<ExecResult>;
/** 跑一整条命令行（经过系统 shell）。只给已经过审批的命令用。 */
export type ExecShell = (command: string, opts: ExecOptions) => Promise<ExecResult>;

function collect(child: ReturnType<typeof spawn>, opts: ExecOptions): Promise<ExecResult> {
  const max = opts.maxOutput ?? 60_000;
  let stdout = '', stderr = '', timedOut = false;
  const cap = (s: string, add: string) => (s.length >= max ? s : (s + add).slice(0, max));
  child.stdout?.on('data', (d: Buffer) => (stdout = cap(stdout, d.toString('utf8'))));
  child.stderr?.on('data', (d: Buffer) => (stderr = cap(stderr, d.toString('utf8'))));
  if (opts.input !== undefined) child.stdin?.end(opts.input);
  else child.stdin?.end();
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, opts.timeoutMs ?? 120_000);
  return new Promise((resolve) => {
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(err.message), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/** 子进程只拿到最少的环境变量，不把中枢自己的密钥漏出去。 */
export function safeEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const keep = ['PATH', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'ComSpec', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'SHELL', 'USER', 'LOGNAME'];
  const out: Record<string, string> = {};
  for (const k of keep) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) out[k] = v;
  return out;
}

export const execFile: ExecFile = (program, args, opts) =>
  collect(spawn(program, [...args], { cwd: opts.cwd, env: safeEnv(opts.env), shell: false, windowsHide: true, ...(opts.signal ? { signal: opts.signal } : {}) }), opts);

export const execShell: ExecShell = (command, opts) => {
  const win = process.platform === 'win32';
  const [sh, flag] = win ? ['cmd.exe', '/d /s /c'] : ['/bin/sh', '-c'];
  const args = win ? [...flag.split(' '), command] : [flag, command];
  return collect(spawn(sh, args, { cwd: opts.cwd, env: safeEnv(opts.env), shell: false, windowsHide: true, ...(opts.signal ? { signal: opts.signal } : {}) }), opts);
};
