import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  applyPlanOps, defaultProjectSettings, newId, presetLayout, securityAudit, validateLayout,
  type Actor, type EventBody, type Message, type ModelSource, type Project, type Thread,
} from '@zhongshu/core';
import { JsonlLog, MemoryLog, Workspace } from '../store/index.js';
import { FileSecrets, localKeyCipher, redact, type SecretStore } from '../secrets/index.js';
import { Approvals } from '../approvals/index.js';
import { providerFor, type ChatProvider } from '../providers/index.js';
import { BuiltinRunner, CliRunner, SimRunner, cliInvocation, execFile as realExecFile, execShell as realExecShell, type ExecFile, type ExecShell } from '../runners/index.js';
import { Coordinator } from '../coordinator/index.js';
import { SkillService } from '../skills/index.js';
import { CommandS, type Command } from './schemas.js';

export interface AppOptions {
  /** 数据目录：事件日志、密钥、skill、默认工作区都在这里。为空时全放内存（测试用）。 */
  dataDir?: string;
  secrets?: SecretStore;
  fetch?: typeof fetch;
  execFile?: ExecFile;
  execShell?: ExecShell;
  /** 没配模型时用模拟运行，方便离线试用 */
  simulate?: boolean;
  simDelayMs?: number;
  /** transport 为 mock 的来源用它 */
  mockProvider?: ChatProvider;
  random?: () => number;
}

export type CommandResult = { ok: true; result?: unknown } | { ok: false; error: string };

const ME: Actor = { kind: 'user', id: 'me' };
const COLORS = ['#c96442', '#3b82f6', '#16a34a', '#a855f7', '#e11d48', '#0891b2', '#ca8a04'];

/** 把各模块接起来。对外只暴露这一个入口。 */
export class App {
  readonly ws: Workspace;
  readonly secrets: SecretStore;
  readonly approvals: Approvals;
  readonly coordinator: Coordinator;
  readonly skills: SkillService;
  private readonly rnd: () => number;
  private readonly dataDir: string | undefined;
  private readonly exec: ExecFile;

  constructor(private readonly o: AppOptions = {}) {
    this.rnd = o.random ?? Math.random;
    this.dataDir = o.dataDir ? resolve(o.dataDir) : undefined;
    if (this.dataDir) mkdirSync(this.dataDir, { recursive: true });
    this.ws = Workspace.open(this.dataDir ? new JsonlLog(join(this.dataDir, 'events.jsonl')) : new MemoryLog());
    this.secrets = o.secrets ?? (this.dataDir ? new FileSecrets(join(this.dataDir, 'secrets.json'), localKeyCipher(join(this.dataDir, 'secret.key'))) : new (class {
      private m = new Map<string, string>();
      async get(r: string) { return this.m.get(r); }
      async set(r: string, v: string) { this.m.set(r, v); }
      async delete(r: string) { this.m.delete(r); }
      async has(r: string) { return this.m.has(r); }
    })());
    this.exec = o.execFile ?? realExecFile;
    this.approvals = new Approvals(this.ws, { random: this.rnd });
    const providerDeps = { secrets: this.secrets, ...(o.fetch ? { fetch: o.fetch } : {}), ...(o.mockProvider ? { mock: o.mockProvider } : {}) };
    this.skills = new SkillService(this.ws, join(this.dataDir ?? join(process.cwd(), '.zhongshu-data'), 'skills'), async () => this.helperModel());
    const builtin = new BuiltinRunner(
      async (t) => providerFor(t.model!.source, providerDeps),
      { approvals: this.approvals, execShell: o.execShell ?? realExecShell, ...(o.fetch ? { fetch: o.fetch } : {}), allowed: ['read_file', 'write_file', 'edit_file', 'list_files', 'run_command', 'web_fetch'] },
    );
    this.coordinator = new Coordinator({
      ws: this.ws, providers: providerDeps, execFile: this.exec,
      runners: { builtin, cli: new CliRunner(this.exec), sim: new SimRunner(o.simDelayMs ?? 800) },
      folderFor: (p) => this.folderFor(p), simulate: o.simulate ?? false, random: this.rnd,
      skillNotes: () => this.skills.notes(),
    });
  }

  folderFor(p: Project): string {
    return p.folder ? resolve(p.folder) : join(this.dataDir ?? join(process.cwd(), '.zhongshu-data'), 'workspaces', p.id);
  }

  /** 转换 skill 用的模型：任一项目的协调模型（API 类） */
  private async helperModel(): Promise<{ p: ChatProvider; model: string } | null> {
    const st = this.ws.current;
    for (const src of Object.values(st.sources)) {
      if (src.transport !== 'anthropic' && src.transport !== 'openai' && src.transport !== 'mock') continue;
      const m = src.models.find((x) => x.enabled);
      if (!m) continue;
      try {
        return { p: await providerFor(src, { secrets: this.secrets, ...(this.o.fetch ? { fetch: this.o.fetch } : {}), ...(this.o.mockProvider ? { mock: this.o.mockProvider } : {}) }), model: m.id };
      } catch {
        /* 下一个 */
      }
    }
    return null;
  }

  private msg(threadId: string, author: Actor, text: string, label: string): Message {
    return { id: newId('msg', this.rnd), threadId, author, authorLabel: label, text, ts: Date.now() };
  }

  audit() {
    return securityAudit(this.ws.current, this.ws.allEvents());
  }

  /** 处理一条命令。先校验，再执行；出错时返回能看懂的中文。 */
  async handle(raw: unknown): Promise<CommandResult> {
    const parsed = CommandS.safeParse(raw);
    if (!parsed.success) return { ok: false, error: `请求格式不对：${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('；')}` };
    try {
      const result = await this.run(parsed.data);
      return { ok: true, ...(result !== undefined ? { result } : {}) };
    } catch (err) {
      return { ok: false, error: redact((err as Error).message) };
    }
  }

  private thread(id: string): Thread {
    const t = this.ws.current.threads[id];
    if (!t) throw new Error('找不到这个讨论串');
    return t;
  }

  private project(id: string): Project {
    const p = this.ws.current.projects[id];
    if (!p) throw new Error('找不到这个项目');
    return p;
  }

  private async run(c: Command): Promise<unknown> {
    const st = this.ws.current;
    switch (c.type) {
      case 'project.create': {
        const id = newId('prj', this.rnd);
        const p: Project = {
          id, name: c.name, color: c.color ?? COLORS[Object.keys(st.projects).length % COLORS.length]!, goal: c.goal ?? '', template: c.template ?? 'blank',
          createdAt: Date.now(), archived: false, layout: presetLayout(c.preset ?? 'claude', () => newId('wdg', this.rnd)), settings: defaultProjectSettings(),
          ...(c.folder ? { folder: c.folder } : {}),
        };
        const coord: Thread = { id: newId('thr', this.rnd), projectId: id, kind: 'coord', title: '协调者', createdAt: Date.now(), updatedAt: Date.now(), resolved: null, keepOpen: true, model: null, steps: [] };
        mkdirSync(this.folderFor(p), { recursive: true });
        this.ws.commit([{ type: 'project.created', project: p }, { type: 'thread.created', thread: coord }], ME);
        return { projectId: id, coordThreadId: coord.id };
      }
      case 'project.update':
        this.project(c.projectId);
        this.ws.commit({ type: 'project.updated', projectId: c.projectId, patch: c.patch as never }, ME);
        return;
      case 'project.layout': {
        this.project(c.projectId);
        const issues = validateLayout(c.layout);
        if (issues.length) throw new Error(`布局不对：${issues.join('；')}`);
        this.ws.commit({ type: 'project.layoutChanged', projectId: c.projectId, layout: c.layout }, ME);
        return;
      }
      case 'project.delete':
        this.project(c.projectId);
        for (const t of Object.values(st.threads)) if (t.projectId === c.projectId) this.coordinator.stop(t.id);
        this.ws.commit({ type: 'project.deleted', projectId: c.projectId }, ME);
        return;
      case 'thread.create': {
        const p = this.project(c.projectId);
        const t: Thread = {
          id: newId('thr', this.rnd), projectId: p.id, kind: 'work', title: c.title, createdAt: Date.now(), updatedAt: Date.now(), resolved: null, keepOpen: false,
          model: p.settings.threadDefault.model, ...(p.settings.threadDefault.effort ? { effort: p.settings.threadDefault.effort } : {}), steps: [],
        };
        this.ws.commit({ type: 'thread.created', thread: t }, ME);
        return { threadId: t.id };
      }
      case 'message.send': {
        const t = this.thread(c.threadId);
        const bodies: EventBody[] = [];
        // 在已解决的讨论串里发消息会把它重新打开（不算“你手动重开”，协调者之后仍可自动解决）
        if (t.resolved) bodies.push({ type: 'thread.reopened', threadId: t.id, by: 'coordinator' });
        bodies.push({ type: 'thread.message', message: this.msg(t.id, ME, c.text, '你') });
        this.ws.commit(bodies, ME);
        if (/^\s*(继续|重试|continue|retry)\s*$/i.test(c.text) && t.steps.some((s) => s.state === 'wait')) {
          this.coordinator.retryWaiting(t.id);
          this.coordinator.dispatch(t.id);
          return;
        }
        void this.coordinator.onUserMessage(t.id, c.text);
        return;
      }
      case 'thread.resolve': {
        const t = this.thread(c.threadId);
        if (t.kind === 'coord') throw new Error('协调者对话不能解决');
        if (t.resolved) return;
        this.coordinator.stop(t.id);
        this.ws.commit({ type: 'thread.resolved', threadId: t.id, by: 'user', reason: '你手动解决' }, ME);
        return;
      }
      case 'thread.reopen': {
        const t = this.thread(c.threadId);
        if (!t.resolved) return;
        this.ws.commit({ type: 'thread.reopened', threadId: t.id, by: 'user' }, ME);
        return;
      }
      case 'thread.settings':
        this.thread(c.threadId);
        this.ws.commit({ type: 'thread.settings', threadId: c.threadId, ...(c.model !== undefined ? { model: c.model } : {}), ...(c.effort !== undefined ? { effort: c.effort } : {}), ...(c.title ? { title: c.title } : {}) }, ME);
        return;
      case 'thread.stop':
        this.coordinator.stop(this.thread(c.threadId).id);
        return;
      case 'thread.continue': {
        const t = this.thread(c.threadId);
        this.coordinator.retryWaiting(t.id);
        this.coordinator.dispatch(t.id);
        return;
      }
      case 'plan.apply': {
        const t = this.thread(c.threadId);
        const ch = applyPlanOps(t.steps, c.ops, () => newId('stp', this.rnd));
        if (!ch.summary) return { summary: '' };
        this.ws.commit({ type: 'plan.changed', threadId: t.id, steps: ch.steps, previous: t.steps, summary: ch.summary }, ME);
        return { summary: ch.summary };
      }
      case 'plan.undo': {
        const r = this.coordinator.undoPlan(c.threadId, c.seq);
        if (!r.ok) throw new Error(r.error);
        return;
      }
      case 'approval.decide': {
        const r = this.approvals.decide(c.approvalId, c.approve, ME, { always: c.always ?? false });
        if (!r.ok) throw new Error(r.error);
        return;
      }
      case 'policy.set':
        this.ws.commit({ type: 'policy.changed', policy: c.policy }, ME);
        return;
      case 'audit.fix': {
        const f = this.audit().find((x) => x.id === c.findingId);
        if (!f?.fix) throw new Error('这一项不能一键修复');
        this.ws.commit({ type: 'policy.changed', policy: { ...st.policy, ...f.fix } }, ME);
        return;
      }
      case 'source.save': {
        const prev = st.sources[c.source.id];
        const ref = prev?.secretRef ?? `src:${c.source.id}`;
        if (c.secret) await this.secrets.set(ref, c.secret.trim());
        const has = c.secret ? true : prev?.secretRef ? await this.secrets.has(prev.secretRef) : false;
        const source: ModelSource = { ...(c.source as ModelSource), ...(has ? { secretRef: ref } : {}) };
        this.ws.commit({ type: 'source.saved', source }, ME);
        return;
      }
      case 'source.remove': {
        const s = st.sources[c.sourceId];
        if (s?.secretRef) await this.secrets.delete(s.secretRef);
        this.ws.commit({ type: 'source.removed', sourceId: c.sourceId }, ME);
        return;
      }
      case 'source.test': {
        const s = st.sources[c.sourceId];
        if (!s) throw new Error('找不到这个来源');
        const model = c.modelId ?? s.models.find((m) => m.enabled)?.id ?? s.models[0]?.id;
        if (!model) throw new Error('这个来源还没有模型');
        if (s.transport.startsWith('cli-')) {
          const inv = cliInvocation(s.transport, model, 'hi');
          const r = await this.exec(inv!.program, ['--version'], { cwd: process.cwd(), timeoutMs: 20_000 });
          if (r.code !== 0) throw new Error(`没找到 ${inv!.program}，或者它跑不起来：${r.stderr.slice(0, 200)}`);
          return { text: `${inv!.program} ${r.stdout.trim()}，记得先在终端里登录一次` };
        }
        const p = await providerFor(s, { secrets: this.secrets, ...(this.o.fetch ? { fetch: this.o.fetch } : {}), ...(this.o.mockProvider ? { mock: this.o.mockProvider } : {}) });
        const r = await p.chat({ model, system: '只回答“通了”两个字。', turns: [{ role: 'user', text: '测试连接' }], maxTokens: 200, effort: '低' });
        return { text: r.text.slice(0, 200) || '（连上了，但没有返回文字）', servedBy: r.servedBy };
      }
      case 'group.save':
        this.ws.commit({ type: 'group.saved', group: c.group }, ME);
        return;
      case 'group.remove':
        this.ws.commit({ type: 'group.removed', groupId: c.groupId }, ME);
        return;
      case 'skill.preview':
        return this.skills.preview(c.files, { ...(c.name ? { name: c.name } : {}), useAgent: c.useAgent ?? false });
      case 'skill.install':
        return this.skills.install(c.files, { acceptRisks: c.acceptRisks ?? false });
      case 'skill.verify':
        return this.skills.verify(c.name);
      case 'skill.deploy':
        return { path: await this.skills.deploy(c.name, c.platform) };
      case 'skill.remove':
        await this.skills.remove(c.name);
        return;
      case 'system.emergencyStop':
        this.ws.commit({ type: 'system.emergencyStop', on: c.on }, ME);
        if (c.on) {
          this.coordinator.stopAll();
          this.approvals.denyAll(ME);
        }
        return;
    }
  }

  close(): void {
    this.coordinator.stopAll();
    this.approvals.close();
  }
}

export function createApp(o: AppOptions = {}): App {
  return new App(o);
}
