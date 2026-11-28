# Changelog

## 0.2.0

- Generate schema 2 Source and replay reports with ordered events, linked screenshots, execution errors, and explicit evidence for checks that did not run.
- Freeze `--acceptance` before execution and bind each expectation through `--check-id` or an exact IR reference. Missing bindings remain unverified and block acceptance; failed entries cannot be hidden by another passing entry.
- Finalize replay reports from Playwright's original JSON, final test result, errors, and native HTML. `report.facts_json` contains the final facts; intermediate attachments and `--skip-test` cannot establish PASS.
- Separate the current run's identity, tool version, CLI/runtime hashes, browser, and authentication from the Source recording's provenance. Preserve generated IR, test, and fixture bytes through replay and atomic case saving.
- Improve report navigation, check details, screenshot selection, and flow playback. Preserve flow evidence across tab changes and expose the Playwright native-detail link.
- `report merge` accepts native schema 2 Source reports and preserves their execution, acceptance, and evidence. Schema 1 inputs are explicitly rejected with `REPORT_SCHEMA`.

## 0.1.1

- Expand the English and Chinese quickstarts with a repeatable local page and report/replay guidance.
- Simplify the optional e2et companion Skill and align package verification with its files.

## 0.1.0

First standalone public release as `@coder_maxin/e2et`.

- Deterministic browser actions and assertions with standard DOM/ARIA targets.
- Source traces, IR compilation, replay, native reports, and an atomic personal case library.
- Default `~/.e2et` work root and `E2ET_*` environment inputs.
- Public npm package and dependencies, a GitHub Release tarball, and Linux package verification in CI.

Install artifact: `coder_maxin-e2et-0.1.0.tgz` from GitHub Release `v0.1.0`.
