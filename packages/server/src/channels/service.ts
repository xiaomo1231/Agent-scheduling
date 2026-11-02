import { randomInt } from 'node:crypto';
import type { Actor, Approval, Channel, ChannelKind, ZEvent } from '@zhongshu/core';
import type { Workspace } from '../store/index.js';
import type { SecretStore } from '../secrets/index.js';
import { redact } from '../secrets/index.js';

/** 渠道收到的东西交给 App 处理 */
export interface ChannelHandlers {
  approve(approvalId: string, ok: boolean, actor: Actor): { ok: boolean; error?: string };
  /** 用户从渠道发来的话，进对应项目的协调者 */
  userMessage(projectId: string, text: string, via: string): Promise<{ threadId: string }>;
  status(projectId?: string): string;
}

/** Webhook 只允许这些官方域名，防止把通知发到别处 */
const WEBHOOK_HOSTS: Record<Exclude<ChannelKind, 'telegram'>, RegExp> = {
  feishu: /^(open\.feishu\.cn|open\.larksuite\.com)$/,
  dingtalk: /^oapi\.dingtalk\.com$/,
  wecom: /^qyapi\.weixin\.qq\.com$/,
};

export function checkWebhook(kind: ChannelKind, url: string): string | null {
  if (kind === 'telegram') return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'Webhook 地址格式不对';
  }
  if (u.protocol !== 'https:') return 'Webhook 必须是 https 地址';
  if (!WEBHOOK_HOSTS[kind].test(u.hostname)) return `这不像${{ feishu: '飞书', dingtalk: '钉钉', wecom: '企业微信' }[kind]}的 Webhook 地址（域名是 ${u.hostname}）`;
  return null;
}

export function checkBotToken(token: string): string | null {
  return /^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(token.trim()) ? null : 'Telegram bot token 格式不对，应该像 123456:ABC-DEF…（找 @BotFather 要）';
}

function webhookBody(kind: Exclude<ChannelKind, 'telegram'>, text: string): unknown {
  return kind === 'feishu' ? { msg_type: 'text', content: { text } } : { msgtype: 'text', text: { content: text } };
}

interface TgUpdate {
  update_id: number;
  message?: { message_id: number; chat: { id: number; type?: string; title?: string; username?: string; first_name?: string }; text?: string };
  callback_query?: { id: string; data?: string; message?: { chat: { id: number } } };
}

const PAIR_TTL = 10 * 60 * 1000;

/**
 * 消息渠道：
 * - Telegram：长轮询 getUpdates，不需要公网地址。先配对（在中枢里拿 6 位码，发 /pair 码 给机器人），之后只认这一个聊天。
 * - 飞书 / 钉钉 / 企业微信：群机器人 Webhook，只往外发通知。
 */
export class ChannelService {
  private readonly polls = new Map<string, AbortController>();
  private readonly codes = new Map<string, { code: string; until: number; tries: number }>();
  /** 最近从哪个渠道发过话：协调者在那个讨论串里的回复会转回去 */
  private readonly inbound = new Map<string, { threadId: string; at: number }>();
  private unsub: (() => void) | undefined;
  private closed = false;

  constructor(
    private readonly ws: Workspace,
    private readonly secrets: SecretStore,
    private readonly h: ChannelHandlers,
    private readonly f: typeof fetch = fetch,
    private readonly opts: { pollTimeoutSec?: number; retryMs?: number } = {},
  ) {}

  start(): void {
    this.unsub = this.ws.subscribe((evs) => this.onEvents(evs));
    this.sync();
  }

  close(): void {
    this.closed = true;
    this.unsub?.();
    for (const ac of this.polls.values()) ac.abort();
    this.polls.clear();
  }

  /** 生成配对码（10 分钟有效） */
  pairCode(channelId: string): string {
    const c = this.ws.current.channels[channelId];
    if (!c || c.kind !== 'telegram') throw new Error('只有 Telegram 渠道需要配对');
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    this.codes.set(channelId, { code, until: Date.now() + PAIR_TTL, tries: 0 });
    return code;
  }

  async test(channelId: string): Promise<void> {
    const c = this.ws.current.channels[channelId];
    if (!c) throw new Error('找不到这个渠道');
    if (c.kind === 'telegram' && !c.paired) throw new Error('还没配对。先点“配对”，把配对码发给机器人');
    await this.send(c, '中枢：渠道测试，收到这条说明通了。');
  }

  // ---------- 发 ----------
  private async send(c: Channel, text: string, buttons?: { text: string; data: string }[]): Promise<void> {
    const secret = c.secretRef ? await this.secrets.get(c.secretRef) : undefined;
    if (!secret) throw new Error(`渠道“${c.name}”还没填 token 或 Webhook 地址`);
    const body = redact(text).slice(0, 3500);
    if (c.kind === 'telegram') {
      if (!c.paired) return;
      await this.tg(secret, 'sendMessage', {
        chat_id: c.paired.chatId, text: body,
        ...(buttons ? { reply_markup: { inline_keyboard: [buttons.map((b) => ({ text: b.text, callback_data: b.data }))] } } : {}),
      });
      return;
    }
    const bad = checkWebhook(c.kind, secret);
    if (bad) throw new Error(bad);
    const res = await this.f(secret, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(webhookBody(c.kind, body)) });
    if (!res.ok) throw new Error(`Webhook 返回 ${res.status}`);
  }

  private async tg(token: string, method: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
    const res = await this.f(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), ...(signal ? { signal } : {}),
    });
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: unknown; description?: string };
    if (!j.ok) throw new Error(`Telegram：${j.description ?? res.status}`);
    return j.result;
  }

  private broadcast(pred: (c: Channel) => boolean, text: string, buttons?: { text: string; data: string }[]) {
    for (const c of Object.values(this.ws.current.channels)) {
      if (!c.enabled || !pred(c)) continue;
      void this.send(c, text, buttons).catch(() => {});
    }
  }

  private onEvents(evs: ZEvent[]): void {
    let channelsChanged = false;
    for (const e of evs) {
      const b = e.body;
      if (b.type === 'channel.saved' || b.type === 'channel.removed') channelsChanged = true;
      else if (b.type === 'approval.requested' && b.approval.state === 'pending') this.notifyApproval(b.approval);
      else if (b.type === 'thread.resolved' && b.by === 'coordinator') {
        const t = this.ws.current.threads[b.threadId];
        if (t) this.broadcast((c) => c.notify.results && this.inProject(c, t.projectId), `「${t.title}」做完了：${b.reason}`);
      } else if (b.type === 'thread.message' && b.message.author.kind === 'coordinator' && b.message.text) {
        const m = b.message;
        for (const [cid, v] of this.inbound) {
          if (v.threadId !== m.threadId || Date.now() - v.at > 30 * 60 * 1000) continue;
          const c = this.ws.current.channels[cid];
          if (c?.enabled) void this.send(c, m.text).catch(() => {});
        }
      }
    }
    if (channelsChanged) this.sync();
  }

  private inProject(c: Channel, projectId: string): boolean {
    return !c.projectId || c.projectId === projectId;
  }

  private notifyApproval(a: Approval) {
    const t = this.ws.current.threads[a.request.threadId];
    const where = t ? `「${t.title}」里的 ` : '';
    this.broadcast(
      (c) => c.notify.approvals && (!t || this.inProject(c, t.projectId)),
      `要你批准：${where}${a.request.agentId}\n${a.request.target}${a.reasons.length ? `\n原因：${a.reasons.join('、')}` : ''}`,
      [{ text: '批准这一次', data: `a:${a.id}` }, { text: '拒绝', data: `d:${a.id}` }],
    );
  }

  // ---------- 收（Telegram 长轮询） ----------
  private sync(): void {
    if (this.closed) return;
    const want = new Set(Object.values(this.ws.current.channels).filter((c) => c.kind === 'telegram' && c.enabled && c.secretRef).map((c) => c.id));
    for (const [id, ac] of this.polls) if (!want.has(id)) { ac.abort(); this.polls.delete(id); }
    for (const id of want) {
      if (this.polls.has(id)) continue;
      const ac = new AbortController();
      this.polls.set(id, ac);
      void this.poll(id, ac.signal);
    }
  }

  private async poll(channelId: string, signal: AbortSignal): Promise<void> {
    let offset = 0;
    while (!signal.aborted) {
      const c = this.ws.current.channels[channelId];
      const token = c?.secretRef ? await this.secrets.get(c.secretRef) : undefined;
      if (!c || !token) return;
      try {
        const ups = (await this.tg(token, 'getUpdates', { offset, timeout: this.opts.pollTimeoutSec ?? 25, allowed_updates: ['message', 'callback_query'] }, signal)) as TgUpdate[];
        for (const u of ups) {
          offset = Math.max(offset, u.update_id + 1);
          await this.handle(channelId, token, u).catch(() => {});
        }
      } catch {
        if (signal.aborted) return;
        await new Promise((r) => setTimeout(r, this.opts.retryMs ?? 5000));
      }
    }
  }

  private async handle(channelId: string, token: string, u: TgUpdate): Promise<void> {
    const c = this.ws.current.channels[channelId];
    if (!c) return;
    const SYS: Actor = { kind: 'system', id: `channel:${c.id}` };
    if (u.callback_query) {
      const q = u.callback_query;
      const chat = String(q.message?.chat.id ?? '');
      if (!c.paired || chat !== c.paired.chatId) return;
      const m = (q.data ?? '').match(/^([ad]):(apv_[a-z0-9]+)$/);
      if (!m) return;
      const r = this.h.approve(m[2]!, m[1] === 'a', { kind: 'user', id: 'me' });
      await this.tg(token, 'answerCallbackQuery', { callback_query_id: q.id, text: r.ok ? (m[1] === 'a' ? '已批准' : '已拒绝') : (r.error ?? '处理不了') });
      return;
    }
    const msg = u.message;
    if (!msg?.text) return;
    const chat = String(msg.chat.id);
    const text = msg.text.trim();
    const reply = (t: string) => this.tg(token, 'sendMessage', { chat_id: chat, text: t });
    const pair = text.match(/^\/pair(?:@\w+)?\s+(\d{6})$/);
    if (pair) {
      if (msg.chat.type && msg.chat.type !== 'private') {
        await reply('只能在和机器人的私聊里配对（群里的任何人都能点批准，不安全）。');
        return;
      }
      const want = this.codes.get(c.id);
      if (!want || want.until < Date.now() || want.code !== pair[1]) {
        // 猜错 5 次就作废，防止有人暴力试
        if (want && ++want.tries >= 5) this.codes.delete(c.id);
        await reply('配对码不对或过期了，回中枢重新拿一个。');
        return;
      }
      this.codes.delete(c.id);
      const name = msg.chat.title ?? msg.chat.username ?? msg.chat.first_name;
      this.ws.commit({ type: 'channel.saved', channel: { ...c, paired: { chatId: chat, ...(name ? { name } : {}), at: Date.now() } } }, SYS);
      await reply('配好了。以后这里会收到待批准的操作和完成通知；直接发文字就是跟协调者说话。/status 看进度。');
      return;
    }
    if (!c.paired || chat !== c.paired.chatId) {
      await reply('这个机器人还没和你配对。在中枢的“消息渠道”里点“配对”，把 /pair 加 6 位码发过来。');
      return;
    }
    const cmd = text.match(/^\/(approve|deny)(?:@\w+)?[_ ](apv_[a-z0-9]+)$/);
    if (cmd) {
      const r = this.h.approve(cmd[2]!, cmd[1] === 'approve', { kind: 'user', id: 'me' });
      await reply(r.ok ? (cmd[1] === 'approve' ? '已批准' : '已拒绝') : (r.error ?? '处理不了'));
      return;
    }
    if (/^\/status(@\w+)?$/.test(text)) {
      await reply(this.h.status(c.projectId));
      return;
    }
    if (/^\/(start|help)(@\w+)?$/.test(text)) {
      await reply('直接发文字 = 跟协调者说话。\n/status 看进度\n待批准的操作会带按钮发过来。');
      return;
    }
    const pid = c.projectId && this.ws.current.projects[c.projectId] ? c.projectId : Object.values(this.ws.current.projects).find((p) => !p.archived)?.id;
    if (!pid) {
      await reply('中枢里还没有项目，先在电脑上建一个。');
      return;
    }
    const r = await this.h.userMessage(pid, text.slice(0, 4000), c.name);
    this.inbound.set(c.id, { threadId: r.threadId, at: Date.now() });
  }
}
