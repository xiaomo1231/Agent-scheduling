// 小而全的 CSV：带引号、逗号、换行的字段都能来回。表 = 第一行表头的对象数组。

export type Row = Record<string, string>;

export function parseCsv(text: string): Row[] {
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { cur.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      cur.push(field); field = '';
      rows.push(cur); cur = [];
    } else field += c;
  }
  if (field.length || cur.length) { cur.push(field); rows.push(cur); }
  const head = rows.shift()?.map((h, i) => h.trim() || `列${i + 1}`) ?? [];
  return rows.filter((r) => r.some((x) => x.trim())).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

const cell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function toCsv(rows: readonly Row[], columns?: string[]): string {
  const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return [cols.map(cell).join(','), ...rows.map((r) => cols.map((c) => cell(r[c] ?? '')).join(','))].join('\n');
}

/** 给模型看的 Markdown 表格，超过 limit 行就截断并说明 */
export function tableToMarkdown(rows: readonly Row[], limit = 50): string {
  if (!rows.length) return '（空表）';
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const esc = (v: string) => v.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const lines = [`| ${cols.join(' | ')} |`, `| ${cols.map(() => '---').join(' | ')} |`, ...rows.slice(0, limit).map((r) => `| ${cols.map((c) => esc(r[c] ?? '')).join(' | ')} |`)];
  if (rows.length > limit) lines.push(`（共 ${rows.length} 行，只显示前 ${limit} 行）`);
  return lines.join('\n');
}

/** 从模型的回答里找表格：```csv 代码块，或 Markdown 表格。找不到返回 null。 */
export function extractTable(text: string): Row[] | null {
  const m = text.match(/```csv\s*\n([\s\S]*?)```/i);
  if (m) {
    const rows = parseCsv(m[1]!);
    if (rows.length) return rows;
  }
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length - 1; i++) {
    if (/^\s*\|.*\|\s*$/.test(lines[i]!) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1]!)) {
      const split = (l: string) => l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((x) => x.trim().replace(/\\\|/g, '|'));
      const head = split(lines[i]!);
      const out: Row[] = [];
      for (let j = i + 2; j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j]!); j++) {
        const cells = split(lines[j]!);
        out.push(Object.fromEntries(head.map((h, k) => [h, cells[k] ?? ''])));
      }
      if (out.length) return out;
    }
  }
  return null;
}
