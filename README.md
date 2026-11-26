# e2et

[中文](README.zh-CN.md)

e2et is a command-line tool for browser automation and end-to-end testing.
Use it directly or let an AI agent drive it to test pages and produce execution evidence.

## What it does

- Operate web pages: navigate, click, fill forms, select options, and inspect page state.
- Verify results with assertions, screenshots, and HTML reports.
- Record interactions and turn them into reusable tests for regression runs.
- Locate elements through standard DOM and ARIA semantics across component libraries.

## How it works

Browser actions → trace → IR → Playwright replay → HTML report

The CLI controls the browser through CDP, Chrome's remote debugging protocol,
and records actions and observations in a trace. It compiles that trace into IR,
a structured test case that can be checked, saved, and replayed through Playwright.

Commands return JSON so agents can plan the steps, inspect results, and decide
what to do next. Reports bring together assertions, screenshots, and execution evidence.

## Install

Requires **Node.js 20+** and a local **Google Chrome or Chromium** installation.

```sh
npm install -g e2et
e2et setup
```

## Usage

Try a public page with an empty login state:

```sh
echo '{"cookies":[],"origins":[]}' | e2et auth import
e2et session start --auth imported --browser managed
```

Replace `SESSION_ID` with the `session_id` returned by the previous command:

```sh
e2et page open -s SESSION_ID https://example.com --intent "Open example" --group smoke
e2et assert text -s SESSION_ID "documentation examples" --group smoke
e2et page screenshot -s SESSION_ID --intent "Capture result" --group smoke
e2et session stop -s SESSION_ID
e2et report -s SESSION_ID
```

The report command returns the HTML report path. Local data is stored under `~/.e2et`.
For pages that require a login, prepare it with `e2et auth login --url <page-url>`.
See `e2et --help` for more commands.

Licensed under ISC. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for dependency licenses.
