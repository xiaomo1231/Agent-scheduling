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
];
