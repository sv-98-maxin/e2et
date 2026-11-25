#!/usr/bin/env bash
# schema + 纯 renderIR byte compare；不调用带 trace gate 的公开 CLI。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
"$ROOT/node_modules/esbuild/bin/esbuild" "$ROOT/scripts/render-check.ts" \
  --bundle --platform=node --format=esm --outfile="$TMP/render-check.mjs"
node "$TMP/render-check.mjs" "${1:-$ROOT}"
