import type { Widget } from '../model/types.js';

export const GRID_COLS = 12;
export const GRID_ROWS = 8;
export const MIN_W = 3;
export const MIN_H = 2;

type Rect = Pick<Widget, 'x' | 'y' | 'w' | 'h'>;

export const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
export const inBounds = (r: Rect) => r.x >= 0 && r.y >= 0 && r.w >= MIN_W && r.h >= MIN_H && r.x + r.w <= GRID_COLS && r.y + r.h <= GRID_ROWS;

/** 在已放好的模块中间，为 want 找一个最近的空位（同样大小）。 */
export function findSpot(placed: readonly Rect[], want: Rect): Rect | null {
  let best: Rect | null = null;
  let bestD = Infinity;
  for (let y = 0; y <= GRID_ROWS - want.h; y++) {
    for (let x = 0; x <= GRID_COLS - want.w; x++) {
      const r = { x, y, w: want.w, h: want.h };
      if (placed.some((p) => overlaps(p, r))) continue;
      const d = Math.abs(x - want.x) + Math.abs(y - want.y) * 1.5;
      if (d < bestD) { bestD = d; best = r; }
    }
  }
  return best;
}

/**
 * 把一个模块放到新位置 / 新大小。挡路的模块就近让位；
 * 让不开时，如果只压住一个且大小没变，就和它对调；否则返回 null（放不下）。
 */
export function placeWidget(layout: readonly Widget[], id: string, to: Rect): Widget[] | null {
  if (!inBounds(to)) return null;
  const items = layout.map((w) => ({ ...w }));
  const it = items.find((w) => w.id === id);
  if (!it) return null;
  const old = { ...it };
  Object.assign(it, to);
  const placed: Rect[] = [it];
  let ok = true;
  for (const o of items.filter((w) => w !== it).sort((a, b) => a.y - b.y || a.x - b.x)) {
    if (placed.some((p) => overlaps(p, o))) {
      const s = findSpot(placed, o);
      if (!s) { ok = false; break; }
      o.x = s.x; o.y = s.y;
    }
    placed.push(o);
  }
  if (ok) return items;
  const hits = layout.filter((w) => w.id !== id && overlaps(w, to));
  if (hits.length !== 1 || to.w !== old.w || to.h !== old.h) return null;
  return layout.map((w) => {
    if (w.id === id) return { ...w, x: hits[0]!.x, y: hits[0]!.y, w: hits[0]!.w, h: hits[0]!.h };
    if (w.id === hits[0]!.id) return { ...w, x: old.x, y: old.y, w: old.w, h: old.h };
    return { ...w };
  });
}

/** 加一个模块：先按想要的大小找空位，找不到就逐步缩小。 */
export function addWidget(layout: readonly Widget[], w: Omit<Widget, 'x' | 'y'>): Widget[] | null {
  if (layout.some((x) => x.k === w.k)) return null;
  for (const [ww, hh] of [[w.w, w.h], [4, 3], [MIN_W, MIN_H]] as const) {
    const s = findSpot(layout, { x: 0, y: 0, w: ww, h: hh });
    if (s) return [...layout, { ...w, ...s }];
  }
  return null;
}

export function validateLayout(layout: readonly Widget[]): string[] {
  const issues: string[] = [];
  const kinds = new Set<string>();
  layout.forEach((w, i) => {
    if (!inBounds(w)) issues.push(`${w.k} 超出画布或太小`);
    if (kinds.has(w.k)) issues.push(`${w.k} 重复`);
    kinds.add(w.k);
    for (const o of layout.slice(i + 1)) if (overlaps(w, o)) issues.push(`${w.k} 和 ${o.k} 重叠`);
  });
  return issues;
}

type Preset = [k: string, x: number, y: number, w: number, h: number][];
export const LAYOUT_PRESETS: Record<string, { label: string; widgets: Preset }> = {
  claude: { label: '协调者 + 讨论串（像 Claude）', widgets: [['coord', 0, 0, 5, 8], ['threads', 5, 0, 7, 8]] },
  stack: { label: '左边上下两块 + 讨论串', widgets: [['coord', 0, 0, 5, 5], ['lib', 0, 5, 5, 3], ['threads', 5, 0, 7, 8]] },
  quad: { label: '四宫格', widgets: [['coord', 0, 0, 6, 4], ['m:term', 0, 4, 6, 4], ['threads', 6, 0, 6, 5], ['m:preview', 6, 5, 6, 3]] },
  workbench: { label: '讨论串 + 工作台模块', widgets: [['threads', 0, 0, 5, 8], ['mods', 5, 0, 7, 8]] },
  three: { label: '协调者 + 讨论串 + 模块', widgets: [['coord', 0, 0, 4, 8], ['threads', 4, 0, 4, 8], ['mods', 8, 0, 4, 8]] },
  threadsOnly: { label: '只看讨论串', widgets: [['threads', 0, 0, 12, 8]] },
};

export function presetLayout(name: keyof typeof LAYOUT_PRESETS | string, newId: () => string): Widget[] {
  const p = LAYOUT_PRESETS[name] ?? LAYOUT_PRESETS.claude!;
  return p.widgets.map(([k, x, y, w, h]) => ({ id: newId(), k, x, y, w, h }));
}
