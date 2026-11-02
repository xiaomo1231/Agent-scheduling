import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ZEvent } from '@zhongshu/core';

/** 事件日志：只追加，不修改。 */
export interface EventLog {
  readAll(): ZEvent[];
  append(events: readonly ZEvent[]): void;
}

export class MemoryLog implements EventLog {
  private events: ZEvent[] = [];
  readAll(): ZEvent[] {
    return [...this.events];
  }
  append(events: readonly ZEvent[]): void {
    this.events.push(...events);
  }
}

/** 一行一条 JSON。写到一半断电时最后一行可能不完整，读的时候丢掉它。 */
export class JsonlLog implements EventLog {
  constructor(private readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
  }
  readAll(): ZEvent[] {
    if (!existsSync(this.file)) return [];
    const lines = readFileSync(this.file, 'utf8').split('\n').filter((l) => l.trim());
    const out: ZEvent[] = [];
    for (let i = 0; i < lines.length; i++) {
      try {
        out.push(JSON.parse(lines[i]!) as ZEvent);
      } catch {
        if (i === lines.length - 1) break; // 最后一行写坏了
        throw new Error(`事件日志第 ${i + 1} 行读不出来，文件可能损坏：${this.file}`);
      }
    }
    return out;
  }
  append(events: readonly ZEvent[]): void {
    if (!events.length) return;
    appendFileSync(this.file, events.map((e) => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 });
  }
}
