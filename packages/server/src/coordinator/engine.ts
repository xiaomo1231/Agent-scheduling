import {
  applyPlanOps, autoResolveBlocker, memoryPrompt, choiceLabel, newId, resolveChoice, runsViaCli,
  type Actor, type EventBody, type Message, type MessageCard, type ModelChoice, type PlanOp, type Project, type ResolvedModel, type Step, type Thread,
} from '@zhongshu/core';
import type { Workspace } from '../store/index.js';
import { providerFor, ProviderError, type ChatProvider, type ChatTurn, type ProviderDeps, type ToolCall } from '../providers/index.js';
import type { Runner, StepTask, ExecFile } from '../runners/index.js';
import { redact } from '../secrets/index.js';
import { COORD_TOOLS } from './tools.js';
import { RuleBrain } from './rule-brain.js';
import type { Worktrees } from '../worktrees/index.js';
import { CliBrain } from './cli-brain.js';

export interface CoordinatorDeps {
  ws: Workspace;
  providers: ProviderDeps;
  runners: { builtin: Runner; cli: Runner; sim?: Runner };
  execFile: ExecFile;
  /** 项目的工作区目录 */
  folderFor: (p: Project) => string;
  /** 群评审：开一个评审讨论串并开始，结论会贴回 replyTo */
  startReview?: (projectId: string, question: string, preset: string, replyTo?: string) => { threadId: string } | { error: string };
  /** 没配模型时用模拟运行（离线演示） */
  simulate?: boolean;
  random?: () => number;
  /** 已装 skill 的说明，拼进 agent 的提示里 */
  skillNotes?: () => string;
  /** 有就按项目设置给每个讨论串开独立 worktree */
  worktrees?: Worktrees;
}

const COORD: Actor = { kind: 'coordinator', id: 'coord' };

/**
 * 协调者引擎 = 大脑 + 身体。
 * 大脑（模型 / CLI / 规则）只负责决定调用哪些工具；身体（这里）负责执行、留痕、派活、自动解决。
 */
export class Coordinator {
  private queues = new Map<string, Promise<void>>();
  private running = new Map<string, AbortController>();
  private waitingQuestion = new Set<string>();
  private rnd: () => number;

  constructor(private readonly d: CoordinatorDeps) {
    this.rnd = d.random ?? Math.random;
    // 上次退出时还在跑的步骤，退回排队
    const stuck: EventBody[] = [];
    for (const t of Object.values(d.ws.current.threads)) for (const s of t.steps) if (s.state === 'run') stuck.push({ type: 'step.state', threadId: t.id, stepId: s.id, state: 'queue' });
    if (stuck.length) d.ws.commit(stuck, { kind: 'system', id: 'startup' });
  }

  private get st() {
    return this.d.ws.current;
  }

  private say(threadId: string, text: string, author: Actor = COORD, label?: string, cards?: MessageCard[]): void {
    const m: Message = { id: newId('msg', this.rnd), threadId, author, authorLabel: label ?? this.coordLabel(threadId), text, ts: Date.now(), ...(cards ? { cards } : {}) };
    this.d.ws.commit({ type: 'thread.message', message: m }, author);
  }

  private coordLabel(threadId: string): string {
    const t = this.st.threads[threadId];
    const p = t && this.st.projects[t.projectId];
    const c = p?.settings.coordinator.model ?? null;
    return c ? `协调者 · ${choiceLabel(c, this.st.sources, this.st.groups)}` : '协调者';
  }

  /** 每个讨论串一次只处理一条消息，后来的排队。 */
  onUserMessage(threadId: string, text: string): Promise<void> {
    this.waitingQuestion.delete(threadId);
    const prev = this.queues.get(threadId) ?? Promise.resolve();
    const next = prev.then(() => this.think(threadId, text)).catch((err: unknown) => {
      this.say(threadId, `协调者出错了：${redact(String((err as Error)?.message ?? err))}`, { kind: 'system', id: 'error' }, '系统');
    });
    this.queues.set(threadId, next);
    return next;
  }

  /** 选大脑：项目设置的协调模型 → 备用 / 副脑 → 规则兜底 */
  private async brains(p: Project, thread: Thread, text: string): Promise<{ main: ChatProvider; model: string; effort?: string; backup?: { p: ChatProvider; model: string }; reviewer?: { p: ChatProvider; model: string } }> {
    const rules = { main: new RuleBrain({ thread, text }), model: 'rules' };
    const cs = p.settings.coordinator;
    const make = async (r: ResolvedModel | null): Promise<ChatProvider | null> => {
      if (!r) return null;
      if (runsViaCli(r.source.transport)) return new CliBrain(r.source.transport, this.d.execFile, this.d.folderFor(p));
      return providerFor(r.source, this.d.providers, { projectId: p.id });
    };
    const resolved = resolveChoice(cs.model, this.st.sources, this.st.groups);
    let main: ChatProvider | null = null;
    try {
      main = await make(resolved);
    } catch (e) {
      this.say(thread.id, `协调模型用不了（${(e as Error).message}），先用规则处理。`, { kind: 'system', id: 'coord' }, '系统');
    }
    if (!main || !resolved) return rules;
    const out: Awaited<ReturnType<Coordinator['brains']>> = { main, model: resolved.model.id, ...(cs.effort ?? resolved.effort ? { effort: (cs.effort ?? resolved.effort)! } : {}) };
    if (resolved.backup) {
      const b = await make({ source: resolved.backup.source, model: resolved.backup.model }).catch(() => null);
      if (b) out.backup = { p: b, model: resolved.backup.model.id };
    }
    if (cs.dual?.enabled && cs.dual.model) {
      const dr = resolveChoice(cs.dual.model, this.st.sources, this.st.groups);
      const dp = await make(dr).catch(() => null);
      if (dp && dr) {
        if (cs.dual.mode === 'backup') out.backup ??= { p: dp, model: dr.model.id };
        else out.reviewer = { p: dp, model: dr.model.id };
      }
    }
    return out;
  }

  private systemPrompt(p: Project, here: Thread, query = ''): string {
    const threads = Object.values(this.st.threads).filter((t) => t.projectId === p.id && t.kind !== 'coord' && !t.resolved);
    const fmt = (t: Thread) =>
      `- ${t.id}「${t.title}」\n` + t.steps.map((s, i) => `    T${i + 1} ${s.id} [${s.state}] ${s.title}${s.assignee ? ' ' + s.assignee : ''}`).join('\n');
    return [
      '你是“中枢”的协调者。你的工作是调度：听用户说要做什么，开讨论串、排计划、派 agent、在需要时问用户、做完时解决讨论串。你自己不写代码、不跑命令。',
      '回复用中文，口语化，简短。先说结论。',
      '用户追加要求时：新增步骤、调整顺序、取消步骤用 update_plan；跟当前讨论串无关的事用 create_thread 另开。',
      '只有计划都做完、没有待审批、不用等用户回答时，才调用 resolve_thread。拿不准就别解决。',
      `\n项目：${p.name}${p.goal ? `（目标：${p.goal}）` : ''}`,
      p.settings.instructions ? `项目说明：${p.settings.instructions}` : '',
      `当前讨论串：${here.kind === 'coord' ? '协调者对话' : `${here.id}「${here.title}」`}`,
      threads.length ? `进行中的讨论串：\n${threads.map(fmt).join('\n')}` : '现在没有进行中的讨论串。',
      memoryPrompt(this.st.memory[p.id], query),
      '值得长期记住的项目事实（约定、决定、踩过的坑）用 remember 记下来。需要多个角度把关的决定，可以用 start_review 开一次群评审。',
    ].filter(Boolean).join('\n');
  }

  private history(threadId: string, limit = 30): ChatTurn[] {
    const msgs = (this.st.messages[threadId] ?? []).slice(-limit);
    const turns: ChatTurn[] = [];
    for (const m of msgs) {
      if (m.author.kind === 'coordinator') turns.push({ role: 'assistant', text: m.text || '（已处理）', toolCalls: [] });
      else if (m.author.kind === 'user') turns.push({ role: 'user', text: m.text });
      else turns.push({ role: 'user', text: `[${m.authorLabel}] ${m.text}` });
    }
    // 合并相邻同角色，开头必须是用户
    const merged: ChatTurn[] = [];
    for (const t of turns) {
      const last = merged.at(-1);
      if (last && last.role === t.role && t.role !== 'tool') {
        if (t.role === 'user' && last.role === 'user') last.text += '\n' + t.text;
        else if (t.role === 'assistant' && last.role === 'assistant') last.text += '\n' + t.text;
      } else merged.push({ ...t } as ChatTurn);
    }
    while (merged[0] && merged[0].role !== 'user') merged.shift();
    return merged;
  }

  private async think(threadId: string, text: string): Promise<void> {
    const thread = this.st.threads[threadId];
    const p = thread && this.st.projects[thread.projectId];
    if (!thread || !p) return;
    const b = await this.brains(p, thread, text);
    const system = this.systemPrompt(p, thread, text);
    const turns = this.history(threadId);
    let brain = b.main;
    let model = b.model;
    for (let round = 0; round < 8; round++) {
      let r;
      try {
        r = await brain.chat({ model, system, turns, tools: COORD_TOOLS, ...(b.effort ? { effort: b.effort } : {}) });
      } catch (err) {
        if (b.backup && brain !== b.backup.p) {
          this.say(threadId, `主模型出错（${redact((err as Error).message)}），换备用模型继续。`, { kind: 'system', id: 'coord' }, '系统');
          brain = b.backup.p;
          model = b.backup.model;
          round--;
          continue;
        }
        if (!(brain instanceof RuleBrain)) {
          this.say(threadId, `模型出错（${redact((err as Error).message)}），先用规则处理。`, { kind: 'system', id: 'coord' }, '系统');
          brain = new RuleBrain({ thread, text });
          model = 'rules';
          continue;
        }
        throw err;
      }
      if (r.stop === 'refusal' && !r.toolCalls.length) {
        this.say(threadId, '模型拒绝回答这条消息，可以换个说法，或者在项目设置里换个协调模型。');
        return;
      }
      turns.push({ role: 'assistant', text: r.text, toolCalls: r.toolCalls, raw: r.raw });
      if (r.text.trim()) this.say(threadId, r.text.trim());
      if (!r.toolCalls.length) return;
      if (b.reviewer && r.toolCalls.some((c) => c.name === 'create_thread' || c.name === 'update_plan')) await this.review(threadId, b.reviewer, r.toolCalls);
      const results = [];
      for (const c of r.toolCalls) {
        const out = this.exec(c, thread);
        results.push({ id: c.id, content: out.content, ...(out.isError ? { isError: true } : {}) });
      }
      turns.push({ role: 'tool', results });
      if (brain.kind === 'cli') return; // CLI 每问一次都很贵，执行完就停
    }
  }

  private async review(threadId: string, reviewer: { p: ChatProvider; model: string }, calls: ToolCall[]) {
    try {
      const r = await reviewer.p.chat({
        model: reviewer.model,
        system: '你是副脑，负责复核协调者的调度。没问题只回“同意”两个字；有问题用一两句话指出。',
        turns: [{ role: 'user', text: `协调者准备这样做：\n${JSON.stringify(calls.map((c) => ({ tool: c.name, input: c.input })), null, 1)}` }],
        effort: '低',
      });
      const t = r.text.trim();
      if (t && !/^同意[。.!！]?$/.test(t)) this.say(threadId, t, { kind: 'coordinator', id: 'reviewer' }, `副脑 · ${reviewer.model}`);
    } catch {
      /* 副脑出错不挡主流程 */
    }
  }

  /** 执行协调者的工具调用，返回给大脑看的结果。 */
  exec(c: ToolCall, from: Thread): { content: string; isError?: boolean } {
    const input = c.input;
    const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
    switch (c.name) {
      case 'create_thread': {
        const title = s('title').trim().slice(0, 60);
        if (!title) return { content: '缺标题', isError: true };
        const raw = Array.isArray(input.steps) ? (input.steps as unknown[]) : [];
        const steps: Step[] = raw
          .map((x) => (typeof x === 'string' ? { title: x } : (x as { title?: string; assignee?: string })))
          .filter((x) => x && typeof x.title === 'string' && x.title.trim())
          .map((x) => ({ id: newId('stp', this.rnd), title: x.title!.trim(), assignee: x.assignee?.trim() || '@agent', state: 'queue' as const }));
        const p = this.st.projects[from.projectId]!;
        const t: Thread = {
          id: newId('thr', this.rnd), projectId: p.id, kind: 'work', title, createdAt: Date.now(), updatedAt: Date.now(), resolved: null, keepOpen: false,
          model: p.settings.threadDefault.model, ...(p.settings.threadDefault.effort ? { effort: p.settings.threadDefault.effort } : {}), steps: [],
        };
        this.d.ws.commit(
          [
            { type: 'thread.created', thread: t },
            { type: 'plan.changed', threadId: t.id, steps, previous: [], summary: `初始计划 ${steps.length} 步` },
            { type: 'thread.message', message: { id: newId('msg', this.rnd), threadId: t.id, author: COORD, authorLabel: this.coordLabel(t.id), text: `计划：\n${steps.map((x, i) => `T${i + 1} ${x.title}（${x.assignee}）`).join('\n')}`, ts: Date.now() } },
            ...(from.id !== t.id ? [{ type: 'thread.message' as const, message: { id: newId('msg', this.rnd), threadId: from.id, author: COORD, authorLabel: this.coordLabel(from.id), text: '', ts: Date.now(), cards: [{ kind: 'thread' as const, threadId: t.id }] } }] : []),
          ],
          COORD,
        );
        if (input.start === true) this.dispatch(t.id);
        return { content: `已开讨论串 ${t.id}，${steps.length} 步：${steps.map((x) => x.id).join(', ')}` };
      }
      case 'update_plan': {
        const t = this.st.threads[s('thread_id') || from.id];
        if (!t) return { content: '找不到这个讨论串', isError: true };
        const ops = (Array.isArray(input.ops) ? input.ops : []) as PlanOp[];
        const ch = applyPlanOps(t.steps, ops, () => newId('stp', this.rnd));
        if (!ch.summary) return { content: '计划没有变化' };
        const undoToken = `undo:${this.st.lastSeq + 1}`;
        this.d.ws.commit(
          [
            { type: 'plan.changed', threadId: t.id, steps: ch.steps, previous: t.steps, summary: ch.summary },
            ...(t.resolved ? [{ type: 'thread.reopened' as const, threadId: t.id, by: 'coordinator' as const }] : []),
            { type: 'thread.message', message: { id: newId('msg', this.rnd), threadId: t.id, author: COORD, authorLabel: this.coordLabel(t.id), text: '', ts: Date.now(), cards: [{ kind: 'planDiff', summary: ch.summary, undoToken }] } },
          ],
          COORD,
        );
        return { content: `已调整：${ch.summary}` };
      }
      case 'dispatch': {
        const id = s('thread_id') || from.id;
        if (!this.st.threads[id]) return { content: '找不到这个讨论串', isError: true };
        this.dispatch(id);
        return { content: '已开始派活' };
      }
      case 'ask_user': {
        const id = s('thread_id') || from.id;
        if (!this.st.threads[id]) return { content: '找不到这个讨论串', isError: true };
        this.waitingQuestion.add(id);
        this.say(id, s('question'));
        return { content: '已提问，等用户回答' };
      }
      case 'resolve_thread': {
        const t = this.st.threads[s('thread_id') || from.id];
        if (!t) return { content: '找不到这个讨论串', isError: true };
        if (t.kind === 'coord') return { content: '协调者对话不能解决', isError: true };
        const p = this.st.projects[t.projectId]!;
        const why = autoResolveBlocker({ thread: t, approvals: this.st.approvals, autoResolveEnabled: p.settings.autoResolve, waitingQuestion: this.waitingQuestion.has(t.id) });
        if (why) return { content: `先不解决：${why}`, isError: true };
        this.d.ws.commit({ type: 'thread.resolved', threadId: t.id, by: 'coordinator', reason: s('reason') || '做完了' }, COORD);
        return { content: '已解决' };
      }
      case 'remember': {
        const text = s('text').trim().slice(0, 500);
        if (!text) return { content: '缺少 text', isError: true };
        const tags = Array.isArray(input.tags) ? input.tags.filter((x): x is string => typeof x === 'string').slice(0, 5) : [];
        this.d.ws.commit({ type: 'memory.added', projectId: from.projectId, entry: { id: newId('mem', this.rnd), text: redact(text), tags, by: 'coordinator', at: Date.now() } }, COORD);
        return { content: '记下了' };
      }
      case 'start_review': {
        if (!this.d.startReview) return { content: '群评审不可用', isError: true };
        const r = this.d.startReview(from.projectId, s('question'), s('preset') || 'design', from.id);
        return 'error' in r ? { content: r.error, isError: true } : { content: `已开群评审 ${r.threadId}，结论出来会贴回这里` };
      }
      default:
        return { content: `不认识的工具 ${c.name}`, isError: true };
    }
  }

  /** 撤销一次计划调整（planDiff 卡片上的“撤销”） */
  undoPlan(threadId: string, seq: number): { ok: boolean; error?: string } {
    const e = this.d.ws.allEvents().find((x) => x.seq === seq);
    if (!e || e.body.type !== 'plan.changed' || e.body.threadId !== threadId) return { ok: false, error: '找不到这次调整' };
    const t = this.st.threads[threadId]!;
    const keep = new Map(t.steps.map((s) => [s.id, s]));
    // 回到调整前的步骤，但保留之后已经更新的状态
    const steps = e.body.previous.map((s) => keep.get(s.id) ?? s);
    this.d.ws.commit({ type: 'plan.changed', threadId, steps, previous: t.steps, summary: `撤销：${e.body.summary}` }, { kind: 'user', id: 'me' });
    return { ok: true };
  }

  private modelFor(t: Thread): ResolvedModel | null {
    const p = this.st.projects[t.projectId];
    const choice: ModelChoice | null = t.model ?? p?.settings.threadDefault.model ?? null;
    return resolveChoice(choice, this.st.sources, this.st.groups);
  }

  /** 按顺序执行讨论串里排队的步骤。已经在跑就什么都不做。 */
  dispatch(threadId: string): void {
    if (this.running.has(threadId)) return;
    const ac = new AbortController();
    this.running.set(threadId, ac);
    void this.drain(threadId, ac).finally(() => this.running.delete(threadId));
  }

  stop(threadId: string): void {
    this.running.get(threadId)?.abort();
  }

  stopAll(): void {
    for (const ac of this.running.values()) ac.abort();
  }

  isRunning(threadId: string): boolean {
    return this.running.has(threadId);
  }

  private async drain(threadId: string, ac: AbortController): Promise<void> {
    for (;;) {
      if (ac.signal.aborted || this.st.emergencyStop) return;
      const t = this.st.threads[threadId];
      if (!t || t.resolved) return;
      const step = t.steps.find((s) => s.state === 'queue');
      if (!step) break;
      const p = this.st.projects[t.projectId]!;
      const model = this.modelFor(t);
      let runner: Runner | undefined;
      if (model) runner = runsViaCli(model.source.transport) ? this.d.runners.cli : this.d.runners.builtin;
      else if (this.d.simulate) runner = this.d.runners.sim;
      if (!runner) {
        this.d.ws.commit({ type: 'step.state', threadId, stepId: step.id, state: 'wait' }, COORD);
        this.say(threadId, '还没给这个讨论串选执行模型。在讨论串设置或项目设置里选一个，再让我继续。');
        return;
      }
      let root: string;
      try {
        root = await this.workdir(threadId);
      } catch (err) {
        this.d.ws.commit({ type: 'step.state', threadId, stepId: step.id, state: 'wait' }, COORD);
        this.say(threadId, `${(err as Error).message}。可以在项目设置里关掉 worktree 再继续。`);
        return;
      }
      this.d.ws.commit({ type: 'step.state', threadId, stepId: step.id, state: 'run' }, COORD);
      const agent: Actor = { kind: 'agent', id: step.assignee || '@agent' };
      const label = `${step.assignee || '@agent'}${model ? ` · ${model.model.label}` : ''}`;
      const task: StepTask = {
        projectId: p.id, threadId, stepId: step.id, title: step.title, threadTitle: t.title, goal: p.goal,
        instructions: [p.settings.instructions, this.d.skillNotes?.() ?? ''].filter(Boolean).join('\n\n'),
        workspaceRoot: root, agentId: agent.id, model, ...(t.effort ? { effort: t.effort } : {}), signal: ac.signal,
        memory: memoryPrompt(this.st.memory[p.id], `${t.title} ${step.title}`),
      };
      let rep;
      try {
        rep = await runner.run(task, (text) => this.say(threadId, redact(text), agent, label));
      } catch (err) {
        rep = { ok: false, summary: err instanceof ProviderError ? err.message : `出错：${(err as Error).message}` };
      }
      if (!this.st.threads[threadId]?.steps.some((s) => s.id === step.id && s.state === 'run')) continue; // 期间被取消或改掉了
      this.say(threadId, redact(rep.summary), agent, label);
      this.d.ws.commit({ type: 'step.state', threadId, stepId: step.id, state: rep.ok ? 'done' : 'wait' }, agent);
      if (!rep.ok) {
        this.say(threadId, `T${t.steps.indexOf(step) + 1} 卡住了，等你看一下。回复“继续”我会重试这一步。`);
        return;
      }
    }
    await this.finishWorktree(threadId);
    this.maybeAutoResolve(threadId);
  }

  /** 这个讨论串该在哪个目录干活：开了 worktree 就用 worktree */
  private async workdir(threadId: string): Promise<string> {
    const t = this.st.threads[threadId]!;
    const p = this.st.projects[t.projectId]!;
    const folder = this.d.folderFor(p);
    const w = t.worktree;
    if (w && (w.state === 'active' || w.state === 'ready')) {
      if (w.state === 'ready') this.d.ws.commit({ type: 'thread.worktree', threadId, worktree: { ...w, state: 'active' } }, COORD);
      return w.path;
    }
    if (!p.settings.useWorktrees || !this.d.worktrees) return folder;
    const created = await this.d.worktrees.create(t, folder);
    if (!created) return folder; // 不是 git 仓库，直接在项目目录里干
    this.d.ws.commit({ type: 'thread.worktree', threadId, worktree: created }, COORD);
    this.say(threadId, `在独立的 worktree 里干活（分支 ${created.branch}，从 ${created.base} 开出），不会动你正在用的目录。`);
    return created.path;
  }

  /** 步骤都做完后，把 worktree 里的改动提交到分支，等你合并或丢弃 */
  private async finishWorktree(threadId: string): Promise<void> {
    const t = this.st.threads[threadId];
    const w = t?.worktree;
    if (!t || !w || w.state !== 'active' || !this.d.worktrees) return;
    if (t.steps.some((s) => s.state === 'queue' || s.state === 'run' || s.state === 'wait')) return;
    try {
      const summary = await this.d.worktrees.commit(w, t.title);
      if (!summary) {
        await this.d.worktrees.remove(w);
        this.d.ws.commit({ type: 'thread.worktree', threadId, worktree: { ...w, state: 'discarded' } }, COORD);
        return;
      }
      this.d.ws.commit(
        [
          { type: 'thread.worktree', threadId, worktree: { ...w, state: 'ready', summary } },
          { type: 'thread.message', message: { id: newId('msg', this.rnd), threadId, author: COORD, authorLabel: this.coordLabel(threadId), text: `改动已经提交到分支 ${w.branch}，看过没问题就合并回 ${w.base}。`, ts: Date.now(), cards: [{ kind: 'worktree', threadId }] } },
        ],
        COORD,
      );
    } catch (err) {
      this.say(threadId, `提交改动时出错：${(err as Error).message}`, { kind: 'system', id: 'worktree' }, '系统');
    }
  }

  async mergeWorktree(threadId: string): Promise<void> {
    const t = this.st.threads[threadId];
    const w = t?.worktree;
    if (!t || !w || w.state !== 'ready' || !this.d.worktrees) throw new Error('没有等待合并的改动');
    const r = await this.d.worktrees.merge(w, `合并讨论串：${t.title}`);
    if (!r.ok) throw new Error(r.error);
    this.d.ws.commit({ type: 'thread.worktree', threadId, worktree: { ...w, state: 'merged' } }, { kind: 'user', id: 'me' });
    this.say(threadId, `已合并回 ${w.base}，worktree 和分支已清理。`);
    this.maybeAutoResolve(threadId);
  }

  async discardWorktree(threadId: string): Promise<void> {
    const t = this.st.threads[threadId];
    const w = t?.worktree;
    if (!t || !w || (w.state !== 'ready' && w.state !== 'active') || !this.d.worktrees) throw new Error('没有可以丢弃的改动');
    this.stop(threadId);
    await this.d.worktrees.remove(w);
    this.d.ws.commit({ type: 'thread.worktree', threadId, worktree: { ...w, state: 'discarded' } }, { kind: 'user', id: 'me' });
    this.say(threadId, `已丢弃分支 ${w.branch} 上的改动。`);
  }

  maybeAutoResolve(threadId: string): void {
    const t = this.st.threads[threadId];
    if (!t || t.kind === 'coord') return;
    const p = this.st.projects[t.projectId];
    if (!p) return;
    const why = autoResolveBlocker({ thread: t, approvals: this.st.approvals, autoResolveEnabled: p.settings.autoResolve, waitingQuestion: this.waitingQuestion.has(threadId) });
    if (!why) {
      this.say(threadId, '计划里的步骤都做完了，没有待处理的事，先把这个讨论串放到已解决。有新要求直接发消息，它会重新打开。');
      this.d.ws.commit({ type: 'thread.resolved', threadId, by: 'coordinator', reason: '计划都做完了' }, COORD);
    }
  }

  /** 让卡住（wait）的步骤重新排队 */
  retryWaiting(threadId: string): number {
    const t = this.st.threads[threadId];
    if (!t) return 0;
    const ws = t.steps.filter((s) => s.state === 'wait');
    if (ws.length) this.d.ws.commit(ws.map((s) => ({ type: 'step.state' as const, threadId, stepId: s.id, state: 'queue' as const })), { kind: 'user', id: 'me' });
    return ws.length;
  }

  /** 等所有排队中的消息处理完（测试用） */
  async idle(): Promise<void> {
    await Promise.all([...this.queues.values()]);
  }
}
