# e2et

[中文](README.zh-CN.md)

## What it does

e2et is a browser-testing CLI. It opens pages, uses standard DOM and ARIA semantics to operate them, checks visible results, captures evidence, and produces a native HTML report.

It can also record an authorized interaction into a reusable test, save that test locally, and replay it later with fresh input values.

## How Agent + Skill + CLI work

The CLI drives the browser through CDP, records actions and observations in a trace, compiles the trace into IR, and replays saved cases through Playwright. The Agent turns your goal into concrete actions and assertions, then chooses the next step from the CLI's JSON results.

The companion Skill is recommended but optional: it only gives an Agent tested guidance for using the CLI. You can call the CLI independently or use your own Skill.

## Install

The CLI requires Node.js 20+ and a local Google Chrome or Chromium installation.

**CLI**

```sh
npm install -g @coder_maxin/e2et
e2et setup
```

**Companion Skill**

The `skills` installer requires Node.js 22.20+.

```sh
npx skills add sv-98-maxin/e2et --skill e2et
```

## Use it in natural language

- "Use e2et to open `https://example.com`, confirm the page shows `Example Domain`, capture the completed state, and give me the native test report."
- "Use e2et with the storage state at `/path/to/state.json` to verify this page, and stop before any save or submit action."
- "Record this form flow as the case `profile-edit`, then replay it with a fresh test name."

For direct CLI discovery, run `e2et --help` or `e2et commands --json`.
