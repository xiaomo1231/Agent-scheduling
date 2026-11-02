import type { ToolSpec } from '../providers/index.js';

/** 协调者能用的工具。协调者只调度，不直接动文件和命令。 */
export const COORD_TOOLS: ToolSpec[] = [
  {
    name: 'create_thread',
    description: '为一件新的工作开一个讨论串，并给出计划步骤。start 为 true 时立刻开始派活。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '讨论串标题：动词开头，三到十个字' },
        steps: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, assignee: { type: 'string', description: '由谁做，如 @builder、@tester' } }, required: ['title'] } },
        start: { type: 'boolean' },
      },
      required: ['title', 'steps'],
    },
  },
  {
    name: 'update_plan',
    description: '调整某个讨论串的计划。ops 里每项是 {op:add,title,assignee?,after?,before?} / {op:move,stepId,before?|after?|first?} / {op:cancel,stepId} / {op:rename,stepId,title} / {op:assign,stepId,assignee}。',
    parameters: { type: 'object', properties: { thread_id: { type: 'string' }, ops: { type: 'array', items: { type: 'object' } } }, required: ['thread_id', 'ops'] },
  },
  {
    name: 'dispatch',
    description: '开始（或继续）按顺序执行某个讨论串里排队的步骤。',
    parameters: { type: 'object', properties: { thread_id: { type: 'string' } }, required: ['thread_id'] },
  },
  {
    name: 'ask_user',
    description: '需要用户拍板时，在讨论串里提一个问题。问完就停下等回答。',
    parameters: { type: 'object', properties: { thread_id: { type: 'string' }, question: { type: 'string' } }, required: ['thread_id', 'question'] },
  },
  {
    name: 'resolve_thread',
    description: '事情做完、没人欠下一步时，把讨论串标为已解决。拿不准就别调。',
    parameters: { type: 'object', properties: { thread_id: { type: 'string' }, reason: { type: 'string' } }, required: ['thread_id', 'reason'] },
  },
  {
    name: 'remember',
    description: '把以后还会用到的项目事实记进项目记忆：约定、用户的偏好、做过的决定、踩过的坑。不记临时进度，不记密钥。',
    parameters: { type: 'object', properties: { text: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['text'] },
  },
  {
    name: 'start_review',
    description: '开一次群评审：几个角色（其中一个专门唱反调）围绕一个问题讨论，最后由拍板的模型给结论。preset 可选 design 方案评审 / code 代码评审 / product 产品决策 / writing 写作润色 / risk 风险评估 / stack 技术选型 / brainstorm 头脑风暴。',
    parameters: { type: 'object', properties: { question: { type: 'string', description: '要评审的问题，带上必要的背景' }, preset: { type: 'string' } }, required: ['question'] },
  },
];
