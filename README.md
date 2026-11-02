# 中枢

先帮你管好手里的模型账号（订阅、Coding Plan、API Key、本地模型），再让你当 AI agent 团队的管理者：跟协调者说要做什么，它开讨论串、排计划、派 agent 去做；跑命令、删文件、往外发消息这类事先问你；做完了自动放到“已解决”。

## 现在能用的（v0.2）

- **项目画布**：12 × 8 格子，像 iOS 主屏幕一样调整。点“调整布局”进入编辑，拖标题栏移动、拖右下角改大小，挡路的模块自动让位，满了会挤出位置；有六种现成布局。模块：协调者、讨论串、当前讨论串、待批准、动态。
- **协调者**：可以用 API 模型（多轮调用工具）、订阅账号（通过官方 CLI 无界面模式，每条消息问一次），没配模型时用规则兜底。支持双脑（副脑复核 / 备用接手）和分组里的备用模型。
- **讨论串**：每个带计划清单，可以加步骤、挪顺序、取消，改动可撤销；运行中追加“再加一步…”“先做 T3”“取消 T2”会改计划。全部做完、没有待批准、不用等你回答时，协调者自动解决；你也能手动解决或重开，重开过的不再自动解决；往已解决的讨论串发消息会重新打开它。
- **执行**：内置 agent（读写文件、跑命令、读网页，工具都在中枢手里，每一步过权限检查），或者把步骤交给 Claude Code / Codex / Gemini CLI 用订阅额度去做。
- **模型**：常见服务的预设（Claude 订阅、ChatGPT 订阅、智谱 / Kimi Coding Plan、OpenCode Go、火山方舟、百炼、DeepSeek、Anthropic、OpenAI、OpenRouter、Ollama、LM Studio），地址可改；思考强度按模型分挡（Claude 五挡对应官方 effort，GPT 系列对应 reasoning_effort）；按用途分组。Claude 官方 API 用自适应思考，并默认开启服务端兜底（被安全分类器拒绝时自动换模型重答）。
- **权限与安全**：命令策略五档、精确到参数的白名单、“以后都允许”只放行同一条命令、内联代码必问、高风险动作必问、读过外部内容后跑命令要确认、没人审批默认拒绝、审批绑定指纹、紧急停止、安全体检一键修复。
- **Skills**：导入 Claude Code / Codex / Gemini CLI / OpenCode / OpenClaw 的 skill，先转成中枢通用模板（SKILL.md + `metadata.zhongshu`），静态扫描，高风险内容要你确认，带锁安装，再投放到各个 agent 的 skills 目录。
- **留痕**：所有变化都是事件，前后用 SHA-256 串成链；启动时校验，改过一条就拒绝打开。密钥加密存在本机（桌面版用系统钥匙串），不进事件、不进界面、日志打码。

还没做的见 [docs/roadmap.md](docs/roadmap.md)。

## 运行

需要 Node 22 以上。

```bash
npm install
npm run build          # 编译 core、server、web、desktop
npm start              # 打开桌面版（Electron）
```

不想装 Electron，也可以只跑本地服务，用浏览器打开它打印出来的地址（末尾带 `#token=…`）：

```bash
npm run build
node packages/server/dist/cli.js            # 数据放在 ~/.zhongshu
node packages/server/dist/cli.js --simulate # 没接模型时用模拟运行，先看看流程
```

开发时前后端分开跑：

```bash
npm run dev:server -- --port 4319 --dev-origin http://localhost:5173 --simulate
npm run dev:web        # 打开 http://localhost:5173/#token=…（token 用上一条命令打印的）
```

提交前跑 `npm run check`（类型检查 + 测试）。

## 目录

```
packages/core     纯逻辑：领域类型、事件与哈希链、reducer、权限判断、计划调整、布局、模型挡位、Skill 模板、安全体检
packages/server   本地服务：事件存储、密钥、模型接入、审批、运行器、协调者、Skill 安装、本地网关
apps/web          React 界面，只通过网关和后端说话
apps/desktop      Electron 外壳：启动网关、开安全设置的窗口
demo/             早期的单文件可点击原型，只作参考
docs/             架构、决定记录、产品设计、路线图
```

先读 [docs/architecture.md](docs/architecture.md)，里面写了放在哪个包、依赖方向和必须遵守的安全约定。
