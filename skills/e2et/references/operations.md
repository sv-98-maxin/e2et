# 页面操作与动态值

本文件是页面动作、target、等待、表单和动态值的唯一操作手册。身份/浏览器见 [setup-auth.md](setup-auth.md)，断言/证据见 [acceptance.md](acceptance.md)，UI 检查见 [ui-check.md](ui-check.md)。

## 1. 动作与观测

```bash
e2et page open -s '<sid>' '<url>' --intent '<意图>' --group '<group>'
e2et page state -s '<sid>'
e2et page state -s '<sid>' --frame '<name|url_contains|selector>'
e2et page read -s '<sid>' --local-storage '<key>' [--path '<dot-path>']
e2et page read -s '<sid>' --global '<全局标量>'
e2et page read -s '<sid>' --local-storage '<key>' --frame '<frame>'
```

- `page state` 是 DOM/ARIA 事实来源；页面刷新、弹窗、跳转或 DOM 变化后必须重新取 state，旧 `[N]` 索引立即作废。
- `page open` 或动作返回的 `elements` 只是该次响应摘要，不是可直接复用的 page state 索引；用 `[N]` 前先显式 `page state`，优先当前 role/name/label 语义目标。
- frame 内快照必须显式 `--frame`；frame 内不发可操作 `[N]` 索引，继续用 `css=`、`role=`、`label=`、`text=` 或裸名称定位。`frame[N]` 索引不支持。
- `page read` 只读取 localStorage / 全局标量，不修改、不断言；需要断言时用 `assert data`。
- `page execute` 只允许独立侦察会话诊断；它不是 Source 可映射动作，不能进 IR，不能作为 PASS 证据，不能靠删 trace 规避 `UNMAPPED_ACTIONS`。常规验收优先 `page read` / `capture` / 正式 assert。

## 2. target 语法

target 是位置参数，不是 `--target`：

| 写法 | 含义 |
|---|---|
| `[N]` | 最新主文档 `page state` 的索引；frame 内不可用 |
| `css=选择器` | CSS 选择器，必须带 `css=` |
| `testid=值` | 转成 `[data-testid="..."]` |
| `role=角色[:名称]` | 标准 ARIA role + accessible name；歧义拒绝 |
| `label=标签文本` | accessible name 匹配 |
| `text=文本` | 可见文本匹配 |
| 裸字符串 | accessible name 匹配 |

优先 role/name/label/text；用户显式给 CSS selector 时按输入使用。不根据组件库类名、私有 DOM 或框架内部状态分支，不为组件库维护 adapter。target 歧义、语义缺失或动作失败时保留诊断并报错，不猜另一个目标。

## 3. 等待

等待参数附加在对应动作上，不额外插 sleep：

| 参数 | 等什么 | 典型场景 |
|---|---|---|
| `--wait-api <path>` | 指定请求 settle | 查询、提交、重新取配置 |
| `--wait-element <target>` | 元素出现 | 弹窗、真实表单、展开后的字段 |
| `--wait-gone <target>` | 元素消失 | loading/骨架屏/遮罩 |
| `--wait-text <text>` | 页面文本出现 | 成功提示、校验反馈 |
| `--wait-url <url>` | URL 包含指定内容 | 同 tab 跳转 |
| `--wait-timeout-ms <n>` | 显式完成预算 | 需配合至少一个 `--wait-*` |

每个动作自带 DOM settle；只有已核实现场目标时才加显式等待。禁止用 `page execute` + `setTimeout` 或按键前插 sleep。材料/需求已给出被触发接口时，写/提交/刷新动作必须携带对应 `--wait-api '<path>'`，不得裸发动作后另猜 settle。

## 4. 导航与 tab

```bash
e2et page click -s '<sid>' '<target>' --intent '<意图>'
e2et page click -s '<sid>' '<target>' --clicks 2 --intent '<意图>'
e2et page click -s '<sid>' '<target>' --wait-url '<目标URL特征>' --intent '<意图>'
e2et page switch-tab -s '<sid>' --url-contains '<URL特征>' --intent '<意图>'
e2et page back -s '<sid>' --intent '<意图>'
e2et page refresh -s '<sid>' --intent '<意图>'
```

- 点击后同 tab 跳转：把 `--wait-url` 挂在点击动作上，再取 state。
- 双击用 `page click --clicks 2` 保留真实 `clickCount=2`/dblclick 语义；不能拆成两次普通 click。IR 中已录制的 `double_click` 合同仍按原类型读取和回放。
- 新标签页：点击后先取 state 确认 tabs，再按实际 URL 特征 `switch-tab`；不猜 tab 索引。
- 用户给出具体 URL 时用 `page open` 直达，不先点无关按钮。
- `--creates '<entity>=<创建请求path>'` 只用于真实创建实体的动作；entity 和 path 都需业务依据，不能代替导航等待或证明创建成功。
- 接口成功不等于页面已跳转；接口和页面两边都核。

## 5. 表单与控件

```bash
e2et page fill -s '<sid>' '<target>' '<value>' --intent '<意图>'
e2et page type -s '<sid>' '<target>' '<value>' --intent '<意图>'
e2et page select -s '<sid>' '<target>' '<option>' [--filter-text '<过滤>'] --intent '<意图>'
e2et page choose -s '<sid>' '<target>' '<option1>' '<option2>' [--filter-text '<过滤>'] --intent '<意图>'
e2et page category -s '<sid>' '<target>' '<一级>' '<二级>' --intent '<意图>'
e2et page upload -s '<sid>' '<target>' '<file>' --intent '<意图>'
e2et page press -s '<sid>' '<key>' --intent '<意图>'
```

- `fill` 是定位 → focus → 清空 → 写值；需要逐字符触发 keydown/input/keyup（联想、受控组件）时用 `type`，不能假定 `fill` 一定触发业务 onChange。
- 标准 `<select>`/combobox 用 `select`；多选 combobox/listbox 用 `choose`；可搜索控件先用 `--filter-text` 过滤，再选实际 option。
- 日期只做文本框输入；日历面板多步交互按当前命令能力显式编排。
- 文件上传只设置 file input 文件；文件存在性由调用方保证。
- 按键只使用当前 schema 支持的键名，不猜扩展键。

## 6. 批量填写 scope

```bash
e2et page fill-form -s '<sid>' --scope required --field '字段=<已核实值>' --intent '<意图>'
e2et page fill-form -s '<sid>' --scope all --field '字段=<已核实值>' --intent '明确重置其他字段'
e2et page fill-form -s '<sid>' --scope targeted --field '字段=<值>' --intent '<意图>'
```

| scope | 语义 | 使用条件 |
|---|---|---|
| `required` | 只写显式 `--field`，由 Host 选定必填集合 | 已核实字段集合的新建；不自动识别业务必填 |
| `all` | 写显式字段，并清空未提供的可填字段 | **只有用户明确要求重置未提供字段时**才用 |
| `targeted` | 只写显式 `--field`，其他字段不动 | 编辑、查询、修改指定字段；保留其他值时也用 |

编辑/查询修改已存在记录的字段时，必须用 `page fill-form --scope targeted --field '<字段>=<已核实值>'`；`page fill/type` 只用于单控件即时输入或需要逐字符触发 onChange，不能替代 targeted 填写。

`required`/`targeted` 未传字段时拒绝空执行；batch 不自动生成字段值。字段是否存在、是否折叠、是否依赖上游选择，必须来自最新 state 或已核源码事实。

## 7. 上游依赖与顺序

- 需求、用户已给可信材料或现场/源码已明确某上游选择会改变字段集合时：先执行上游选择 → 重新取 state → 读实际出现的下游字段 → 再填写（含边界/恢复）。字段已可见不能跳过已知依赖。
- 没有依赖证据就不推断操作事务；控件名称本身不证明依赖关系。
- 目标字段缺失且有展开入口时，先按现场真实入口展开并等待目标字段；无入口、无法呈现目标场景时保留缺口并 `BLOCKED`。

## 8. 动态值与跨步骤引用

```bash
e2et page fill -s '<sid>' '[14]' '' --value-template 'e2e-record-${ts}' --intent '填写标题'
e2et capture api -s '<sid>' '<req>' '<json-path>' --as 'newRecordId'
e2et page fill -s '<sid>' '[5]' '' --value-ref 'newRecordId' --intent '填入捕获值'
```

同一 sid/group 的完整动态值链路（A 生成新值，B 与两条断言全部引用它）：

```bash
e2et page fill -s '<sid>' 'label=字段 A' '' --value-template 'e2e-${ts}-${random}' --save-as runValue --intent '<意图>' --group '<group>'
e2et page fill -s '<sid>' 'label=字段 B' '' --value-ref runValue --intent '<意图>' --group '<group>'
e2et assert field -s '<sid>' '字段 A' --value-ref runValue --group '<group>'
e2et assert field -s '<sid>' '字段 B' --value-ref runValue --group '<group>'
```

随后在该 group 截完成态 screenshot，再 `session stop` 和 `report`。字段名、`<sid>`、`<group>` 一律从当前 `page state` 和本次 plan 替换。

- 可用模板变量：`${ts}`、`${rand6}`、`${random}`、`${date:YYYY-MM-DD}`；模板是完整新值。
- 搜索框、真实数据匹配、下拉选项、捕获 ID、数字/枚举/日期等不能随便加唯一化后缀。
- 业务明确用后缀识别测试记录时，模板 token 保持该后缀；是否加测试标记必须来自当前业务规则。
- `--value-ref` 与 `--value-template` 互斥；引用值覆盖位置参数的空串占位。
- 需要把输入结果传给后续输入时，在前序输入动作加 `--save-as '<name>'`。
- `assert api --expect`（响应体）、`assert request --body/--query`、`assert text`、`assert field` 支持字面量 / `--value-ref` / `--value-from-action` 三选一；`assert api --header` 只有字面断言，动态来源会被 daemon 拒绝；`assert data` 只支持 `--equals`。
- 一次性原值修改只能作为 Source 字面量：Host 从 `page state` 读取当次值并拼接，回放使用该字面量，不会重新读取当次值。需要按回放当次值动态派生而 CLI 无对应 token 时，按 schema 报 `BLOCKED`。

## 9. frame

- 页面动作、文本/可见/字段/样式/元素/console 断言都可显式 `--frame '<name|url_contains|selector>'`；frame 检查必须是独立动作，不能拿外层 DOM 推断。
- 先 `page state --frame` 确认 frame 内结构；frame 内没有 `[N]` 索引，使用显式 target。
- 跨域 frame 不可读或 frame 定位不唯一时保留诊断并 `BLOCKED`，不切换到外部浏览器工具。

## 10. 失败与诊断

- 动作失败先保留 CLI 错误、实际值、请求引用和截图；不根据按钮名称猜提交是否发生、是否可以重试。
- `page fill` 后提交报校验错误时，核实际字段值和校验证据，再按授权处理；不无限重试写操作。
- `assert api` 找不到请求时，先核 req 引用/路径/动作是否真实发出，再看请求是否在 mock 前发出；`page state` 的 URL 不能证明接口已发送。
- `capture api` 取不到 body 时保留 `BODY_UNAVAILABLE`/非 JSON 等首次证据；只读且授权范围内才可重新取证，业务写不得因取不到 body 重发。
- 元素找不到/点不动：重新取 state，按 role/name/label/text 重新定位；连续失败保留诊断，不盲点坐标。
- 执行等待超时导致动作失败按 FAIL；不用更宽松断言或换身份掩盖。
- 原生 alert/confirm/prompt 用 `--dialog accept|dismiss`（prompt 可配 `--prompt-text`）预登记；loading 遮罩用 `--wait-gone`/`--wait-element`，不盲点被遮挡元素。
