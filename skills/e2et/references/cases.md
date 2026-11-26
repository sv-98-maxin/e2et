# 用例发现、回放与落库

本文件维护个人用例库、IR 覆盖判断、真实回放和落库。通用验收见 [acceptance.md](acceptance.md)，页面动作见 [operations.md](operations.md)。

## 1. 已有用例发现

```bash
e2et case list
```

- 只相信 `data.cases` 与 `data.invalid`；损坏条目保留具体诊断，不能当不存在后静默新建。
- 按目标页面/场景筛候选，然后读取候选 `<name>.ir.json` 的实际 steps/intents/inputs/waits/checks。
- 名称、同一 URL、`covered_pages`、description 或旧用例跑绿都不能证明新增要求已被断言；`covered_pages` 只是导航页面集合。
- 逐项核“本次要求 → 具体断言 → 身份/数据前置 → 全部 steps 是否在本次操作/写授权内”。回放不新增写授权；含未授权写时不得执行旧 case，也不得裁剪/手改 IR/test。

## 2. case run

```bash
e2et case run '<name>' --auth auto --browser auto
```

- 完整执行保存的 `.test.ts` 原字节，不读原 trace、不重新 judge/编译；不能只读截断。
- 回放身份按本次有效输入：已有准备身份可用 `auto`；调用方给定 state 或显式匿名时用 `--auth imported --browser managed --auth-state '<state>'`。不读取录制时的 provenance 作为本次身份。
- 成功核 `data.status=passed`，保留 `data.run_dir` 与 `data.report`。回放报告路径以本次返回为准：`data.report.json` 是 `run_dir/report.json`，`data.report.html` 是 `run_dir/html-report`；不预设其他临时目录。
- `run_dir/report.json` 是 Playwright 原始 JSON（顶层 `config/suites/errors/stats`），不是 ReportData；取最终 test result 的 `ir-report` 附件 base64 解码，核 ReportData `result` 与 cases/steps/assertions。缺附件不判 PASS；不能只看进程退出码或控制台摘要。
- 覆盖完整、身份/数据前置满足、全部 steps 获授权时，才把本次结果绑定到对应检查项。
- 部分覆盖时保留旧回归覆盖项；缺项另录独立场景，不能用一个宽松旧 case 把新要求扩写成 PASS。
- 原场景输入值、定位、步骤、等待或断言任一变化：旧 trace 不能给新定义作证，必须重新 Source → 新 trace → 新 IR，再完整 check/judge 后 `land --force`。

## 3. 新场景 Source → IR

```bash
e2et ir build -s '<sid>' --name '<name>'
e2et ir check '<ir-file>' --trace '<sid>'
e2et judge '<ir-file>'
```

- Source 只用可映射动作；`page execute` 不能进 IR，`UNMAPPED_ACTIONS` 必须保留并另开侦察会话，不得删 trace 规避。
- `ir build` 前先 `session stop` 并生成原生 Source 报告，`data.result=pass` 且 ReportData `result=PASS` 才 build；任一 BLOCKED/FAIL 不推进，`ir check` 通过不能覆盖 Source 失败。
- `judge` 只验技术证据（trace、断言、mock、schema、locator、请求与值来源），不替用户定义业务覆盖或数据策略。
- IR、checks、provenance、保存的 test 都是生成产物；禁止手改、复制或伪造。缺少动态值/能力时按 schema 报 `BLOCKED`，不抄 Source 旧值绕过。

## 4. verify、land 与 render

```bash
e2et verify '<ir-file>' --auth auto --browser auto
e2et land '<ir-file>' --auth auto --browser auto
e2et land '<ir-file>' --force --auth auto --browser auto
e2et render "$HOME/.e2et/library/<name>/<name>.ir.json" --output "$HOME/.e2et/library/<name>/__tests__"
```

- `verify` = check + judge + render + Playwright 回放；`land` 会再真实回放，完整成功后才原子写个人库。
- 用户明确要求“保存后回放”时，`land` 成功后再调用 `case run`；`land` 的 verification 在入库前执行，不代替保存后的 `case run`。
- 调用方给定 state 或显式匿名时，verify/land 显式用 `--auth imported --browser managed --auth-state '<state>'`；已有准备身份可用 `auto`。失败不自动 fallback 到个人身份。
- verify 成功核 `data.status=passed`；land 成功核 `data.status=landed` 且 `data.verification.status=passed`。两者都要保留 `data.run_dir`、`data.report`，取 `run_dir/report.json` 的最终 test result `ir-report` 附件 base64 解码后核 ReportData `result`；缺附件不判 PASS。失败时保留 `data.run_dir` 与 `data.report` 指向的原始证据。
- `land` 默认拒绝同名；行为变化完整重录后可用 `--force`，但 `--force` 不放宽 trace/mock/check/judge/回放门禁，失败保留旧用例。
- 本次用户明确说“落库/保存用例”，且该用例 steps 已在本次授权内：本地 `land` 及其同一 steps 的真实回放直接落库，不重复确认；回放不是新的页面写授权。未授权或 IR 含本次未授权的页面写/身份变更时先展示证据；`--force` 需独立的同名替换授权。
- 编译器/模板变化但用例定义未变时，只允许 `render` 已保存 IR：成功核 `data.status=compiled`、`data.replay=not_run`，只证明新测试写入成功；需要回放证据时另跑 `case run`。
- 任何步骤、定位、输入、等待或断言变化都属于行为变化，不能靠 render 旧 IR 宣称适配完成。
- 使用过 `mock add` 的会话不可 land；模拟结果必须标明来源。

## 5. 落库产物合同

```text
~/.e2et/library/<name>/
  <name>.ir.json
  __tests__/<name>.test.ts
  cases/fixtures/<name>/<sha256>-<原文件名>   # 仅上传用例存在
```

- case 名必须匹配 `^[a-zA-Z0-9][a-zA-Z0-9_-]*$`；非法名 exit 2，缺失用例 exit 1。
- 用例目录不保存 Cookie、state、profile 或绝对认证路径。
- 个人用例库固定为 `~/.e2et/library`，不会因 `E2ET_HOME` 指向其它 workspace 而迁移。
- `land` 成功核 `data.status=landed`、`data.verification.status=passed`、`data.case_root`、`data.files`；可选 `data.cleanup_error` 原样报告。
- `verify`、`land`、`case run` 的 `--output` 是私有运行目录父路径，必须位于 `setup` 返回的实际 `<workspace>/verify` 内，不是落库目标；父路径不得是 symlink。实际 `run_dir` 以命令返回为准。
- case run/verify/land 不要求项目 `.git`、`test/e2e/` 或项目 `node_modules`；运行时由 e2et 包内锁定依赖提供。

## 6. 失败与更新

- `ALREADY_EXISTS`：保留旧用例；行为变化重录后按已有授权 `land --force`；需要独立场景时用 `ir build --name` 生成新名称，land 没有 `--name`。
- `judge` 拒绝：按 reasons 定位缺失事实或失败动作，修动作/断言后重新录制；不能手改 IR/checks 绕过。
- `ir check` 失败：按 failures 定位 locator/请求/值来源，修实际动作后重录并 build，不手改 IR。
- 缺/坏 fixture 在业务动作前拒绝；原 trace 与上传源文件清理后仍应可运行。
- 回放身份按本次有效输入，不取录制 provenance；显式 state/profile 失败保留 BLOCKED，不自动 fallback。
