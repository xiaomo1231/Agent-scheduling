# 中枢架构

这份文档定下工程的骨架。往后加功能先看这里：放在哪个包、走哪条路、遵守哪些约定。改动骨架要先改这份文档，并在 `docs/decisions/` 里记一条决定。

## 1. 技术选型

| 层 | 选型 | 理由 |
|---|---|---|
| 语言 | TypeScript（strict），Node 22 | 前后端一套类型 |
| 包管理 | npm workspaces | 不引入额外工具 |
| 桌面外壳 | Electron | 自带 Node，能直接装各家 CLI；跨平台 |
| 前端 | React 19 + Vite | 生态最大；Vite 开发快 |
| 本地服务 | Node `http` + `ws` | 依赖少，够用 |
| 输入校验 | zod | 网关入口统一校验 |
| 存储 | 事件日志（JSONL）+ 内存投影 | 天然留痕、可回放、无原生依赖 |
| 测试 | vitest | 与 Vite 一致 |

## 2. 目录与包

```
packages/
  core/      @zhongshu/core    纯逻辑，不碰文件、网络、进程
  server/    @zhongshu/server  存储、模型、协调者、运行器、审批、本地网关
apps/
  web/       @zhongshu/web     React 前端，只通过网关和后端说话
  desktop/   @zhongshu/desktop Electron 外壳：启动网关、开窗口、管密钥
docs/        架构、约定、决定记录
demo/        早期的单文件可点击原型，只作参考
```

依赖方向只能往下：`desktop → server → core`，`web → core`（只用类型和纯函数）。`core` 不依赖任何包；`web` 不能 import `server`。

### core 里有什么

| 模块 | 内容 |
|---|---|
| `model/` | 领域类型：项目、讨论串、步骤、消息、模型来源、分组、agent、审批、skill |
| `events/` | 事件类型、哈希链留痕（`appendEvent`、`verifyChain`） |
| `state/` | 由事件推出当前状态的 reducer（`reduce(state, event)`） |
| `policy/` | 命令策略、白名单匹配、内联代码识别、审批指纹、高风险判断 |
| `plan/` | 计划调整：解析“新增 / 先做 / 取消 / 另开”，生成可撤销的改动 |
| `threads/` | 讨论串状态与自动解决规则 |
| `layout/` | 12 × 8 画布布局引擎（放置、让位、对调、满了挤位置），模块种类 `WIDGET_KINDS` |
| `audit/` | 安全体检：找出放松了的设置，给出一键修复 |
| `models/` | 模型目录、思考强度挡位、用途分组解析 |
| `skills/` | SKILL.md 解析、`metadata.zhongshu` 校验、静态扫描、工具名映射、投放目录 |
| `memory/` | 记忆检索（中文两字切词）、按字节截断、放进提示词的记忆段 |
| `review/` | 群评审的 7 套预设班子 |
| `workflow/` | 工作流：定义（表单字段、节点、连线）、校验、拓扑与就绪节点、切批、CSV、内置预设 |

### server 里有什么

| 模块 | 内容 |
|---|---|
| `store/` | 事件日志写入与读取（每个工作区一个 `events.jsonl`），启动时回放 |
| `secrets/` | 密钥存取接口；桌面版接系统钥匙串，测试用内存实现；日志打码 |
| `providers/` | 模型适配：Anthropic、OpenAI 兼容（GLM / Kimi / DeepSeek / OpenCode / Ollama 等）、模拟；`MeteredProvider` 记用量、碰到 429 等恢复再重试 |
| `coordinator/` | 协调者引擎：把用户消息变成工具调用（开讨论串、改计划、派活、请求审批、解决） |
| `runners/` | agent 运行器：内置 agent（工具全在中枢手里）、CLI agent（Claude Code / Codex 等无界面模式） |
| `approvals/` | 审批队列：指纹绑定、超时兜底、白名单“以后都允许” |
| `skills/` | Skill 安装服务：预览转换、带锁安装、校验、投放到各平台目录 |
| `worktrees/` | 每个讨论串一个 git worktree：开分支、提交、合并、丢弃 |
| `memory/` | 项目记忆：桌面页、条目、每日整理 |
| `review/` | 群评审：角色轮流发言、唱反调、拍板 |
| `side/` | 划词追问：侧枝讨论串、关掉时带回结论 |
| `channels/` | 消息渠道：Telegram 长轮询 + 配对、飞书 / 钉钉 / 企业微信 Webhook |
| `flows/` | 工作流执行器：开运行（一条 flow 讨论串）、按依赖派节点、人工检查点、切批、产出落盘 |
| `search/` | 搜索服务：博查 / Tavily / Brave 适配，`web_search` 工具和“搜一搜”节点都走它 |
| `gateway/` | 本地网关：HTTP API + WebSocket 事件流，只绑 127.0.0.1，带 token，校验 Host 和 Origin |
| `app/` | 组装：把以上模块接起来，命令的 zod 校验和分发；对外只暴露 `createApp(options)` |

## 3. 数据怎么流

```
前端 ──HTTP 命令──▶ 网关 ──▶ 服务（校验、权限）──▶ 追加事件 ──▶ 事件日志
  ▲                                              │
  └──────────── WebSocket 推送新事件 ◀────────────┘
                 前端用同一个 core reducer 更新界面
```

- **所有状态变化都是事件**。没有“直接改数据库”。事件带 `seq`、`ts`、`actor`（谁做的，带 agent 编号）、`prevHash`、`hash`，形成哈希链，即审计记录。
- 前端和后端用 **同一个 reducer**（在 core 里），所以界面状态和后端一致。
- 命令（command）和事件（event）分开：命令是“请求做某事”，可能被拒绝；事件是“已经发生”。

## 4. 安全约定（默认就安全）

1. 网关只监听 `127.0.0.1`，每次启动生成随机 token；没有 token 的请求一律 401。
2. 任何会执行命令、写文件、联网、发消息的动作，都先过 `core/policy` 的 `decide()`，结果只有 `allow / ask / deny`。
3. `ask` 生成审批；审批绑定 **指纹**（命令全文 + 目录 + agent 编号 + 讨论串），执行前重算指纹，对不上就作废。
4. 没人审批时按 `askFallback`（默认 `deny`）。
5. 外部内容（网页、邮件、PR 评论、群消息）进模型前一律包成 `<untrusted>`，并且不触发工具。
6. 密钥不进事件日志、不进前端；日志统一过 `redact()`。
7. skill 只能申请权限，不能授予；实际权限 = agent 权限 ∩ 安装时批准的权限。
8. 放松安全的开关一律以 `dangerously` 开头，体检会标红。

## 5. 接口约定

- HTTP：`POST /api/commands`，body 是 `{ type, ...payload }`，zod 校验；返回 `{ ok, events }` 或 `{ ok:false, error }`。查询走 `GET /api/state`（当前状态快照）。
- WebSocket：`/api/events?token=…`，连接后先收 `{ kind:'snapshot' }`，之后逐条收 `{ kind:'event' }`。
- 命令名和事件名用 `领域.动作` 形式，如 `thread.create`、`thread.resolved`、`plan.stepAdded`。
- 所有 id 是带前缀的随机串：`prj_`、`thr_`、`stp_`、`msg_`、`apv_`、`src_`、`grp_`、`agt_`。

## 6. 代码约定

- 每个模块一个文件夹，`index.ts` 是唯一对外出口；跨模块只 import 出口。
- 纯函数优先；有副作用的东西（时间、随机数、文件、网络、进程）通过参数注入，方便测试。
- 每个模块都要有测试；改 bug 先写一个能复现的测试。
- 用户能看到的文字放在调用处，用中文，口语化；错误信息说清楚“怎么了、你能做什么”。
- 提交前跑 `npm run check`（类型检查 + 测试）。

## 7. 模型接入约定

- Anthropic 官方接口用官方 SDK（`@anthropic-ai/sdk`）。现行 Claude 模型用自适应思考（`thinking: {type: "adaptive"}`）+ `output_config.effort`，不用已淘汰的固定思考预算；思考块原样传回下一轮。Fable 5.1、Opus 5.5、Opus 5、Sonnet 5.5 默认带服务端兜底（`fallbacks: "default"`）。
- 第三方 Anthropic 兼容地址（智谱、Kimi 等）只发最基础的参数。
- OpenAI 兼容接口只用 `/chat/completions` 的通用部分；GPT 系列的挡位映射到 `reasoning_effort`。
- 订阅账号只通过官方 CLI 自己的登录使用，中枢不碰它们的凭据，也不加放开权限的参数。

- 所有经 `providerFor` 拿到的模型都包了 `MeteredProvider`：调用一次记一条 `usage.recorded`；429 时发 `source.quota` 并等待。新代码要拿模型，一律走 `providerFor`（带上 `projectId`），不要自己 new 适配器。

## 8. 桌面外壳约定

- 窗口 `contextIsolation`、`sandbox` 开，`nodeIntegration` 关，不加 preload；token 通过地址的 `#token=` 传给页面，页面读完就从地址栏抹掉。
- 只能停留在本地网关的页面，外部链接交给系统浏览器；拒绝所有权限请求。

## 9. 新功能的约定

- 新的状态一律先在 core 里加类型和事件，再在 reducer 里处理；server 的服务只发事件，不直接改状态。
- 从外部来的内容（网页、渠道消息之外的第三方文本、其他角色的发言、记忆）进提示词时要包起来并说明“只当资料”。
- 渠道只认配对过的聊天；Webhook 只发往官方域名；token 只进密钥库。
- 子 agent 只给只读工具；读过外部内容的结论按外部内容处理。

## 10. 现在做到哪、后面接什么

见 `docs/roadmap.md`。
