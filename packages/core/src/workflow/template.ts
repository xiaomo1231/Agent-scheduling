/** 节点文字里的模板变量：只认 {{inputs.键}} 和 {{键}}，没有表达式。 */
export function renderTemplate(text: string, inputs: Record<string, string>): string {
  return text.replace(/\{\{\s*(?:inputs\.)?([^{}\s]+)\s*\}\}/g, (_m, k: string) => (k in inputs ? inputs[k]! : `{{${k}}}`));
}

/** 把表切成每批 n 行 */
export function chunkRows<T>(rows: readonly T[], n: number): T[][] {
  const size = Math.max(1, Math.floor(n));
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

export function previewOf(text: string, n = 300): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}
