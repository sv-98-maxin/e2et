# 页面操作、定位与动态值

参数以本次 `e2et commands page [SUB] --json` 为准。身份见 [setup-auth.md](setup-auth.md)，断言见 [ui-check.md](ui-check.md)，报告见 [acceptance.md](acceptance.md)。

## 观察与定位

```bash
e2et page open -s '<sid>' '<url>' --intent '<意图>' --group '<group>'
e2et page state -s '<sid>'
e2et page state -s '<sid>' --frame '<name|url_contains|selector>'
e2et page read -s '<sid>' --local-storage '<key>' --path '<dot-path>'
e2et page read -s '<sid>' --global '<全局标量>'
```

- state 提供 DOM/ARIA、tabs/frames 和当前可交互元素索引。open/动作响应的 elements 摘要不是可复用 state 索引。
- DOM、弹窗、导航或刷新后重新取 state；旧 `[N]` 不复用。frame 快照不发可操作索引。
- page read 只读 localStorage/全局标量，不断言；核值用 assert data。

**target 是位置参数，不是 `--target`：**

| 写法 | 含义 |
|---|---|
| `[N]` | 最新主文档 state 索引 |
| `role=角色[:名称]` | ARIA role 与 accessible name |
| `label=标签` / `text=文本` | accessible name / 可见文本 |
| `testid=值` | data-testid |
| `css=选择器` | CSS 选择器 |
| 裸字符串 | accessible name |

优先 role/name/label/text，用户给定 selector 时显式使用。歧义或缺失时读新 state 修正，不猜坐标或组件私有结构。frame 内用显式 target 与 `--frame`，不用 `[N]` 或 `frame[N]`。

## 动作与等待

```bash
e2et page click -s '<sid>' '<target>' --intent '<意图>' --group '<group>'
e2et page click -s '<sid>' '<target>' --clicks 2 --intent '<双击意图>'
e2et page hover -s '<sid>' '<target>' --intent '<意图>'
e2et page fill -s '<sid>' '<target>' '<value>' --intent '<意图>'
e2et page type -s '<sid>' '<target>' '<value>' --intent '<意图>'
e2et page press -s '<sid>' 'Tab' --intent '<意图>'
e2et page select -s '<sid>' '<target>' '<option>' --intent '<意图>'
e2et page choose -s '<sid>' '<target>' '<option1>' '<option2>' --intent '<意图>'
e2et page category -s '<sid>' '<target>' '<一级>' '<二级>' --intent '<意图>'
e2et page upload -s '<sid>' '<target>' '<file>' --intent '<意图>'
```

- fill 聚焦、清空并写值；需逐字符键盘事件时用 type，不能假定 fill 触发所需业务 onChange。日期文本框可 fill，日历面板按实际 state 编排。
- select 对应标准 select/combobox；choose 对应多选；支持过滤的控件可用 `--filter-text`。选择后核实际值，菜单打开不代表已选择。
- 双击用 `--clicks 2`，不拆成两次普通 click。按键名以当前定义为准。
- hover 后浮层由 CLI 保持，立即断言/截图；tooltip 可能在 portal，不只查触发元素子树。
- 文件上传需要真实存在的文件。原生 alert/confirm/prompt 在触发动作上预登记 `--dialog accept|dismiss`，prompt 可配 `--prompt-text`。

动作自带 DOM settle；需要明确完成条件时把等待挂在触发动作上，不插 sleep：

| 参数 | 条件 |
|---|---|
| `--wait-api '<path>'` | 已知请求完成 |
| `--wait-element '<target>'` / `--wait-gone '<target>'` | 出现 / 消失 |
| `--wait-text '<text>'` / `--wait-url '<片段>'` | 文本出现 / URL 包含 |
| `--wait-timeout-ms '<n>'` | 正整数预算，须配至少一个 wait 条件 |

同 tab 导航在 click 上加 wait-url；新 tab 先 state 核 tabs，再 `page switch-tab -s '<sid>' --url-contains '<片段>' --intent '<意图>'`。也有 back/refresh。接口 settle 不证明页面业务成功，仍需对应 assert。

## 批量表单

```bash
e2et page fill-form -s '<sid>' --scope targeted --field '字段=<值>' --intent '<意图>'
```

| scope | 行为 |
|---|---|
| targeted / required | 只写显式 field，其他字段不动；required 不自动识别业务必填 |
| all | 写显式 field，**清空其他可填字段**；仅在授权重置时用 |

单字段可 fill/type，多字段可 fill-form。字段有已知上游依赖时先选择上游，再取新 state 填下游；不要从字段名猜依赖或默认值。

## 动态值与引用

需要每次回放生成新值时，输入和断言共用 CLI 值来源：

```bash
e2et page fill -s '<sid>' 'label=字段 A' '' --value-template 'e2e-${ts}-${random}' --save-as runValue --intent '<意图>' --group '<group>'
e2et page fill -s '<sid>' 'label=字段 B' '' --value-ref runValue --intent '<意图>' --group '<group>'
e2et assert field -s '<sid>' '字段 A' --value-ref runValue --group '<group>'
e2et assert field -s '<sid>' '字段 B' --value-ref runValue --group '<group>'
e2et capture api -s '<sid>' '<req>' '<json-path>' --as newId --group '<group>'
```

- 模板支持 `${ts}`、`${rand6}`、`${random}`、`${date:YYYY-MM-DD}`；单引号保留 token 给 CLI，不让 shell 展开。
- value-ref 与 value-template 互斥；引用覆盖输入位置的空串占位，save-as 保存实际值供后续使用。
- assert text/field、api 的 expect、request 的 body/query 支持字面量、value-ref、value-from-action 三选一。api header 只接受字面量；assert data 只用 equals。
- 捕获 ID、枚举、搜索已有数据等使用真实值，不随意加唯一后缀。需要按回放现场值派生而 CLI 无能力时说明缺口，不把 Source 旧值当动态结果。

## 操作边界

- page execute 是 JavaScript 诊断能力；本次需要归组时先核对应 commands 已支持 `--group`，报告保留安全代码、返回与错误。脚本结果不冒充正式 assert 或鼠标/键盘路径，仍不可映射到 IR，不删 trace 绕过 UNMAPPED_ACTIONS；已有会话只收尾时不补执行或重开会话。
- mock 会改变请求来源，须标明模拟；用过 mock add 的会话不能落库。
- 动作异常按 [tool-issues.md](tool-issues.md) 保留现场；有副作用的动作不因超时或缺响应 body 自动重发。
