/** CLI 命令目录元数据：commands 自发现与参数解析共用。 */

export interface ArgDef {
  name: string;
  kind: 'string' | 'flag' | 'enum';
  required?: boolean;
  /** 末尾位置参数可变长：超出固定位置参数后逐个追加（完整有序数组取 ParsedArgs.positional） */
  variadic?: boolean;
  description: string;
  enum?: string[];
}

export interface CommandDef {
  name: string;
  subcommand?: string;
  summary: string;
  args: ArgDef[];
}

/** 显式等待参数：open 与操作命令共用，CLI 端透传给 daemon。
 *  Phase D：open 并入 runAction 等待链路，同样开放这六个参数。 */
const COMMON_WAIT_ARGS: ArgDef[] = [
  { name: '--wait-api', kind: 'string', description: '显式等待请求 path（#n 取第 n 个 settle 的；多个 path 用逗号分隔，一次等齐）' },
  { name: '--wait-element', kind: 'string', description: '等待元素出现（target 解析同操作命令）' },
  { name: '--wait-gone', kind: 'string', description: '等待元素消失' },
  { name: '--wait-text', kind: 'string', description: '等待页面文本出现' },
  { name: '--wait-url', kind: 'string', description: '等待 URL 包含指定内容' },
  { name: '--wait-timeout-ms', kind: 'string', description: '显式完成预算（正整数 ms），需配合至少一个 --wait-* 条件' },
];

export function commandDefinitions(): CommandDef[] {
  return COMMAND_TABLE;
}

/** 操作命令公共参数：--wait-* / --creates / --dialog / --frame / --save-as / --value-template / --value-ref
 *  所有 page 操作命令复用，CLI 端透传给 daemon。 */
const COMMON_ACTION_ARGS: ArgDef[] = [
  ...COMMON_WAIT_ARGS,
  { name: '--creates', kind: 'string', description: '标注本动作创建实体：entity=path' },
  { name: '--dialog', kind: 'enum', enum: ['accept', 'dismiss'], description: '预登记 JS 弹窗处理（accept|dismiss）' },
  { name: '--prompt-text', kind: 'string', description: '--dialog 的 prompt 输入文本' },
  { name: '--frame', kind: 'string', description: '在指定 iframe 内操作（name/url_contains/selector）' },
  { name: '--save-as', kind: 'string', description: '把本步实际值存为变量' },
  { name: '--value-template', kind: 'string', description: '值由模板生成（${ts}/${rand6}/${random}/${date:YYYY-MM-DD}）' },
  { name: '--value-ref', kind: 'string', description: '值引用前序 capture 变量' },
  { name: '--group', kind: 'string', description: '步骤分组标签，报告按此折叠' },
];

const COMMAND_TABLE: CommandDef[] = [
  {
    name: 'commands',
    summary: '输出命令及参数定义（机器可读，供 Host LLM 自发现；最多两个位置参数按组/叶子过滤）',
    args: [
      { name: 'group', kind: 'string', description: '命令组名（如 page/assert）' },
      { name: 'subcommand', kind: 'string', description: '命令组内叶子名' },
      { name: '--json', kind: 'flag', description: '输出 JSON（当前唯一机器可读格式）' },
    ],
  },
  {
    name: 'session', subcommand: 'start',
    summary: '拉起本会话专属 daemon，返回 session_id',
    args: [
      { name: '--env', kind: 'string', description: '通用环境标签（默认 default；不选择 URL、商家、凭据或 CI）' },
      { name: '--auth', kind: 'enum', enum: ['auto', 'profile', 'imported'], description: '登录态来源（默认 auto：profile → imported）' },
      { name: '--browser', kind: 'enum', enum: ['auto', 'existing', 'chrome', 'managed'], description: '浏览器端点（默认 auto：profile 强制选 chrome；否则优先可达的现成 CDP）' },
      { name: '--acceptance', kind: 'string', description: '启动前校验并冻结验收说明 JSON 文件，后续只读取本次快照' },
    ],
  },
  {
    name: 'session', subcommand: 'stop',
    summary: '结束会话：写 session_end、销毁自己的 tab/context、退出 daemon',
    args: [{ name: '-s', kind: 'string', required: true, description: '会话 id' }],
  },
  {
    name: 'session', subcommand: 'list',
    summary: '列出全部会话及存活状态',
    args: [],
  },
  {
    name: 'page', subcommand: 'open',
    summary: '导航并等待稳定，返回页面摘要',
    args: [
      { name: '-s', kind: 'string', required: true, description: '会话 id' },
      { name: 'url', kind: 'string', required: true, description: '目标 URL' },
      { name: '--intent', kind: 'string', required: true, description: '本次导航意图（步骤名）' },
      { name: '--group', kind: 'string', description: '步骤分组标签，报告按此折叠' },
      { name: '--value-ref', kind: 'string', description: '值引用前序 capture 变量（daemon 侧渲染后覆盖 url 输入槽）' },
      ...COMMON_WAIT_ARGS,
    ],
  },
  {
    name: 'page', subcommand: 'state',
    summary: '返回当前页面快照（可交互元素带 [N] 索引 + role/name + tabs/frames/messages + 主文档 context）',
    args: [
      { name: '-s', kind: 'string', required: true, description: '会话 id' },
      { name: '--frame', kind: 'string', description: '查看指定 iframe 内快照（name/url_contains/selector；frame 内不发可操作 [N] 索引）' },
      { name: '--debug-ax', kind: 'flag', description: '输出 AX 树诊断信息（调试用）' },
    ],
  },
  {
    name: 'page', subcommand: 'read',
    summary: '读取页面数据（主文档 localStorage 指定 key 或全局标量，不做断言），返回 present/value + 主文档 context',
    args: [
      { name: '-s', kind: 'string', required: true, description: '会话 id' },
      { name: '--local-storage', kind: 'string', description: 'localStorage key（与 --global 互斥）' },
      { name: '--path', kind: 'string', description: 'JSON dot path（仅 --local-storage，如 record.mode / items.0.id，取标量叶子）' },
      { name: '--global', kind: 'string', description: '全局变量名（主世界自身标量属性，与 --local-storage 互斥）' },
      { name: '--frame', kind: 'string', description: '读取指定 iframe 的 storage/真实 default context（name/url_contains/selector）' },
      { name: '--group', kind: 'string', description: '步骤分组标签，报告按此折叠' },
    ],
  },
  {
    name: 'page', subcommand: 'inspect',
    summary: 'UI 异常诊断候选（只出证据，不生成业务 PASS）：text-artifacts/i18n/overflow/broken-images/error-exposure',
    args: [
      { name: '-s', kind: 'string', required: true, description: '会话 id' },
      { name: '--check', kind: 'enum', enum: ['text-artifacts', 'i18n', 'overflow', 'broken-images', 'error-exposure'], required: true, description: '诊断类型' },
      { name: '--within', kind: 'string', description: '限定诊断根元素（target 写法；必须唯一命中）' },
      { name: '--frame', kind: 'string', description: '在指定 iframe 内诊断（name/url_contains/selector）' },
      { name: '--group', kind: 'string', description: '诊断附录分组标签' },
    ],
  },
  {
    name: 'page', subcommand: 'console',
    summary: '读取当前 page 的完整安全 Console 日志（不清理缓冲区），含完整性状态',
    args: [
      { name: '-s', kind: 'string', required: true, description: '会话 id' },
      { name: '--frame', kind: 'string', description: '只返回指定 iframe 的日志' },
    ],
  },
  {
    name: 'page', subcommand: 'execute',
    summary: '在页面上下文中执行 JavaScript 表达式并返回结果',
    args: [
      { name: '-s', kind: 'string', required: true, description: '会话 id' },
      { name: 'expression', kind: 'string', required: true, description: 'JavaScript 表达式（结果需 JSON-serializable）' },
      { name: '--intent', kind: 'string', required: true, description: '本步骤意图（步骤名）' },
      { name: '--await-promise', kind: 'flag', description: '等待 Promise resolve（默认关闭，传 --await-promise 开启）' },
      { name: '--group', kind: 'string', description: '显式场景标签，脚本操作完整保留在执行时间线' },
    ],
  },
  {
    name: 'page', subcommand: 'click',
    summary: '点击元素：按 [N] 索引或 role+name 定位 → DOM 派发完整鼠标事件',
    args: [
      { name: '-s', kind: 'string', required: true, description: '会话 id' },
      { name: 'target', kind: 'string', required: true, description: '目标写法：[N] 索引 / css=选择器 / testid=data-testid / role=角色[:名称] / label=标签文本 / text=文本 / 裸字符串=无障碍名' },
      { name: '--clicks', kind: 'enum', enum: ['1', '2'], description: '鼠标点击次数（缺省 1；2 产生 clickCount=1+2 的真实双击）' },
      { name: '--intent', kind: 'string', required: true, description: '本步骤意图（步骤名）' },
      ...COMMON_ACTION_ARGS,
    ],
  },
  {
    name: 'page', subcommand: 'fill',
    summary: '填充表单字段：定位 → focus → 清空 → 写值（不逐字符）',
    args: [
      { name: '-s', kind: 'string', required: true, description: '会话 id' },
      { name: 'target', kind: 'string', required: true, description: '目标写法：[N] 索引 / css=选择器 / testid=data-testid / role=角色[:名称] / label=标签文本 / text=文本 / 裸字符串=无障碍名' },
      { name: 'value', kind: 'string', required: true, description: '填入值' },
      { name: '--intent', kind: 'string', required: true, description: '本步骤意图' },
      ...COMMON_ACTION_ARGS,
    ],
  },
  {
    name: 'page', subcommand: 'type',
    summary: '逐字符输入：定位 → focus → keydown/input/keyup 逐字符',
    args: [
      { name: '-s', kind: 'string', required: true, description: '会话 id' },
      { name: 'target', kind: 'string', required: true, description: '目标写法：[N] 索引 / css=选择器 / testid=data-testid / role=角色[:名称] / label=标签文本 / text=文本 / 裸字符串=无障碍名' },
      { name: 'value', kind: 'string', required: true, description: '输入文本' },
      { name: '--intent', kind: 'string', required: true, description: '本步骤意图' },
      ...COMMON_ACTION_ARGS,
    ],
  },
  {
    name: 'page', subcommand: 'press',
    summary: '按键：Enter/Tab/Escape/Backspace/ArrowDown/ArrowUp/ArrowLeft/ArrowRight/PageDown/PageUp/Home/End/Delete',
    args: [
      { name: '-s', kind: 'string', required: true, description: '会话 id' },
      { name: 'key', kind: 'string', required: true, description: '键名（Enter|Tab|Escape|Backspace|ArrowDown|ArrowUp|ArrowLeft|ArrowRight|PageDown|PageUp|Home|End|Delete）' },
      { name: '--intent', kind: 'string', required: true, description: '本步骤意图' },
      ...COMMON_ACTION_ARGS,
    ],
  },
  {
    name: 'page', subcommand: 'select',
    summary: '下拉选择：定位 select/combobox → 选 option',
    args: [
      { name: '-s', kind: 'string', required: true, description: '会话 id' },
      { name: 'target', kind: 'string', required: true, description: '字段写法（label 或 target）' },
      { name: 'option', kind: 'string', description: '选项文本（--value-ref/--value-template 提供时可省略；显式空串为合法空 label）' },
      { name: '--filter-text', kind: 'string', description: '可搜索控件的过滤文本（替换旧值，空串有效）' },
      { name: '--intent', kind: 'string', required: true, description: '本步骤意图' },
      ...COMMON_ACTION_ARGS,
    ],
  },
  {
    name: 'page', subcommand: 'upload',
    summary: '上传文件：定位 file input → DOM.setFileInputFiles',
    args: [
      { name: '-s', kind: 'string', required: true, description: '会话 id' },
      { name: 'target', kind: 'string', required: true, description: 'file input 目标写法' },
      { name: 'files', kind: 'string', variadic: true, description: '文件路径（可多个，CLI 端校验）' },
      { name: '--intent', kind: 'string', required: true, description: '本步骤意图' },
      ...COMMON_ACTION_ARGS,
    ],
  },
  {
    name: 'page', subcommand: 'hover',
    summary: '悬停元素：CDP 物理鼠标 mouseMoved（触发 isTrusted tooltip/菜单展开）',
    args: [
      { name: '-s', kind: 'string', required: true, description: '会话 id' },
      { name: 'target', kind: 'string', required: true, description: '目标写法：[N] 索引 / css=选择器 / testid=data-testid / role=角色[:名称] / label=标签文本 / text=文本 / 裸字符串=无障碍名' },
      { name: '--intent', kind: 'string', required: true, description: '本步骤意图' },
      ...COMMON_ACTION_ARGS,
    ],
  },
  {
    name: 'page', subcommand: 'scroll',
    summary: '滚动：--direction 按方向滚整页或 target 容器，无 direction 滚 target 到视口中心',
    args: [
      { name: '-s', kind: 'string', required: true, description: '会话 id' },
      { name: 'target', kind: 'string', description: '目标写法（省略则按 dir 滚整页）' },
      { name: '--direction', kind: 'enum', enum: ['up', 'down', 'left', 'right'], description: '滚动方向（整页或 target 容器按轴）' },
      { name: '--intent', kind: 'string', required: true, description: '本步骤意图' },
      ...COMMON_ACTION_ARGS,
    ],
  },
  {
    name: 'page', subcommand: 'screenshot',
    summary: '截图：整页或视口，输出 PNG 到 workspace/screenshots（观察步骤，不写 action trace）',
    args: [
      { name: '-s', kind: 'string', required: true, description: '会话 id' },
      { name: '--full-page', kind: 'flag', description: '截整页（含视口外内容）' },
      { name: '--intent', kind: 'string', required: true, description: '本步骤意图（步骤名）' },
      { name: '--group', kind: 'string', description: '步骤分组标签，标签确认的完成态截图优先进报告' },
    ],
  },
  {
    name: 'page', subcommand: 'switch-tab',
    summary: '切换真实 tab：按创建顺序索引或 URL 关键字选存活 ready 目标，切 CDP target/网络 active scope（不改浏览器前台）',
    args: [
      { name: '-s', kind: 'string', required: true, description: '会话 id' },
      { name: 'index', kind: 'string', description: '目标 tab 索引（page state tabs[] 的 index，按创建顺序）' },
      { name: '--url-contains', kind: 'string', description: 'URL 关键字匹配存活 tab' },
      { name: '--intent', kind: 'string', required: true, description: '本步骤意图' },
      // switch-tab 不走 runAction：排除 --wait-timeout-ms（不广告、不默接受）
      ...COMMON_ACTION_ARGS.filter((a) => a.name !== '--wait-timeout-ms'),
    ],
  },
  {
    name: 'page', subcommand: 'back',
    summary: '历史后退一步',
    args: [
      { name: '-s', kind: 'string', required: true, description: '会话 id' },
      { name: '--intent', kind: 'string', required: true, description: '本步骤意图' },
      ...COMMON_ACTION_ARGS,
    ],
  },
  {
    name: 'page', subcommand: 'refresh',
    summary: '刷新页面（Page.reload）',
    args: [
      { name: '-s', kind: 'string', required: true, description: '会话 id' },
      { name: '--intent', kind: 'string', required: true, description: '本步骤意图' },
      ...COMMON_ACTION_ARGS,
    ],
  },
  {
    name: 'page', subcommand: 'choose',
    summary: '多选 combobox/listbox：展开 → 选多个 option',
    args: [
      { name: '-s', kind: 'string', required: true, description: '会话 id' },
      { name: 'target', kind: 'string', required: true, description: '字段写法' },
      { name: 'options', kind: 'string', variadic: true, description: '选项文本（逐个空格分隔可多个，显式空串为合法空 label）' },
      { name: '--filter-text', kind: 'string', description: '可搜索控件的过滤文本（替换旧值，空串有效）' },
      { name: '--intent', kind: 'string', required: true, description: '本步骤意图' },
      ...COMMON_ACTION_ARGS,
    ],
  },
  {
    name: 'page', subcommand: 'category',
    summary: '多级类目：逐级展开 → 选末级（如 生鲜 蔬菜 叶菜）',
    args: [
      { name: '-s', kind: 'string', required: true, description: '会话 id' },
      { name: 'target', kind: 'string', required: true, description: '类目控件写法' },
      { name: 'path', kind: 'string', variadic: true, description: '类目路径逐级文本（逐个空格分隔可多个）' },
      { name: '--intent', kind: 'string', required: true, description: '本步骤意图' },
      ...COMMON_ACTION_ARGS,
    ],
  },
  {
    name: 'page', subcommand: 'fill-form',
    summary: '批量表单填充：按 scope 过滤必填 → 逐字段 fill',
    args: [
      { name: '-s', kind: 'string', required: true, description: '会话 id' },
      { name: '--scope', kind: 'enum', enum: ['required', 'all', 'targeted'], description: '填充范围（默认 required）' },
      { name: '--field', kind: 'string', description: '指定字段 名称=值（可多个）' },
      { name: '--skip', kind: 'string', description: '跳过字段名（可多个）' },
      { name: '--intent', kind: 'string', required: true, description: '本步骤意图' },
      ...COMMON_ACTION_ARGS,
    ],
  },
  {
    name: 'setup',
    summary: '首次安装：准备 workspace 目录 + 探测 Chrome/CDP（Skill 独立安装）',
    args: [],
  },
  {
    name: 'auth', subcommand: 'import',
    summary: '从文件/stdin 导入 storageState/cookie，或复制 macOS Chrome 完整 profile 并以 --url 验证后安装',
    args: [
      { name: 'file', kind: 'string', description: '输入文件路径（省略则读 stdin）' },
      { name: '--domain', kind: 'string', description: '文件/stdin 裸 cookie 头模式的作用域（单一 DNS host，可带前导点）' },
      { name: '--chrome', kind: 'flag', description: '复制 macOS 系统 Chrome 完整 profile（与 file 互斥，需 --url）' },
      { name: '--profile', kind: 'string', description: 'Chrome profile 目录名（仅 --chrome 模式）' },
      { name: '--url', kind: 'string', description: 'Chrome profile 验证 URL（仅 --chrome 模式，http(s)）' },
    ],
  },
  {
    name: 'auth', subcommand: 'login',
    summary: '有头打开专用 profile，导航 --url 并轮询到达（完成 URL 条件，不保证业务已登录）',
    args: [
      { name: '--url', kind: 'string', required: true, description: '登录后应到达的 http(s) URL（必填，无业务默认）' },
    ],
  },
  {
    name: 'auth', subcommand: 'export',
    summary: '从本地专用 profile 导出 --domain 作用域内 cookie 到 storageState 文件（--out/--domain 必填）',
    args: [
      { name: '--out', kind: 'string', required: true, description: '输出 storageState 文件路径（权限 0600）' },
      { name: '--domain', kind: 'string', required: true, description: '导出作用域（单一 DNS host，可带前导点表示域 cookie）' },
    ],
  },
  {
    name: 'auth', subcommand: 'status',
    summary: '探测现成端点并静态查看登录态，预判 auto 组合（不启动浏览器、不注入 cookie）',
    args: [],
  },
  {
    name: 'doctor',
    summary: '只读探测现成端点与登录态前提（不启动浏览器、不创建 context）',
    args: [],
  },
  // ── 阶段 2.4：assert / capture / mock / report ──
  {
    name: 'assert', subcommand: 'api',
    summary: '断言请求响应 body 或响应头：--expect/--header 恰好一个；body 引用模式 "<json-path> <op>" + 恰好一个来源 flag',
    args: [
      { name: '-s', kind: 'string', required: true, description: '会话 id' },
      { name: 'req', kind: 'string', required: true, description: '请求引用：r9 或 <path>[@<nav>][#<n>]' },
      { name: '--expect', kind: 'string', description: '断言响应体："<json-path> <op> <value>"，op: == != exists contains > <（与 --header 恰好一个）' },
      { name: '--header', kind: 'string', description: '断言响应头："<header-name> <op> <value>"（大小写不敏感；与 --expect 恰好一个）' },
      { name: '--value-ref', kind: 'string', description: '期望来源：会话变量名（与 literal/--value-from-action 互斥，恰好选一）' },
      { name: '--value-from-action', kind: 'string', description: '期望来源：已完成输入动作 id（open/type/fill/select/date，与 literal/--value-ref 互斥）' },
      { name: '--group', kind: 'string', description: '步骤分组标签，报告按此折叠' },
    ],
  },
  {
    name: 'assert', subcommand: 'request',
    summary: '断言请求 body 或 query：--body/--query 恰好一个；引用模式 "<path> <op>" + 恰好一个来源 flag',
    args: [
      { name: '-s', kind: 'string', required: true, description: '会话 id' },
      { name: 'req', kind: 'string', required: true, description: '请求引用' },
      { name: '--body', kind: 'string', description: '断言请求体："<json-path> <op> <value>"（与 --query 恰好一个）' },
      { name: '--query', kind: 'string', description: '断言 URL query："<完整键名> <op> <value>"（不解析 JSON 路径；与 --body 恰好一个）' },
      { name: '--value-ref', kind: 'string', description: '期望来源：会话变量名（与 literal/--value-from-action 互斥，恰好选一）' },
      { name: '--value-from-action', kind: 'string', description: '期望来源：已完成输入动作 id（open/type/fill/select/date，与 literal/--value-ref 互斥）' },
      { name: '--group', kind: 'string', description: '步骤分组标签，报告按此折叠' },
    ],
  },
  {
    name: 'assert', subcommand: 'toast',
    summary: '断言页面提示（toast/校验错误）包含 text',
    args: [
      { name: '-s', kind: 'string', required: true, description: '会话 id' },
      { name: 'text', kind: 'string', required: true, description: '期望包含的文本' },
      { name: '--group', kind: 'string', description: '步骤分组标签，报告按此折叠' },
    ],
  },
  {
    name: 'assert', subcommand: 'text',
    summary: '断言页面可见文本包含期望值，可限定 --within 范围；值来源三选一：literal(contains) / --value-ref / --value-from-action',
    args: [
      { name: '-s', kind: 'string', required: true, description: '会话 id' },
      { name: 'contains', kind: 'string', required: false, description: '期望包含的文本（literal）；与 --value-ref / --value-from-action 三选一' },
      { name: '--within', kind: 'string', description: '限定范围（target 写法）' },
      { name: '--frame', kind: 'string', description: '在指定 iframe 内断言（name/url_contains/selector）' },
      { name: '--value-ref', kind: 'string', description: '期望值来源：引用 save_as 变量名' },
      { name: '--value-from-action', kind: 'string', description: '期望值来源：引用前序动作 id' },
      { name: '--group', kind: 'string', description: '步骤分组标签，报告按此折叠' },
    ],
  },
  {
    name: 'assert', subcommand: 'visible',
    summary: '断言 target 可见',
    args: [
      { name: '-s', kind: 'string', required: true, description: '会话 id' },
      { name: 'target', kind: 'string', required: true, description: '目标写法：[N] 索引 / css=选择器 / testid=data-testid / role=角色[:名称] / label=标签文本 / text=文本 / 裸字符串=无障碍名' },
      { name: '--frame', kind: 'string', description: '在指定 iframe 内断言（[N] 不支持）' },
      { name: '--group', kind: 'string', description: '步骤分组标签，报告按此折叠' },
    ],
  },
  {
    name: 'assert', subcommand: 'absent',
    summary: '断言 target 不可见',
    args: [
      { name: '-s', kind: 'string', required: true, description: '会话 id' },
      { name: 'target', kind: 'string', required: true, description: '目标写法：[N] 索引 / css=选择器 / testid=data-testid / role=角色[:名称] / label=标签文本 / text=文本 / 裸字符串=无障碍名' },
      { name: '--frame', kind: 'string', description: '在指定 iframe 内断言（[N] 不支持）' },
      { name: '--group', kind: 'string', description: '步骤分组标签，报告按此折叠' },
    ],
  },
  {
    name: 'assert', subcommand: 'table-row',
    summary: '断言表格有包含 contains 的行，可校验 --count 行数',
    args: [
      { name: '-s', kind: 'string', required: true, description: '会话 id' },
      { name: 'contains', kind: 'string', required: true, description: '行内期望包含的文本' },
      { name: '--count', kind: 'string', description: '期望匹配行数（默认只判有无）' },
      { name: '--frame', kind: 'string', description: '在指定 iframe 内断言（name/url_contains/selector）' },
      { name: '--group', kind: 'string', description: '步骤分组标签，报告按此折叠' },
    ],
  },
  {
    name: 'assert', subcommand: 'field',
    summary: '按 label 找唯一字段，当前值严格等于期望值（值位置参数或恰好一个来源 flag）',
    args: [
      { name: '-s', kind: 'string', required: true, description: '会话 id' },
      { name: 'label', kind: 'string', required: true, description: '字段 label' },
      { name: 'value', kind: 'string', description: '期望值（严格相等；与 --value-ref/--value-from-action 互斥，恰好选一个；允许空串）' },
      { name: '--value-ref', kind: 'string', description: '期望来源：会话变量名（与 value/--value-from-action 互斥，恰好选一）' },
      { name: '--value-from-action', kind: 'string', description: '期望来源：已完成输入动作 id（open/type/fill/select/date，与 value/--value-ref 互斥）' },
      { name: '--frame', kind: 'string', description: '在指定 iframe 内断言（name/url_contains/selector）' },
      { name: '--group', kind: 'string', description: '步骤分组标签，报告按此折叠' },
    ],
  },
  {
    name: 'assert', subcommand: 'url',
    summary: '断言当前 URL 包含 contains',
    args: [
      { name: '-s', kind: 'string', required: true, description: '会话 id' },
      { name: 'contains', kind: 'string', required: true, description: 'URL 期望包含的文本' },
      { name: '--group', kind: 'string', description: '步骤分组标签，报告按此折叠' },
    ],
  },
  {
    name: 'assert', subcommand: 'style',
    summary: '断言计算样式：默认唯一目标，--all 才逐个核对；支持伪元素',
    args: [
      { name: '-s', kind: 'string', required: true, description: '会话 id' },
      { name: 'target', kind: 'string', required: true, description: '目标写法：css=/role=角色[:名称]/label=/text=/裸名称' },
      { name: '--property', kind: 'string', required: true, description: 'CSS 属性名（如 display/color）' },
      { name: '--equals', kind: 'string', required: true, description: '计算样式期望值（空串合法）' },
      { name: '--pseudo', kind: 'enum', enum: ['before', 'after'], description: '伪元素 before|after' },
      { name: '--all', kind: 'flag', description: '全部匹配逐个核对（默认要求唯一目标）' },
      { name: '--frame', kind: 'string', description: '在指定 iframe 内断言' },
      { name: '--group', kind: 'string', description: '步骤分组标签，报告按此折叠' },
    ],
  },
  {
    name: 'assert', subcommand: 'element',
    summary: '断言标准 DOM 属性或 count：count 可为 0，其余属性零匹配不通过',
    args: [
      { name: '-s', kind: 'string', required: true, description: '会话 id' },
      { name: 'target', kind: 'string', required: true, description: '目标写法：css=/role=角色[:名称]/label=/text=/裸名称' },
      { name: '--property', kind: 'string', required: true, description: '标准属性：count/text/rect.*/scroll*/client*/image.*/overflowX' },
      { name: '--expect', kind: 'string', required: true, description: '"<op> <value>"，op: == != exists contains > <' },
      { name: '--all', kind: 'flag', description: '全部匹配逐个核对' },
      { name: '--frame', kind: 'string', description: '在指定 iframe 内断言' },
      { name: '--group', kind: 'string', description: '步骤分组标签，报告按此折叠' },
    ],
  },
  {
    name: 'assert', subcommand: 'console',
    summary: '断言 Console：--no-error；或 --level + --contains [--count]；--scope 默认 session',
    args: [
      { name: '-s', kind: 'string', required: true, description: '会话 id' },
      { name: '--no-error', kind: 'flag', description: '无 error 日志（console.assert 失败计 error）' },
      { name: '--level', kind: 'enum', enum: ['log', 'debug', 'info', 'warning', 'error', 'trace'], description: '级别匹配模式' },
      { name: '--contains', kind: 'string', description: '文本包含（--level 模式必填）' },
      { name: '--count', kind: 'string', description: '期望匹配条数（默认 1）' },
      { name: '--scope', kind: 'enum', enum: ['session', 'action'], description: '范围：session 默认，action 显式收窄' },
      { name: '--frame', kind: 'string', description: '只检查指定 iframe 的日志' },
      { name: '--group', kind: 'string', description: '步骤分组标签，报告按此折叠' },
    ],
  },
  {
    name: 'assert', subcommand: 'data',
    summary: '断言页面数据（localStorage key 或全局标量）严格等于 JSON 标量；缺失≠null、数字字符串≠数字',
    args: [
      { name: '-s', kind: 'string', required: true, description: '会话 id' },
      { name: '--local-storage', kind: 'string', description: 'localStorage key（与 --global 互斥）' },
      { name: '--path', kind: 'string', description: 'JSON dot path（仅 --local-storage，如 record.mode / items.0.id，取标量叶子）' },
      { name: '--global', kind: 'string', description: '全局变量名（真实 default world 自身标量属性，与 --local-storage 互斥）' },
      { name: '--equals', kind: 'string', required: true, description: '期望 JSON 标量（字符串/数字/boolean/null；空串允许；按 JSON 解析一次）' },
      { name: '--frame', kind: 'string', description: '在指定 iframe 内断言（name/url_contains/selector）' },
      { name: '--group', kind: 'string', description: '步骤分组标签，报告按此折叠' },
    ],
  },
  {
    name: 'capture', subcommand: 'api',
    summary: '从请求响应 body 用 JSON path 取值存变量',
    args: [
      { name: '-s', kind: 'string', required: true, description: '会话 id' },
      { name: 'req', kind: 'string', required: true, description: '请求引用' },
      { name: 'path', kind: 'string', required: true, description: 'JSON path（如 data.itemId 或 data.items[0].id）' },
      { name: '--as', kind: 'string', required: true, description: '变量名' },
      { name: '--group', kind: 'string', description: '步骤分组标签，报告按此折叠' },
    ],
  },
  {
    name: 'capture', subcommand: 'element',
    summary: '从页面元素取值存变量',
    args: [
      { name: '-s', kind: 'string', required: true, description: '会话 id' },
      { name: 'target', kind: 'string', required: true, description: '目标写法：[N] 索引 / css=选择器 / testid=data-testid / role=角色[:名称] / label=标签文本 / text=文本 / 裸字符串=无障碍名' },
      { name: '--as', kind: 'string', required: true, description: '变量名' },
      { name: '--frame', kind: 'string', description: '在指定 iframe 内取值（[N] 不支持）' },
      { name: '--group', kind: 'string', description: '步骤分组标签，报告按此折叠' },
    ],
  },
  {
    name: 'mock', subcommand: 'add',
    summary: '注册拦截：匹配 path 的请求返回伪造响应（用过 mock 即不可落库）',
    args: [
      { name: '-s', kind: 'string', required: true, description: '会话 id' },
      { name: 'path', kind: 'string', required: true, description: '请求 path（pathname）' },
      { name: '--call-index', kind: 'string', description: '只拦第 n 次（默认每次都拦）' },
      { name: '--status', kind: 'string', description: '响应状态码（默认 200）' },
      { name: '--body-file', kind: 'string', required: true, description: '伪造响应 body 文件路径' },
      { name: '--content-type', kind: 'string', description: '响应 Content-Type（默认 application/json）' },
    ],
  },
  {
    name: 'mock', subcommand: 'clear',
    summary: '清除 mock 拦截规则（不传 path 清全部）',
    args: [
      { name: '-s', kind: 'string', required: true, description: '会话 id' },
      { name: 'path', kind: 'string', description: '只清该 path 的规则（省略清全部）' },
    ],
  },
  {
    name: 'report',
    summary: '从 trace 生成会话报告（JSON 结论 + HTML）',
    args: [
      { name: '-s', kind: 'string', required: true, description: '会话 id' },
      { name: '--title', kind: 'string', description: '报告标题（默认 “E2E 会话报告 <sid>”）' },
      { name: '--summary', kind: 'string', description: '一句话结论（LLM 写），CLI 在旁边强制附断言统计' },
      { name: '--findings', kind: 'string', description: '发现列表，分号分隔（发现1;发现2;...）' },
      { name: '--plan', kind: 'string', description: '预期业务 group 名称数组（JSON 文件路径），按验收顺序排列；缺失/无断言 group 补 BLOCKED，重复/空拒绝' },
      { name: '--step-titles', kind: 'string', description: 'group → 业务标题映射（JSON 文件路径）；只改显示 action，不改 group/判定/计划覆盖' },
      { name: '--open', kind: 'flag', description: '生成后用系统默认浏览器打开 HTML' },
    ],
  },
  {
    name: 'report', subcommand: 'merge',
    summary: '只读汇总指定会话的原生报告与最终 trace；保留各来源终态和覆盖边界',
    args: [
      { name: 'sid', kind: 'string', required: true, variadic: true, description: '原生报告会话 id（按输入顺序，可多个，不重复）' },
      { name: '--title', kind: 'string', description: '汇总报告标题' },
      { name: '--open', kind: 'flag', description: '生成后用系统默认浏览器打开 HTML' },
    ],
  },
  {
    name: 'ir', subcommand: 'build',
    summary: 'trace → 候选 IR v2，输出提炼结果（保留/删除/不可映射动作）供 Host 确认',
    args: [
      { name: '-s', kind: 'string', required: true, description: '会话 id' },
      { name: '--name', kind: 'string', description: '用例名（默认 case-<session>）' },
    ],
  },
  {
    name: 'ir', subcommand: 'check',
    summary: '对 IR 跑 schema + refine 等校验（可选 --trace 跑动态道）',
    args: [
      { name: 'ir-file', kind: 'string', required: true, description: 'IR JSON 文件路径' },
      { name: '--trace', kind: 'string', description: '关联会话 id（跑请求引用/wait 一致性动态道）' },
    ],
  },
  {
    name: 'judge',
    summary: '技术证据可执行性判据，返回 {regressible, reasons[]}',
    args: [
      { name: 'ir-file', kind: 'string', required: true, description: 'IR JSON 文件路径' },
    ],
  },
  {
    name: 'case', subcommand: 'list',
    summary: '扫描个人用例库，返回合法用例与坏条目；不运行浏览器',
    args: [],
  },
  {
    name: 'case', subcommand: 'run',
    summary: '执行个人用例库中已保存的 .test.ts 原字节，并生成本次回放报告',
    args: [
      { name: 'name', kind: 'string', required: true, description: '用例名' },
      { name: '--output', kind: 'string', description: '私有运行目录父路径（必须在 workspace/verify 内）' },
      { name: '--auth', kind: 'enum', enum: ['auto', 'profile', 'imported'], description: '本次回放登录态（默认 auto：有效 state → imported，否则 profile → imported）' },
      { name: '--browser', kind: 'enum', enum: ['auto', 'existing', 'chrome', 'managed'], description: '本次回放浏览器（默认 auto）' },
      { name: '--auth-state', kind: 'string', description: '本次显式标准 storageState；不能与 profile/chrome 混用' },
      { name: '--acceptance', kind: 'string', description: '本次验收说明 JSON 文件，执行前校验并冻结' },
    ],
  },
  {
    name: 'render',
    summary: 'IR v2 静态校验 → 当前编译器重生成 .test.ts；不读 trace、不执行回放',
    args: [
      { name: 'ir-file', kind: 'string', required: true, description: 'IR v2 JSON 文件路径' },
      { name: '--output', kind: 'string', description: '输出目录（默认 ~/.e2et/workspace/render）' },
    ],
  },
  {
    name: 'verify',
    summary: 'ir check + judge + render + 本地 Playwright 跑编译产物（--skip-test 跳过最后一步）',
    args: [
      { name: 'ir-file', kind: 'string', required: true, description: 'IR v2 JSON 文件路径' },
      { name: '--output', kind: 'string', description: '私有运行目录父路径（必须在 workspace/verify 内）' },
      { name: '--auth', kind: 'enum', enum: ['auto', 'profile', 'imported'], description: '本次回放登录态（默认 auto：有效 state → imported，否则 profile → imported）' },
      { name: '--browser', kind: 'enum', enum: ['auto', 'existing', 'chrome', 'managed'], description: '本次回放浏览器（默认 auto）' },
      { name: '--auth-state', kind: 'string', description: '本次显式标准 storageState；不能与 profile/chrome 混用' },
      { name: '--skip-test', kind: 'flag', description: '跳过 Playwright 执行，只跑 check+judge+render' },
      { name: '--acceptance', kind: 'string', description: '本次验收说明 JSON 文件，执行前校验并冻结' },
    ],
  },
  {
    name: 'land',
    summary: '完整 trace 门禁 + Playwright 回放 → 原子落库到 ~/.e2et/library/<name>',
    args: [
      { name: 'ir-file', kind: 'string', required: true, description: 'IR v2 JSON 文件路径' },
      { name: '--output', kind: 'string', description: '私有运行目录父路径（必须在 workspace/verify 内）' },
      { name: '--auth', kind: 'enum', enum: ['auto', 'profile', 'imported'], description: '本次回放登录态（默认 auto：有效 state → imported，否则 profile → imported）' },
      { name: '--browser', kind: 'enum', enum: ['auto', 'existing', 'chrome', 'managed'], description: '本次回放浏览器（默认 auto）' },
      { name: '--auth-state', kind: 'string', description: '本次显式标准 storageState；不能与 profile/chrome 混用' },
      { name: '--force', kind: 'flag', description: '目标文件已存在时覆盖（默认拒绝）' },
      { name: '--acceptance', kind: 'string', description: '本次验收说明 JSON 文件，执行前校验并冻结' },
    ],
  },
];

for (const command of COMMAND_TABLE) {
  if (command.name === 'assert') command.args.push({ name: '--check-id', kind: 'string', description: '绑定当前冻结验收说明内、属于本次有效 group 的检查 ID' });
}
