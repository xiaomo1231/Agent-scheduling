import { defaultPolicy } from '../model/defaults.js';
import type { Approval, InstalledSkill, Message, ModelGroup, ModelSource, Policy, Project, Thread } from '../model/types.js';
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
  lastSeq: number;
  lastHash: string;
}

export function emptyState(): State {
  return {
    projects: {}, threads: {}, messages: {}, approvals: {}, policy: defaultPolicy(), sources: {}, groups: {}, skills: {},
    emergencyStop: false, lastSeq: 0, lastHash: GENESIS_HASH,
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
    default: {
      const never: never = b;
      void never;
    }
  }
  return next;
}

export function replay(events: readonly ZEvent[], from: State = emptyState()): State {
  return events.reduce(reduce, from);
}
