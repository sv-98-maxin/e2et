# 验收证据与报告

本文件是需求 → 检查项 → 证据 → PASS/FAIL/BLOCKED 的唯一验收手册。页面动作见 [operations.md](operations.md)，UI 检查见 [ui-check.md](ui-check.md)，用例回放见 [cases.md](cases.md)。

## 1. 需求 → 检查项

- 从本次要求、验收报告、已提供源码或明确预期列出检查项，写清正反边界、身份/数据前置和操作/写授权。
- 每个检查项先定必备证据：实际 DOM 文本/字段值、计算样式/几何、显式接口引用、原始响应/请求、traceId（后端排查时需要）、断言后完成态截图。
- 具体数值、字段依赖、拒绝条件和恢复策略来自本次要求；不把示例范围套给其他字段。
- 用户给了显式检查项时优先采用；源码只能补充本次行为和独立预期，不能从目录名、环境标签或已有页面值推导业务默认规则。
- API 检查用请求/响应断言，字段检查用请求体/字段断言；样式检查用目标 DOM 的 `assert style`、必要的几何/溢出断言和完成态截图。Console 只证明日志条件，不替代行为断言。
- 检查项写清实际动作、正式断言和数据前置，再按证据逐项核销。可见性只核销展示，不能核销选择/查询/筛选行为；空态只核销空态，不能核销有效数据正例。缺数据、未执行动作或未覆盖断言保留为未验项，写进 plan、报告 summary/findings 和交付边界；不能缩小原 plan 刷绿。

## 2. plan 与 group

```bash
plan_file='<setup返回的实际 workspace>/plan.json'
printf '%s\n' '["打开页面核对标题","hover提示核对文案"]' > "$plan_file"
e2et session stop -s '<sid>'
e2et report -s '<sid>' --plan "$plan_file"
```

- 一个检查步骤一个 `--group`；支持 group 的 page 动作、assert、capture、screenshot 带 group。
- 验收说明逐步标 `[只读]` 或 `[真提交]`；plan 数组每项与实际 `--group` 名称完全一致，不单独给 plan 名称加标记。`[真提交]` 须有本次明确写授权；明确只读/仅改字段时不自动保存。未授权时停在该步前说明缺口，不能只靠 `--group` 或事后断言补授权。
- 每个 group 必须有动作、同 group 显式 assert 和完成态截图；截图必须是该 group 最后一条证据，所有正式断言做完后再截图。capture-only / 只有截图 = BLOCKED。
- assert/capture 的显式 group 优先于 after action 的 group；同一动作后可跟多个独立证据组；报告主体用 group 名，不拼探查 intent。
- `plan.json` 必须是合法、非空、无重复的 JSON 字符串数组；缺失 group 由 report 补 BLOCKED。
- 计划外已执行步骤不能被 plan 投影删除；失败也不能被补报或断言合计改写。
- 诊断动作不进入业务结论；`page execute` 只允许独立侦察会话，不能混入准备 IR 的 Source。

## 3. 证据完备性

| 改动类型 | 必备证据 |
|---|---|
| 接口/数据源替换 | 新接口请求+原始响应；受影响组件展开后的截图；下游真实渲染断言 |
| 表单/提交字段 | 请求体/query 断言 + 表单目标区域完成态截图 |
| 样式/布局 | `assert style` 目标计算值（必要时 `--all`/`--pseudo`）+ `assert element` 几何/溢出 + 改动区域截图 |
| 纯文本/字段 | `assert text/field` + 完成态截图 |
| UI 异常 | `page inspect` 候选 + 正式 `assert text/element/style/console` 或网络证据；候选未确认 = BLOCKED |
| 交互行为 | 真实 hover/click/type 等动作 + 可观察响应/assert；死按钮归因必须有 console/frame/网络证据 |
| Console | `assert console --no-error` 或级别/文本断言；未订阅/截断/归属未知 = BLOCKED |
| frame | 独立 `--frame` 动作 + frame 内正式 assert/console；外层 DOM 不算 |

“页面看起来正常”、请求已发出、CSS bundle 有规则、inspect 候选为空、capture 成功都不等于 PASS。

纯只读观察（没有显式 assert）只证明已观察：`session stop` 的 `result=pass` 或 `report` 的 `conclusion=PASS` 不含断言和断言后截图时，汇报写“已观察，未验证业务”，不报业务 PASS。

## 4. 网络与响应头证据

- 只认显式引用：`assert api/request` 的 evidence/req_id、`capture api` 的 from.req_id、`--wait-api` 在 action.args 留下的显式等待；自动 settle 的请求不算显式引用。
- 一个 group 有多个接口时逐项保留，不丢第二个；认证请求不冒充业务接口。
- 请求字段用 `assert request`：body 用 `--body '<json-path> <op> <value>'`，URL query 用 `--query '<完整键名> <op> <value>'`，二者恰好一个；引用模式只给 `<path> <op>` + 恰好一个来源 flag。
- 响应字段用 `assert api --expect`；响应头用 `assert api --header`，且 `--expect`/`--header` 恰好一个。`--expect` 可用字面量/`--value-ref`/`--value-from-action`，`--header` 只用字面量；给 header 传动态来源会被 daemon 拒绝。
- header 只断言非敏感头；`set-cookie`、`authorization`、`cookie`、认证 token 等不得写入断言或报告。值被脱敏、掩码或带 marker（如 `***`、`[redacted]`）时不能判 PASS，保留证据并 BLOCKED。
- 结论指向后端时（HTTP 非 2xx、`success:false`、HTTP 200 但业务字段异常/为空/缺失）必须有响应头/TraceId 证据。失败 API assert 的 backendInfo 由 report 自动从精确请求组装；取不到写“缺失”。
- Source 与回放报告只消费安全 `respHeaders`/`traceId`/`time` 现有字段，不造新字段；不得因报告侧有字段就伪造 Source 证据。
- 不为业务写重发请求补 TraceId；只在已知只读、无副作用且授权范围内才允许重新取证。缺失就保留缺失证据并判 FAIL/BLOCKED。

## 5. 判定与收尾

- **PASS**：该业务组动作成功、所有显式 assert 通过、断言后完成态截图存在；有接口引用的组有原始响应/请求证据；样式/元素/console/frame 使用对应正式断言。
- **FAIL**：任一动作失败或 assert 未通过；3/4 通过也是 FAIL，不做“基本通过”。
- **BLOCKED**：无失败但未验证（0 断言、缺完成态截图、缺引用响应、inspect 候选未确认、console 未订阅/截断/归属未知、frame 证据不足、能力缺口）。
- 执行等待超时导致动作失败按 FAIL；capture-only、看起来正常、仅加载成功都不算 PASS。
- 断言统计、case 数量、通过率只作展示，不能覆盖 CLI 的 FAIL/BLOCKED。
- 本轮创建的每个会话在完成、失败或阻断取证后都先 `session stop`：`data.result=pass` 才是正常通过前置，`fail`/`blocked` 保留，`aborted` 不正常。
- 已启动的阻断页同样 stop/report，保留原 plan，缺 group 由报告补 BLOCKED；不得跳过该页再汇总剩余 PASS。身份/能力前置失败未启动会话时只交付 BLOCKED 和原始错误，不伪造会话或报告；收尾/报告命令本身失败也保留错误，不声称已有完整总报告。
- 失败时保留 CLI 错误、实际值、请求引用和截图；不自动换身份、不自动重执页面写、不静默修复。修复属于另行授权的任务，不能用旧页面结果冒充复验。

## 6. 报告门禁

- Source：`e2et report` 的 `ok=true` 只表示报告生成成功；业务 PASS 还须独立核 `data.conclusion=PASS`、报告 JSON 的 `result=PASS`，且 plan 无 FAIL/BLOCKED。
- 回放：核 `data.status=passed` 与 `data.run_dir`；`run_dir/report.json` 是 Playwright 原始 JSON（顶层 `config/suites/errors/stats`），取最终 test result 的 `ir-report` 附件 base64 解码后的 ReportData，核 `result`、cases/steps/assertions；缺 `ir-report` 附件不判 PASS。不能用退出码、控制台摘要或断言合计替代。
- 报告必须包含每个业务 group 的 action/assert/截图；失败/阻断也生成可用报告，保留原始边界，不用补报改写。
- 报告是自包含 HTML；截图由 CLI 安全目录内嵌。不要用其他模板或手写 report/base64 替代原生产物。
- `--findings` 只记录发现，不是 FAIL 来源；失败只由真实 assert/动作结果判定。

多页验收先核 `report merge` 能力，各页分别正常收尾并生成带原 plan 的报告，再汇总：

```bash
e2et report merge '<sid1>' '<sid2>' '<sid3>' --title '<本次验收标题>' --open
```

- 只消费指定 sid 已保存的原生报告，sid 顺序就是展示顺序；参数只用本次 `commands report merge --json` 暴露的 sid 列表、`--title`、`--open`。不转手拼 HTML/spec，不改原报告，不重跑业务。
- 仅已有报告汇总只核能力并读这些原报告；不查版本/registry、不安装、不准备 auth、不查个人库、不启动/停止会话、不调用平台。缺能力或输入报错保留错误并 BLOCKED，不能丢掉坏来源后汇总剩余 PASS。
- 实际核 merge 的 `data.conclusion`、总报告 JSON `result`、逐来源终态与 coverage；生成成功不代表需求完整覆盖，FAIL/BLOCKED/aborted 与缺失 plan 边界全部保留。类型空数据等未验项必须在对应来源 summary/findings 可见，不能只留在聊天里。
- 单页交付其原生 report HTML，多页交付 merge 返回的单份自包含 HTML；分别给输入报告结论、需求结论和具体未验项，报告交付后结束本次流程。

## 7. 授权与失败

- 只读默认执行；保存、提交、删除、审核、发送通知等写操作须本次明确授权。用户指定身份不得替换，测试记录或账号标签不产生写授权。
- 目标、有效数据、拒绝条件和恢复策略来自本次输入；缺事实先列具体缺项，不猜业务规则。
- 字段必填/格式校验失败保留原始证据；仅在授权范围内且当前规则已明确时补填，最多 3 轮。业务拒绝不重试，不换身份重跑；结果未知的写操作按 [tool-issues.md](tool-issues.md) 留证。
- Source 报告按现有 headers/traceId/time 字段消费；不新增报告 flag，不把统计成功当业务结论。
