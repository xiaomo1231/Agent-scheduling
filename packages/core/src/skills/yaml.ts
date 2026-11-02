// SKILL.md frontmatter 只用到 YAML 的一小部分：键值、嵌套映射、行内数组 [a, b]、短横线列表。
// 这里实现这一部分，够用且没有依赖。遇到看不懂的写法抛出带行号的错误。

export type Yaml = string | number | boolean | null | Yaml[] | { [k: string]: Yaml };

function scalar(raw: string): Yaml {
  const s = raw.trim();
  if (s === '') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    const inner = s.slice(1, -1);
    return s.startsWith('"') ? inner.replace(/\\"/g, '"').replace(/\\n/g, '\n') : inner.replace(/''/g, "'");
  }
  if (s.startsWith('[') && s.endsWith(']')) {
    const body = s.slice(1, -1).trim();
    if (!body) return [];
    return splitTop(body).map(scalar);
  }
  if (s.startsWith('{') && s.endsWith('}')) {
    const body = s.slice(1, -1).trim();
    const o: Record<string, Yaml> = {};
    if (body) for (const part of splitTop(body)) {
      const i = part.indexOf(':');
      if (i < 0) throw new Error(`看不懂“${part}”`);
      o[part.slice(0, i).trim()] = scalar(part.slice(i + 1));
    }
    return o;
  }
  return s;
}

function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = '', q: string | null = null;
  for (const c of s) {
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '[' || c === '{') depth++;
    if (c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function stripComment(line: string): string {
  let q: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i);
  }
  return line;
}

interface Line { indent: number; text: string; no: number }

export function parseYaml(src: string): Record<string, Yaml> {
  const lines: Line[] = [];
  src.split(/\r?\n/).forEach((l, i) => {
    const t = stripComment(l).replace(/\s+$/, '');
    if (t.trim()) lines.push({ indent: t.length - t.trimStart().length, text: t.trim(), no: i + 1 });
  });
  let pos = 0;
  function block(indent: number): Yaml {
    const first = lines[pos];
    if (!first || first.indent < indent) return null;
    if (first.text.startsWith('- ') || first.text === '-') {
      const arr: Yaml[] = [];
      while (pos < lines.length && lines[pos]!.indent === first.indent && (lines[pos]!.text.startsWith('-'))) {
        const item = lines[pos]!.text.replace(/^-\s*/, '');
        pos++;
        if (!item) arr.push(block(first.indent + 1));
        else if (/^[\w.-]+:\s/.test(item) || /^[\w.-]+:$/.test(item)) {
          // 列表项里的映射：把这一行当成更深一层
          lines.splice(pos, 0, { indent: first.indent + 2, text: item, no: lines[pos - 1]!.no });
          arr.push(block(first.indent + 2));
        } else arr.push(scalar(item));
      }
      return arr;
    }
    const obj: Record<string, Yaml> = {};
    while (pos < lines.length && lines[pos]!.indent === first.indent) {
      const l = lines[pos]!;
      const m = l.text.match(/^([^:]+?):(\s+(.*)|)$/);
      if (!m) throw new Error(`第 ${l.no} 行看不懂：${l.text}`);
      pos++;
      const key = m[1]!.trim().replace(/^["']|["']$/g, '');
      const rest = m[3];
      if (rest === undefined || rest === '') {
        const next = lines[pos];
        obj[key] = next && next.indent > l.indent ? block(next.indent) : null;
      } else if (rest === '|' || rest === '>') {
        const buf: string[] = [];
        while (pos < lines.length && lines[pos]!.indent > l.indent) buf.push(lines[pos++]!.text);
        obj[key] = buf.join(rest === '|' ? '\n' : ' ');
      } else obj[key] = scalar(rest);
    }
    return obj;
  }
  const r = block(0);
  if (pos < lines.length) throw new Error(`第 ${lines[pos]!.no} 行缩进不对`);
  return (r && typeof r === 'object' && !Array.isArray(r)) ? r : {};
}

function needsQuote(s: string): boolean {
  return s === '' || /^[\s\-?:,[\]{}#&*!|>'"%@`]|:\s|\s#|^(true|false|null|~|-?\d+(\.\d+)?)$/.test(s) || /[\n]/.test(s);
}

function fmtScalar(v: Yaml): string {
  if (v === null) return 'null';
  if (typeof v === 'string') return needsQuote(v) ? JSON.stringify(v) : v;
  return String(v);
}

export function stringifyYaml(obj: Record<string, Yaml>, indent = 0): string {
  const pad = ' '.repeat(indent);
  let out = '';
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      if (v.every((x) => x === null || typeof x !== 'object')) out += `${pad}${k}: [${v.map(fmtScalar).join(', ')}]\n`;
      else { out += `${pad}${k}:\n`; for (const it of v) out += `${pad}  - ${typeof it === 'object' && it ? JSON.stringify(it) : fmtScalar(it)}\n`; }
    } else if (v && typeof v === 'object') {
      out += `${pad}${k}:\n` + stringifyYaml(v, indent + 2);
    } else out += `${pad}${k}: ${fmtScalar(v)}\n`;
  }
  return out;
}
