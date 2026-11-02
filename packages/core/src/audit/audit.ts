import type { Policy } from '../model/types.js';
import type { State } from '../state/reduce.js';
import { verifyChain } from '../events/chain.js';
import type { ZEvent } from '../events/types.js';

export type FindingLevel = 'danger' | 'warn' | 'info';
export interface Finding {
  id: string;
  level: FindingLevel;
  title: string;
  detail: string;
  /** 一键修复：把策略改成这样。没有就只能手动处理。 */
  fix?: Partial<Policy>;
}

/** 安全体检，照 OpenClaw 的 security audit：找出放松了的设置，能修的给出修法。 */
export function securityAudit(state: State, events?: readonly ZEvent[]): Finding[] {
  const p = state.policy;
  const out: Finding[] = [];
  if (p.commandMode === 'dangerouslyAllowAll') {
    out.push({ id: 'cmd.allowAll', level: 'danger', title: '命令全部放行', detail: 'agent 跑任何命令都不问你。建议改回“白名单 + 其余问我”。', fix: { commandMode: 'allowlist' } });
  }
  if (p.askFallback !== 'deny') {
    out.push({ id: 'ask.fallback', level: 'warn', title: '没人审批时会按白名单放行', detail: '你不在时，本该问你的命令会按白名单处理。建议改成直接拒绝。', fix: { askFallback: 'deny' } });
  }
  if (!p.strictInlineEval) {
    out.push({ id: 'inline.eval', level: 'warn', title: '内联代码不再强制询问', detail: 'python -c、node -e 这类命令可能借白名单溜过去。', fix: { strictInlineEval: true } });
  }
  const hr = p.highRisk;
  const loose = (Object.entries(hr) as [string, unknown][]).filter(([k, v]) => k !== 'spendOverYuan' && v === false).map(([k]) => k);
  if (loose.length) {
    out.push({ id: 'highRisk.off', level: 'warn', title: `有 ${loose.length} 类高风险动作不再必问`, detail: loose.join('、'), fix: { highRisk: { ...hr, deleteFiles: true, database: true, pushOrRelease: true, install: true, externalWrite: true } } });
  }
  const wide = p.allowlist.filter((r) => !r.args && r.agents === '*' && r.source !== 'default');
  if (wide.length) {
    out.push({ id: 'allow.wide', level: 'warn', title: `${wide.length} 条白名单对所有 agent 放行任意参数`, detail: wide.map((r) => r.program).join('、') + '。建议加上参数限制或只给特定 agent。' });
  }
  if (!p.separateNetworkAndExec) out.push({ id: 'net.exec', level: 'info', title: '联网和执行没分开', detail: '读了网页的 agent 也能直接跑命令，提示注入的风险更高。', fix: { separateNetworkAndExec: true } });
  if (p.approvalTimeoutSec > 3600) out.push({ id: 'ask.timeout', level: 'info', title: '审批等待时间很长', detail: `现在是 ${Math.round(p.approvalTimeoutSec / 60)} 分钟。` });
  for (const s of Object.values(state.skills)) {
    if (s.permissions.shell.includes('*') || s.permissions.network.includes('*')) {
      out.push({ id: `skill.${s.name}`, level: 'warn', title: `skill “${s.name}” 申请了不限范围的权限`, detail: '实际权限仍以 agent 自身权限为上限。' });
    }
  }
  if (events) {
    const c = verifyChain(events);
    if (!c.ok) out.push({ id: 'log.chain', level: 'danger', title: '留痕记录对不上', detail: `第 ${c.brokenAt} 条：${c.reason ?? ''}。记录可能被改过。` });
  }
  return out;
}
