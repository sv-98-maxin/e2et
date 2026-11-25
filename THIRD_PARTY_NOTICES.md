# Third-party notices

e2et's ISC license does not replace upstream licenses. This distribution retains
the following copyright notices and full license texts.

| Distributed component | License and notices |
| --- | --- |
| ws, included in `dist/cli.js` and installed for replay | Full MIT license and original copyrights in `third-party-notices/ws.LICENSE` |
| Zod, included in `dist/cli.js` | Full MIT license and original copyright in `third-party-notices/zod.LICENSE` |
| Playwright native DOM source, included in the CLI and replay runtime | Full Apache License 2.0 in `runtime_assets/runtime/native-dom-source.LICENSE`; attribution in `third-party-notices/playwright.NOTICE` |
| `@playwright/test`, `playwright`, and `playwright-core` 1.64.1, installed dependencies | Their packages include complete `LICENSE` and `NOTICE` files; Playwright and Playwright Core also ship `ThirdPartyNotices.txt` and full bundled license sidecars under `lib/` |

The original Playwright `NOTICE` and both `ThirdPartyNotices.txt` files are also
included in `third-party-notices/`. The files referenced by those notices remain
in the installed `playwright` and `playwright-core` dependencies. Each
`lib/**/*.js.LICENSE` sidecar contains the full license texts and copyright
notices for that upstream bundle.

The CLI build retains legal comments in `dist/cli.js.LEGAL.txt` when esbuild emits
them. Full ws and Zod licenses are shipped independently of comment emission.
Development dependencies are not part of the installed CLI unless their code is
included in the bundle, as with Zod.
