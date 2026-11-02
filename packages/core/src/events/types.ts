import type {
  Actor, Approval, ApprovalState, AllowRule, InstalledSkill, Message, ModelGroup, ModelSource, Policy, Project,
  ProjectSettings, Step, StepState, Thread, Widget, ModelChoice,
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
  | { type: 'system.emergencyStop'; on: boolean };

export type EventType = EventBody['type'];

export interface EventMeta {
  seq: number;
  ts: number;
  actor: Actor;
  prevHash: string;
  hash: string;
}

export type ZEvent = EventMeta & { body: EventBody };
