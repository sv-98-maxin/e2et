# 结果判读与原生报告

本文件说明 CLI 结果、group/plan 和报告合同，不替调用方定义业务验收制度。

## 命令成功不等于测试通过

成功通常返回 `{"ok":true,"data":...}`，错误返回 `{"ok":false,"error":{"code":...,"message":...,"hint":...}}`。退出码 0 为命令成功，1 为校验/工具失败，2 为参数错误，3 为环境不可用/致命异常。

| 操作 | 核对字段 |
|---|---|
| assert | `data.pass === true`；pass=false 仍可能退出 0 |
| session stop | `data.result`：pass / fail / blocked / aborted |
| report / report merge | `data.conclusion` 与 data.json 文件顶层 result |
| verify / land / case run | 各自 status 与回放报告，见 [cases.md](cases.md) |

只有观察、截图或 capture，不证明业务已验证；FAIL/BLOCKED 与未覆盖项如实保留，不用统计合计或后续诊断覆盖原始失败。

## 执行前的验收说明

本次有独立预期时，先准备验收 JSON，再向本次选定的 `session start / verify / land / case run` 传 `--acceptance '<file>'`。这些新参数以对应 `commands` 已暴露为前提，缺能力时停止依赖它的步骤。CLI 在浏览器启动前校验冻结；使用者不配置内部快照或运行环境。没有输入就保留「需求未提供」，不从 actual 反填预期；仅 merge、观察或既有会话收尾不补造快照或重开会话。

```json
{
  "schemaVersion": 1,
  "scenarios": [{
    "id": "title",
    "goal": "核对页面标题",
    "source": {"kind": "user", "text": "页面标题应包含记录列表"},
    "preconditions": ["只读取证"],
    "checks": [{"id": "title.text", "expectation": "页面标题包含记录列表"}]
  }]
}
```

scenario ID 对应 group，check ID 全局唯一。source.kind 为 `user/contract/case/host`，至少有 text 或 ref；Host 整理内容不冒称用户原文。可选 actions 描述操作约束，irRef 只引用核实的 IR SHA256、stepId、checkIndex 与可选 entryIndex。正式 assert 的 `--check-id` 必须存在于冻结说明且所属 scenario 与有效 group 一致，不匹配在读取/比较前拒绝；未绑定断言保留事实，验收项保持未绑定。capture、inspect 或脚本返回不核销正式检查。

## group 与 plan

把同一检查的动作和证据带上相同 `--group`，让报告归组。group 名来自本次实际检查，不额外造准备项或业务规则。

```bash
e2et page open -s '<sid>' '<url>' --intent '<意图>' --group title
e2et assert text -s '<sid>' '<预期文本>' --group title [--check-id '<check-id>']
e2et page screenshot -s '<sid>' --intent '完成态' --group title
printf '%s\n' '["title"]' > '<workspace>/plan.json'
e2et session stop -s '<sid>'
e2et report -s '<sid>' --plan '<workspace>/plan.json'
```

- plan 参数可选；需要显式覆盖检查时使用非空 JSON 字符串数组，每项非空、无重复，且与 group 完全一致。缺项补 BLOCKED，计划外真实步骤不被删除。
- 显式 plan 下，完成态截图须在同 group 全部动作、断言、capture/其他证据之后；未加 group 的 screenshot 不写该组 trace 证据，自动动作截图不能代替完成态截图。
- 报告步骤 PASS 要有通过的显式 assert、可用截图和所引用的原始接口证据，且没有动作/断言失败；缺证据为 BLOCKED，动作/断言失败为 FAIL。无 plan 时报告可用自动动作截图，但不把它描述成断言后的完成态。
- Source 正常通过同时核 stop.result=pass、report.conclusion=PASS、报告 JSON result=PASS 与本次覆盖范围。没有独立预期时只说明观察结果。

## 网络断言

```bash
e2et assert request -s '<sid>' '<req>' --body '<json-path> == <value>' --group '<group>'
e2et assert request -s '<sid>' '<req>' --query '<key> == <value>' --group '<group>'
e2et assert api -s '<sid>' '<req>' --expect '<json-path> == <value>' --group '<group>'
e2et assert api -s '<sid>' '<req>' --header '<header> == <value>' --group '<group>'
```

- request 的 body/query、api 的 expect/header 各自恰好一个。req 引用与 path 从真实动作/返回取得，不猜请求已发生。
- body/query/expect 可用动态来源；引用模式只给 path 与运算符，再加 value-ref 或 value-from-action。header 仅字面量；敏感头或被掩码值不能作通过证据。
- assert/capture 和显式 wait-api 关联请求证据，自动 settle 不等于独立接口检查。缺 body/TraceId 保留缺失，不重发业务写来补资料。
- report 自动从精确请求组装现有安全响应头/TraceId；只有实际请求/响应支持时才归因后端。

## 生成与汇总

report 直接消费会话 trace，不需要先 build IR。结束已启动会话后，即使失败也用原 plan report；错误前未启动会话时只给原始错误，不伪造报告。

```bash
e2et report -s '<sid>' --plan '<plan-file>' --title '<标题>'
e2et commands report merge --json
e2et report merge '<sid1>' '<sid2>' --title '<标题>'
```

- report 返回 `data.html`、`data.json`、`data.report_dir`；Source/merge 的 JSON 沿用原 `report.json`，路径以返回为准。原生 HTML 自包含，引用截图仍受安全目录与大小限制。
- merge 只消费指定 Source sid 已保存的 schema2 原生报告，按给定顺序展示；旧版、混合或缺必需事实字段具名拒绝，不手工升级旧报告、不丢掉失败来源。仅汇总不准备身份或快照、不启动浏览器、不重跑页面；缺输入或能力保留错误。
- 新 Source/回放事实报告均为 `report_schema_version=2`。按 `cases[].events` 的 sequence 核动作、断言、capture、观测和错误，保留无 group/无图事件；`images` 只按 eventId/actionId 关联，不按标题或数组下标猜图。检查保留 expect、resolvedExpected、actual 与 actualStatus，缺失与 null、数字与字符串分开，脱敏或截断标记保留。
- `cases[].run` 是本次执行的身份来源、工具版本、SHA 和终态，`recording` 是录制历史；历史身份和旧值不当成当前运行事实。验收说明来自冻结输入，未提供或未绑定时保留未验范围。
- 生成成功只表示文件可用；核 conclusion、JSON result 和来源/coverage 后返回实际 HTML 路径及未验证项。输入报告通过不代表用户新增要求已覆盖。
- summary/findings 是说明文字，不是 FAIL 的来源，也不能改写真实断言结果；不手拼替代报告。
