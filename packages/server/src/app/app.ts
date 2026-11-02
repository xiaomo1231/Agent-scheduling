import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  applyPlanOps, defaultProjectSettings, newId, presetLayout, resolveChoice, runsViaCli, securityAudit, threadStatus, validateLayout,
  type Actor, type Channel, type ModelChoice, type EventBody, type Message, type ModelSource, type Project, type Thread,
} from '@zhongshu/core';
import { JsonlLog, MemoryLog, Workspace } from '../store/index.js';
import { FileSecrets, localKeyCipher, redact, type SecretStore } from '../secrets/index.js';
import { Approvals } from '../approvals/index.js';
import { providerFor, type ChatProvider, type Meter, type ProviderDeps } from '../providers/index.js';
import { BuiltinRunner, CliRunner, SimRunner, cliInvocation, execFile as realExecFile, execShell as realExecShell, type ExecFile, type ExecShell } from '../runners/index.js';
import { Coordinator } from '../coordinator/index.js';
import { SkillService } from '../skills/index.js';
import { Worktrees } from '../worktrees/index.js';
import { MemoryService } from '../memory/index.js';
import { ReviewService, type ModelFor } from '../review/index.js';
import { SideService } from '../side/index.js';
import { ChannelService, checkBotToken, checkWebhook } from '../channels/index.js';
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
  /** 碰到额度上限后第一次等多久，测试时调小 */
  quotaBaseDelayMs?: number;
  /** 启动消息渠道轮询和每日记忆整理。默认有数据目录时开 */
  background?: boolean;
  channelPollTimeoutSec?: number;
}

/** 本地日期 YYYY-MM-DD */
export function localDay(t = Date.now()): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
  readonly memory: MemoryService;
  readonly reviews: ReviewService;
  readonly sides: SideService;
  readonly channels: ChannelService;
  private readonly rnd: () => number;
  private readonly dataDir: string | undefined;
  private readonly exec: ExecFile;
  readonly providerDeps: ProviderDeps;

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
    // 命令策略为 review 时，先让审查模型看；它只能放行或交给你，不能拒绝也不能改命令
    this.approvals = new Approvals(this.ws, {
      random: this.rnd,
      reviewer: async (req) => {
        const h = await this.helperModel();
        if (!h) return 'ask';
        const r = await h.p.chat({
          model: h.model,
          system: '你是命令审查员。判断这条命令在开发工作区里是否明显安全（只读、或只影响工作区内的构建产物）。明显安全只回答 allow，其余一律回答 ask。',
          turns: [{ role: 'user', text: `目录：${req.cwd}\n<untrusted source="agent-command">\n${req.target}\n</untrusted>` }],
          effort: '低',
          maxTokens: 50,
        });
        return /^\s*allow\b/i.test(r.text) ? 'allow' : 'ask';
      },
    });
    this.providerDeps = { secrets: this.secrets, ...(o.fetch ? { fetch: o.fetch } : {}), ...(o.mockProvider ? { mock: o.mockProvider } : {}), meter: this.meter() };
    const providerDeps = this.providerDeps;
    this.skills = new SkillService(this.ws, join(this.dataDir ?? join(process.cwd(), '.zhongshu-data'), 'skills'), async () => this.helperModel());
    const builtin = new BuiltinRunner(
      async (t) => providerFor(t.model!.source, providerDeps, { projectId: t.projectId }),
      { approvals: this.approvals, execShell: o.execShell ?? realExecShell, ...(o.fetch ? { fetch: o.fetch } : {}), allowed: ['read_file', 'write_file', 'edit_file', 'list_files', 'run_command', 'web_fetch'], separateNetworkAndExec: () => this.ws.current.policy.separateNetworkAndExec },
      30,
      { subagents: 3, remember: (t, text, tags) => this.memory.add(t.projectId, text, tags, t.agentId, { kind: 'agent', id: t.agentId }) },
    );
    this.memory = new MemoryService(this.ws, async () => this.helperModel(), this.rnd);
    const modelFor: ModelFor = (pid, choice) => this.modelFor(pid, choice);
    this.reviews = new ReviewService(this.ws, modelFor, this.rnd);
    this.sides = new SideService(this.ws, modelFor, this.rnd);
    this.coordinator = new Coordinator({
      ws: this.ws, providers: providerDeps, execFile: this.exec,
      runners: { builtin, cli: new CliRunner(this.exec), sim: new SimRunner(o.simDelayMs ?? 800) },
      folderFor: (p) => this.folderFor(p), simulate: o.simulate ?? false, random: this.rnd,
      skillNotes: () => this.skills.notes(),
      worktrees: new Worktrees(this.exec, join(this.dataDir ?? join(process.cwd(), '.zhongshu-data'), 'worktrees')),
      startReview: (projectId, question, preset, replyTo) => {
        try {
          return this.reviews.start({ projectId, question, preset, ...(replyTo ? { replyTo } : {}) });
        } catch (e) {
          return { error: (e as Error).message };
        }
      },
    });
    this.channels = new ChannelService(this.ws, this.secrets, {
      approve: (id, ok, actor) => this.approvals.decide(id, ok, actor),
      userMessage: async (projectId, text, via) => {
        const coord = Object.values(this.ws.current.threads).find((t) => t.projectId === projectId && t.kind === 'coord');
        if (!coord) throw new Error('这个项目没有协调者');
        this.ws.commit({ type: 'thread.message', message: this.msg(coord.id, ME, text, `你（${via}）`) }, ME);
        void this.coordinator.onUserMessage(coord.id, text);
        return { threadId: coord.id };
      },
      status: (projectId) => this.statusText(projectId),
    }, o.fetch ?? fetch, { ...(o.channelPollTimeoutSec !== undefined ? { pollTimeoutSec: o.channelPollTimeoutSec, retryMs: 50 } : {}) });
    if (o.background ?? !!this.dataDir) {
      this.channels.start();
      this.memory.startDaily({ kind: 'system', id: 'memory' });
    }
  }

  private meter(): Meter {
    const SYS: Actor = { kind: 'system', id: 'meter' };
    return {
      record: (u) => this.ws.commit({ type: 'usage.recorded', day: localDay(), ...u }, SYS),
      waiting: (sourceId, until, reason) => this.ws.commit({ type: 'source.quota', sourceId, until, reason }, SYS),
      recovered: (sourceId) => {
        if (this.ws.current.quota[sourceId]) this.ws.commit({ type: 'source.quota', sourceId, until: null }, SYS);
      },
      autoContinue: (projectId) => this.ws.current.projects[projectId]?.settings.autoContinueAfterQuotaReset ?? true,
      ...(this.o.quotaBaseDelayMs !== undefined ? { baseDelayMs: this.o.quotaBaseDelayMs } : {}),
    };
  }

  /** 给群评审、追问用的模型：指定的 → 项目协调模型 → 讨论串默认模型 → 任一 API 模型。CLI 订阅不能这样用。 */
  private async modelFor(projectId: string, choice?: ModelChoice | null): Promise<{ p: ChatProvider; model: string; label: string } | null> {
    const st = this.ws.current;
    const p = st.projects[projectId];
    for (const c of [choice ?? null, p?.settings.coordinator.model ?? null, p?.settings.threadDefault.model ?? null]) {
      const r = resolveChoice(c, st.sources, st.groups);
      if (!r || runsViaCli(r.source.transport)) continue;
      try {
        return { p: await providerFor(r.source, this.providerDeps, { projectId }), model: r.model.id, label: r.model.label };
      } catch {
        /* 下一个 */
      }
    }
    const h = await this.helperModel();
    return h ? { ...h, label: h.model } : null;
  }

  /** 渠道里 /status 的回答 */
  statusText(projectId?: string): string {
    const st = this.ws.current;
    const pending = Object.values(st.approvals).filter((a) => a.state === 'pending');
    const threads = Object.values(st.threads).filter((t) => t.kind !== 'coord' && !t.resolved && (!projectId || t.projectId === projectId));
    const lines = threads.slice(0, 10).map((t) => {
      const done = t.steps.filter((s) => s.state === 'done').length;
      return `· ${t.title}（${({ waiting: '等你', running: '在跑', idle: '空闲', resolved: '已解决' } as Record<string, string>)[threadStatus(t, st.approvals)]}，${done}/${t.steps.length}）`;
    });
    return [`待批准 ${pending.length} 个`, threads.length ? `进行中的讨论串：\n${lines.join('\n')}` : '没有进行中的讨论串'].join('\n');
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
        return { p: await providerFor(src, this.providerDeps), model: m.id };
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
        if (t.kind === 'side') {
          this.sides.reply(t.id);
          return;
        }
        if (t.kind === 'review') return; // 评审讨论串只看，不派活
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
      case 'thread.merge':
        await this.coordinator.mergeWorktree(this.thread(c.threadId).id);
        return;
      case 'thread.discard':
        await this.coordinator.discardWorktree(this.thread(c.threadId).id);
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
        const p = await providerFor(s, this.providerDeps);
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
      case 'memory.desk':
        this.project(c.projectId);
        this.memory.setDesk(c.projectId, c.desk, ME);
        return;
      case 'memory.add':
        this.project(c.projectId);
        return { entryId: this.memory.add(c.projectId, c.text, c.tags ?? [], 'user', ME, c.pinned ?? false).id };
      case 'memory.remove':
        this.memory.remove(c.projectId, c.entryId, ME);
        return;
      case 'memory.consolidate':
        this.project(c.projectId);
        return this.memory.consolidate(c.projectId, ME);
      case 'review.start':
        return this.reviews.start({
          projectId: c.projectId, question: c.question, ...(c.preset ? { preset: c.preset } : {}), ...(c.roles ? { roles: c.roles as never } : {}),
          ...(c.rounds ? { rounds: c.rounds } : {}), ...(c.decider !== undefined ? { decider: c.decider } : {}), ...(c.replyTo ? { replyTo: c.replyTo } : {}),
        });
      case 'thread.side':
        return this.sides.open({ threadId: c.threadId, quote: c.quote, question: c.question, ...(c.messageId ? { messageId: c.messageId } : {}) });
      case 'thread.sideClose':
        await this.sides.close(c.threadId, c.outcome);
        return;
      case 'channel.save': {
        const prev = st.channels[c.channel.id];
        const ref = prev?.secretRef ?? `chn:${c.channel.id}`;
        if (c.secret) {
          const bad = c.channel.kind === 'telegram' ? checkBotToken(c.secret) : checkWebhook(c.channel.kind, c.secret.trim());
          if (bad) throw new Error(bad);
          await this.secrets.set(ref, c.secret.trim());
        }
        const has = c.secret ? true : prev?.secretRef ? await this.secrets.has(prev.secretRef) : false;
        // 换了 token 就要重新配对
        const keepPair = prev?.paired && !c.secret && prev.kind === c.channel.kind;
        const channel: Channel = { ...c.channel, ...(has ? { secretRef: ref } : {}), ...(keepPair ? { paired: prev.paired! } : {}) };
        this.ws.commit({ type: 'channel.saved', channel }, ME);
        return;
      }
      case 'channel.remove': {
        const ch = st.channels[c.channelId];
        if (ch?.secretRef) await this.secrets.delete(ch.secretRef);
        this.ws.commit({ type: 'channel.removed', channelId: c.channelId }, ME);
        return;
      }
      case 'channel.test':
        await this.channels.test(c.channelId);
        return;
      case 'channel.pair':
        return { code: this.channels.pairCode(c.channelId) };
      case 'channel.unpair': {
        const ch = st.channels[c.channelId];
        if (!ch) throw new Error('找不到这个渠道');
        const { paired: _p, ...rest } = ch;
        this.ws.commit({ type: 'channel.saved', channel: rest }, ME);
        return;
      }
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
    this.channels.close();
    this.memory.close();
    this.coordinator.stopAll();
    this.approvals.close();
  }
}

export function createApp(o: AppOptions = {}): App {
  return new App(o);
}
