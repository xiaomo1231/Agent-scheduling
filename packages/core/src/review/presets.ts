import type { ReviewRole } from '../model/types.js';

export interface ReviewPreset {
  id: string;
  name: string;
  hint: string;
  roles: Omit<ReviewRole, 'id'>[];
}

const DEVIL: Omit<ReviewRole, 'id'> = {
  name: '唱反调',
  stance: '你的任务是反对。找出别人没说的漏洞、最坏情况和被忽略的替代方案。不许附和，不许说“我同意”。如果实在找不到问题，就指出最可能出错的一处。',
  devil: true,
};

/** 内置的 7 套评审班子。每套都带一个唱反调的。 */
export const REVIEW_PRESETS: ReviewPreset[] = [
  { id: 'design', name: '方案评审', hint: '技术方案、架构设计', roles: [
    { name: '架构师', stance: '看整体结构、边界划分、以后好不好扩展。' },
    { name: '实现者', stance: '看具体怎么做、工作量、哪里会卡住。' },
    { name: '用户代言人', stance: '只关心用户最后得到什么，有没有绕远路。' },
    DEVIL,
  ] },
  { id: 'code', name: '代码评审', hint: '一段代码或一个改动', roles: [
    { name: '正确性', stance: '找 bug：边界情况、并发、错误处理。' },
    { name: '安全', stance: '找注入、越权、密钥泄露、不可信输入。' },
    { name: '可维护性', stance: '看命名、重复、复杂度，半年后的人能不能看懂。' },
    DEVIL,
  ] },
  { id: 'product', name: '产品决策', hint: '要不要做、先做哪个', roles: [
    { name: '产品经理', stance: '看目标、优先级、做了能带来什么。' },
    { name: '目标用户', stance: '以用户身份说话：我会不会用、为什么。' },
    { name: '工程成本', stance: '估算代价和机会成本。' },
    DEVIL,
  ] },
  { id: 'writing', name: '写作润色', hint: '文章、文案、文档', roles: [
    { name: '编辑', stance: '看结构、节奏、哪里啰嗦。' },
    { name: '目标读者', stance: '以读者身份说：哪里看不懂、哪里想跳过。' },
    { name: '事实核查', stance: '挑出没有依据或可能说错的地方。' },
    DEVIL,
  ] },
  { id: 'risk', name: '风险评估', hint: '上线、发布、迁移前', roles: [
    { name: '安全', stance: '会被怎么攻击、数据会不会泄露。' },
    { name: '合规', stance: '隐私、许可证、法律条款。' },
    { name: '运维', stance: '出事了怎么发现、怎么回滚。' },
    DEVIL,
  ] },
  { id: 'stack', name: '技术选型', hint: '在几个方案里选一个', roles: [
    { name: '支持方', stance: '为最被看好的方案辩护，说清楚它的优势。' },
    { name: '替代方', stance: '为第二选择辩护，说清楚它在哪些情况下更好。' },
    { name: '长期维护', stance: '看社区、生态、升级成本、锁定风险。' },
    DEVIL,
  ] },
  { id: 'brainstorm', name: '头脑风暴', hint: '想点子', roles: [
    { name: '天马行空', stance: '提大胆的、不寻常的点子，不用管能不能做。' },
    { name: '务实派', stance: '把点子变成下周就能试的版本。' },
    { name: '用户', stance: '说哪个点子你真的会用。' },
    DEVIL,
  ] },
];

export function presetById(id: string): ReviewPreset | undefined {
  return REVIEW_PRESETS.find((p) => p.id === id);
}
