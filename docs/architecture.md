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
| `layout/` | 12 × 8 画布布局引擎（放置、让位、对调） |
| `models/` | 模型目录、思考强度挡位、用途分组解析 |
| `skills/` | SKILL.md 解析、`metadata.zhongshu` 校验、静态扫描、工具名映射、投放目录 |

### server 里有什么

| 模块 | 内容 |
|---|---|
| `store/` | 事件日志写入与读取（每个工作区一个 `events.jsonl`），启动时回放 |
| `secrets/` | 密钥存取接口；桌面版接系统钥匙串，测试用内存实现；日志打码 |
| `providers/` | 模型适配：Anthropic、OpenAI 兼容（GLM / Kimi / DeepSeek / OpenCode / Ollama 等）、模拟 |
| `coordinator/` | 协调者引擎：把用户消息变成工具调用（开讨论串、改计划、派活、请求审批、解决） |
| `runners/` | agent 运行器：内置 agent（工具全在中枢手里）、CLI agent（Claude Code / Codex 等无界面模式） |
| `approvals/` | 审批队列：指纹绑定、超时兜底、白名单“以后都允许” |
| `gateway/` | 本地网关：HTTP API + WebSocket 事件流，只绑 127.0.0.1，带 token |
| `app.ts` | 组装：把以上模块接起来，对外只暴露 `createApp(options)` |

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

## 7. 现在做到哪、后面接什么

见 `docs/roadmap.md`。
