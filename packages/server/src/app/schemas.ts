import { z } from 'zod';

// 网关入口统一校验。字段名和 core 的类型一一对应。
const id = (p: string) => z.string().regex(new RegExp(`^${p}_[a-z0-9]{6,32}$`), `应是 ${p}_ 开头的编号`);
const text = (max: number) => z.string().max(max);

export const ModelRefS = z.object({ sourceId: z.string().max(64), modelId: z.string().max(200) });
export const ModelChoiceS = z.union([
  z.object({ kind: z.literal('model'), ref: ModelRefS }),
  z.object({ kind: z.literal('group'), groupId: z.string().max(64), purpose: text(40) }),
]);
export const WidgetS = z.object({ id: z.string().max(64), k: z.string().max(64), x: z.number().int(), y: z.number().int(), w: z.number().int(), h: z.number().int() });
export const ModelEntryS = z.object({ id: text(200).min(1), label: text(100), vendor: text(60), enabled: z.boolean() });
export const SourceS = z.object({
  id: z.string().max(64),
  kind: z.enum(['subscription', 'plan', 'apikey', 'local']),
  name: text(100).min(1),
  transport: z.enum(['anthropic', 'openai', 'cli-claude', 'cli-codex', 'cli-gemini', 'cli-copilot', 'mock']),
  baseUrl: z.string().url().max(300).optional(),
  multiVendor: z.boolean().optional(),
  models: z.array(ModelEntryS).max(200),
});
export const GroupS = z.object({
  id: z.string().max(64),
  name: text(60).min(1),
  roles: z.array(z.object({ purpose: text(40), model: ModelRefS.nullable(), backup: ModelRefS.nullable(), effort: text(20).optional() })).max(20),
});
export const AllowRuleS = z.object({
  id: z.string().max(64), program: text(100).min(1), args: text(500).optional(), agents: z.union([z.literal('*'), z.array(text(100))]),
  source: z.enum(['default', 'always', 'user']), note: text(300).optional(),
});
export const PolicyS = z.object({
  commandMode: z.enum(['deny', 'allowlist', 'ask', 'review', 'dangerouslyAllowAll']),
  strictInlineEval: z.boolean(),
  askFallback: z.enum(['deny', 'allowlist']),
  approvalTimeoutSec: z.number().int().min(10).max(86400),
  highRisk: z.object({ deleteFiles: z.boolean(), database: z.boolean(), pushOrRelease: z.boolean(), install: z.boolean(), externalWrite: z.boolean(), spendOverYuan: z.number().nullable() }),
  allowlist: z.array(AllowRuleS).max(500),
  separateNetworkAndExec: z.boolean(),
  sandboxSubagents: z.boolean(),
});
const SettingsPatchS = z.object({
  coordinator: z.object({
    model: ModelChoiceS.nullable(),
    effort: text(20).optional(),
    dual: z.object({ enabled: z.boolean(), mode: z.enum(['review', 'backup']), model: ModelChoiceS.nullable(), effort: text(20).optional() }).optional(),
  }).optional(),
  threadDefault: z.object({ model: ModelChoiceS.nullable(), effort: text(20).optional() }).optional(),
  autoResolve: z.boolean().optional(),
  autoContinueAfterQuotaReset: z.boolean().optional(),
  useWorktrees: z.boolean().optional(),
  instructions: text(20000).optional(),
});
const PlanOpS = z.union([
  z.object({ op: z.literal('add'), title: text(200).min(1), assignee: text(60).optional(), after: z.string().optional(), before: z.string().optional() }),
  z.object({ op: z.literal('move'), stepId: z.string(), before: z.string().optional(), after: z.string().optional(), first: z.boolean().optional() }),
  z.object({ op: z.literal('cancel'), stepId: z.string() }),
  z.object({ op: z.literal('rename'), stepId: z.string(), title: text(200).min(1) }),
  z.object({ op: z.literal('assign'), stepId: z.string(), assignee: text(60) }),
  z.object({ op: z.literal('state'), stepId: z.string(), state: z.enum(['queue', 'run', 'wait', 'done', 'cancelled']) }),
]);
const Files = z.record(z.string().max(300), z.string().max(500_000));
const ToolNameS = z.enum(['read_file', 'write_file', 'edit_file', 'list_files', 'run_command', 'web_fetch', 'web_search', 'send_message']);
const NodeBaseS = { id: z.string().max(64).min(1), title: text(60), x: z.number(), y: z.number() };
const FlowNodeS = z.discriminatedUnion('kind', [
  z.object({ ...NodeBaseS, kind: z.literal('input'), config: z.object({ key: text(60) }) }),
  z.object({ ...NodeBaseS, kind: z.literal('search'), config: z.object({ queries: z.array(text(300)).max(10), queriesFrom: text(60).optional(), limit: z.number().int().min(1).max(20).optional(), recency: z.enum(['day', 'week', 'month', 'year', 'any']).optional() }) }),
  z.object({ ...NodeBaseS, kind: z.literal('agent'), config: z.object({
    instruction: text(8000), tools: z.array(ToolNameS).max(8), model: ModelChoiceS.nullable().optional(), effort: text(20).optional(), output: z.enum(['text', 'table']),
    sample: z.number().int().min(1).max(500).optional(), each: z.object({ rows: z.union([z.number().int().min(1), text(60)]), from: z.string().max(64).optional() }).optional(),
  }) }),
  z.object({ ...NodeBaseS, kind: z.literal('human'), config: z.object({ ask: text(1000), pick: z.boolean().optional() }) }),
  z.object({ ...NodeBaseS, kind: z.literal('export'), config: z.object({ filename: text(100) }) }),
]);
export const FlowDefS = z.object({
  id: z.string().max(64).min(1), name: text(60), description: text(500), audience: text(60).optional(),
  inputs: z.array(z.object({ key: text(60), label: text(60), kind: z.enum(['text', 'longtext', 'number', 'select', 'file']), required: z.boolean().optional(), options: z.array(text(60)).max(30).optional(), hint: text(200).optional(), default: text(500).optional() })).max(20),
  nodes: z.array(FlowNodeS).max(40), edges: z.array(z.object({ from: z.string().max(64), to: z.string().max(64) })).max(100),
  builtin: z.boolean().optional(), updatedAt: z.number().optional(),
});

export const CommandS = z.discriminatedUnion('type', [
  z.object({ type: z.literal('project.create'), name: text(60).min(1), color: text(20).optional(), goal: text(500).optional(), template: text(40).optional(), preset: text(40).optional(), folder: text(1000).optional() }),
  z.object({
    type: z.literal('project.update'), projectId: id('prj'),
    patch: z.object({ name: text(60).min(1).optional(), color: text(20).optional(), goal: text(500).optional(), archived: z.boolean().optional(), folder: text(1000).optional(), settings: SettingsPatchS.optional() }),
  }),
  z.object({ type: z.literal('project.layout'), projectId: id('prj'), layout: z.array(WidgetS).max(40) }),
  z.object({ type: z.literal('project.delete'), projectId: id('prj') }),
  z.object({ type: z.literal('thread.create'), projectId: id('prj'), title: text(60).min(1) }),
  z.object({ type: z.literal('message.send'), threadId: id('thr'), text: text(20000).min(1) }),
  z.object({ type: z.literal('thread.resolve'), threadId: id('thr') }),
  z.object({ type: z.literal('thread.reopen'), threadId: id('thr') }),
  z.object({ type: z.literal('thread.settings'), threadId: id('thr'), model: ModelChoiceS.nullable().optional(), effort: text(20).optional(), title: text(60).min(1).optional() }),
  z.object({ type: z.literal('thread.stop'), threadId: id('thr') }),
  z.object({ type: z.literal('thread.merge'), threadId: id('thr') }),
  z.object({ type: z.literal('thread.discard'), threadId: id('thr') }),
  z.object({ type: z.literal('thread.continue'), threadId: id('thr') }),
  z.object({ type: z.literal('plan.apply'), threadId: id('thr'), ops: z.array(PlanOpS).max(50) }),
  z.object({ type: z.literal('plan.undo'), threadId: id('thr'), seq: z.number().int().positive() }),
  z.object({ type: z.literal('approval.decide'), approvalId: id('apv'), approve: z.boolean(), always: z.boolean().optional() }),
  z.object({ type: z.literal('policy.set'), policy: PolicyS }),
  z.object({ type: z.literal('audit.fix'), findingId: text(100) }),
  z.object({ type: z.literal('source.save'), source: SourceS, secret: text(2000).optional() }),
  z.object({ type: z.literal('source.remove'), sourceId: z.string().max(64) }),
  z.object({ type: z.literal('source.test'), sourceId: z.string().max(64), modelId: text(200).optional() }),
  z.object({ type: z.literal('group.save'), group: GroupS }),
  z.object({ type: z.literal('group.remove'), groupId: z.string().max(64) }),
  z.object({ type: z.literal('skill.preview'), files: Files, name: text(64).optional(), useAgent: z.boolean().optional() }),
  z.object({ type: z.literal('skill.install'), files: Files, acceptRisks: z.boolean().optional() }),
  z.object({ type: z.literal('skill.verify'), name: text(64) }),
  z.object({ type: z.literal('skill.deploy'), name: text(64), platform: z.enum(['claude-code', 'codex', 'gemini-cli', 'opencode', 'openclaw', 'zhongshu']) }),
  z.object({ type: z.literal('skill.remove'), name: text(64) }),
  z.object({ type: z.literal('system.emergencyStop'), on: z.boolean() }),
  z.object({ type: z.literal('memory.desk'), projectId: id('prj'), desk: text(8000) }),
  z.object({ type: z.literal('memory.add'), projectId: id('prj'), text: text(500).min(1), tags: z.array(text(30)).max(5).optional(), pinned: z.boolean().optional() }),
  z.object({ type: z.literal('memory.remove'), projectId: id('prj'), entryId: id('mem') }),
  z.object({ type: z.literal('memory.consolidate'), projectId: id('prj') }),
  z.object({
    type: z.literal('review.start'), projectId: id('prj'), question: text(4000).min(1), preset: text(40).optional(),
    roles: z.array(z.object({ name: text(30).min(1), stance: text(500), devil: z.boolean().optional(), model: ModelChoiceS.nullable().optional() })).max(8).optional(),
    rounds: z.number().int().min(1).max(4).optional(), decider: ModelChoiceS.nullable().optional(), replyTo: id('thr').optional(),
  }),
  z.object({ type: z.literal('thread.side'), threadId: id('thr'), messageId: id('msg').optional(), quote: text(2000).min(1), question: text(4000) }),
  z.object({ type: z.literal('thread.sideClose'), threadId: id('thr'), outcome: z.enum(['discard', 'conclusion', 'all']) }),
  z.object({
    type: z.literal('channel.save'),
    channel: z.object({
      id: id('chn'), kind: z.enum(['telegram', 'feishu', 'dingtalk', 'wecom']), name: text(60).min(1), enabled: z.boolean(),
      projectId: id('prj').optional(), notify: z.object({ approvals: z.boolean(), results: z.boolean() }),
    }),
    secret: text(500).optional(),
  }),
  z.object({ type: z.literal('channel.remove'), channelId: id('chn') }),
  z.object({ type: z.literal('channel.test'), channelId: id('chn') }),
  z.object({ type: z.literal('channel.pair'), channelId: id('chn') }),
  z.object({ type: z.literal('channel.unpair'), channelId: id('chn') }),
  z.object({ type: z.literal('flow.save'), flow: FlowDefS }),
  z.object({ type: z.literal('flow.remove'), flowId: z.string().max(64) }),
  z.object({ type: z.literal('flow.start'), projectId: id('prj'), flowId: z.string().max(64), inputs: z.record(text(60), z.string().max(2_000_000)), model: ModelChoiceS.nullable().optional() }),
  z.object({ type: z.literal('flow.decide'), threadId: id('thr'), nodeId: z.string().max(64), approve: z.boolean(), note: text(2000).optional(), picked: z.array(z.number().int().min(0)).max(10_000).optional() }),
  z.object({ type: z.literal('flow.retry'), threadId: id('thr') }),
  z.object({ type: z.literal('search.save'), provider: z.enum(['bocha', 'tavily', 'brave']), key: text(500).optional() }),
  z.object({ type: z.literal('search.remove') }),
  z.object({ type: z.literal('search.test') }),
]);

export type Command = z.infer<typeof CommandS>;
