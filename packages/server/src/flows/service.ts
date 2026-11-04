import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import {
  FLOW_PRESETS, MAX_BATCHES, MAX_BATCH_ROWS, MAX_REJECTS, chunkRows, emptyRun, extractTable, memoryPrompt, newId, parseCsv, previewOf, readyNodes, rejectTargets,
  renderTemplate, resolveChoice, runStatus, runsViaCli, sha256Hex, stepsForFlow, tableToMarkdown, toCsv, upstreamOf, validateFlow,
  type Actor, type EventBody, type FlowDef, type FlowNode, type FlowRun, type Message, type ModelChoice, type NodeOutput, type Project, type ResolvedModel, type Row, type Thread,
} from '@zhongshu/core';
import type { Workspace } from '../store/index.js';
import type { Runner, StepTask } from '../runners/index.js';
import { wrapUntrusted } from '../runners/index.js';
import type { SearchHit, SearchService } from '../search/index.js';
import { redact } from '../secrets/index.js';

export interface FlowDeps {
  ws: Workspace;
  folderFor: (p: Project) => string;
  runners: { builtin: Runner; cli: Runner };
  search?: SearchService;
  /** 没模型时用模拟结果走通流程 */
  simulate?: boolean;
  random?: () => number;
  /** 同时跑几个节点 */
  parallel?: number;
}

const SYS: Actor = { kind: 'system', id: 'flow' };
const ME: Actor = { kind: 'user', id: 'me' };
/** 给模型看的上游内容上限（字符） */
const CONTEXT_LIMIT = 8000;

/** 一个已经读进内存的节点结果 */
interface Loaded {
  node: FlowNode;
  out: NodeOutput;
  text?: string;
  rows?: Row[];
}

/**
 * 工作流执行器。一次运行 = 一条 kind 为 flow 的讨论串；节点状态投影成步骤。
 * 每轮挑“上游都完成”的节点并行跑；人工节点把步骤置为 wait，等用户在收件箱里拍板。
 */
export class FlowService {
  private readonly rnd: () => number;
  private readonly running = new Map<string, Promise<void>>();
  private readonly stopped = new Set<string>();

  constructor(private readonly d: FlowDeps) {
    this.rnd = d.random ?? Math.random;
    // 上次退出时还在跑的节点退回排队
    const fix: EventBody[] = [];
    for (const t of Object.values(d.ws.current.threads)) {
      if (!t.run) continue;
      for (const [id, n] of Object.entries(t.run.nodes)) if (n.state === 'run') fix.push({ type: 'run.node', threadId: t.id, nodeId: id, patch: { state: 'queue' } });
    }
    if (fix.length) d.ws.commit(fix, { kind: 'system', id: 'startup' });
  }

  private get st() {
    return this.d.ws.current;
  }

  /** 内置预设 + 用户自建 */
  all(): FlowDef[] {
    return [...FLOW_PRESETS, ...Object.values(this.st.flows)];
  }

  get(id: string): FlowDef | undefined {
    return this.st.flows[id] ?? FLOW_PRESETS.find((f) => f.id === id);
  }

  save(def: FlowDef): FlowDef {
    if (FLOW_PRESETS.some((f) => f.id === def.id)) throw new Error('内置预设不能直接改，先复制一份');
    const issues = validateFlow(def);
    if (issues.length) throw new Error(`工作流还有问题：${issues.join('；')}`);
    const { builtin: _b, ...rest } = def;
    const saved: FlowDef = { ...rest, updatedAt: Date.now() };
    this.d.ws.commit({ type: 'flow.saved', flow: saved }, ME);
    return saved;
  }

  remove(id: string): void {
    if (!this.st.flows[id]) throw new Error(FLOW_PRESETS.some((f) => f.id === id) ? '内置预设不能删' : '找不到这个工作流');
    this.d.ws.commit({ type: 'flow.removed', flowId: id }, ME);
  }

  /** 发起一次运行 */
  async start(o: { projectId: string; flowId: string; inputs: Record<string, string>; model?: ModelChoice | null }): Promise<{ threadId: string }> {
    const p = this.st.projects[o.projectId];
    if (!p) throw new Error('找不到这个项目');
    const def = this.get(o.flowId);
    if (!def) throw new Error('找不到这个工作流');
    const issues = validateFlow(def);
    if (issues.length) throw new Error(`工作流还有问题：${issues.join('；')}`);
    const inputs: Record<string, string> = {};
    for (const i of def.inputs) {
      const v = (o.inputs[i.key] ?? i.default ?? '').trim();
      if (i.required && !v) throw new Error(`“${i.label}”还没填`);
      if (i.kind === 'number' && v && !Number.isFinite(Number(v))) throw new Error(`“${i.label}”要填数字`);
      if (i.kind === 'select' && v && i.options && !i.options.includes(v)) throw new Error(`“${i.label}”只能选：${i.options.join(' / ')}`);
      inputs[i.key] = v;
    }
    if (def.nodes.some((n) => n.kind === 'search') && !this.d.search?.configured() && !this.d.simulate) throw new Error('这个工作流要搜索。先到“模型”页的“搜索服务”里选一家并填 key。');
    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
    const dir = join('产出', `${stamp}-${def.name.replace(/[/\\:*?"<>|]/g, '_')}`);
    const root = this.d.folderFor(p);
    const abs = join(root, dir);
    await mkdir(join(abs, '输入'), { recursive: true });
    // 文件类输入：工作区里的路径就复制进来，否则当成粘贴的文本存下来
    for (const i of def.inputs) {
      const v = inputs[i.key];
      if (i.kind !== 'file' || !v) continue;
      const src = inside(root, v);
      const isPath = !/[\n,]/.test(v) && v.length < 500 && src && (await stat(src).then((s) => s.isFile()).catch(() => false));
      // 粘贴的多行文本按表处理（没有逗号就是一列），单行当文字
      const ext = isPath ? (src!.match(/\.[a-z0-9]+$/i)?.[0] ?? '') : v.trim().split(/\r?\n/).filter((l) => l.trim()).length >= 2 ? '.csv' : '.txt';
      const dest = join(abs, '输入', `${i.key}${ext}`);
      if (isPath) await copyFile(src!, dest);
      else await writeFile(dest, v);
      inputs[i.key] = join('输入', `${i.key}${ext}`);
    }
    await writeFile(join(abs, '输入', '表单.json'), JSON.stringify(Object.fromEntries(def.inputs.map((i) => [i.key, inputs[i.key]])), null, 2));
    const t: Thread = {
      id: newId('thr', this.rnd), projectId: p.id, kind: 'flow', title: def.name, createdAt: Date.now(), updatedAt: Date.now(), resolved: null, keepOpen: false,
      model: o.model ?? p.settings.threadDefault.model, steps: [],
    };
    const run = emptyRun(def, inputs, dir);
    const form = def.inputs.filter((i) => inputs[i.key]).map((i) => `${i.label}：${i.kind === 'longtext' || i.kind === 'file' ? previewOf(inputs[i.key]!, 80) : inputs[i.key]}`).join('\n');
    this.d.ws.commit(
      [
        { type: 'thread.created', thread: t },
        { type: 'plan.changed', threadId: t.id, steps: stepsForFlow(def), previous: [], summary: `工作流 ${def.nodes.length} 个节点` },
        { type: 'thread.run', threadId: t.id, run },
        { type: 'thread.message', message: this.msg(t.id, `开始运行「${def.name}」。\n${form}\n产出会放在 ${dir}/`) },
      ],
      ME,
    );
    this.pump(t.id);
    return { threadId: t.id };
  }

  /** 用户在检查点拍板 */
  async decide(threadId: string, nodeId: string, approve: boolean, note = '', picked?: number[]): Promise<void> {
    const t = this.st.threads[threadId];
    const def = t?.run && this.defFor(t.run);
    if (!t?.run || !def) throw new Error('这不是一次工作流运行');
    const node = def.nodes.find((n) => n.id === nodeId);
    const rn = t.run.nodes[nodeId];
    if (!node || node.kind !== 'human' || rn?.state !== 'wait') throw new Error('这一步现在不在等你');
    if (!approve && !note.trim()) throw new Error('打回要写一句意见，模型才知道怎么改');
    const bodies: EventBody[] = [{ type: 'run.decided', threadId, nodeId, approve, ...(note ? { note } : {}), ...(picked ? { picked } : {}) }];
    if (approve) {
      const ups = await this.loadUpstream(t, def, node);
      let out: NodeOutput | undefined = ups[0]?.out;
      if (node.config.pick && picked) {
        const table = ups.find((u) => u.rows);
        if (!table?.rows) throw new Error('上游没有表格，没法勾选');
        const rows = picked.filter((i) => i >= 0 && i < table.rows!.length).map((i) => table.rows![i]!);
        if (!rows.length) throw new Error('一行都没勾');
        out = await this.saveTable(t, node, rows, table.out.external);
      }
      bodies.push({ type: 'run.node', threadId, nodeId, patch: { state: 'done', ...(out ? { output: out } : {}), ...(note ? { note } : {}) } });
      bodies.push({ type: 'thread.message', message: this.msg(threadId, `你通过了「${node.title}」${picked ? `，勾了 ${picked.length} 行` : ''}${note ? `：${note}` : ''}`, ME, '你') });
      this.d.ws.commit(bodies, ME);
      this.pump(threadId);
      return;
    }
    const targets = rejectTargets(def, nodeId);
    if (!targets) throw new Error('上游没有模型节点，打回了也没人改；可以改表单重新发起');
    if (t.run.rejects + 1 >= MAX_REJECTS) {
      bodies.push({ type: 'run.node', threadId, nodeId, patch: { state: 'failed', note: `打回了 ${MAX_REJECTS} 次还不满意：${note}` } });
      bodies.push({ type: 'thread.message', message: this.msg(threadId, `已经打回 ${MAX_REJECTS} 次了。建议改一下表单重新发起，或者在编排里把要求写得更具体。`) });
      this.d.ws.commit(bodies, ME);
      return;
    }
    const rerunNode = def.nodes.find((n) => n.id === targets.rerun)!;
    bodies.push({ type: 'run.node', threadId, nodeId: targets.rerun, patch: { state: 'queue', note } });
    for (const id of targets.reset) bodies.push({ type: 'run.node', threadId, nodeId: id, patch: { state: 'queue' } });
    bodies.push({ type: 'thread.message', message: this.msg(threadId, `你打回了「${node.title}」：${note}\n「${rerunNode.title}」会按这个意见重做。`, ME, '你') });
    this.d.ws.commit(bodies, ME);
    this.pump(threadId);
  }

  /** 失败的节点重新排队 */
  retry(threadId: string): number {
    const t = this.st.threads[threadId];
    if (!t?.run) throw new Error('这不是一次工作流运行');
    const failed = Object.entries(t.run.nodes).filter(([, n]) => n.state === 'failed').map(([id]) => id);
    if (failed.length) this.d.ws.commit(failed.map((id) => ({ type: 'run.node' as const, threadId, nodeId: id, patch: { state: 'queue' as const } })), ME);
    this.stopped.delete(threadId);
    this.pump(threadId);
    return failed.length;
  }

  stop(threadId: string): void {
    this.stopped.add(threadId);
  }

  stopAll(): void {
    for (const id of this.running.keys()) this.stopped.add(id);
  }

  isRunning(threadId: string): boolean {
    return this.running.has(threadId);
  }

  /** 读运行目录里的一个文件（给“产出”窗口用），只能读这次运行的目录 */
  async readFile(threadId: string, path: string): Promise<{ content: string; truncated: boolean }> {
    const t = this.st.threads[threadId];
    if (!t?.run) throw new Error('这不是一次工作流运行');
    const p = this.st.projects[t.projectId];
    if (!p) throw new Error('找不到项目');
    const dir = join(this.d.folderFor(p), t.run.dir);
    const full = inside(dir, path);
    if (!full) throw new Error('只能看这次运行的产出');
    const text = await readFile(full, 'utf8');
    return text.length > 200_000 ? { content: text.slice(0, 200_000), truncated: true } : { content: text, truncated: false };
  }

  /** 等所有运行结束（测试用） */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.all([...this.running.values()]);
  }

  // ---------- 执行 ----------

  private defFor(run: FlowRun): FlowDef | undefined {
    return this.get(run.flowId);
  }

  private pump(threadId: string): void {
    if (this.running.has(threadId)) return;
    this.stopped.delete(threadId);
    const p = this.loop(threadId).catch((err: unknown) => {
      this.d.ws.commit({ type: 'thread.message', message: this.msg(threadId, `工作流出错了：${redact(String((err as Error)?.message ?? err))}`) }, SYS);
    }).finally(() => this.running.delete(threadId));
    this.running.set(threadId, p);
  }

  private async loop(threadId: string): Promise<void> {
    for (;;) {
      const t = this.st.threads[threadId];
      const def = t?.run && this.defFor(t.run);
      if (!t?.run || !def || t.resolved || this.stopped.has(threadId) || this.st.emergencyStop) return;
      const ready = readyNodes(def, t.run);
      if (!ready.length) {
        const s = runStatus(t.run);
        if (s === 'done') this.finish(threadId);
        return; // waiting / failed：等用户
      }
      const batch = ready.slice(0, Math.max(1, this.d.parallel ?? 3));
      await Promise.all(batch.map((n) => this.runNode(threadId, n)));
    }
  }

  private async runNode(threadId: string, node: FlowNode): Promise<void> {
    const t0 = this.st.threads[threadId]!;
    const def = this.defFor(t0.run!)!;
    const prev = t0.run!.nodes[node.id];
    this.d.ws.commit({ type: 'run.node', threadId, nodeId: node.id, patch: { state: 'run', attempts: (prev?.attempts ?? 0) + 1 } }, SYS);
    try {
      const t = this.st.threads[threadId]!;
      const ups = await this.loadUpstream(t, def, node);
      let out: NodeOutput | undefined;
      switch (node.kind) {
        case 'input': out = await this.runInput(t, node); break;
        case 'search': out = await this.runSearch(t, node, ups); break;
        case 'agent': out = await this.runAgent(t, def, node, ups, prev?.note); break;
        case 'export': out = await this.runExport(t, node, ups); break;
        case 'human': {
          const ask = renderTemplate(node.config.ask, t.run!.inputs);
          this.d.ws.commit(
            [
              { type: 'run.node', threadId, nodeId: node.id, patch: { state: 'wait', note: ask } },
              { type: 'thread.message', message: this.msg(threadId, `等你确认「${node.title}」：${ask}\n在待办收件箱里处理。`) },
            ],
            SYS,
          );
          return;
        }
      }
      if (this.stopped.has(threadId)) return;
      this.d.ws.commit(
        [
          { type: 'run.node', threadId, nodeId: node.id, patch: { state: 'done', ...(out ? { output: out } : {}) } },
          { type: 'thread.message', message: this.msg(threadId, `「${node.title}」做完了${out ? `：${describe(out)}` : ''}`) },
        ],
        SYS,
      );
    } catch (err) {
      const why = redact((err as Error).message ?? String(err));
      this.d.ws.commit(
        [
          { type: 'run.node', threadId, nodeId: node.id, patch: { state: 'failed', note: why } },
          { type: 'thread.message', message: this.msg(threadId, `「${node.title}」卡住了：${why}\n处理好后点“重试”。`) },
        ],
        SYS,
      );
    }
  }

  private finish(threadId: string): void {
    const t = this.st.threads[threadId]!;
    const p = this.st.projects[t.projectId]!;
    const files = Object.values(t.run!.nodes).flatMap((n) => (n.output?.kind === 'files' && n.output.path ? n.output.path.split(',') : []));
    const bodies: EventBody[] = [{ type: 'thread.message', message: this.msg(threadId, `全部做完了。产出在 ${t.run!.dir}/${files.length ? `：\n${files.map((f) => `· ${f}`).join('\n')}` : ''}`) }];
    if (p.settings.autoResolve && !t.keepOpen) bodies.push({ type: 'thread.resolved', threadId, by: 'coordinator', reason: '工作流跑完了' });
    this.d.ws.commit(bodies, SYS);
  }

  // ---------- 各种节点 ----------

  private async runInput(t: Thread, node: FlowNode & { kind: 'input' }): Promise<NodeOutput> {
    const v = t.run!.inputs[node.config.key] ?? '';
    const input = this.get(t.run!.flowId)?.inputs.find((i) => i.key === node.config.key);
    if (input?.kind === 'file') {
      const text = await readFile(join(this.absDir(t), v), 'utf8');
      if (/\.csv$/i.test(v)) {
        const rows = parseCsv(text);
        if (rows.length) return { kind: 'table', path: v, preview: previewOf(tableToMarkdown(rows, 3)), rows: rows.length, sha256: sha256Hex(text) };
      }
      return { kind: 'text', path: v, preview: previewOf(text), sha256: sha256Hex(text) };
    }
    return this.saveText(t, node, v);
  }

  private async runSearch(t: Thread, node: FlowNode & { kind: 'search' }, ups: Loaded[]): Promise<NodeOutput> {
    let queries: string[];
    if (node.config.queriesFrom) {
      const col = node.config.queriesFrom;
      queries = ups.flatMap((u) => u.rows ?? []).map((r) => r[col] ?? '').filter(Boolean);
      if (!queries.length) throw new Error(`上游表格里没有“${col}”这一列`);
    } else queries = node.config.queries.map((q) => renderTemplate(q, t.run!.inputs)).filter((q) => q.trim());
    queries = [...new Set(queries)].slice(0, 10);
    const rows: Row[] = [];
    const seen = new Set<string>();
    for (const q of queries) {
      const hits = this.d.search?.configured()
        ? await this.d.search.search(q, { limit: node.config.limit ?? 8, recency: node.config.recency ?? 'any' })
        : this.d.simulate
          ? [1, 2, 3].map((i): SearchHit => ({ title: `（模拟）${q} 结果 ${i}`, url: `https://example.com/${encodeURIComponent(q)}/${i}`, snippet: `这是关于“${q}”的模拟搜索结果 ${i}`, date: '2026-01-01' }))
          : (() => { throw new Error('还没接搜索服务'); })();
      for (const h of hits) {
        if (seen.has(h.url)) continue;
        seen.add(h.url);
        rows.push({ 查询词: q, 标题: h.title, 链接: h.url, 摘要: h.snippet, 日期: h.date ?? '', 来源: h.source ?? '' });
      }
    }
    return this.saveTable(t, node, rows, true);
  }

  private async runAgent(t: Thread, def: FlowDef, node: FlowNode & { kind: 'agent' }, ups: Loaded[], feedback?: string): Promise<NodeOutput> {
    const cfg = node.config;
    const p = this.st.projects[t.projectId]!;
    const choice = cfg.model ?? t.model ?? p.settings.threadDefault.model ?? null;
    const model = resolveChoice(choice, this.st.sources, this.st.groups);
    if (!model && !this.d.simulate) throw new Error('还没选执行模型。在项目设置里选一个讨论串默认模型，或在编排里给这个节点指定模型');
    const instruction = renderTemplate(cfg.instruction, t.run!.inputs) + (feedback ? `\n\n用户对上一版的意见（必须照改）：${feedback}` : '');
    const external = ups.some((u) => u.out.external);
    const form = def.inputs.filter((i) => i.kind !== 'file' && t.run!.inputs[i.key]).map((i) => `- ${i.label}：${t.run!.inputs[i.key]}`).join('\n');

    const once = async (loaded: Loaded[], tag: string): Promise<string> => {
      const context = loaded.map((u) => this.describeUpstream(u, cfg.sample)).join('\n\n');
      const prompt = [
        instruction,
        form ? `\n表单输入：\n${form}` : '',
        context ? `\n上游结果：\n${context}` : '',
        cfg.output === 'table' ? '\n输出要求：只用一个 ```csv 代码块给出表格，第一行是表头，不要别的内容。' : '',
      ].filter(Boolean).join('\n');
      if (!model) return cfg.output === 'table' ? '```csv\n结果,说明\n（模拟）' + node.title + tag + ',没有接模型时的占位结果\n```' : `（模拟）「${node.title}」${tag} 的结果。接上模型后这里会是真的内容。`;
      const task: StepTask = {
        projectId: p.id, threadId: t.id, stepId: node.id, title: node.title + tag, threadTitle: t.title, goal: `工作流「${t.run!.flowName}」`,
        instructions: p.settings.instructions, workspaceRoot: this.absDir(t), agentId: `@flow/${node.id}`, model, ...(cfg.effort ? { effort: cfg.effort } : {}),
        memory: memoryPrompt(this.st.memory[p.id], `${t.title} ${node.title}`), tools: cfg.tools, externalContext: external,
      };
      const runner = runsViaCli(model.source.transport) ? this.d.runners.cli : this.d.runners.builtin;
      const r = await runner.run({ ...task, prompt }, (text) => this.d.ws.commit({ type: 'thread.message', message: this.msg(t.id, redact(text), { kind: 'agent', id: task.agentId }, `${node.title}${tag} · ${model.model.label}`) }, { kind: 'agent', id: task.agentId }));
      if (!r.ok) throw new Error(r.summary);
      return r.summary;
    };

    let text: string;
    let rows: Row[] | null = null;
    if (cfg.each) {
      const rowsN = Number(typeof cfg.each.rows === 'string' ? renderTemplate(cfg.each.rows, t.run!.inputs) : cfg.each.rows);
      if (!Number.isFinite(rowsN) || rowsN < 1) throw new Error('每批行数不对');
      if (rowsN > MAX_BATCH_ROWS) throw new Error(`每批最多 ${MAX_BATCH_ROWS} 行`);
      const src = (cfg.each.from ? ups.find((u) => u.node.id === cfg.each!.from) : [...ups].filter((u) => u.rows).sort((a, b) => (b.rows?.length ?? 0) - (a.rows?.length ?? 0))[0]);
      if (!src?.rows) throw new Error('“对每一批分别做”需要上游有一张表');
      const chunks = chunkRows(src.rows, rowsN);
      if (chunks.length > MAX_BATCHES) throw new Error(`会切成 ${chunks.length} 批，超过上限 ${MAX_BATCHES}。把每批行数调大，或者先把数据拆开`);
      const others = ups.filter((u) => u !== src);
      const results: string[] = new Array(chunks.length);
      const limit = Math.max(1, this.d.parallel ?? 3);
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(limit, chunks.length) }, async () => {
        for (;;) {
          const i = next++;
          if (i >= chunks.length || this.stopped.has(t.id)) return;
          const part: Loaded = { ...src, rows: chunks[i]!, out: { ...src.out, rows: chunks[i]!.length } };
          results[i] = await once([...others, part], `（第 ${i + 1}/${chunks.length} 批）`);
        }
      }));
      if (cfg.output === 'table') {
        rows = [];
        results.forEach((r, i) => {
          const tb = extractTable(r ?? '');
          if (!tb) throw new Error(`第 ${i + 1} 批的结果不是表格，点“重试”再跑一次`);
          rows!.push(...tb);
        });
        text = '';
      } else text = results.map((r, i) => (chunks.length > 1 ? `## 第 ${i + 1} 批\n\n${r}` : r)).join('\n\n');
    } else {
      text = await once(ups, '');
      if (cfg.output === 'table') {
        rows = extractTable(text);
        if (!rows) throw new Error('模型没有按要求输出表格，点“重试”再跑一次');
      }
    }
    return rows ? this.saveTable(t, node, rows, external) : this.saveText(t, node, text, external);
  }

  private async runExport(t: Thread, node: FlowNode & { kind: 'export' }, ups: Loaded[]): Promise<NodeOutput> {
    const name = node.config.filename.trim();
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    const paths: string[] = [];
    const sources = ups.filter((u) => u.out.kind !== 'files');
    for (const [i, u] of sources.entries()) {
      const file = sources.length > 1 ? `${base}-${i + 1}${ext}` : name;
      const content = u.rows ? (ext.toLowerCase() === '.md' ? tableToMarkdown(u.rows, 10_000) : toCsv(u.rows)) : u.text ?? '';
      await writeFile(join(this.absDir(t), file), content);
      paths.push(file);
    }
    if (!paths.length) throw new Error('上游没有可以导出的内容');
    return { kind: 'files', path: paths.join(','), preview: paths.join('、') };
  }

  // ---------- 结果读写 ----------

  private absDir(t: Thread): string {
    return join(this.d.folderFor(this.st.projects[t.projectId]!), t.run!.dir);
  }

  private fileName(t: Thread, node: FlowNode, ext: string): string {
    const order = t.steps.findIndex((s) => s.id === node.id) + 1;
    return `${String(order).padStart(2, '0')}-${node.title.replace(/[/\\:*?"<>|\s]/g, '_')}${ext}`;
  }

  private async saveTable(t: Thread, node: FlowNode, rows: Row[], external?: boolean): Promise<NodeOutput> {
    const path = this.fileName(t, node, '.csv');
    const csv = toCsv(rows);
    await writeFile(join(this.absDir(t), path), csv);
    return { kind: 'table', path, preview: previewOf(tableToMarkdown(rows, 3)), rows: rows.length, sha256: sha256Hex(csv), ...(external ? { external: true } : {}) };
  }

  private async saveText(t: Thread, node: FlowNode, text: string, external?: boolean): Promise<NodeOutput> {
    const path = this.fileName(t, node, '.md');
    await writeFile(join(this.absDir(t), path), text);
    return { kind: 'text', path, preview: previewOf(text), sha256: sha256Hex(text), ...(external ? { external: true } : {}) };
  }

  private async loadUpstream(t: Thread, def: FlowDef, node: FlowNode): Promise<Loaded[]> {
    const out: Loaded[] = [];
    for (const u of upstreamOf(def, node.id)) {
      const o = t.run!.nodes[u.id]?.output;
      if (!o) continue;
      const l: Loaded = { node: u, out: o };
      if (o.path && o.kind !== 'files') {
        const text = await readFile(join(this.absDir(t), o.path), 'utf8');
        if (o.kind === 'table') l.rows = parseCsv(text);
        else l.text = text;
      }
      out.push(l);
    }
    return out;
  }

  private describeUpstream(u: Loaded, sample?: number): string {
    let body: string;
    if (u.rows) {
      const limit = sample ?? u.rows.length;
      let md = tableToMarkdown(u.rows, limit);
      if (md.length > CONTEXT_LIMIT) {
        let n = Math.min(limit, u.rows.length);
        while (n > 1 && md.length > CONTEXT_LIMIT) { n = Math.floor(n / 2); md = tableToMarkdown(u.rows, n); }
      }
      body = md;
    } else body = (u.text ?? '').length > CONTEXT_LIMIT ? u.text!.slice(0, CONTEXT_LIMIT) + `\n…（太长已截断，完整内容在文件 ${u.out.path}）` : u.text ?? '';
    const head = `### ${u.node.title}（${u.rows ? `表格，${u.out.rows ?? u.rows.length} 行` : '文字'}${u.out.path ? `；文件 ${u.out.path}` : ''}）`;
    return `${head}\n${u.out.external ? wrapUntrusted(u.node.title, body) : body}`;
  }

  private msg(threadId: string, text: string, author: Actor = SYS, label = '工作流'): Message {
    return { id: newId('msg', this.rnd), threadId, author, authorLabel: label, text, ts: Date.now() };
  }
}

function describe(o: NodeOutput): string {
  if (o.kind === 'table') return `${o.rows ?? 0} 行表格（${o.path}）`;
  if (o.kind === 'files') return `写了 ${o.preview}`;
  return o.preview.slice(0, 120);
}

function inside(root: string, p: string): string | null {
  const full = isAbsolute(p) ? resolve(p) : resolve(root, p);
  const r = resolve(root);
  return full === r || full.startsWith(r + sep) ? full : null;
}
