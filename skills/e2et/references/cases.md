# 用例、编译与回放

IR 是从真实录制生成的中间测试表示。仅在需要复用场景时走本流程；报告生成不依赖 IR。

## 已有用例

```bash
e2et case list
e2et case run '<name>' --auth imported --browser managed --auth-state '<state>' [--acceptance '<acceptance-file>']
```

- list 返回 data.cases/data.invalid。选候选后读实际 IR steps、inputs、waits、checks；名称、同 URL 或历史 PASS 不证明覆盖本次要求。
- 回放完整执行保存的测试原字节，不从旧 trace 重编译；不要裁剪步骤或改生成文件。
- 本次身份与页面操作次数/写授权适用于全部 steps。给定 state 用 imported+managed；已有准备身份可 auto。回放不沿用录制 provenance 里的身份，不在失败后换账号。
- 需要验收输入时先核对应 commands 支持 `--acceptance`，按 [acceptance.md](acceptance.md#执行前的验收说明) 在运行前准备独立预期；校验冻结和内部环境传递由 CLI 管理，无输入不补造。

## Source → IR → 保存

Source 指实时录制会话。先正常 stop 并生成原生报告；仅 stop.result=pass、报告 result=PASS 且本次检查覆盖后继续。

```bash
e2et ir build -s '<sid>' --name '<name>'
e2et ir check '<ir-file>' --trace '<sid>'
e2et judge '<ir-file>'
e2et land '<ir-file>' --auth imported --browser managed --auth-state '<state>' [--acceptance '<acceptance-file>']
```

- ir build 返回 data.ir_path、unmapped_actions、dropped_steps、warnings。保留不能映射/丢弃事实，不删 trace 或手改 IR 来过校验。
- ir check 看 data.passed；judge 看 data.regressible。两者核技术证据，不定义业务覆盖。
- page execute 的脚本事实可在 Source 报告阅读，仍不是可映射动作，judge 的 UNMAPPED_ACTIONS 拒绝不变；不删 trace 规避，仅报告收尾不要求新开会话。用过 mock add 的会话不能落库。
- **land 会真实回放一次，成功后才原子写个人库**。verify 默认也回放，case run 又执行一次；不要习惯性全部串跑。若次数或步骤超授权，先说明冲突，不额外执行。
- 用户要求保存且步骤在授权内时可直接 land；要求“保存后再回放”才在成功后 case run。已有同名默认拒绝，force 需明确同名替换授权；失败保留旧用例。

## 返回字段与回放证据

| 命令 | 成功字段 | 回放证据位置 |
|---|---|---|
| verify | data.status=passed | **data.run_dir、data.report** |
| case run | data.status=passed | **data.run_dir、data.report** |
| land | data.status=landed 且 data.verification.status=passed | **data.verification.run_dir、data.verification.report** |
| render | data.status=compiled 且 data.replay=not_run | 无回放证据 |

- verify 的 skip-test 返回 data.status=skipped，只证明未跑，验收为 BLOCKED/not_run。失败返回 ok=false/error，不假设还有成功 data；有 error.evidence 时读取其中实际存在的 run_dir/report 路径，不为找路径重放页面写。
- 回放 report 对象中 `json` 是 PW 原始 `report.json`（config/suites/errors/stats），`facts_json` 是最终 `report-data.json`，`html` 是新自包含 `report.html`，`playwright_html` 保留原生 `html-report/index.html` 详情。路径以实际返回且存在的文件为准；land 从 verification.report 读取。
- 最终 facts_json 的 ReportData 须 result=PASS，本次 run、events/images 与检查证据对应实际执行，同时核 PW 最终 test result 和 errors。ir-report 附件只是中间事实：内联 body 为 base64，path 指向实际文件；它不能盖过最终 failed/timedOut/interrupted、非 0 进程或清理错误，这些保留 FAIL。
- 无失败但 skipped/0 tests、PW passed 却缺少或损坏 ir-report 附件时为 BLOCKED；缺最终 facts_json 也不能判 PASS，不补造动作、实测或截图，不改原报告或借回放重复提交。

## 只重编译

```bash
e2et render "$HOME/.e2et/library/<name>/<name>.ir.json" --output "$HOME/.e2et/library/<name>/__tests__"
```

render 只编译，不准备身份或启动浏览器。适用于编译器变化而场景定义未变；需要新的网页执行证据时另行 case run。步骤、定位、输入、等待或断言变化须重新录制，不靠 render 旧 IR 宣称已适配。

## 路径与更新

```text
~/.e2et/library/<name>/
  <name>.ir.json
  __tests__/<name>.test.ts
  cases/fixtures/<name>/<sha256>-<原文件名>  # 上传用例
```

- name 匹配 `^[a-zA-Z0-9][a-zA-Z0-9_-]*$`；library 固定在 HOME 下，不随 E2ET_HOME 迁移，且不保存 Cookie/state/profile。
- verify/land/case run 的 output 是实际 `<workspace>/verify` 内的运行目录父路径，不是落库目标，父路径不得为 symlink；实际 run_dir 以返回为准。
- 运行依赖由 CLI 包提供，不要求当前目录有 .git、项目 node_modules 或 test/e2e。
- ALREADY_EXISTS 时保留旧用例；新场景用 ir build 的 name，land 没有 name 参数。行为变化按新 Source/IR 重新校验再授权 force；check/judge 拒绝时修实际录制，不编辑生成物。
