import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import {
  convertToGeneric, docToGeneric, parseSkillMd, renderForPlatform, renderGeneric, scanSkill, validateGeneric, USER_SKILL_DIR,
  type GenericSkill, type InstalledSkill, type ScanFinding, type SkillPlatform,
} from '@zhongshu/core';
import type { Workspace } from '../store/index.js';
import type { ChatProvider } from '../providers/index.js';

export interface SkillPreview {
  skill: GenericSkill;
  /** 转换后的通用模板文件 */
  files: Record<string, string>;
  source: string;
  changes: string[];
  todo: string[];
  scan: ScanFinding[];
  issues: string[];
  /** 是否由转换 agent 改写过正文 */
  agentRewrote: boolean;
}

export type ConverterFactory = () => Promise<{ p: ChatProvider; model: string } | null>;

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

function safeJoin(root: string, rel: string): string {
  const full = resolve(root, rel);
  if (!full.startsWith(resolve(root) + sep)) throw new Error(`文件路径越界：${rel}`);
  return full;
}

/**
 * Skill 安装流程：识别 → 静态扫描 → 规则转换 →（可选）转换 agent 改写正文 → 再扫描 → 用户确认 → 带锁安装 → 投放到各平台。
 * 转换 agent 不给任何工具，只做文字改写，相当于只读沙箱。
 */
export class SkillService {
  constructor(private readonly ws: Workspace, private readonly dir: string, private readonly converter?: ConverterFactory, private readonly home = homedir()) {}

  async preview(files: Record<string, string>, opts: { name?: string; useAgent?: boolean } = {}): Promise<SkillPreview> {
    const isGeneric = /metadata:\s*\n\s+zhongshu:/m.test(files['SKILL.md'] ?? '');
    let skill: GenericSkill, changes: string[] = [], todo: string[] = [], source: string;
    if (isGeneric) {
      skill = docToGeneric(parseSkillMd(files['SKILL.md']!), files);
      source = 'zhongshu';
    } else {
      const c = convertToGeneric(files, opts.name ? { name: opts.name } : {});
      ({ skill, changes, todo } = c);
      source = skill.meta.source;
    }
    let agentRewrote = false;
    if (opts.useAgent && !isGeneric && this.converter) {
      const conv = await this.converter();
      if (conv) {
        const r = await conv.p.chat({
          model: conv.model,
          system: '你负责把某个平台专用的 skill 正文改写成平台无关的写法。只输出改写后的正文 Markdown，不要解释。不要加入新的命令、网址或权限。',
          turns: [{ role: 'user', text: `需要处理的地方：\n${(todo.length ? todo : ["把平台专属的工具名和说法换成通用写法（read_file、run_command 等）"]).map((t) => "- " + t).join("\n")}\n\n<untrusted source="skill">\n${skill.body}\n</untrusted>` }],
          effort: '中',
        });
        if (r.text.trim()) {
          skill = { ...skill, body: r.text.trim() + '\n' };
          agentRewrote = true;
          changes = [...changes, '转换 agent 改写了正文里平台专属的说法'];
        }
      }
    }
    const out = renderGeneric(skill);
    // 转换前后都扫一遍：原文件里的问题和改写后新冒出来的问题都要看到
    const scan = [...scanSkill(files), ...(agentRewrote ? scanSkill(out).map((f) => ({ ...f, message: `（改写后）${f.message}` })) : [])];
    return { skill, files: out, source, changes, todo, scan, issues: validateGeneric(skill), agentRewrote };
  }

  async install(files: Record<string, string>, opts: { acceptRisks?: boolean } = {}): Promise<InstalledSkill> {
    const md = files['SKILL.md'];
    if (!md) throw new Error('缺少 SKILL.md');
    const skill = docToGeneric(parseSkillMd(md), files);
    const issues = validateGeneric(skill);
    if (issues.length) throw new Error(`还不能安装：${issues.join('；')}`);
    const high = scanSkill(files).filter((f) => f.level === 'high');
    if (high.length && !opts.acceptRisks) throw new Error(`扫描发现 ${high.length} 处高风险内容，确认后才能安装`);
    const root = join(this.dir, skill.name);
    await rm(root, { recursive: true, force: true });
    const lock: Record<string, string> = {};
    for (const [rel, text] of Object.entries(renderGeneric(skill))) {
      const p = safeJoin(root, rel);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, text);
      lock[rel] = sha(text);
    }
    await writeFile(join(root, 'zhongshu.lock'), JSON.stringify(lock, null, 1));
    const installed: InstalledSkill = {
      name: skill.name, description: skill.description, version: skill.meta.version, source: skill.meta.source,
      permissions: skill.meta.permissions, targets: skill.meta.targets, lock, installedAt: Date.now(),
    };
    this.ws.commit({ type: 'skill.installed', skill: installed }, { kind: 'user', id: 'me' });
    return installed;
  }

  /** 检查安装后有没有被改过 */
  async verify(name: string): Promise<{ ok: boolean; changed: string[] }> {
    const s = this.ws.current.skills[name];
    if (!s) throw new Error('没装这个 skill');
    const changed: string[] = [];
    for (const [rel, h] of Object.entries(s.lock)) {
      const text = await readFile(safeJoin(join(this.dir, name), rel), 'utf8').catch(() => null);
      if (text === null || sha(text) !== h) changed.push(rel);
    }
    return { ok: !changed.length, changed };
  }

  /** 投放到某个平台的用户级 skills 目录（生成该平台自己的格式） */
  async deploy(name: string, platform: SkillPlatform): Promise<string> {
    const v = await this.verify(name);
    if (!v.ok) throw new Error(`安装后被改过：${v.changed.join('、')}，先重新安装`);
    const base = USER_SKILL_DIR[platform];
    if (!base) throw new Error('这个平台还不支持投放');
    const root = join(base.replace(/^~/, this.home), name);
    const files: Record<string, string> = {};
    const lock = this.ws.current.skills[name]!.lock;
    for (const rel of Object.keys(lock)) files[rel] = await readFile(join(this.dir, name, rel), 'utf8');
    const skill = docToGeneric(parseSkillMd(files['SKILL.md']!), files);
    for (const [rel, text] of Object.entries(renderForPlatform(skill, platform))) {
      const p = safeJoin(root, rel);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, text);
    }
    return root;
  }

  async remove(name: string): Promise<void> {
    await rm(join(this.dir, name), { recursive: true, force: true });
    this.ws.commit({ type: 'skill.removed', name }, { kind: 'user', id: 'me' });
  }

  /** 给 agent 的提示：装了哪些 skill、什么时候用 */
  notes(): string {
    const list = Object.values(this.ws.current.skills);
    if (!list.length) return '';
    return '可用的 skill（需要时读对应目录下的 SKILL.md）：\n' + list.map((s) => `- ${s.name}：${s.description}`).join('\n');
  }
}
