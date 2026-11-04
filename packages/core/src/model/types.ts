// 领域类型。只放数据形状，不放逻辑。
import type { FlowRun } from '../workflow/types.js';

export type ActorKind = 'user' | 'coordinator' | 'agent' | 'system';
export interface Actor {
  kind: ActorKind;
  /** 用户为 'me'，协调者为 'coord'，agent 为其编号（如 agt_xxx 或 @backend-01） */
  id: string;
}

// ---------- 模型来源与分组 ----------
export type SourceKind = 'subscription' | 'plan' | 'apikey' | 'local';
/** 模型怎么被调用：中枢引擎直连 API，或交给官方 CLI 代跑（订阅额度） */
export type ModelTransport = 'anthropic' | 'openai' | 'cli-claude' | 'cli-codex' | 'cli-gemini' | 'cli-copilot' | 'mock';

export interface ModelEntry {
  /** 发给服务方的模型名，如 claude-opus-4-8、glm-5.3 */
  id: string;
  /** 给人看的名字 */
  label: string;
  vendor: string;
  enabled: boolean;
}

export interface ModelSource {
  id: string;
  kind: SourceKind;
  name: string;
  transport: ModelTransport;
  /** OpenAI / Anthropic 兼容地址；订阅类为空 */
  baseUrl?: string;
  /** 密钥在钥匙串里的引用名，绝不存明文 */
  secretRef?: string;
  /** 是否包含多家厂商的模型（OpenCode Go、火山方舟等） */
  multiVendor?: boolean;
  models: ModelEntry[];
}

/** 指向一个具体模型：来源 id + 模型 id */
export interface ModelRef {
  sourceId: string;
  modelId: string;
}

export type Purpose = '协调' | '写提示词' | '执行' | '审查' | '整理' | '摘要' | '测试' | string;

export interface GroupRole {
  purpose: Purpose;
  model: ModelRef | null;
  backup: ModelRef | null;
  effort?: string;
}

export interface ModelGroup {
  id: string;
  name: string;
  roles: GroupRole[];
}

/** 选模型时可以选具体模型，也可以选“某组的某个用途” */
export type ModelChoice = { kind: 'model'; ref: ModelRef } | { kind: 'group'; groupId: string; purpose: Purpose };

// ---------- agent ----------
export type AgentKind = 'builtin' | 'cli';
export interface AgentDef {
  id: string;
  name: string;
  kind: AgentKind;
  /** CLI 的可执行文件名，如 claude、codex、gemini、opencode */
  command?: string;
  /** 能用的工具 */
  tools: ToolName[];
}

export type ToolName = 'read_file' | 'write_file' | 'edit_file' | 'list_files' | 'run_command' | 'web_fetch' | 'web_search' | 'send_message';

// ---------- 项目、讨论串、计划 ----------
export interface Widget {
  id: string;
  /** 模块种类：coord / threads / mods / lib / m:files / m:term ... */
  k: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CoordinatorSettings {
  model: ModelChoice | null;
  effort?: string;
  dual?: { enabled: boolean; mode: 'review' | 'backup'; model: ModelChoice | null; effort?: string };
}

export interface ProjectSettings {
  coordinator: CoordinatorSettings;
  threadDefault: { model: ModelChoice | null; effort?: string };
  /** 协调者判断做完就自动解决讨论串 */
  autoResolve: boolean;
  autoContinueAfterQuotaReset: boolean;
  useWorktrees: boolean;
  instructions: string;
}

export interface Project {
  id: string;
  name: string;
  color: string;
  goal: string;
  template: string;
  /** 工作区目录：agent 只能在这里读写和执行。空表示用中枢数据目录下的默认位置。 */
  folder?: string;
  createdAt: number;
  archived: boolean;
  layout: Widget[];
  settings: ProjectSettings;
}

export type StepState = 'queue' | 'run' | 'wait' | 'done' | 'cancelled';
export interface Step {
  id: string;
  title: string;
  /** 由谁做：agent 编号或岗位名 */
  assignee: string;
  state: StepState;
}

export type ThreadStatus = 'waiting' | 'running' | 'idle' | 'resolved';
export interface Thread {
  id: string;
  projectId: string;
  /** coord 是项目的协调者对话，每个项目一条；work 是普通讨论串；flow 是一次工作流运行。缺省为 work。 */
  kind?: 'coord' | 'work' | 'review' | 'side' | 'flow';
  title: string;
  createdAt: number;
  updatedAt: number;
  resolved: null | { by: 'coordinator' | 'user'; at: number; reason: string };
  /** 用户手动重开过，协调者就不再自动解决它 */
  keepOpen: boolean;
  model: ModelChoice | null;
  effort?: string;
  steps: Step[];
  /** 在独立 worktree 里干活时的信息 */
  worktree?: Worktree;
  /** kind 为 review 时：群评审的设置和结论 */
  review?: ReviewSetup;
  /** kind 为 side 时：从哪条消息的哪段话岔出来 */
  parent?: SideParent;
  /** kind 为 flow 时：这次运行的输入、目录和每个节点的状态 */
  run?: FlowRun;
}

// ---------- 群评审 ----------
export interface ReviewRole {
  id: string;
  name: string;
  /** 这个角色站在什么立场、看重什么 */
  stance: string;
  /** 唱反调：专门找毛病，不许附和 */
  devil?: boolean;
  /** 为空时用评审默认模型 */
  model?: ModelChoice | null;
}

export interface ReviewSetup {
  preset: string;
  question: string;
  roles: ReviewRole[];
  /** 讨论几轮（每轮每个角色说一次） */
  rounds: number;
  /** 拍板的模型；为空用协调者模型 */
  decider: ModelChoice | null;
  state: 'running' | 'decided' | 'failed';
  decision?: string;
}

// ---------- 划词追问 ----------
export interface SideParent {
  threadId: string;
  messageId?: string;
  /** 用户划出来的那段话 */
  quote: string;
  /** 关掉时怎么处理：丢掉 / 只把结论带回去 / 整段对话带回去 */
  outcome?: 'discard' | 'conclusion' | 'all';
}

// ---------- 用量与额度 ----------
export interface UsageRow {
  /** YYYY-MM-DD（本地时间） */
  day: string;
  projectId: string;
  sourceId: string;
  model: string;
  calls: number;
  input: number;
  output: number;
}

export interface QuotaWait {
  sourceId: string;
  /** 预计什么时候恢复（毫秒时间戳） */
  until: number;
  reason: string;
}

// ---------- 项目记忆 ----------
/** 桌面页上限（字节）：每次都会放进提示词，所以必须短 */
export const DESK_LIMIT = 4096;
export const MEMORY_ENTRY_LIMIT = 500;

export interface MemoryEntry {
  id: string;
  text: string;
  tags: string[];
  /** 谁记的：agent 编号、协调者或 user */
  by: string;
  at: number;
  pinned?: boolean;
}

export interface ProjectMemory {
  /** 桌面页：项目最重要的事实，≤ DESK_LIMIT */
  desk: string;
  entries: MemoryEntry[];
  consolidatedAt?: number;
}

// ---------- 搜索服务 ----------
export type SearchProviderKind = 'bocha' | 'tavily' | 'brave';
export interface SearchSettings {
  provider: SearchProviderKind;
  /** key 在密钥库里的引用 */
  secretRef?: string;
}

// ---------- 消息渠道 ----------
export type ChannelKind = 'telegram' | 'feishu' | 'dingtalk' | 'wecom';

export interface Channel {
  id: string;
  kind: ChannelKind;
  name: string;
  enabled: boolean;
  /** bot token 或 webhook 地址存在密钥库里，这里只放引用 */
  secretRef?: string;
  /** 消息默认进哪个项目的协调者 */
  projectId?: string;
  /** Telegram：已配对的聊天 */
  paired?: { chatId: string; name?: string; at: number };
  notify: { approvals: boolean; results: boolean };
}

export interface Worktree {
  /** 原仓库根目录 */
  repo: string;
  /** worktree 目录 */
  path: string;
  branch: string;
  /** 从哪个分支开出来，合并时合回这里 */
  base: string;
  state: 'active' | 'ready' | 'merged' | 'discarded';
  /** 做完后的改动摘要（git diff --stat） */
  summary?: string;
}

export interface Message {
  id: string;
  threadId: string;
  author: Actor;
  /** 显示名，如“协调者 · Fable” */
  authorLabel: string;
  text: string;
  ts: number;
  /** 引用的外部内容一律标记为不可信 */
  untrusted?: boolean;
  /** 消息里带的卡片：开了新讨论串、请求审批等 */
  cards?: MessageCard[];
}

export type MessageCard =
  | { kind: 'thread'; threadId: string }
  | { kind: 'approval'; approvalId: string }
  | { kind: 'planDiff'; summary: string; undoToken?: string }
  | { kind: 'worktree'; threadId: string }
  | { kind: 'side'; threadId: string; quote: string };

// ---------- 权限与审批 ----------
export type CommandMode = 'deny' | 'allowlist' | 'ask' | 'review' | 'dangerouslyAllowAll';

export interface AllowRule {
  id: string;
  /** 程序名（不含路径），如 git、npm、pytest */
  program: string;
  /** 对参数（不含程序名，用空格连起来）的正则；空表示任意参数 */
  args?: string;
  agents: '*' | string[];
  source: 'default' | 'always' | 'user';
  note?: string;
}

export interface HighRiskSettings {
  deleteFiles: boolean;
  database: boolean;
  pushOrRelease: boolean;
  install: boolean;
  externalWrite: boolean;
  spendOverYuan: number | null;
}

export interface Policy {
  commandMode: CommandMode;
  strictInlineEval: boolean;
  askFallback: 'deny' | 'allowlist';
  approvalTimeoutSec: number;
  highRisk: HighRiskSettings;
  allowlist: AllowRule[];
  separateNetworkAndExec: boolean;
  sandboxSubagents: boolean;
}

export interface ActionRequest {
  agentId: string;
  threadId: string;
  kind: 'command' | 'write_file' | 'network' | 'send_message';
  /** command 时是命令全文；write_file 时是路径；network 时是 URL */
  target: string;
  cwd: string;
  workspaceRoot: string;
}

export type ApprovalState = 'pending' | 'approved' | 'denied' | 'expired' | 'invalidated';
export interface Approval {
  id: string;
  request: ActionRequest;
  fingerprint: string;
  reasons: string[];
  risk: string[];
  state: ApprovalState;
  createdAt: number;
  decidedAt?: number;
  decidedBy?: Actor;
}

// ---------- skill ----------
export type SkillPlatform = 'claude-code' | 'codex' | 'gemini-cli' | 'opencode' | 'openclaw' | 'copilot' | 'cursor' | 'dsh' | 'zhongshu';

export interface SkillPermissions {
  files: 'none' | 'read' | 'write';
  shell: string[];
  network: string[];
  sendMessage: boolean;
}

export interface InstalledSkill {
  name: string;
  description: string;
  version: string;
  source: SkillPlatform | 'unknown';
  permissions: SkillPermissions;
  targets: SkillPlatform[];
  /** 文件路径 → sha256，用来发现安装后被改动 */
  lock: Record<string, string>;
  installedAt: number;
}
