// 领域类型。只放数据形状，不放逻辑。

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
  title: string;
  createdAt: number;
  updatedAt: number;
  resolved: null | { by: 'coordinator' | 'user'; at: number; reason: string };
  /** 用户手动重开过，协调者就不再自动解决它 */
  keepOpen: boolean;
  model: ModelChoice | null;
  effort?: string;
  steps: Step[];
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
  | { kind: 'planDiff'; summary: string; undoToken?: string };

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
