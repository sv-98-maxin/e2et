# e2et

[中文](README.zh-CN.md)

e2et is a command-line tool for browser automation and end-to-end testing.
Record browser interactions, run assertions, generate reusable tests, and
inspect the results in HTML reports with screenshots and execution evidence.

## Install

Requires **Node.js 20+** and a local **Google Chrome or Chromium** installation.

```sh
npm install -g e2et
e2et --version
e2et setup
```

Playwright is installed automatically as a package dependency. `e2et setup`
creates the local workspace and checks browser availability.

## Authentication and browsers

Use explicit authentication for reproducible runs:

```sh
export E2ET_AUTH_STATE=/absolute/path/storage-state.json
e2et session start --auth imported --browser managed
```

The file must be a standard Playwright storage state with `cookies` and `origins`
arrays. An explicit empty state (`{"cookies":[],"origins":[]}`) is valid for a
public page. Empty paths, missing files, invalid JSON, and invalid storage shapes
fail; the CLI does not retry a failed action using another identity.

`auto` resolves available sources. An explicit valid state with `auto` selects
`imported`. `profile` uses a dedicated copy of a system Google Chrome profile;
Playwright Chromium is not a replacement for that profile browser. The current
`auth import --chrome` implementation supports **macOS only**, uses the local
Chrome profile and keychain, requires `rsync` for profile copying, and verifies
an explicitly supplied URL:

```sh
e2et auth import --chrome --url https://your-app.example/
e2et session start --auth profile --browser chrome
```

Linux CI uses `imported` with `managed`. `existing` uses a configured CDP endpoint
and a private context. `auth login --url ...` opens a dedicated profile and checks
arrival at the URL; business login success still needs an application assertion.
`e2et auth status` and `e2et doctor` inspect prerequisites without logging in.

## Record and replay

Read `e2et commands --json` first; it is the current contract for all 58 command
definitions. Commands return JSON (`{ok:true,data}` or `{ok:false,error}`);
diagnostics go to stderr. Exit codes are 0 (command completed), 1 (validation or
test failure), 2 (usage), and 3 (environment). An assertion can complete with exit
0 and `data.pass=false`: always check both `ok` and `data.pass`.

For a page you control, replace the example URL and field labels with its actual
targets, then use the returned `session_id`:

```sh
e2et page open -s SESSION_ID http://127.0.0.1:3000/ --intent "Open form" --group form
e2et page state -s SESSION_ID
e2et page fill -s SESSION_ID 'label=Name' '' \
  --value-template 'example-${random}' --save-as name --intent "Fill name" --group form
e2et assert field -s SESSION_ID Name --value-ref name --group form
e2et page screenshot -s SESSION_ID --intent "Form completion" --group form
e2et session stop -s SESSION_ID
e2et report -s SESSION_ID
e2et ir build -s SESSION_ID --name my_case
```

Use the returned `ir_path` for the remaining gates:

```sh
e2et ir check /absolute/path/my_case.ir.json --trace SESSION_ID
e2et judge /absolute/path/my_case.ir.json
e2et verify /absolute/path/my_case.ir.json \
  --auth imported --browser managed --auth-state /absolute/path/storage-state.json
e2et land /absolute/path/my_case.ir.json \
  --auth imported --browser managed --auth-state /absolute/path/storage-state.json
e2et case list
e2et case run my_case \
  --auth imported --browser managed --auth-state /absolute/path/storage-state.json
```

`land` runs the full gate and atomically saves the case. `case run` executes the
saved test's original bytes. Do not edit generated IR, tests, or fixtures.
Dynamic templates and references are evaluated during each replay, while
provenance records the original session. Reports contain actual assertions,
screenshots, and replay environment attachments; a generated report alone does
not prove that a test passed.

Targets use standard DOM/ARIA semantics (`label=`, `role=`, `text=`, `testid=`) or
an explicit `css=` selector. The core has no component library adapters. Ambiguous
targets or unavailable options fail with diagnostics. Business commit actions
such as Enter, blur, and Save must be explicit steps with final state assertions.

## Local data

The default work root is `~/.e2et`. Sessions, authentication copies, profiles and
`workspace/{traces,ir,render,verify,screenshots}` live under that root. `E2ET_HOME`
overrides the work root for isolation. The personal case library always remains
**`~/.e2et/library`**, even with `E2ET_HOME` set. Older directories and environment
variable names are not automatically imported or migrated.

Useful inputs are `E2ET_AUTH_STATE`, `E2ET_CDP_URL`,
`E2ET_MANAGED_HEADLESS=true`, `HEADLESS=true`, and `BROWSER_EXECUTABLE_PATH`.
Replay also accepts `E2ET_REPLAY_AUTH` and `E2ET_REPLAY_BROWSER`; explicit
`--auth`, `--browser`, and `--auth-state` override the corresponding inherited
inputs. A same-command state plus `profile`/`chrome` is rejected. Explicit
`profile`/`chrome` clears an inherited state path.

## Develop and verify

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

`runtime/` is the source of truth; `runtime_assets/runtime/` and `src/shared/`
are generated mirrors. After editing runtime sources, run
`bash scripts/sync-runtime-to-agents.sh` and verify zero differences. Existing
render guard tests cover controlled IR inputs; no application case corpus is
required for this standalone package.

The package gate installs the actual tarball in a fresh prefix, drives the HTTP
fixture exclusively through that installed CLI, and verifies Source, replay,
authentication rejection, default paths, and an unchanged saved case failing in
negative fixture mode. Native reports and `receipt.json` are retained under
`~/.e2et/workspace/package-verification-*`. GitHub Actions runs the same Linux
gate using public dependencies and uploads native reports and receipts.

## License

ISC for e2et. Upstream notices and full license locations are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), including Playwright's Apache 2.0
native DOM source and the MIT dependencies included in the bundle.
