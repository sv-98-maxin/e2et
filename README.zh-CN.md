# e2et

[English](README.md)

e2et 是浏览器自动化与端到端测试命令行工具。
你可以直接使用，也可以交给 AI Agent 调用，完成页面验证并留下执行证据。

## 能做什么

- 操作网页：打开页面、点击、填写表单、选择选项、查看页面状态。
- 验证结果：执行断言、截取页面截图、生成 HTML 测试报告。
- 沉淀回归用例：录制交互，生成可保存、可重复回放的测试。
- 跨组件库定位：通过标准 DOM 和 ARIA 语义操作页面元素。

## 实现方式

页面操作 → trace → IR → Playwright 回放 → HTML 报告

CLI 通过 CDP（Chrome 的远程调试协议）控制浏览器，把动作和观察结果录成 trace。
再将 trace 编译成 IR，也就是一份结构化用例，经过校验后交给 Playwright 回放。

命令返回 JSON，AI Agent 可以据此规划步骤、检查结果、决定下一步动作。
报告汇总断言、截图和执行证据，方便定位失败原因。

## 安装

需要 **Node.js 20+**，以及本机安装的 **Google Chrome 或 Chromium**。

```sh
npm install -g e2et
e2et setup
```

## 使用

先用空登录态测试一个公开页面：

```sh
echo '{"cookies":[],"origins":[]}' | e2et auth import
e2et session start --auth imported --browser managed
```

将返回的 `session_id` 替换到下面的 `SESSION_ID`：

```sh
e2et page open -s SESSION_ID https://example.com --intent "打开示例页面" --group smoke
e2et assert text -s SESSION_ID "documentation examples" --group smoke
e2et page screenshot -s SESSION_ID --intent "截取结果" --group smoke
e2et session stop -s SESSION_ID
e2et report -s SESSION_ID
```

报告命令会返回 HTML 文件路径，本地数据保存在 `~/.e2et`。
需要登录的业务页面，先用 `e2et auth login --url <页面URL>` 准备登录态。
其他命令可通过 `e2et --help` 查看。

采用 ISC 许可，依赖许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
