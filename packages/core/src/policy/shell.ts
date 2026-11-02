// 把命令行拆成若干段，每段再拆成参数。只做判断用，不负责真正执行。

export interface Segment {
  /** 程序名（去掉路径和 .exe） */
  program: string;
  args: string[];
  raw: string;
}

export interface ParsedCommand {
  segments: Segment[];
  /** 出现了 $(...)、反引号、进程替换这类“命令里套命令” */
  hasSubstitution: boolean;
  /** 有管道到 shell 的写法，如 curl ... | sh */
  pipesToShell: boolean;
  /** 有重定向写文件（> 或 >>） */
  redirectsToFile: boolean;
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'pwsh', 'powershell', 'cmd']);

function tokenize(input: string): { tokens: string[]; ops: string[] } {
  const tokens: string[] = [];
  const ops: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  const push = () => { if (has) { tokens.push(cur); cur = ''; has = false; } };
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (quote) {
      if (c === quote) { quote = null; continue; }
      if (c === '\\' && quote === '"' && i + 1 < input.length) { cur += input[++i]; continue; }
      cur += c; continue;
    }
    if (c === '"' || c === "'") { quote = c; has = true; continue; }
    if (c === '\\' && i + 1 < input.length) { cur += input[++i]; has = true; continue; }
    if (/\s/.test(c)) { push(); continue; }
    const two = input.slice(i, i + 2);
    if (two === '&&' || two === '||' || two === '>>') { push(); tokens.push(two); ops.push(two); i++; continue; }
    if (c === '|' || c === ';' || c === '&' || c === '>' || c === '<' || c === '\n') { push(); tokens.push(c); ops.push(c); continue; }
    cur += c; has = true;
  }
  push();
  return { tokens, ops };
}

function baseName(p: string): string {
  const b = p.split(/[\\/]/).pop() ?? p;
  return b.replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
}

export function parseCommand(input: string): ParsedCommand {
  const hasSubstitution = /\$\(|`|<\(|>\(/.test(input);
  const { tokens } = tokenize(input);
  const segments: Segment[] = [];
  let cur: string[] = [];
  let redirectsToFile = false;
  let pipesToShell = false;
  let afterPipe = false;
  let skipNext = false;
  const flush = () => {
    if (cur.length) {
      // 跳过前面的环境变量赋值，如 FOO=1 npm test
      let i = 0;
      while (i < cur.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(cur[i]!)) i++;
      const prog = cur[i];
      if (prog !== undefined) {
        const program = baseName(prog);
        if (afterPipe && SHELLS.has(program)) pipesToShell = true;
        segments.push({ program, args: cur.slice(i + 1), raw: cur.join(' ') });
      }
    }
    cur = [];
  };
  for (const t of tokens) {
    if (skipNext) { skipNext = false; continue; }
    if (t === '>' || t === '>>') { redirectsToFile = true; skipNext = true; continue; }
    if (t === '<') { skipNext = true; continue; }
    if (t === '|' ) { flush(); afterPipe = true; continue; }
    if (t === '&&' || t === '||' || t === ';' || t === '&' || t === '\n') { flush(); afterPipe = false; continue; }
    cur.push(t);
  }
  flush();
  return { segments, hasSubstitution, pipesToShell, redirectsToFile };
}

const INLINE_FLAGS: Record<string, string[]> = {
  python: ['-c'], python3: ['-c'], py: ['-c'],
  node: ['-e', '--eval', '-p', '--print'], deno: ['eval'], bun: ['-e', '--eval'],
  ruby: ['-e'], perl: ['-e', '-E'], php: ['-r'],
  bash: ['-c'], sh: ['-c'], zsh: ['-c'], dash: ['-c'], fish: ['-c'],
  pwsh: ['-c', '-command', '-encodedcommand'], powershell: ['-c', '-command', '-encodedcommand'], cmd: ['/c', '/k'],
  osascript: ['-e'],
};

/** python -c、node -e 这类直接执行一段代码的写法 */
export function isInlineEval(seg: Segment): boolean {
  const flags = INLINE_FLAGS[seg.program];
  if (!flags) return false;
  return seg.args.some((a) => flags.includes(a.toLowerCase()));
}
