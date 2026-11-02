import type { Policy, ProjectSettings, AllowRule } from './types.js';

export const DEFAULT_ALLOWLIST: AllowRule[] = [
  { id: 'rul_default_git', program: 'git', args: '^(status|diff|log|show|branch)(\\s|$)', agents: '*', source: 'default', note: '只读的 git 命令' },
  { id: 'rul_default_ls', program: 'ls', agents: '*', source: 'default' },
  { id: 'rul_default_cat', program: 'cat', agents: '*', source: 'default' },
  { id: 'rul_default_npmtest', program: 'npm', args: '^(test|run (lint|test|typecheck|check))(\\s|$)', agents: '*', source: 'default' },
  { id: 'rul_default_pytest', program: 'pytest', agents: '*', source: 'default' },
];

export function defaultPolicy(): Policy {
  return {
    commandMode: 'ask',
    strictInlineEval: true,
    askFallback: 'deny',
    approvalTimeoutSec: 1800,
    highRisk: { deleteFiles: true, database: true, pushOrRelease: true, install: true, externalWrite: true, spendOverYuan: 20 },
    allowlist: DEFAULT_ALLOWLIST.map((r) => ({ ...r })),
    separateNetworkAndExec: true,
    sandboxSubagents: true,
  };
}

export function defaultProjectSettings(): ProjectSettings {
  return {
    coordinator: { model: null, effort: undefined, dual: { enabled: false, mode: 'review', model: null } },
    threadDefault: { model: null },
    autoResolve: true,
    autoContinueAfterQuotaReset: true,
    useWorktrees: true,
    instructions: '',
  };
}
