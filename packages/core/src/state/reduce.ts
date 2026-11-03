import { defaultPolicy } from '../model/defaults.js';
import { MEMORY_ENTRY_LIMIT, type Approval, type Channel, type InstalledSkill, type Message, type ModelGroup, type ModelSource, type Policy, type Project, type ProjectMemory, type QuotaWait, type SearchSettings, type Thread, type UsageRow } from '../model/types.js';
import { stepStateFor, type FlowDef } from '../workflow/index.js';
import type { ZEvent } from '../events/types.js';
import { GENESIS_HASH } from '../events/chain.js';

/** 整个工作区的当前状态，全部由事件推出来。前后端共用。 */
export interface State {
  projects: Record<string, Project>;
  threads: Record<string, Thread>;
  messages: Record<string, Message[]>;
  approvals: Record<string, Approval>;
  policy: Policy;
  sources: Record<string, ModelSource>;
  groups: Record<string, ModelGroup>;
  skills: Record<string, InstalledSkill>;
  emergencyStop: boolean;
  /** 键为 日期|项目|来源|模型 */
  usage: Record<string, UsageRow>;
  quota: Record<string, QuotaWait>;
  memory: Record<string, ProjectMemory>;
  channels: Record<string, Channel>;
  /** 用户自建或改过的工作流（内置预设不在这里） */
  flows: Record<string, FlowDef>;
  search: SearchSettings | null;
  lastSeq: number;
  lastHash: string;
}

export function emptyState(): State {
  return {
    projects: {}, threads: {}, messages: {}, approvals: {}, policy: defaultPolicy(), sources: {}, groups: {}, skills: {},
    emergencyStop: false, usage: {}, quota: {}, memory: {}, channels: {}, flows: {}, search: null, lastSeq: 0, lastHash: GENESIS_HASH,
  };
}

/** 应用一条事件，返回新状态（不改旧对象）。 */
export function reduce(s: State, e: ZEvent): State {
  const next: State = { ...s, lastSeq: e.seq, lastHash: e.hash };
  const b = e.body;
  switch (b.type) {
    case 'project.created':
      next.projects = { ...s.projects, [b.project.id]: b.project };
      break;
    case 'project.updated': {
      const p = s.projects[b.projectId];
      if (!p) break;
      const { settings, ...rest } = b.patch;
      next.projects = { ...s.projects, [p.id]: { ...p, ...rest, settings: settings ? { ...p.settings, ...settings } : p.settings } };
      break;
    }
    case 'project.layoutChanged': {
      const p = s.projects[b.projectId];
      if (p) next.projects = { ...s.projects, [p.id]: { ...p, layout: b.layout } };
      break;
    }
    case 'project.deleted': {
      const { [b.projectId]: _gone, ...rest } = s.projects;
      next.projects = rest;
      const threads: Record<string, Thread> = {};
      const messages: Record<string, Message[]> = {};
      for (const t of Object.values(s.threads)) {
        if (t.projectId !== b.projectId) { threads[t.id] = t; messages[t.id] = s.messages[t.id] ?? []; }
      }
      next.threads = threads;
      next.messages = messages;
      break;
    }
    case 'thread.created':
      next.threads = { ...s.threads, [b.thread.id]: b.thread };
      next.messages = { ...s.messages, [b.thread.id]: [] };
      break;
    case 'thread.message': {
      const t = s.threads[b.message.threadId];
      if (!t) break;
      next.messages = { ...s.messages, [t.id]: [...(s.messages[t.id] ?? []), b.message] };
      next.threads = { ...s.threads, [t.id]: { ...t, updatedAt: b.message.ts } };
      break;
    }
    case 'thread.resolved': {
      const t = s.threads[b.threadId];
      if (t) next.threads = { ...s.threads, [t.id]: { ...t, resolved: { by: b.by, at: e.ts, reason: b.reason }, updatedAt: e.ts } };
      break;
    }
    case 'thread.reopened': {
      const t = s.threads[b.threadId];
      if (t) next.threads = { ...s.threads, [t.id]: { ...t, resolved: null, keepOpen: b.by === 'user' ? true : t.keepOpen, updatedAt: e.ts } };
      break;
    }
    case 'thread.settings': {
      const t = s.threads[b.threadId];
      if (!t) break;
      next.threads = {
        ...s.threads,
        [t.id]: {
          ...t,
          ...(b.model !== undefined ? { model: b.model } : {}),
          ...(b.effort !== undefined ? { effort: b.effort } : {}),
          ...(b.title !== undefined ? { title: b.title } : {}),
        },
      };
      break;
    }
    case 'thread.worktree': {
      const t = s.threads[b.threadId];
      if (!t) break;
      const { worktree: _old, ...rest } = t;
      next.threads = { ...s.threads, [t.id]: b.worktree ? { ...rest, worktree: b.worktree } : rest };
      break;
    }
    case 'plan.changed': {
      const t = s.threads[b.threadId];
      if (t) next.threads = { ...s.threads, [t.id]: { ...t, steps: b.steps, updatedAt: e.ts } };
      break;
    }
    case 'step.state': {
      const t = s.threads[b.threadId];
      if (t) next.threads = { ...s.threads, [t.id]: { ...t, steps: t.steps.map((x) => (x.id === b.stepId ? { ...x, state: b.state } : x)), updatedAt: e.ts } };
      break;
    }
    case 'approval.requested':
      next.approvals = { ...s.approvals, [b.approval.id]: b.approval };
      break;
    case 'approval.decided': {
      const a = s.approvals[b.approvalId];
      if (a) next.approvals = { ...s.approvals, [a.id]: { ...a, state: b.state, decidedAt: e.ts, decidedBy: e.actor } };
      if (b.addRule) next.policy = { ...s.policy, allowlist: [...s.policy.allowlist, b.addRule] };
      break;
    }
    case 'policy.changed':
      next.policy = b.policy;
      break;
    case 'source.saved':
      next.sources = { ...s.sources, [b.source.id]: b.source };
      break;
    case 'source.removed': {
      const { [b.sourceId]: _x, ...rest } = s.sources;
      next.sources = rest;
      break;
    }
    case 'group.saved':
      next.groups = { ...s.groups, [b.group.id]: b.group };
      break;
    case 'group.removed': {
      const { [b.groupId]: _x, ...rest } = s.groups;
      next.groups = rest;
      break;
    }
    case 'skill.installed':
      next.skills = { ...s.skills, [b.skill.name]: b.skill };
      break;
    case 'skill.removed': {
      const { [b.name]: _x, ...rest } = s.skills;
      next.skills = rest;
      break;
    }
    case 'system.emergencyStop':
      next.emergencyStop = b.on;
      break;
    case 'thread.review': {
      const t = s.threads[b.threadId];
      if (t) next.threads = { ...s.threads, [t.id]: { ...t, review: b.review, updatedAt: e.ts } };
      break;
    }
    case 'thread.sideClosed': {
      const t = s.threads[b.threadId];
      if (t?.parent) next.threads = { ...s.threads, [t.id]: { ...t, parent: { ...t.parent, outcome: b.outcome }, updatedAt: e.ts } };
      break;
    }
    case 'usage.recorded': {
      const k = usageKey(b);
      const r = s.usage[k] ?? { day: b.day, projectId: b.projectId, sourceId: b.sourceId, model: b.model, calls: 0, input: 0, output: 0 };
      next.usage = { ...s.usage, [k]: { ...r, calls: r.calls + 1, input: r.input + b.input, output: r.output + b.output } };
      break;
    }
    case 'source.quota': {
      const { [b.sourceId]: _x, ...rest } = s.quota;
      next.quota = b.until === null ? rest : { ...rest, [b.sourceId]: { sourceId: b.sourceId, until: b.until, reason: b.reason ?? '' } };
      break;
    }
    case 'memory.desk': {
      const m = s.memory[b.projectId] ?? { desk: '', entries: [] };
      next.memory = { ...s.memory, [b.projectId]: { ...m, desk: b.desk } };
      break;
    }
    case 'memory.added': {
      const m = s.memory[b.projectId] ?? { desk: '', entries: [] };
      next.memory = { ...s.memory, [b.projectId]: { ...m, entries: [...m.entries, b.entry].slice(-MEMORY_ENTRY_LIMIT) } };
      break;
    }
    case 'memory.removed': {
      const m = s.memory[b.projectId];
      if (m) next.memory = { ...s.memory, [b.projectId]: { ...m, entries: m.entries.filter((x) => x.id !== b.entryId) } };
      break;
    }
    case 'memory.consolidated':
      next.memory = { ...s.memory, [b.projectId]: { desk: b.desk, entries: b.entries, consolidatedAt: e.ts } };
      break;
    case 'channel.saved':
      next.channels = { ...s.channels, [b.channel.id]: b.channel };
      break;
    case 'channel.removed': {
      const { [b.channelId]: _x, ...rest } = s.channels;
      next.channels = rest;
      break;
    }
    case 'flow.saved':
      next.flows = { ...s.flows, [b.flow.id]: b.flow };
      break;
    case 'flow.removed': {
      const { [b.flowId]: _x, ...rest } = s.flows;
      next.flows = rest;
      break;
    }
    case 'thread.run': {
      const t = s.threads[b.threadId];
      if (t) next.threads = { ...s.threads, [t.id]: { ...t, run: b.run, updatedAt: e.ts } };
      break;
    }
    case 'run.node': {
      const t = s.threads[b.threadId];
      if (!t?.run) break;
      const prev = t.run.nodes[b.nodeId] ?? { state: 'queue' as const };
      // 重新排队就丢掉旧结果，只留意见和次数
      const node = b.patch.state === 'queue' ? { state: 'queue' as const, ...(prev.attempts ? { attempts: prev.attempts } : {}), ...(b.patch.note ? { note: b.patch.note } : {}) } : { ...prev, ...b.patch };
      const steps = b.patch.state ? t.steps.map((x) => (x.id === b.nodeId ? { ...x, state: stepStateFor(b.patch.state!) } : x)) : t.steps;
      next.threads = { ...s.threads, [t.id]: { ...t, steps, run: { ...t.run, nodes: { ...t.run.nodes, [b.nodeId]: node } }, updatedAt: e.ts } };
      break;
    }
    case 'run.decided': {
      const t = s.threads[b.threadId];
      if (!t?.run) break;
      const prev = t.run.nodes[b.nodeId] ?? { state: 'queue' as const };
      const node = { ...prev, decision: { approve: b.approve, ...(b.note ? { note: b.note } : {}), at: e.ts } };
      next.threads = { ...s.threads, [t.id]: { ...t, run: { ...t.run, nodes: { ...t.run.nodes, [b.nodeId]: node }, rejects: t.run.rejects + (b.approve ? 0 : 1) }, updatedAt: e.ts } };
      break;
    }
    case 'search.saved':
      next.search = b.search;
      break;
    case 'search.removed':
      next.search = null;
      break;
    default: {
      const never: never = b;
      void never;
    }
  }
  return next;
}

export function usageKey(r: { day: string; projectId: string; sourceId: string; model: string }): string {
  return `${r.day}|${r.projectId}|${r.sourceId}|${r.model}`;
}

export function replay(events: readonly ZEvent[], from: State = emptyState()): State {
  return events.reduce(reduce, from);
}
