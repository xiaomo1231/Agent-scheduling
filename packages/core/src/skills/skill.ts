import type { SkillPermissions, SkillPlatform, ToolName } from '../model/types.js';
import { parseYaml, stringifyYaml, type Yaml } from './yaml.js';

export interface SkillDoc {
  frontmatter: Record<string, Yaml>;
  body: string;
}

export interface ZhongshuMeta {
  version: string;
  source: SkillPlatform | 'unknown';
  targets: SkillPlatform[];
  permissions: SkillPermissions;
  requires: { bins: string[]; env: string[]; os: string[] };
  tools: ToolName[];
  invoke: { user: boolean; auto: boolean };
}

export interface GenericSkill {
  name: string;
  description: string;
  license?: string;
  meta: ZhongshuMeta;
  body: string;
  /** 平台专属说明：platform → markdown */
  adapters: Partial<Record<SkillPlatform, string>>;
  /** scripts/、references/ 等附带文件：相对路径 → 内容 */
  files: Record<string, string>;
}

export function parseSkillMd(text: string): SkillDoc {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { frontmatter: {}, body: text };
  return { frontmatter: parseYaml(m[1]!), body: m[2]! };
}

export function renderSkillMd(doc: SkillDoc): string {
  return `---\n${stringifyYaml(doc.frontmatter)}---\n\n${doc.body.replace(/^\n+/, '')}`;
}

// ---------- 工具名映射 ----------
/** 通用工具名 → 各平台叫法 */
export const TOOL_NAMES: Record<ToolName, Partial<Record<SkillPlatform, string>>> = {
  read_file: { 'claude-code': 'Read', codex: 'read_file', 'gemini-cli': 'read_file', opencode: 'read', openclaw: 'read', copilot: 'read' },
  write_file: { 'claude-code': 'Write', codex: 'apply_patch', 'gemini-cli': 'write_file', opencode: 'write', openclaw: 'write', copilot: 'edit' },
  edit_file: { 'claude-code': 'Edit', codex: 'apply_patch', 'gemini-cli': 'replace', opencode: 'edit', openclaw: 'edit', copilot: 'edit' },
  list_files: { 'claude-code': 'Glob', codex: 'shell', 'gemini-cli': 'glob', opencode: 'glob', openclaw: 'read', copilot: 'search' },
  run_command: { 'claude-code': 'Bash', codex: 'shell', 'gemini-cli': 'run_shell_command', opencode: 'bash', openclaw: 'exec', copilot: 'runCommands' },
  web_fetch: { 'claude-code': 'WebFetch', codex: 'web_search', 'gemini-cli': 'web_fetch', opencode: 'webfetch', openclaw: 'web_fetch', copilot: 'fetch' },
  web_search: { 'claude-code': 'WebSearch', codex: 'web_search', 'gemini-cli': 'google_web_search', opencode: 'websearch', openclaw: 'web_search', copilot: 'search' },
  send_message: { openclaw: 'message' },
};

/** 平台工具名 → 通用名（反查） */
export function toGenericTool(name: string): ToolName | null {
  const base = name.replace(/\(.*\)$/, '').trim();
  for (const [g, map] of Object.entries(TOOL_NAMES) as [ToolName, Partial<Record<SkillPlatform, string>>][]) {
    if (g === base || Object.values(map).some((v) => v?.toLowerCase() === base.toLowerCase())) return g;
  }
  return null;
}

/** 各平台的 skills 目录（用户级）。项目级见 projectSkillDir。 */
export const USER_SKILL_DIR: Partial<Record<SkillPlatform, string>> = {
  'claude-code': '~/.claude/skills',
  codex: '~/.codex/skills',
  'gemini-cli': '~/.gemini/skills',
  opencode: '~/.config/opencode/skills',
  openclaw: '~/.openclaw/skills',
  zhongshu: '~/.zhongshu/skills',
};
export const PROJECT_SKILL_DIR: Partial<Record<SkillPlatform, string>> = {
  'claude-code': '.claude/skills',
  codex: '.codex/skills',
  'gemini-cli': '.gemini/skills',
  opencode: '.opencode/skills',
  openclaw: 'skills',
  zhongshu: '.zhongshu/skills',
};

// ---------- 校验 ----------
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function validateGeneric(s: GenericSkill): string[] {
  const issues: string[] = [];
  if (!NAME_RE.test(s.name)) issues.push('name 只能用小写字母、数字和短横线，最多 64 个字符');
  if (!s.description || s.description.length < 10) issues.push('description 太短，模型靠它判断什么时候用这个 skill');
  if (s.description.length > 1024) issues.push('description 超过 1024 个字符');
  if (!s.body.trim()) issues.push('正文是空的');
  for (const host of s.meta.permissions.network) if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) issues.push(`网络权限“${host}”应写成域名`);
  if (s.meta.permissions.shell.length && !s.meta.tools.includes('run_command')) issues.push('申请了命令权限但工具里没有 run_command');
  for (const f of Object.keys(s.files)) if (f.startsWith('/') || f.split('/').includes('..')) issues.push(`文件路径“${f}”越出了 skill 文件夹`);
  return issues;
}

// ---------- 静态扫描 ----------
export type ScanLevel = 'high' | 'medium' | 'info';
export interface ScanFinding { level: ScanLevel; file: string; line: number; message: string }

const RULES: [RegExp, ScanLevel, string][] = [
  [/(curl|wget)[^\n|]*\|\s*(ba|z)?sh\b/i, 'high', '下载后直接执行脚本'],
  [/base64\s+(-d|--decode)[^\n]*\|\s*(ba)?sh|eval\s*\(\s*(atob|Buffer\.from)/i, 'high', '解码后执行，可能藏了命令'],
  [/(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|xox[bp]-[A-Za-z0-9-]{20,})/, 'high', '写死了密钥'],
  [/~\/\.ssh|id_rsa|\.aws\/credentials|\.netrc|Keychain|security\s+find-generic-password/i, 'high', '读取登录凭据或密钥'],
  [/ignore (all )?(previous|prior) instructions|忽略(之前|以上|前面)的(所有)?(指令|要求)/i, 'high', '正文里有“忽略之前指令”这类话'],
  [/\brm\s+-rf\s+(\/|~|\$HOME)/, 'high', '删除根目录或主目录'],
  [/\bsudo\b/, 'medium', '要求提权'],
  [/(\/Users\/[^/\s]+|\/home\/[^/\s]+|C:\\Users\\[^\\\s]+|~\/Desktop)/, 'medium', '写死了某台电脑上的路径'],
  [/https?:\/\/[^\s)'"]+/, 'info', '会访问外部地址'],
];

export function scanSkill(files: Record<string, string>): ScanFinding[] {
  const out: ScanFinding[] = [];
  for (const [file, text] of Object.entries(files)) {
    text.split(/\r?\n/).forEach((line, i) => {
      for (const [re, level, message] of RULES) if (re.test(line)) out.push({ level, file, line: i + 1, message });
    });
  }
  const order = { high: 0, medium: 1, info: 2 };
  return out.sort((a, b) => order[a.level] - order[b.level]);
}

// ---------- 识别来源 + 规则转换 ----------
export function detectPlatform(files: Record<string, string>): SkillPlatform | 'unknown' {
  const names = Object.keys(files);
  if (names.some((n) => /\.mdc$/.test(n) || n.includes('.cursor/rules'))) return 'cursor';
  if (names.some((n) => /copilot-instructions\.md$|\.instructions\.md$/.test(n))) return 'copilot';
  if (names.some((n) => /gemini-extension\.json$/.test(n))) return 'gemini-cli';
  const md = files['SKILL.md'];
  if (md) {
    const fm = parseSkillMd(md).frontmatter;
    const meta = fm.metadata as Record<string, Yaml> | undefined;
    if (meta && typeof meta === 'object' && 'zhongshu' in meta) return 'zhongshu';
    if (meta && typeof meta === 'object' && ('openclaw' in meta || 'clawdbot' in meta)) return 'openclaw';
    if ('allowed-tools' in fm || /\b(TodoWrite|Bash\(|WebFetch|Task tool)\b/.test(md)) return 'claude-code';
    if (/\bapply_patch\b|\$[a-z-]+ skill|codex/i.test(md)) return 'codex';
    return 'claude-code';
  }
  return 'unknown';
}

export interface ConvertResult {
  skill: GenericSkill;
  /** 规则能确定的改动 */
  changes: string[];
  /** 规则拿不准、交给转换 agent 处理的地方 */
  todo: string[];
}

const str = (v: Yaml | undefined): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
const arr = (v: Yaml | undefined): string[] => (Array.isArray(v) ? v.map(str) : typeof v === 'string' ? v.split(/[\s,]+/).filter(Boolean) : []);

/**
 * 规则部分的转换：把能确定的东西改成通用模板。剩下的（正文里平台专属的说法）
 * 列进 todo，由转换 agent 处理。
 */
export function convertToGeneric(files: Record<string, string>, opts: { name?: string } = {}): ConvertResult {
  const source = detectPlatform(files);
  const changes: string[] = [];
  const todo: string[] = [];
  let fm: Record<string, Yaml> = {};
  let body = '';
  if (files['SKILL.md']) ({ frontmatter: fm, body } = parseSkillMd(files['SKILL.md']));
  else {
    const first = Object.entries(files)[0];
    body = first ? first[1] : '';
    changes.push(`把 ${first?.[0] ?? '内容'} 变成 SKILL.md 正文`);
  }

  const tools = new Set<ToolName>();
  const shell = new Set<string>();
  for (const t of arr(fm['allowed-tools'])) {
    const g = toGenericTool(t);
    if (g) tools.add(g);
    const m = t.match(/^Bash\(([^:)\s]+)/);
    if (m) shell.add(m[1]!);
  }
  if (fm['allowed-tools'] !== undefined) changes.push('allowed-tools 改写成 metadata.zhongshu.tools 和 permissions');

  // 正文里出现的平台工具名换成通用名
  let newBody = body;
  for (const [g, map] of Object.entries(TOOL_NAMES) as [ToolName, Partial<Record<SkillPlatform, string>>][]) {
    const native = source !== 'unknown' ? map[source as SkillPlatform] : undefined;
    if (native && native.length > 3 && new RegExp(`\\b${native}\\b`).test(newBody)) {
      newBody = newBody.replace(new RegExp(`\\b${native}\\b`, 'g'), g);
      tools.add(g);
      changes.push(`正文里的 ${native} 改成通用名 ${g}`);
    }
  }
  const home = /(\/Users\/[^/\s]+|\/home\/[^/\s]+|~)\/Desktop/g;
  if (home.test(newBody)) { newBody = newBody.replace(home, '{baseDir}/output'); changes.push('写死的桌面路径改成 {baseDir}/output'); }
  if (/\bTodoWrite\b|\bTask tool\b|\bsubagent_type\b/.test(newBody)) todo.push('正文里有 Claude Code 专属的用法（TodoWrite / Task），需要改写或移到 adapters/claude-code.md');

  const urls = new Set<string>();
  for (const text of Object.values(files)) for (const m of text.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) urls.add(m[1]!.toLowerCase());
  for (const [f, text] of Object.entries(files)) {
    if (!f.startsWith('scripts/')) continue;
    if (/\.py$/.test(f)) shell.add('python3');
    if (/\.(js|mjs|ts)$/.test(f)) shell.add('node');
    if (/\.sh$/.test(f)) shell.add('bash');
    if (/requests\.|fetch\(|urllib/.test(text)) tools.add('web_fetch');
  }
  if (shell.size) tools.add('run_command');

  const oc = (fm.metadata as Record<string, Yaml> | undefined)?.openclaw as Record<string, Yaml> | undefined;
  const ocReq = (oc?.requires ?? {}) as Record<string, Yaml>;

  const name = (opts.name ?? str(fm.name) ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'imported-skill';
  if (name !== str(fm.name)) changes.push(`name 规范成 ${name}`);

  const skill: GenericSkill = {
    name,
    description: str(fm.description) || newBody.split('\n').find((l) => l.trim() && !l.startsWith('#'))?.trim().slice(0, 200) || '',
    ...(fm.license ? { license: str(fm.license) } : {}),
    meta: {
      version: str((fm.metadata as Record<string, Yaml> | undefined)?.version) || '1.0.0',
      source,
      targets: ['claude-code', 'codex', 'gemini-cli', 'opencode', 'zhongshu'],
      permissions: {
        files: tools.has('write_file') || tools.has('edit_file') ? 'write' : tools.has('read_file') || tools.has('list_files') ? 'read' : 'none',
        shell: [...shell, ...arr(ocReq.bins)].filter((v, i, a) => a.indexOf(v) === i),
        network: [...urls],
        sendMessage: tools.has('send_message'),
      },
      requires: { bins: [...shell, ...arr(ocReq.bins)].filter((v, i, a) => a.indexOf(v) === i), env: arr(ocReq.env), os: arr(oc?.os) },
      tools: [...tools],
      invoke: { user: fm['user-invocable'] !== false, auto: fm['disable-model-invocation'] !== true },
    },
    body: newBody,
    adapters: {},
    files: Object.fromEntries(Object.entries(files).filter(([f]) => f !== 'SKILL.md')),
  };
  if (!skill.description) todo.push('缺 description，需要根据正文写一句“做什么、什么时候用”');
  return { skill, changes, todo };
}

export function genericToDoc(s: GenericSkill): SkillDoc {
  const p = s.meta.permissions;
  return {
    frontmatter: {
      name: s.name,
      description: s.description,
      ...(s.license ? { license: s.license } : {}),
      metadata: {
        zhongshu: {
          version: s.meta.version, source: s.meta.source, targets: s.meta.targets,
          permissions: { files: p.files, shell: p.shell, network: p.network, send_message: p.sendMessage },
          requires: { bins: s.meta.requires.bins, env: s.meta.requires.env, os: s.meta.requires.os },
          tools: s.meta.tools,
          invoke: { user: s.meta.invoke.user, auto: s.meta.invoke.auto },
        },
      },
    },
    body: s.body,
  };
}

export function docToGeneric(doc: SkillDoc, files: Record<string, string> = {}): GenericSkill {
  const z = ((doc.frontmatter.metadata as Record<string, Yaml>)?.zhongshu ?? {}) as Record<string, Yaml>;
  const p = (z.permissions ?? {}) as Record<string, Yaml>;
  const r = (z.requires ?? {}) as Record<string, Yaml>;
  const inv = (z.invoke ?? {}) as Record<string, Yaml>;
  const adapters: GenericSkill['adapters'] = {};
  const rest: Record<string, string> = {};
  for (const [f, t] of Object.entries(files)) {
    const m = f.match(/^adapters\/([a-z-]+)\.md$/);
    if (m) adapters[m[1] as SkillPlatform] = t; else if (f !== 'SKILL.md') rest[f] = t;
  }
  return {
    name: str(doc.frontmatter.name), description: str(doc.frontmatter.description),
    ...(doc.frontmatter.license ? { license: str(doc.frontmatter.license) } : {}),
    meta: {
      version: str(z.version) || '1.0.0', source: (str(z.source) || 'unknown') as GenericSkill['meta']['source'],
      targets: arr(z.targets) as SkillPlatform[],
      permissions: { files: (str(p.files) || 'none') as SkillPermissions['files'], shell: arr(p.shell), network: arr(p.network), sendMessage: p.send_message === true },
      requires: { bins: arr(r.bins), env: arr(r.env), os: arr(r.os) },
      tools: arr(z.tools) as ToolName[],
      invoke: { user: inv.user !== false, auto: inv.auto !== false },
    },
    body: doc.body, adapters, files: rest,
  };
}

/** 生成通用模板的全部文件（SKILL.md + adapters + 附带文件）。 */
export function renderGeneric(s: GenericSkill): Record<string, string> {
  const out: Record<string, string> = { 'SKILL.md': renderSkillMd(genericToDoc(s)) };
  for (const [p, t] of Object.entries(s.adapters)) if (t) out[`adapters/${p}.md`] = t;
  return { ...out, ...s.files };
}

/** 投放：给某个平台生成它自己的格式。通用工具名换回平台叫法，合并该平台的 adapters 内容。 */
export function renderForPlatform(s: GenericSkill, platform: SkillPlatform): Record<string, string> {
  if (platform === 'zhongshu') return renderGeneric(s);
  let body = s.body;
  for (const [g, map] of Object.entries(TOOL_NAMES) as [ToolName, Partial<Record<SkillPlatform, string>>][]) {
    const native = map[platform];
    if (native) body = body.replace(new RegExp(`\\b${g}\\b`, 'g'), native);
  }
  const extra = s.adapters[platform];
  if (extra) body = body.trimEnd() + '\n\n' + extra.trim() + '\n';
  const fm: Record<string, Yaml> = { name: s.name, description: s.description };
  if (s.license) fm.license = s.license;
  if (platform === 'claude-code') {
    const tools = s.meta.tools.map((t) => TOOL_NAMES[t]['claude-code']).filter(Boolean) as string[];
    const bash = s.meta.permissions.shell.map((b) => `Bash(${b}:*)`);
    const list = [...new Set([...tools.filter((t) => t !== 'Bash'), ...bash])];
    if (list.length) fm['allowed-tools'] = list.join(' ');
    if (!s.meta.invoke.auto) fm['disable-model-invocation'] = true;
  }
  if (platform === 'openclaw') {
    fm.metadata = { openclaw: { requires: { bins: s.meta.requires.bins, env: s.meta.requires.env }, ...(s.meta.requires.os.length ? { os: s.meta.requires.os } : {}) } };
    if (!s.meta.invoke.user) fm['user-invocable'] = false;
  }
  return { 'SKILL.md': renderSkillMd({ frontmatter: fm, body }), ...s.files };
}
