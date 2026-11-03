import type { ModelChoice, ToolName } from '../model/types.js';

// 工作流：一张有输入、有节点、有连线的图。给非程序员用，所以节点种类少、名字用人话。

export type FlowInputKind = 'text' | 'longtext' | 'number' | 'select' | 'file';

/** 发起表单里的一个格 */
export interface FlowInput {
  key: string;
  label: string;
  kind: FlowInputKind;
  required?: boolean;
  /** kind 为 select 时的选项 */
  options?: string[];
  hint?: string;
  default?: string;
}

export type FlowNodeKind = 'input' | 'search' | 'agent' | 'human' | 'export';

interface NodeBase {
  id: string;
  title: string;
  /** 编辑器里的位置（像素） */
  x: number;
  y: number;
}

/** 表单里的数据：把一个 file / longtext 字段变成一张表或一段文字，给下游用 */
export interface InputNodeConfig {
  key: string;
}

/** 搜一搜：走搜索服务，不走模型。查询词可以引用表单 {{inputs.键}}；也可以从上游表格的某一列取 */
export interface SearchNodeConfig {
  queries: string[];
  /** 从上游表格的这一列取查询词（有就忽略 queries 里的模板） */
  queriesFrom?: string;
  /** 每个查询词取几条，默认 8 */
  limit?: number;
  recency?: 'day' | 'week' | 'month' | 'year' | 'any';
}

/** 让模型做：一句“要它做什么”，自动附上表单输入和所有上游结果 */
export interface AgentNodeConfig {
  instruction: string;
  /** 这个节点能用的工具；为空就只能想、不能动东西 */
  tools: ToolName[];
  /** 不填就用讨论串 / 项目默认 */
  model?: ModelChoice | null;
  effort?: string;
  /** 要它输出什么：文字，或一张表 */
  output: 'text' | 'table';
  /** 上游表格只给前几行（定口径时用） */
  sample?: number;
  /** 对每一批分别做：把上游表切成若干批并行跑，再合并 */
  each?: { rows: number | string; from?: string };
}

/** 等我确认：暂停，进待办收件箱 */
export interface HumanNodeConfig {
  ask: string;
  /** 上游是表格时让用户勾选行，勾选的行作为这个节点的输出 */
  pick?: boolean;
}

/** 导出：把上游结果写成文件 */
export interface ExportNodeConfig {
  filename: string;
}

export type FlowNode =
  | (NodeBase & { kind: 'input'; config: InputNodeConfig })
  | (NodeBase & { kind: 'search'; config: SearchNodeConfig })
  | (NodeBase & { kind: 'agent'; config: AgentNodeConfig })
  | (NodeBase & { kind: 'human'; config: HumanNodeConfig })
  | (NodeBase & { kind: 'export'; config: ExportNodeConfig });

export interface FlowEdge {
  from: string;
  to: string;
}

export interface FlowDef {
  id: string;
  name: string;
  description: string;
  /** 给谁用，如“短视频创作者” */
  audience?: string;
  inputs: FlowInput[];
  nodes: FlowNode[];
  edges: FlowEdge[];
  /** 内置预设：不进事件，不能删，可以复制一份改 */
  builtin?: boolean;
  updatedAt?: number;
}

// ---------- 运行 ----------

export type RunNodeState = 'queue' | 'run' | 'wait' | 'done' | 'failed' | 'skipped';

/** 节点结果。正文在文件里，事件里只放路径和摘要 */
export interface NodeOutput {
  kind: 'text' | 'table' | 'files';
  /** 相对运行目录的路径（files 时是逗号分隔的多个） */
  path?: string;
  /** 前 300 字，给列表和通知看 */
  preview: string;
  /** 表格行数 */
  rows?: number;
  sha256?: string;
  /** 读过外部内容（搜索、网页），下游按外部内容处理 */
  external?: boolean;
}

export interface RunNode {
  state: RunNodeState;
  output?: NodeOutput;
  /** 出错原因，或打回时的意见 */
  note?: string;
  attempts?: number;
  decision?: { approve: boolean; note?: string; at: number };
}

export interface FlowRun {
  flowId: string;
  flowName: string;
  inputs: Record<string, string>;
  /** 运行目录，相对项目工作区 */
  dir: string;
  nodes: Record<string, RunNode>;
  /** 打回了几次 */
  rejects: number;
}

export const NODE_KINDS: Record<FlowNodeKind, { label: string; hint: string }> = {
  input: { label: '表单里的数据', hint: '把表单里的文件或长文本给下游' },
  search: { label: '搜一搜', hint: '用搜索服务查，结果是带链接的表格' },
  agent: { label: '让模型做', hint: '一句话说要它做什么，自动带上上游结果' },
  human: { label: '等我确认', hint: '暂停，进待办收件箱，通过或打回' },
  export: { label: '导出', hint: '把上游结果写成文件' },
};

/** 一次运行里最多打回几次，超过就停下来让用户改表单 */
export const MAX_REJECTS = 3;
/** 批量节点的上限 */
export const MAX_BATCH_ROWS = 200;
export const MAX_BATCHES = 50;
