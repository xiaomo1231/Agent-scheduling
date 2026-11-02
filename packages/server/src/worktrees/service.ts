import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Thread, Worktree } from '@zhongshu/core';
import type { ExecFile } from '../runners/index.js';

/**
 * 每个讨论串在自己的 git worktree 里干活，互不打扰，也不碰你正在用的工作目录。
 * 做完后把改动提交到 zhongshu/ 开头的分支；你点“合并”才合回原分支，点“丢弃”就删掉。
 */
export class Worktrees {
  constructor(private readonly exec: ExecFile, private readonly baseDir: string) {}

  private async git(cwd: string, ...args: string[]) {
    const r = await this.exec('git', ['-c', 'core.quotepath=false', ...args], { cwd, timeoutMs: 120_000 });
    return { ok: r.code === 0, out: r.stdout.trim(), err: r.stderr.trim() };
  }

  /** 目录在 git 仓库里就返回仓库根目录 */
  async repoRoot(folder: string): Promise<string | null> {
    const r = await this.git(folder, 'rev-parse', '--show-toplevel').catch(() => null);
    return r?.ok ? r.out : null;
  }

  async create(t: Thread, folder: string): Promise<Worktree | null> {
    const repo = await this.repoRoot(folder);
    if (!repo) return null;
    const head = await this.git(repo, 'rev-parse', '--verify', 'HEAD');
    if (!head.ok) return null; // 空仓库没有提交，开不了 worktree
    const base = (await this.git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).out || 'HEAD';
    const branch = `zhongshu/${t.id.slice(4)}`;
    mkdirSync(this.baseDir, { recursive: true });
    const path = join(this.baseDir, t.id);
    const r = await this.git(repo, 'worktree', 'add', '-b', branch, path, 'HEAD');
    if (!r.ok) throw new Error(`开 worktree 失败：${r.err}`);
    return { repo, path, branch, base, state: 'active' };
  }

  /** 把 worktree 里的改动提交到它的分支。返回改动摘要，没有改动返回空串。 */
  async commit(w: Worktree, message: string): Promise<string> {
    await this.git(w.path, 'add', '-A');
    const staged = await this.git(w.path, 'diff', '--cached', '--quiet');
    if (!staged.ok) {
      const c = await this.git(w.path, '-c', 'user.name=中枢', '-c', 'user.email=zhongshu@localhost', 'commit', '-m', message, '--no-verify');
      if (!c.ok) throw new Error(`提交失败：${c.err}`);
    }
    const stat = await this.git(w.repo, 'diff', '--stat', `${w.base}...${w.branch}`);
    return stat.ok ? stat.out : '';
  }

  /** 合回原分支。原仓库有没提交的改动、或者有冲突时不合，原样告诉你。 */
  async merge(w: Worktree, message: string): Promise<{ ok: boolean; error?: string }> {
    const dirty = await this.git(w.repo, 'status', '--porcelain', '--untracked-files=no');
    if (dirty.out) return { ok: false, error: '原仓库有没提交的改动，先提交或暂存再合并' };
    const cur = (await this.git(w.repo, 'rev-parse', '--abbrev-ref', 'HEAD')).out;
    if (cur !== w.base) return { ok: false, error: `原仓库现在在 ${cur} 分支，切回 ${w.base} 再合并` };
    const m = await this.git(w.repo, '-c', 'user.name=中枢', '-c', 'user.email=zhongshu@localhost', 'merge', '--no-ff', '--no-edit', '-m', message, w.branch);
    if (!m.ok) {
      await this.git(w.repo, 'merge', '--abort');
      return { ok: false, error: `有冲突，没有合并：${m.err || m.out}`.slice(0, 500) };
    }
    await this.remove(w);
    return { ok: true };
  }

  async remove(w: Worktree): Promise<void> {
    await this.git(w.repo, 'worktree', 'remove', '--force', w.path);
    await this.git(w.repo, 'branch', '-D', w.branch);
  }
}
