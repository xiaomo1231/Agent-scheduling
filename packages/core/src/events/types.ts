import type {
  Actor, Approval, ApprovalState, AllowRule, InstalledSkill, Message, ModelGroup, ModelSource, Policy, Project,
  ProjectSettings, Step, StepState, Thread, Widget, ModelChoice, Worktree, ReviewSetup, SideParent,
  MemoryEntry, Channel,
} from '../model/types.js';

/** 事件正文：已经发生的事。名字用“领域.动作”。 */
export type EventBody =
  | { type: 'project.created'; project: Project }
  | { type: 'project.updated'; projectId: string; patch: Partial<Pick<Project, 'name' | 'color' | 'goal' | 'archived' | 'folder'>> & { settings?: Partial<ProjectSettings> } }
  | { type: 'project.layoutChanged'; projectId: string; layout: Widget[] }
  | { type: 'project.deleted'; projectId: string }
  | { type: 'thread.created'; thread: Thread }
  | { type: 'thread.message'; message: Message }
  | { type: 'thread.resolved'; threadId: string; by: 'coordinator' | 'user'; reason: string }
  | { type: 'thread.reopened'; threadId: string; by: 'coordinator' | 'user' }
  | { type: 'thread.settings'; threadId: string; model?: ModelChoice | null; effort?: string; title?: string }
  | { type: 'thread.worktree'; threadId: string; worktree: Worktree | null }
  | { type: 'plan.changed'; threadId: string; steps: Step[]; summary: string; previous: Step[] }
  | { type: 'step.state'; threadId: string; stepId: string; state: StepState }
  | { type: 'approval.requested'; approval: Approval }
  | { type: 'approval.decided'; approvalId: string; state: Exclude<ApprovalState, 'pending'>; addRule?: AllowRule }
  | { type: 'policy.changed'; policy: Policy }
  | { type: 'source.saved'; source: ModelSource }
  | { type: 'source.removed'; sourceId: string }
  | { type: 'group.saved'; group: ModelGroup }
  | { type: 'group.removed'; groupId: string }
  | { type: 'skill.installed'; skill: InstalledSkill }
  | { type: 'skill.removed'; name: string }
  | { type: 'system.emergencyStop'; on: boolean }
  | { type: 'thread.review'; threadId: string; review: ReviewSetup }
  | { type: 'thread.sideClosed'; threadId: string; outcome: NonNullable<SideParent['outcome']> }
  | { type: 'usage.recorded'; day: string; projectId: string; sourceId: string; model: string; input: number; output: number }
  | { type: 'source.quota'; sourceId: string; until: number | null; reason?: string }
  | { type: 'memory.desk'; projectId: string; desk: string }
  | { type: 'memory.added'; projectId: string; entry: MemoryEntry }
  | { type: 'memory.removed'; projectId: string; entryId: string }
  | { type: 'memory.consolidated'; projectId: string; desk: string; entries: MemoryEntry[] }
  | { type: 'channel.saved'; channel: Channel }
  | { type: 'channel.removed'; channelId: string };

export type EventType = EventBody['type'];

export interface EventMeta {
  seq: number;
  ts: number;
  actor: Actor;
  prevHash: string;
  hash: string;
}

export type ZEvent = EventMeta & { body: EventBody };
