import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, MockProvider, ProviderError, type App, type ChatRequest, type ChatResult } from '../packages/server/src/index.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 4000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('等太久了');
    await wait(10);
  }
}
async function cmd(a: App, c: unknown) {
  const r = await a.handle(c);
  if (!r.ok) throw new Error(r.error);
  return r.result as any;
}
const end = (text: string): ChatResult => ({ text, toolCalls: [], stop: 'end', usage: { input: 10, output: 5 } });
const call = (name: string, input: Record<string, unknown>, id = name): ChatResult => ({ text: '', toolCalls: [{ id, name, input }], stop: 'tool', usage: { input: 10, output: 5 } });

let app: App | undefined;
afterEach(() => {
  app?.close();
  app = undefined;
});

async function setup(script: (req: ChatRequest, i: number) => ChatResult, extra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'zs-'));
  app = createApp({ dataDir: dir, mockProvider: new MockProvider(script), background: false, ...extra });
  await cmd(app, { type: 'source.save', source: { id: 'src_mockft', kind: 'apikey', name: 'm', transport: 'mock', models: [{ id: 'mock-1', label: 'Mock', vendor: 'x', enabled: true }] } });
  const { projectId, coordThreadId } = await cmd(app, { type: 'project.create', name: 'p' });
  const choice = { kind: 'model', ref: { sourceId: 'src_mockft', modelId: 'mock-1' } };
  await cmd(app, { type: 'project.update', projectId, patch: { settings: { coordinator: { model: choice }, threadDefault: { model: choice } } } });
  return { projectId, coordThreadId, dir };
}

async function runStep(projectId: string) {
  const { threadId } = await cmd(app!, { type: 'thread.create', projectId, title: '干活' });
  await cmd(app!, { type: 'plan.apply', threadId, ops: [{ op: 'add', title: '一步' }] });
  await cmd(app!, { type: 'thread.continue', threadId });
  await until(() => app!.ws.current.threads[threadId]!.steps[0]!.state !== 'queue' && app!.ws.current.threads[threadId]!.steps[0]!.state !== 'run');
  return threadId;
}

describe('用量与额度', () => {
  it('每次调用记用量；429 时等一下自动继续', async () => {
    let fails = 2;
    const { projectId } = await setup(() => {
      if (fails-- > 0) throw new ProviderError('额度到上限', 429, true);
      return end('好了');
    }, { quotaBaseDelayMs: 20 });
    const seen: number[] = [];
    app!.ws.subscribe((evs) => evs.forEach((e) => e.body.type === 'source.quota' && seen.push(e.body.until === null ? 0 : 1)));
    const t = await runStep(projectId);
    expect(app!.ws.current.threads[t]!.steps[0]!.state).toBe('done');
    expect(seen).toEqual([1, 1, 0]);
    const rows = Object.values(app!.ws.current.usage);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ projectId, sourceId: 'src_mockft', model: 'mock-1', calls: 1, input: 10, output: 5 });
  });

  it('关掉自动继续时直接报错', async () => {
    const { projectId } = await setup(() => {
      throw new ProviderError('额度到上限', 429, true);
    }, { quotaBaseDelayMs: 20 });
    await cmd(app!, { type: 'project.update', projectId, patch: { settings: { autoContinueAfterQuotaReset: false } } });
    const t = await runStep(projectId);
    expect(app!.ws.current.threads[t]!.steps[0]!.state).toBe('wait');
    expect(app!.ws.current.quota).toEqual({});
  });
});

describe('子 agent', () => {
  it('并行跑、只读，结论交回主 agent', async () => {
    let live = 0;
    let peak = 0;
    const { projectId, dir } = await setup((req) => {
      const sub = req.system.includes('只读的调研子 agent');
      const last = req.turns.at(-1)!;
      if (sub) {
        if (last.role === 'user') {
          // 子 agent 想写文件：没有这个工具
          return call('write_file', { path: 'x', content: 'x' });
        }
        return end('子结论：没权限写，但读到了');
      }
      if (last.role === 'user') return { text: '', toolCalls: [1, 2, 3, 4].map((i) => ({ id: `s${i}`, name: 'run_subagent', input: { task: `查第${i}块` } })), stop: 'tool' };
      return end(`汇总：${(last as any).results.length} 份结论`);
    });
    // 统计并发：包一层 chat
    const p = (app as any).o.mockProvider as MockProvider;
    const orig = p.chat.bind(p);
    const subResults: string[] = [];
    p.chat = async (req) => {
      if (req.system.includes('子 agent')) {
        if (req.turns.at(-1)!.role === 'tool') subResults.push(JSON.stringify(req.turns.at(-1)));
        live++;
        peak = Math.max(peak, live);
        await wait(20);
        try {
          return await orig(req);
        } finally {
          live--;
        }
      }
      return orig(req);
    };
    void dir;
    const t = await runStep(projectId);
    expect(app!.ws.current.threads[t]!.steps[0]!.state).toBe('done');
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
    expect(subResults).toHaveLength(4);
    expect(subResults[0]).toContain('没有使用 write_file 的权限');
    expect(app!.ws.current.messages[t]!.some((m) => m.text === '汇总：4 份结论')).toBe(true);
  });
});

describe('项目记忆', () => {
  it('agent 用 remember 记下，之后的提示词里带上', async () => {
    const { projectId } = await setup((req) => {
      if (req.turns.at(-1)!.role === 'user') {
        if (req.system.includes('执行 agent') && (req.turns[0] as any).text.includes('用 pnpm')) return end('看到记忆了');
        return call('remember', { text: '这个项目用 pnpm，不要用 npm', tags: ['构建'] });
      }
      return end('记好了');
    });
    await runStep(projectId);
    const mem = app!.ws.current.memory[projectId]!;
    expect(mem.entries[0]).toMatchObject({ text: '这个项目用 pnpm，不要用 npm', tags: ['构建'] });
    const t2 = await runStep(projectId);
    expect(app!.ws.current.messages[t2]!.some((m) => m.text === '看到记忆了')).toBe(true);
  });

  it('桌面页限长；整理用辅助模型，置顶的保留', async () => {
    const { projectId } = await setup((req) =>
      req.system.includes('整理一个项目的长期记忆') ? end('{"desk":"用 pnpm；部署在 fly.io","entries":[{"text":"部署在 fly.io","tags":["部署"]}]}') : end('x'),
    );
    await expect(cmd(app!, { type: 'memory.desk', projectId, desk: '字'.repeat(2000) })).rejects.toThrow(/最多/);
    await cmd(app!, { type: 'memory.add', projectId, text: '密钥不要提交', pinned: true });
    await cmd(app!, { type: 'memory.add', projectId, text: '部署在 fly.io' });
    await cmd(app!, { type: 'memory.add', projectId, text: '部署 在 fly.io' });
    const r = await cmd(app!, { type: 'memory.consolidate', projectId });
    expect(r).toMatchObject({ before: 3, after: 2, byModel: true });
    const mem = app!.ws.current.memory[projectId]!;
    expect(mem.desk).toContain('fly.io');
    expect(mem.entries.map((e) => e.text)).toEqual(['密钥不要提交', '部署在 fly.io']);
    // 一天内不再自动整理
    expect(await app!.memory.tick({ kind: 'system', id: 'm' })).toEqual([]);
  });
});

describe('群评审', () => {
  it('各角色发言、唱反调不附和、拍板后贴回', async () => {
    const { projectId, coordThreadId } = await setup((req) => {
      if (req.system.includes('拍板人')) return end('决定：用 SQLite。风险：并发写。');
      const role = req.system.match(/扮演「(.+?)」/)?.[1] ?? '?';
      return end(`${role}的看法`);
    });
    const { threadId } = await cmd(app!, { type: 'review.start', projectId, question: '数据库用 SQLite 还是 Postgres？', preset: 'stack', rounds: 1, replyTo: coordThreadId });
    await app!.reviews.idle();
    const t = app!.ws.current.threads[threadId]!;
    expect(t.kind).toBe('review');
    expect(t.review!.state).toBe('decided');
    expect(t.review!.roles.some((r) => r.devil)).toBe(true);
    expect(t.resolved?.by).toBe('coordinator');
    const msgs = app!.ws.current.messages[threadId]!.map((m) => m.text);
    expect(msgs).toContain('唱反调的看法');
    expect(msgs.at(-1)).toContain('决定：用 SQLite');
    expect(app!.ws.current.messages[coordThreadId]!.some((m) => m.text.includes('有结论了'))).toBe(true);
    // 唱反调的系统提示要求反对
    const p = (app as any).o.mockProvider as MockProvider;
    expect(p.calls.find((c) => c.system.includes('「唱反调」'))!.system).toContain('不能附和');
  });

  it('协调者可以用 start_review 开评审', async () => {
    const { coordThreadId } = await setup((req) => {
      if (req.tools?.some((t) => t.name === 'start_review')) return req.turns.at(-1)!.role === 'tool' ? end('开了') : call('start_review', { question: '要不要重写？', preset: 'design' });
      return end(req.system.includes('拍板') ? '不重写' : '意见');
    });
    await cmd(app!, { type: 'message.send', threadId: coordThreadId, text: '评审一下要不要重写' });
    await app!.coordinator.idle();
    await app!.reviews.idle();
    expect(Object.values(app!.ws.current.threads).some((t) => t.kind === 'review' && t.review?.decision === '不重写')).toBe(true);
  });
});

describe('划词追问', () => {
  it('开侧枝、追问、带回结论', async () => {
    const { coordThreadId } = await setup((req) => {
      if (req.system.includes('压成两三句结论')) return end('结论：幂等就是重复执行结果一样。');
      if (req.system.includes('划了一段话')) return end(`解释第 ${req.turns.filter((t) => t.role === 'user').length} 次`);
      return end('协调者回答：要保证幂等。');
    });
    await cmd(app!, { type: 'message.send', threadId: coordThreadId, text: '接口要注意什么' });
    await app!.coordinator.idle();
    const m = app!.ws.current.messages[coordThreadId]!.find((x) => x.text.includes('幂等'))!;
    const { threadId } = await cmd(app!, { type: 'thread.side', threadId: coordThreadId, messageId: m.id, quote: '幂等', question: '幂等是什么？' });
    await app!.sides.idle();
    expect(app!.ws.current.messages[threadId]!.at(-1)!.text).toBe('解释第 1 次');
    await cmd(app!, { type: 'message.send', threadId, text: '举个例子' });
    await until(() => app!.ws.current.messages[threadId]!.at(-1)!.text === '解释第 2 次');
    const before = app!.coordinator;
    void before;
    await cmd(app!, { type: 'thread.sideClose', threadId, outcome: 'conclusion' });
    const t = app!.ws.current.threads[threadId]!;
    expect(t.parent!.outcome).toBe('conclusion');
    expect(t.resolved).not.toBeNull();
    const parentMsgs = app!.ws.current.messages[coordThreadId]!;
    expect(parentMsgs.some((x) => x.cards?.some((c) => c.kind === 'side'))).toBe(true);
    expect(parentMsgs.at(-1)!.text).toContain('结论：幂等就是');
    await expect(cmd(app!, { type: 'thread.sideClose', threadId, outcome: 'all' })).rejects.toThrow(/已经关掉/);
  });

  it('丢弃：原讨论串不多东西', async () => {
    const { coordThreadId } = await setup(() => end('答'));
    const { threadId } = await cmd(app!, { type: 'thread.side', threadId: coordThreadId, quote: '某段话', question: '' });
    await app!.sides.idle();
    const n = app!.ws.current.messages[coordThreadId]!.length;
    await cmd(app!, { type: 'thread.sideClose', threadId, outcome: 'discard' });
    expect(app!.ws.current.messages[coordThreadId]!.length).toBe(n);
  });
});

// ---------- 渠道：假的 Telegram 和 Webhook ----------
function fakeNet() {
  const updates: unknown[] = [];
  const sent: { url: string; body: any }[] = [];
  let uid = 1;
  const f = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.startsWith('https://api.telegram.org/bot')) {
      const method = u.split('/').pop();
      if (method === 'getUpdates') {
        await wait(10);
        const out = updates.splice(0).filter((x: any) => x.update_id >= (body.offset ?? 0));
        return json({ ok: true, result: out });
      }
      sent.push({ url: u, body });
      return json({ ok: true, result: {} });
    }
    sent.push({ url: u, body });
    return json({ errcode: 0 });
  }) as typeof fetch;
  return {
    f, sent,
    text: (text: string, chatId = 42, type = 'private') => updates.push({ update_id: uid++, message: { message_id: uid, chat: { id: chatId, type, first_name: 'X' }, text } }),
    press: (data: string, chatId = 42) => updates.push({ update_id: uid++, callback_query: { id: `cb${uid}`, data, message: { chat: { id: chatId } } } }),
  };
}

describe('消息渠道', () => {
  it('Telegram：配对、发话给协调者、按钮批准', async () => {
    const net = fakeNet();
    const { projectId } = await setup((req) => (req.tools?.some((t) => t.name === 'create_thread') ? end('收到，我来安排') : end('x')), { fetch: net.f, background: true, channelPollTimeoutSec: 0 });
    await cmd(app!, { type: 'channel.save', channel: { id: 'chn_tgtest1', kind: 'telegram', name: 'TG', enabled: true, projectId, notify: { approvals: true, results: true } }, secret: '123456:' + 'A'.repeat(35) });
    // 没配对：不理
    net.text('你好');
    await until(() => net.sent.some((s) => String(s.body.text).includes('还没和你配对')));
    // 群里配对：拒绝
    const { code } = await cmd(app!, { type: 'channel.pair', channelId: 'chn_tgtest1' });
    net.text(`/pair ${code}`, -100, 'group');
    await until(() => net.sent.some((s) => String(s.body.text).includes('只能在和机器人的私聊里配对')));
    net.text(`/pair ${code}`);
    await until(() => !!app!.ws.current.channels.chn_tgtest1!.paired);
    expect(app!.ws.current.channels.chn_tgtest1!.paired!.chatId).toBe('42');
    // 发话
    net.text('帮我看看首页');
    await until(() => net.sent.some((s) => s.body.text === '收到，我来安排'));
    // 别人的聊天：不理
    net.text('/status', 99);
    await until(() => net.sent.filter((s) => String(s.body.text).includes('还没和你配对')).length >= 2);
    // 审批推送 + 按钮
    const gate = app!.approvals.gate({ agentId: 'a', threadId: 'thr_zzzzzz', kind: 'command', target: 'rm -rf build', cwd: '/w', workspaceRoot: '/w' }, { kind: 'agent', id: 'a' });
    await until(() => net.sent.some((s) => String(s.body.text).startsWith('要你批准')));
    const push = net.sent.find((s) => String(s.body.text).startsWith('要你批准'))!;
    const data = push.body.reply_markup.inline_keyboard[0][0].callback_data as string;
    net.press(data);
    expect((await gate).ok).toBe(true);
    // token 不进事件日志
    expect(JSON.stringify(app!.ws.allEvents())).not.toContain('AAAAAAAAAA');
  });

  it('Webhook：只认官方域名；通知按格式发', async () => {
    const net = fakeNet();
    await setup(() => end('x'), { fetch: net.f });
    await expect(cmd(app!, { type: 'channel.save', channel: { id: 'chn_fstest1', kind: 'feishu', name: '飞书', enabled: true, notify: { approvals: true, results: true } }, secret: 'https://evil.example/hook' })).rejects.toThrow(/不像飞书/);
    await cmd(app!, { type: 'channel.save', channel: { id: 'chn_fstest1', kind: 'feishu', name: '飞书', enabled: true, notify: { approvals: true, results: true } }, secret: 'https://open.feishu.cn/open-apis/bot/v2/hook/abc' });
    await cmd(app!, { type: 'channel.save', channel: { id: 'chn_ddtest1', kind: 'dingtalk', name: '钉钉', enabled: true, notify: { approvals: true, results: true } }, secret: 'https://oapi.dingtalk.com/robot/send?access_token=x' });
    await cmd(app!, { type: 'channel.test', channelId: 'chn_fstest1' });
    await cmd(app!, { type: 'channel.test', channelId: 'chn_ddtest1' });
    expect(net.sent[0]!.body).toEqual({ msg_type: 'text', content: { text: expect.stringContaining('渠道测试') } });
    expect(net.sent[1]!.body.msgtype).toBe('text');
  });
});
void writeFileSync;
