# 入口、会话与身份

本文件负责 CLI 入口、setup、会话、浏览器与登录态。页面动作见 [operations.md](operations.md)，验收见 [acceptance.md](acceptance.md)。

## 1. 入口与能力门禁

每个新会话首次测试、录制、回放或 render 前检查一次；同一会话后续动作复用已核入口。

```bash
command -v e2et
e2et --version
e2et commands session start --json
```

- 记录实际入口、版本和本次要用的 `commands` 定义。`commands GROUP [SUB] --json` 是参数合同真相源，必须覆盖本次全部所需命令。
- 未安装、版本不可读或缺少所需能力时保留原始输出并报 `BLOCKED`；不自动安装、升级、降级、切换全局 CLI、修改 PATH 或删除 symlink。
- 安装/升级是用户的独立请求，按项目 README 执行。同一已开始会话不中途换 CLI。
- 仅汇总已有原生报告只核 `report merge` 合同，不查版本或准备身份；纯 render 仍核入口/版本与 render 合同，不准备身份或浏览器。

```bash
e2et setup
```

- `setup` 返回实际 `data.workspace`、浏览器探测结果和 `data.blockers`；后续 plan、私有 state 和运行目录都使用这个实际 workspace，不写死机器路径。
- `blockers` 含 `missing_browser` 时先报 `BLOCKED` 并交付 hint，不启动会话。
- `doctor` 只作只读诊断；诊断成功不改变旧失败的结论。

## 2. 会话

```bash
e2et session start --auth imported --browser managed
e2et session list
e2et session stop -s '<sid>'
```

- `session_id`、`auth_source`、`browser_source` 只从返回 JSON 读取，不猜。
- `--env` 默认 `default`，只是本次标签；不选择 URL、商家、凭据或身份。非法标签不静默改成默认值。
- 本轮创建且已开始的会话，无论完成、失败或阻断，都先 `session stop`。`data.result=pass` 才满足 Source 正常通过前置；`fail`/`blocked` 保留边界。
- 多页每页独立 session，逐页收尾；单页失败不抹掉其它页各自的原生结论。
- `session start` 当前只接受 `--auth`/`--browser`，没有 `--auth-state`。显式标准 state 通过环境变量 `E2ET_AUTH_STATE` 传入。

## 3. 选择本次身份

| 本次输入 | Source 启动 | 回放/verify/land |
|---|---|---|
| 调用方给定标准 storageState | `E2ET_AUTH_STATE='<state>' e2et session start --auth imported --browser managed` | 对应命令显式 `--auth imported --browser managed --auth-state '<state>'` |
| 明确匿名或公开页面 | 在 `setup` 实际 workspace 建任务私有空 state，再按上一行启动 | 同一任务显式传该 state |
| 已有可用身份，无需新建 | `e2et session start --auth auto --browser auto` | `--auth auto --browser auto` |
| 用户明确要求交互登录 | 先执行 `e2et auth login --url '<本次URL>'`，成功后用已有身份 | 使用登录后的实际身份 |

- 显式 state/profile 与 `profile`/`chrome` 组合互斥；按当前 `commands` 合同传参。
- 本次 CLI 参数/环境覆盖同名继承值。不是本次输入的旧 `E2ET_AUTH_STATE` 不沿用。
- 给定 state 缺失、非法、加载失败或启动后身份不可用，都是 `BLOCKED`；不得退回个人 `imported.json`、默认 profile 或空身份。
- `auth login --url` 只证明到达 URL，不证明业务已登录；业务身份仍要由真实页面或业务响应确认。

创建显式匿名 state 时，`<workspace>` 必须取 `setup.data.workspace`；使用每任务唯一文件名，不覆盖常用的 `auth/imported.json`：

```bash
task_state="$(mktemp '<workspace>/anonymous-XXXXXXXX.json')"
printf '%s\n' '{"cookies":[],"origins":[]}' > "$task_state"
E2ET_AUTH_STATE="$task_state" e2et session start --auth imported --browser managed
```

成功后核 `data.auth_source=imported`、`data.browser_source=managed`。同一任务回放直接传 `--auth-state "$task_state"`，不要复用个人常用 state。

## 4. 交互登录与恢复

只有用户明确要求或授权 login 时执行：

```bash
e2et auth login --url '<本次 http(s) URL>'
```

单会话限制站点的新 login 可能让原 Chrome 下线，执行前先提示这一风险；用户已授权时本回合直接执行，不用“是否继续”代替动作。

身份失败先保留原始错误和首次失败。可恢复时只用本次授权的新会话验证；不自动换身份、不自动重发结果未知的页面写，也不用登录成功改写旧 FAIL。
