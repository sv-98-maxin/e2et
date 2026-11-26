# e2et

[English](README.md)

## 能干啥

e2et 是一个浏览器测试 CLI。它会打开页面，按标准 DOM 和 ARIA 语义操作，核对可见结果，保存证据，并生成原生 HTML 测试报告。

它也能把一次已授权的页面操作录制成可复用用例，保存到本地，之后用新的输入值回放。

## Agent + Skill + CLI 怎么配合

CLI 通过 CDP 驱动浏览器，把动作和观察记录成 trace，再编译为 IR，并通过 Playwright 回放保存的用例。Agent 把目标转成具体动作和断言，再根据 CLI 返回的 JSON 决定下一步。

配套 Skill 推荐但可选：它只给 Agent 提供经过验证的 e2et 使用指南。你可以独立调用 CLI，也可以用自己的 Skill。

## 安装

CLI 需要 Node.js 20+，以及本机安装的 Google Chrome 或 Chromium。

**CLI**

```sh
npm install -g @coder_maxin/e2et
e2et setup
```

**配套 Skill**

`skills` 安装器需要 Node.js 22.20+。

```sh
npx skills add sv-98-maxin/e2et --skill e2et
```

## 自然语言使用示例

- “用 e2et 打开 `https://example.com`，确认页面显示 `Example Domain`，截取完成态并给我原生测试报告。”
- “用 e2et 和 `/path/to/state.json` 这份登录态验证这个页面，任何保存或提交动作都先停下。”
- “把这次表单流程保存为用例 `profile-edit`，然后用一个新的测试名称回放一次。”

直接使用 CLI 时，可从 `e2et --help` 或 `e2et commands --json` 开始。
