# UI 与交互检查

本文件维护 UI/交互证据。断言与报告门禁见 [acceptance.md](acceptance.md)，页面动作见 [operations.md](operations.md)。UI 检查不能替代业务断言；断言也不能自动证明 UI 无异常。

## 1. 正式证据

| 证据 | CLI | 能证明什么 |
|---|---|---|
| 页面快照 | `page state [--frame]` | 可交互元素、角色/名称、tabs/frames、frame 内结构 |
| 页面数据 | `page read` + `assert data` | localStorage/全局标量严格等于 |
| 文本/字段/表格 | `assert text/field/table-row` | 可见文本、字段值、行内容与行数 |
| 可见性/提示 | `assert visible/absent/toast` | 目标可见性、提示/校验文案 |
| URL | `assert url` | 当前 URL 包含指定片段 |
| 计算样式 | `assert style` | 目标或伪元素的计算样式严格等于 |
| DOM 属性/几何 | `assert element` | count、text、rect、scroll/client、image、overflowX 等标准事实 |
| Console | `page console` + `assert console` | 安全日志、完整性状态、无 error 或指定级别/文本 |
| UI 诊断 | `page inspect` | text-artifacts/i18n/overflow/broken-images/error-exposure 候选 |
| 截图 | `page screenshot [--full-page] --group` | 断言后完成态视觉证据；截图本身不是 PASS |
| 交互 | `page hover/click(--clicks 1|2)/type/press/select/choose/category`；日期文本框用 `page fill` | 真实动作及其页面/网络结果 |

每个关键业务步骤至少一条真实 assert；截图只作为完成态证据，capture-only 不是 PASS。样式、元素、console、frame 检查必须各自有正式断言，不能互相替代。

## 2. 样式与元素

```bash
e2et assert style -s '<sid>' '<target>' --property '<css>' --equals '<期望计算值>' --group '<group>'
e2et assert style -s '<sid>' '<target>' --property '<css>' --equals '<期望计算值>' --all --group '<group>'
e2et assert style -s '<sid>' '<target>' --property '<css>' --equals '<期望计算值>' --pseudo before --group '<group>'
e2et assert element -s '<sid>' '<target>' --property count --expect '== 0' --group '<group>'
```

- `assert style` 默认要求目标唯一；`--all` 才逐个核对全部命中，任一项不符即 FAIL。
- 伪元素 `before`/`after` 各用独立 `--pseudo` 断言；不能拿宿主元素样式代替。
- 目标零匹配不通过；CSS bundle 规则文本、选择器计数或“页面看起来变了”都不是计算样式证据。
- `assert element` 的 `count` 允许为 0；`text/rect.*/scroll*/client*/image.*/overflowX` 零匹配不通过。`--all` 检查每个命中节点。
- 布局/换行除计算值外还要有机改动区域截图；计算值正确但仍有溢出/错位同样 FAIL。

## 3. UI 异常诊断

```bash
e2et page inspect -s '<sid>' --check text-artifacts --group '<group>'
e2et page inspect -s '<sid>' --check i18n --within '<target>' --group '<group>'
e2et page inspect -s '<sid>' --check overflow --frame '<frame>' --group '<group>'
e2et page inspect -s '<sid>' --check broken-images --group '<group>'
e2et page inspect -s '<sid>' --check error-exposure --group '<group>'
```

| 检查 | 典型现象 |
|---|---|
| `text-artifacts` | `undefined` / `null` / `NaN` / `[object Object]` |
| `i18n` | i18n key 残留、占位未替换 |
| `overflow` | 横向溢出、容器越界 |
| `broken-images` | 图片/图标裂开或 404 |
| `error-exposure` | 原始 JSON/堆栈/错误码直接外露 |

- `page inspect` 只出诊断候选，不生成业务 PASS；候选必须用目标明确的正式 assert 确认。
- `--within` 必须唯一命中；`--frame` 只诊断指定 iframe。候选无法落到可断言目标时保留证据并 `BLOCKED`。
- 扫描/怀疑不等于 FAIL；影响使用的真实异常必须有正式断言或 console/网络证据。找不到证据就写“未查清”，不编原因。

## 4. Console

```bash
e2et page console -s '<sid>'
e2et page console -s '<sid>' --frame '<frame>'
e2et assert console -s '<sid>' --no-error --group '<group>'
e2et assert console -s '<sid>' --level error --contains '<文本>' --count '<n>' --group '<group>'
e2et assert console -s '<sid>' --level warning --contains '<文本>' --scope action --group '<group>'
```

- `assert console` 默认 `--scope session`；只有明确要收窄到某次动作时用 `--scope action`，并在证据里写清动作边界。
- warning 必须保留并记录；第三方埋点/deprecation 噪音可以标注为噪音，但不能据此抹掉 warning 事实。
- `console.assert` 失败计 error；`--no-error` 不能通过存在 error 的会话。
- 日志未订阅、缓冲区截断、frame 归属未知或完整性状态不完整时，`--no-error` 不能判 PASS；保留原始状态并 `BLOCKED`。
- Console 断言不能替代业务 assert；它只证明日志条件，不证明业务结果。

## 5. frame

- frame 内 DOM/文本/字段/可见性/样式/元素/console 都必须用独立动作显式 `--frame '<name|url_contains|selector>'`。
- 先 `page state --frame` 确认结构；frame 内没有 `[N]` 索引，只用 css/role/label/text 等显式 target。
- 页面含 iframe 且主文档无请求/无 DOM 变化/无 console 报错时，必须查 frame 证据再下结论；未查 frame 不得判“死按钮/前端 bug”。
- frame 不可读、定位不唯一或证据缺失时保留诊断并 `BLOCKED`，不拿外层 DOM 替代。

## 6. 交互验收

- 用户/上游给出的交互预期优先，逐条转成可验证步骤；实际响应不符时写预期 vs 实际。
- 用户未给时，至少有可观察响应：点击 → 请求/DOM 变化/状态变化之一；hover → 浮层或样式反馈；输入 → 校验或联想反馈。
- tooltip/hover：`page hover` 后浮层保持，随后用 `assert text/visible` 或截图取证；浮层通常在 portal，不要只看触发元素内部。
- 死按钮：先看真实请求、state 变化、console；三项都静默且页面含 iframe 时必须查 frame。仍无证据时写“未查清”并 `BLOCKED`。
- 表单校验：无效输入后用 `page type`/`page press Tab` 触发 blur/校验，再用 `assert toast/text/visible/absent` 核反馈；不要假定 `fill` 触发了受控组件 onChange。
- 下拉/浮层：选择后重新取 state 或断言实际选中值；不要拿“菜单看起来打开”冒充选中。
- 动画延迟：先等待浮层/元素真实出现，再断言；wait 超时先核 target/状态，不盲重试。
- hover 后立即断言/截图，观察期间浮层保持；后续操作由 CLI 管理生命周期，失败保留原始证据。
- 重复提交/loading 不消失：用 `assert visible/absent/element` + console/网络证据判断，不凭截图猜。

## 7. 截图与完成态

- 关键步骤在全部正式断言之后截图，且截图必须是该 group 最后一条证据：`e2et page screenshot -s '<sid>' --intent '核对完成态' --group '<group>'`；需要整页时加 `--full-page`。`assert console`、`page inspect` 的正式确认和网络断言都不能排在截图后。
- 截图必须属于本会话/本 group；报告优先使用断言后的完成态截图，自动动作截图不能替代。
- 截图空白/旧内容通常表示页面尚未稳定或仍在旧构建；先等真实内容/重新导航，仍加载旧产物时保留证据，不把旧页面结果当复验通过。超长页面可分段截图并注明“分段截取”。

## 8. 不绕过、不自动修

- 不用直接 fetch、eval 改状态、手工造 DOM 冒充真实 UI 路径；旁路只能诊断，必须标注“绕过 UI”，不能算 PASS/落库。
- 验证阶段不自动改代码、不静默修复、不对旧部署假复验。修复必须是用户另行授权的独立任务；修复后重新部署/重新验证。
- 失败只由真实 assert/动作结果判定；`--findings` 只记录发现，不是 FAIL 来源，也不能把 FAIL 改写成 PASS。
- 不拼接其他报告模板或自有字段；用原生 step 的 action/observation/screenshot 与正式 assert 表达证据。
