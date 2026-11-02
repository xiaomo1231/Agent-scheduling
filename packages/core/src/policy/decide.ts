import type { ActionRequest, AllowRule, Policy } from '../model/types.js';
import { canonicalJson } from '../util/canonical.js';
import { sha256Hex } from '../util/sha256.js';
import { parseCommand, isInlineEval, type Segment } from './shell.js';
import { riskOf, RISK_LABEL, type RiskKind } from './risk.js';

export type Decision = 'allow' | 'ask' | 'deny';

export interface DecideResult {
  decision: Decision;
  /** 先交给审查模型看（命令策略为 review 时） */
  review: boolean;
  reasons: string[];
  risk: RiskKind[];
}

function ruleMatches(rule: AllowRule, seg: Segment, agentId: string): boolean {
  if (rule.program.toLowerCase() !== seg.program) return false;
  if (rule.agents !== '*' && !rule.agents.includes(agentId)) return false;
  if (!rule.args) return true;
  try {
    return new RegExp(rule.args).test(seg.args.join(' '));
  } catch {
    return false;
  }
}

function inside(root: string, p: string): boolean {
  const norm = (x: string) => x.replace(/\\/g, '/').replace(/\/+$/, '');
  const r = norm(root), q = norm(p);
  return q === r || q.startsWith(r + '/');
}

const RISK_SETTING: Partial<Record<RiskKind, keyof Policy['highRisk']>> = {
  deleteFiles: 'deleteFiles', database: 'database', pushOrRelease: 'pushOrRelease', install: 'install', externalWrite: 'externalWrite',
};

/**
 * 判断一个动作能不能做。结果只有 allow / ask / deny。
 * 规则按顺序：紧急停止 → 策略禁止 → 越界 → 必问的高风险 → 内联代码 → 白名单 → 策略默认。
 */
export function decide(req: ActionRequest, policy: Policy, opts: { emergencyStop?: boolean } = {}): DecideResult {
  const reasons: string[] = [];
  if (opts.emergencyStop) return { decision: 'deny', review: false, reasons: ['已紧急停止，所有动作暂停'], risk: [] };

  if (req.kind === 'write_file') {
    if (!inside(req.workspaceRoot, req.target)) return { decision: 'deny', review: false, reasons: ['只能写工作区里的文件'], risk: [] };
    return { decision: 'allow', review: false, reasons: [], risk: [] };
  }
  if (req.kind === 'send_message') {
    return { decision: 'ask', review: false, reasons: ['往外发消息要你批准'], risk: ['externalWrite'] };
  }
  if (req.kind === 'network') {
    if (/^https?:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1|0\.0\.0\.0)/i.test(req.target)) {
      return { decision: 'deny', review: false, reasons: ['不允许访问本机或内网地址'], risk: [] };
    }
    return { decision: 'allow', review: false, reasons: [], risk: [] };
  }

  // 命令
  if (policy.commandMode === 'deny') return { decision: 'deny', review: false, reasons: ['当前策略禁止执行命令'], risk: [] };
  if (!inside(req.workspaceRoot, req.cwd)) return { decision: 'deny', review: false, reasons: ['只能在工作区里执行命令'], risk: [] };

  const parsed = parseCommand(req.target);
  if (!parsed.segments.length) return { decision: 'deny', review: false, reasons: ['空命令'], risk: [] };

  const risk = new Set<RiskKind>();
  for (const seg of parsed.segments) for (const r of riskOf(seg)) risk.add(r);
  if (parsed.pipesToShell) risk.add('remoteScript');

  let mustAsk = false;
  // 这几类无论什么策略都要问
  for (const r of ['privilege', 'remoteScript', 'secrets'] as RiskKind[]) {
    if (risk.has(r)) { mustAsk = true; reasons.push(RISK_LABEL[r]); }
  }
  for (const r of risk) {
    const key = RISK_SETTING[r];
    if (key && policy.highRisk[key]) { mustAsk = true; reasons.push(RISK_LABEL[r]); }
  }
  if (parsed.hasSubstitution) { mustAsk = true; reasons.push('命令里嵌套了别的命令'); }
  if (policy.strictInlineEval && parsed.segments.some(isInlineEval)) { mustAsk = true; reasons.push('直接执行一段内联代码'); }

  const riskList = [...risk];
  if (mustAsk) return { decision: 'ask', review: false, reasons: [...new Set(reasons)], risk: riskList };

  const allListed = parsed.segments.every((seg) => policy.allowlist.some((r) => ruleMatches(r, seg, req.agentId)));
  if (allListed && !parsed.redirectsToFile) return { decision: 'allow', review: false, reasons: ['在白名单里'], risk: riskList };

  switch (policy.commandMode) {
    case 'allowlist':
      return { decision: 'deny', review: false, reasons: ['不在白名单里'], risk: riskList };
    case 'review':
      return { decision: 'ask', review: true, reasons: ['不在白名单里，先让审查模型看'], risk: riskList };
    case 'dangerouslyAllowAll':
      return { decision: 'allow', review: false, reasons: ['全部放行（危险设置）'], risk: riskList };
    case 'ask':
    default:
      return { decision: 'ask', review: false, reasons: ['不在白名单里'], risk: riskList };
  }
}

/** 审批指纹：命令全文 + 目录 + agent + 讨论串。执行前重算，对不上就作废。 */
export function fingerprint(req: ActionRequest): string {
  return sha256Hex(canonicalJson({ a: req.agentId, t: req.threadId, k: req.kind, x: req.target, c: req.cwd }));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * “以后都允许这类”：按批准的命令生成一条精确规则。
 * 只放行同一个程序 + 完全相同的参数，避免一次批准放开一大类。
 */
export function ruleFromCommand(command: string, agentId: string, id: string): AllowRule | null {
  const parsed = parseCommand(command);
  if (parsed.segments.length !== 1 || parsed.hasSubstitution || parsed.redirectsToFile) return null;
  const seg = parsed.segments[0]!;
  return { id, program: seg.program, args: '^' + escapeRe(seg.args.join(' ')) + '$', agents: [agentId], source: 'always', note: `由批准“${command}”生成` };
}
