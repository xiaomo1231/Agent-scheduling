import type { FlowDef } from './types.js';

// 内置预设：给非程序员的四个常用流程。节点名用人话，不出现提示词、JSON 这些词。
// 坐标是编辑器里的位置；同一列 x 相同，依次往右。

const col = (i: number) => 40 + i * 230;

export const FLOW_PRESETS: FlowDef[] = [
  {
    id: 'flo_preset_hot_video',
    builtin: true,
    name: '短视频热点选题与脚本',
    audience: '短视频、自媒体创作者',
    description: '搜这周的热点，归纳成候选选题给你勾选，然后为每条选题写一条脚本，你审完导出。',
    inputs: [
      { key: '赛道', label: '你的赛道', kind: 'text', required: true, hint: '比如：职场、育儿、数码测评' },
      { key: '平台', label: '发在哪个平台', kind: 'select', options: ['抖音', '小红书', 'B站', '视频号', '快手'], default: '抖音' },
      { key: '风格', label: '你的风格', kind: 'text', hint: '比如：犀利吐槽、温和科普、第一人称故事', default: '轻松口语化' },
      { key: '条数', label: '要几条脚本', kind: 'number', default: '3' },
    ],
    nodes: [
      { id: 'n_search', kind: 'search', title: '搜这周的热点', x: col(0), y: 80, config: { queries: ['{{inputs.平台}} {{inputs.赛道}} 热门话题 本周', '{{inputs.赛道}} 争议 热搜 最近', '{{inputs.赛道}} 爆款视频 选题'], limit: 8, recency: 'week' } },
      { id: 'n_topics', kind: 'agent', title: '归纳成候选选题', x: col(1), y: 80, config: { instruction: '根据搜索结果，为“{{inputs.赛道}}”赛道归纳 8 个适合{{inputs.平台}}的候选选题。只用 ```csv 代码块输出一张表，列：选题、切入角度、为什么现在火、热度、来源链接。热度只能填 高 / 中 / 低；来源链接必须来自搜索结果。', tools: [], output: 'table' } },
      { id: 'n_pick', kind: 'human', title: '勾选要做的选题', x: col(2), y: 80, config: { ask: '勾选要写脚本的选题（建议 {{inputs.条数}} 条）。觉得都不行就打回，写一句你想要的方向。', pick: true } },
      { id: 'n_script', kind: 'agent', title: '为每条选题写脚本', x: col(3), y: 80, config: { instruction: '为这条选题写一条 {{inputs.平台}} 短视频脚本，风格：{{inputs.风格}}，总时长 45 到 60 秒。结构：前 3 秒的开头钩子；分镜（每段写画面 + 口播）；结尾引导；3 个备选标题；5 个话题标签。用 Markdown，标题就是选题名。', tools: [], output: 'text', each: { rows: 1 } } },
      { id: 'n_review', kind: 'human', title: '审稿', x: col(4), y: 80, config: { ask: '看一遍脚本。不满意就打回，写清楚哪条要怎么改。' } },
      { id: 'n_out_topics', kind: 'export', title: '导出选题表', x: col(3), y: 220, config: { filename: '选题.csv' } },
      { id: 'n_out_scripts', kind: 'export', title: '导出脚本', x: col(5), y: 80, config: { filename: '脚本.md' } },
    ],
    edges: [
      { from: 'n_search', to: 'n_topics' }, { from: 'n_topics', to: 'n_pick' }, { from: 'n_pick', to: 'n_script' },
      { from: 'n_script', to: 'n_review' }, { from: 'n_review', to: 'n_out_scripts' }, { from: 'n_pick', to: 'n_out_topics' },
    ],
  },
  {
    id: 'flo_preset_batch_data',
    builtin: true,
    name: '批量数据处理',
    audience: '运营、分析师、行政',
    description: '给一张表和一句话要求。模型先用前 20 行定好处理口径让你确认，再按批处理全部数据，最后出结果表和一份汇总。',
    inputs: [
      { key: '数据', label: '数据', kind: 'file', required: true, hint: '粘贴 CSV 文本，或填工作区里的 .csv 文件路径' },
      { key: '要做什么', label: '要做什么', kind: 'longtext', required: true, hint: '比如：把每条评论分成正面/负面/中性，并提取提到的问题点' },
      { key: '每批行数', label: '每批处理几行', kind: 'number', default: '50' },
    ],
    nodes: [
      { id: 'n_data', kind: 'input', title: '读取数据', x: col(0), y: 80, config: { key: '数据' } },
      { id: 'n_spec', kind: 'agent', title: '用前 20 行定口径', x: col(1), y: 80, config: { instruction: '用户要对这张表做：{{inputs.要做什么}}。只看前 20 行，给出处理口径。只用 ```csv 代码块输出一张表，列：新增列、含义、取值规则、示例。规则要具体到边界情况和拿不准时填什么。', tools: [], output: 'table', sample: 20 } },
      { id: 'n_confirm', kind: 'human', title: '确认口径', x: col(2), y: 80, config: { ask: '这是模型打算新增的列和规则。没问题就通过；要改就打回并写明。' } },
      { id: 'n_process', kind: 'agent', title: '按批处理', x: col(3), y: 80, config: { instruction: '按已确认的口径处理这一批数据：原样保留所有原有列，追加口径里的新增列，一行都不能少、顺序不能变。只用 ```csv 代码块输出。', tools: [], output: 'table', each: { rows: '{{inputs.每批行数}}', from: 'n_data' } } },
      { id: 'n_summary', kind: 'agent', title: '写汇总', x: col(4), y: 80, config: { instruction: '根据处理结果写一份汇总：每个新增列的分布（给数量和比例）、值得注意的异常或集中的问题、三条建议。引用具体的行举例。用 Markdown。', tools: [], output: 'text' } },
      { id: 'n_out_table', kind: 'export', title: '导出结果表', x: col(4), y: 220, config: { filename: '结果.csv' } },
      { id: 'n_out_summary', kind: 'export', title: '导出汇总', x: col(5), y: 80, config: { filename: '汇总.md' } },
    ],
    edges: [
      { from: 'n_data', to: 'n_spec' }, { from: 'n_spec', to: 'n_confirm' }, { from: 'n_data', to: 'n_process' }, { from: 'n_confirm', to: 'n_process' },
      { from: 'n_process', to: 'n_summary' }, { from: 'n_process', to: 'n_out_table' }, { from: 'n_summary', to: 'n_out_summary' },
    ],
  },
  {
    id: 'flo_preset_research',
    builtin: true,
    name: '调研报告',
    audience: '产品、投资、学生',
    description: '给一个课题和几个问题。模型拆搜索词、搜索、逐条打开网页抽证据，你核对证据表后成文，每个论断都带出处。',
    inputs: [
      { key: '课题', label: '课题', kind: 'text', required: true },
      { key: '问题', label: '要回答的问题', kind: 'longtext', required: true, hint: '一行一个，3 到 5 个' },
      { key: '时间范围', label: '资料时间范围', kind: 'select', options: ['近一个月', '近一年', '不限'], default: '近一年' },
    ],
    nodes: [
      { id: 'n_terms', kind: 'agent', title: '拆搜索词', x: col(0), y: 80, config: { instruction: '课题：{{inputs.课题}}。要回答的问题：\n{{inputs.问题}}\n给出 6 个搜索词，中英文都可以。只用 ```csv 代码块输出一张表，列：搜索词、想找什么。', tools: [], output: 'table' } },
      { id: 'n_search', kind: 'search', title: '搜索', x: col(1), y: 80, config: { queries: [], queriesFrom: '搜索词', limit: 6, recency: 'year' } },
      { id: 'n_evidence', kind: 'agent', title: '打开网页抽证据', x: col(2), y: 80, config: { instruction: '逐条打开这批搜索结果里的链接（用 web_fetch），抽取和这些问题有关的证据：\n{{inputs.问题}}\n只用 ```csv 代码块输出一张表，列：论点、证据原文、出处链接、日期、可信度。证据原文不超过 100 字且必须是网页里的原话；可信度只能填 高 / 中 / 低。打不开的链接跳过。', tools: ['web_fetch'], output: 'table', each: { rows: 5 } } },
      { id: 'n_check', kind: 'human', title: '核对证据表', x: col(3), y: 80, config: { ask: '勾选可信的证据，没勾的不会进报告。证据太少就打回，写一句要补什么方向。', pick: true } },
      { id: 'n_write', kind: 'agent', title: '成文', x: col(4), y: 80, config: { instruction: '只用保留下来的证据写调研报告《{{inputs.课题}}》。结构：一段结论；按问题逐个回答；不确定或证据不足之处；来源列表。每个论断后面用括号标出处链接，不许出现证据表里没有的事实。用 Markdown。', tools: [], output: 'text' } },
      { id: 'n_out_report', kind: 'export', title: '导出报告', x: col(5), y: 80, config: { filename: '报告.md' } },
      { id: 'n_out_sources', kind: 'export', title: '导出来源表', x: col(4), y: 220, config: { filename: '来源.csv' } },
    ],
    edges: [
      { from: 'n_terms', to: 'n_search' }, { from: 'n_search', to: 'n_evidence' }, { from: 'n_evidence', to: 'n_check' },
      { from: 'n_check', to: 'n_write' }, { from: 'n_write', to: 'n_out_report' }, { from: 'n_check', to: 'n_out_sources' },
    ],
  },
  {
    id: 'flo_preset_weekly',
    builtin: true,
    name: '周报 / 日报',
    audience: '任何要交报告的人',
    description: '把这周的流水账贴进来，模型写成周报，你提意见打回它就改，满意了导出。',
    inputs: [
      { key: '材料', label: '这周做了什么', kind: 'longtext', required: true, hint: '流水账就行，想到什么写什么' },
      { key: '读者', label: '给谁看', kind: 'text', default: '直属领导' },
      { key: '语气', label: '语气', kind: 'select', options: ['简洁', '正式', '轻松'], default: '简洁' },
      { key: '字数', label: '大概字数', kind: 'number', default: '400' },
    ],
    nodes: [
      { id: 'n_material', kind: 'input', title: '读取材料', x: col(0), y: 80, config: { key: '材料' } },
      { id: 'n_draft', kind: 'agent', title: '写周报', x: col(1), y: 80, config: { instruction: '把材料整理成给{{inputs.读者}}看的周报，语气{{inputs.语气}}，约 {{inputs.字数}} 字。结构：本周结果（先说成果和数据）、进行中、问题与需要的支持、下周计划。不编造材料里没有的事。用 Markdown。', tools: [], output: 'text' } },
      { id: 'n_review', kind: 'human', title: '看一眼', x: col(2), y: 80, config: { ask: '满意就通过；要改就打回并写意见，模型会按意见改。' } },
      { id: 'n_out', kind: 'export', title: '导出', x: col(3), y: 80, config: { filename: '周报.md' } },
    ],
    edges: [{ from: 'n_material', to: 'n_draft' }, { from: 'n_draft', to: 'n_review' }, { from: 'n_review', to: 'n_out' }],
  },
];

export function presetFlow(id: string): FlowDef | undefined {
  return FLOW_PRESETS.find((f) => f.id === id);
}
