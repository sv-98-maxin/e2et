# 入口、会话与身份

## 入口与 workspace

`commands` 是当前安装版本的参数定义；示例只作使用指南。

```bash
command -v e2et
e2et --version
e2et commands session start --json
e2et setup
```

- setup 只准备目录并探测浏览器，不安装 Chrome、不登录。读取 `data.workspace`、`data.blockers` 和 `data.blocker_hints`；有 missing_browser 时先处理前置，不启动会话。
- plan、任务私有 state 与运行目录使用实际 workspace。默认根目录为 `~/.e2et`，可由 `E2ET_HOME` 改变；个人用例库仍固定在 `~/.e2et/library`。
- 未安装或缺能力时给出原始错误与缺口；用户要求安装/升级时参照项目 README。doctor 用于诊断，不代表目标站点已登录。

## 选择本次身份

| 输入 | Source 会话 | verify / land / case run |
|---|---|---|
| 标准 storageState 文件 | `E2ET_AUTH_STATE='<state>' e2et session start --auth imported --browser managed` | `--auth imported --browser managed --auth-state '<state>'` |
| 公开页或明确匿名 | 在实际 workspace 建任务私有空 state，按上一行使用 | 显式传同一任务 state |
| 已准备好可用身份 | `e2et session start --auth auto --browser auto` | `--auth auto --browser auto` |
| 授权复用本人 Chrome 登录态 | 先按下面的 Chrome 导入说明准备，再用 `--auth profile --browser chrome` | `--auth profile --browser chrome` |
| 明确要求交互登录 | `e2et auth login --url '<url>'`，再使用准备好的身份 | 按实际准备结果选择 |

- `session start` **没有 `--auth-state` 参数**，Source 用环境变量；回放命令才接受该 flag。
- auto 会选择已有身份，不表示匿名。给定 state 缺失、非法或无法加载时保留错误，不退回个人 profile/imported.json 或空身份。
- 显式 state 与 profile/chrome 组合互斥。本次参数覆盖同名环境输入；非本次输入的旧 `E2ET_AUTH_STATE` 不沿用。
- `auth login` 到达 URL 不证明业务登录成功，仍需页面/业务响应确认；新登录可能使原 Chrome 在该站点下线，只在授权内执行。

匿名示例：把 `<workspace>` 换成 setup 返回路径，不覆盖常用 auth 文件。

```bash
task_state="$(mktemp '<workspace>/anonymous-XXXXXXXX.json')"
printf '%s\n' '{"cookies":[],"origins":[]}' > "$task_state"
E2ET_AUTH_STATE="$task_state" e2et session start --auth imported --browser managed
```

成功核 `data.auth_source=imported`、`data.browser_source=managed`；state 含凭据时限制文件权限，不提交或公开分享。

## 准备可复用登录态

只需本次标准 state 时直接传路径；需要保存到 CLI 的 imported 身份时才导入：

```bash
e2et auth import '<state-or-cookies-file>'
e2et auth import '<cookie-header-file>' --domain '<host>'
e2et auth status
```

文件或 stdin 支持 storageState/cookies JSON；裸 Cookie 头须提供 domain。成功返回 data.path，不把 cookie 值输出或提交。

用户授权复用本人 Chrome 时可用 `e2et auth import --chrome --url '<url>'`；当前仅支持 macOS，多个 profile 时按返回列表选 `--profile '<目录名>'`。成功返回 auth_source=profile，后续用 profile+chrome，不把复制 profile 当作通用 state。需导出该托管 profile 的域内 Cookie 时用 `e2et auth export --out '<file>' --domain '<host>'`。

## 会话生命周期

```bash
e2et session list
e2et session stop -s '<sid>'
```

- sid 取启动返回的 `data.session_id`。`--env` 默认 default，只是标签，不选择 URL、身份或环境凭据。
- 本轮创建的会话在完成/失败/阻断后都 stop，再按 [acceptance.md](acceptance.md) report。`data.result` 为 pass/fail/blocked/aborted；pass 才是正常通过前置。
- 已结束会话可直接生成报告；不要为收尾重启会话或重做页面操作。
