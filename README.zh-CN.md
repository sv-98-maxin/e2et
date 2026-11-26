# e2et

[English](README.md)

e2et 是浏览器自动化与端到端测试命令行工具。支持页面操作、断言、录制、
生成可回放用例，以及带截图和执行证据的 HTML 报告。

## 安装

需要 **Node.js 20+**，以及本机安装的 **Google Chrome 或 Chromium**。

```sh
npm install -g e2et
e2et --version
e2et setup
```

Playwright 会随 npm 依赖自动安装。`e2et setup` 创建本地工作目录并检查浏览器是否可用。

## 登录态与浏览器

可复现的录制建议显式传标准 Playwright storage state：

```sh
export E2ET_AUTH_STATE=/绝对路径/storage-state.json
e2et session start --auth imported --browser managed
```

文件需要 `cookies`、`origins` 数组。公开页面可用显式空 state
`{"cookies":[],"origins":[]}`。空路径、缺文件、非 JSON、坏存储结构都会拒绝；
动作失败不会换身份重跑。

`auto` 根据可用来源选择；有效显式 state 配 `auto` 使用 `imported`。
`profile` 使用系统 Google Chrome 的专用副本，不能拿 Playwright Chromium 替代。
当前 `auth import --chrome` **只支持 macOS**，用 `rsync` 复制本机 Chrome profile、
使用钥匙串，并验证显式提供的 URL：

```sh
e2et auth import --chrome --url https://your-app.example/
e2et session start --auth profile --browser chrome
```

Linux CI 使用 `imported` + `managed`。`existing` 连接配置的 CDP 端点并使用私有 context。
`auth login --url ...` 打开专用 profile，检查到达 URL；业务是否登录成功仍需业务断言。
`auth status`、`doctor` 只检查前置，不发起登录。

## 录制与回放

先读 `e2et commands --json`，以当前 58 条命令定义为准。命令 stdout 是 JSON 信封，
诊断走 stderr。退出码：0 完成、1 校验或测试失败、2 用法错误、3 环境错误。
**断言不成立也可能 exit 0、`data.pass=false`，必须同时检查 `ok` 和 `data.pass`。**

下面的 URL、字段名需要换成你实际页面的值；使用 `session start` 返回的 `session_id`：

```sh
e2et page open -s SESSION_ID http://127.0.0.1:3000/ --intent "打开表单" --group form
e2et page state -s SESSION_ID
e2et page fill -s SESSION_ID 'label=名称' '' \
  --value-template 'example-${random}' --save-as name --intent "填写名称" --group form
e2et assert field -s SESSION_ID 名称 --value-ref name --group form
e2et page screenshot -s SESSION_ID --intent "表单完成态" --group form
e2et session stop -s SESSION_ID
e2et report -s SESSION_ID
e2et ir build -s SESSION_ID --name my_case
```

后续使用 `ir build` 返回的 `ir_path`：

```sh
e2et ir check /绝对路径/my_case.ir.json --trace SESSION_ID
e2et judge /绝对路径/my_case.ir.json
e2et verify /绝对路径/my_case.ir.json \
  --auth imported --browser managed --auth-state /绝对路径/storage-state.json
e2et land /绝对路径/my_case.ir.json \
  --auth imported --browser managed --auth-state /绝对路径/storage-state.json
e2et case list
e2et case run my_case \
  --auth imported --browser managed --auth-state /绝对路径/storage-state.json
```

`land` 全门禁通过后原子落库，`case run` 执行已保存测试的原字节。IR、测试、fixtures
都是生成产物，不手改。模板和引用在每次回放重新求值；provenance 只记录录制事实。
报告包含实际断言、截图和本次回放环境附件，报告生成成功不等于测试通过。

定位基于标准 DOM/ARIA（`label=`、`role=`、`text=`、`testid=`）和显式 `css=`。
核心没有组件库 adapter；目标歧义、找不到选项时明确拒绝。Enter、失焦、保存等业务提交
动作由用例显式执行，再断言最终状态。

## 本地目录

默认工作根为 `~/.e2et`。session、auth 副本、profile 与
`workspace/{traces,ir,render,verify,screenshots}` 从这里派生。
`E2ET_HOME` 可覆盖工作根，但个人库始终固定在 **`~/.e2et/library`**。
不自动读取或迁移旧目录、旧环境变量。

常用输入：`E2ET_AUTH_STATE`、`E2ET_CDP_URL`、`E2ET_MANAGED_HEADLESS=true`、
`HEADLESS=true`、`BROWSER_EXECUTABLE_PATH`。
回放也支持 `E2ET_REPLAY_AUTH`、`E2ET_REPLAY_BROWSER`；显式 `--auth`、`--browser`、
`--auth-state` 覆盖对应继承环境。同次 state + profile/chrome 拒绝；
显式 profile/chrome 可清除继承的 state 路径。

## 开发与验证

```sh
npm ci
npx --no-install playwright install chromium
export BROWSER_EXECUTABLE_PATH="$(node -p "require('@playwright/test').chromium.executablePath()")"
npm run typecheck
npm run check:architecture -- --self-test
npm run check:architecture
npm run build
npm test -- --pool=forks --no-cache
npm run test:runtime
bash scripts/sync-runtime-to-agents.sh --dry-run
npm run bundle
npm pack --dry-run --ignore-scripts
npm pack --ignore-scripts
npm run test:package -- "$PWD/e2et-0.1.0.tgz"
```

`runtime/` 是 SSOT；`runtime_assets/runtime/`、`src/shared/` 是生成镜像。
修改 runtime 后运行 `bash scripts/sync-runtime-to-agents.sh`，再检查零差异。
现有 render guard 使用五类受控输入，不需要虚构业务 IR 集合。

包验收把实际 tarball 安装到全新 prefix，只用安装后的 CLI 驱动 Node HTTP fixture，
核 Source、回放、auth 拒绝、默认根和同一个保存用例在负 fixture 下的真实失败。
原生报告与 `receipt.json` 保留在 `~/.e2et/workspace/package-verification-*`。
GitHub Actions 用公开依赖执行相同 Linux 门禁，只上传原生报告和收据。

## 许可

e2et 使用 ISC。上游完整许可与归属见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，包括 Playwright 原生 DOM 源码的
Apache 2.0 和 bundle 内 MIT 依赖。
