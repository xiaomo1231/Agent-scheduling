import type { Segment } from './shell.js';

export type RiskKind = 'deleteFiles' | 'database' | 'pushOrRelease' | 'install' | 'externalWrite' | 'privilege' | 'remoteScript' | 'secrets';

export const RISK_LABEL: Record<RiskKind, string> = {
  deleteFiles: '删除文件或目录',
  database: '修改数据库结构或数据',
  pushOrRelease: 'git push、合并、发布',
  install: '安装依赖或全局软件',
  externalWrite: '往外部服务写入',
  privilege: '提权（sudo 等）',
  remoteScript: '下载后直接执行',
  secrets: '读取密钥或登录凭据',
};

const SQL_WRITE = /\b(alter|drop|truncate|delete\s+from|update\s+\w+\s+set|insert\s+into|create\s+(table|index|database))\b/i;

/** 判断一段命令属于哪些高风险类别。 */
export function riskOf(seg: Segment): RiskKind[] {
  const out = new Set<RiskKind>();
  const p = seg.program;
  const a = seg.args;
  const first = a[0] ?? '';
  const joined = a.join(' ');
  if (p === 'rm' || p === 'rmdir' || p === 'del' || p === 'rd' || p === 'shred' || p === 'unlink' || (p === 'git' && first === 'clean') || (p === 'find' && a.includes('-delete'))) out.add('deleteFiles');
  if (p === 'remove-item') out.add('deleteFiles');
  if (['psql', 'mysql', 'sqlite3', 'mongosh', 'redis-cli'].includes(p) && (SQL_WRITE.test(joined) || /\bflushall\b/i.test(joined))) out.add('database');
  if (/\b(migrate|migration|db:push|prisma migrate|alembic upgrade)\b/i.test(seg.raw)) out.add('database');
  if (p === 'git' && ['push', 'merge', 'rebase', 'tag'].includes(first)) out.add('pushOrRelease');
  if (p === 'gh' && ['pr', 'release'].includes(first) && /\b(merge|create)\b/.test(joined)) out.add('pushOrRelease');
  if ((p === 'npm' || p === 'pnpm' || p === 'yarn' || p === 'bun') && /^(publish|deploy)$/.test(first)) out.add('pushOrRelease');
  if ((p === 'npm' || p === 'pnpm' || p === 'yarn' || p === 'bun') && /^(i|install|add|ci)$/.test(first)) out.add('install');
  if ((p === 'pip' || p === 'pip3' || p === 'uv' || p === 'cargo' || p === 'go' || p === 'gem') && /^(install|add|get)$/.test(first)) out.add('install');
  if (['brew', 'apt', 'apt-get', 'yum', 'dnf', 'winget', 'choco', 'scoop'].includes(p)) out.add('install');
  if ((p === 'curl' || p === 'wget' || p === 'http') && /(-X\s*(POST|PUT|PATCH|DELETE)|--data|-d\s|-F\s|--upload-file|-T\s)/i.test(joined)) out.add('externalWrite');
  if (p === 'sudo' || p === 'su' || p === 'doas' || p === 'runas') out.add('privilege');
  if (/(^|\/)\.ssh(\/|$)|\.aws\/credentials|\.netrc|id_rsa|id_ed25519|\.gnupg|keychain|security\s+find-generic-password/i.test(joined)) out.add('secrets');
  return [...out];
}
