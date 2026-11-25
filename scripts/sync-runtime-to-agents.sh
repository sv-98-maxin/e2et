#!/usr/bin/env bash
# 同步 runtime + shared → 核心镜像，供随包分发。
# SSOT 是 runtime/，镜像只读。零差异，否则 exit 1。
#
# 同步目标：
#   runtime/         → runtime_assets/runtime/       (随包回放)
#   runtime/shared/  → src/shared/                   (核心 CLI 编译输入)
#   runtime/shared/  → runtime_assets/runtime/shared/ (由 runtime 镜像自然覆盖)
#
# 排除：node_modules/、__tests__/、test-results/（随包镜像不含单测与产物）
# cases 是业务验证数据，不进入核心发布包。
#
# 两个 shared 源文件必须非空；两镜像缺失/差异/多余都拒绝。
#
# 跑法：
#   bash scripts/sync-runtime-to-agents.sh            # 同步并校验
#   bash scripts/sync-runtime-to-agents.sh --dry-run   # 只比对，不写
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_RUNTIME="$ROOT/runtime"
SRC_SHARED="$ROOT/runtime/shared"
DEST="$ROOT/runtime_assets"
DEST_CLI_SHARED="$ROOT/src/shared"

if [[ ! -d "$SRC_RUNTIME" ]]; then
  echo "❌ 源缺失: $SRC_RUNTIME" >&2
  exit 1
fi
# shared 源文件必须存在且非空
for f in assertion.ts template.ts; do
  fp="$SRC_SHARED/$f"
  if [[ ! -f "$fp" ]]; then
    echo "❌ shared 源缺失: $fp" >&2
    exit 1
  fi
  if [[ ! -s "$fp" ]]; then
    echo "❌ shared 源为空: $fp" >&2
    exit 1
  fi
done

DRY_RUN=0
if [[ $# -gt 1 ]] || { [[ $# -eq 1 ]] && [[ "$1" != "--dry-run" ]]; }; then
  echo "用法: bash scripts/sync-runtime-to-agents.sh [--dry-run]" >&2
  echo "  无参       实同步并校验" >&2
  echo "  --dry-run 只比对，不写" >&2
  exit 2
fi
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
fi

# 临时构建期望镜像，与现有 DEST 逐字节比对，零差异才放行。
# 镜像只含文件（无空目录），CI 镜像没有 rsync，用 find + cp 构建。
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/runtime" "$TMP/cli-shared"
# runtime：镜像 .ts/.json/.html，排除 __tests__/node_modules/test-results
(
  cd "$SRC_RUNTIME"
  find . \( -name node_modules -o -name __tests__ -o -name test-results \) -prune -o -type f \
    ! -name '.DS_Store' \
    \( -name '*.ts' -o -name '*.json' -o -name '*.html' -o -name 'native-dom-source.LICENSE' \) -print0
) | while IFS= read -r -d '' rel; do
  mkdir -p "$TMP/runtime/${rel%/*}"
  cp -p "$SRC_RUNTIME/$rel" "$TMP/runtime/$rel"
done

# CLI shared 镜像：仅 .ts（与源 shared 一致）
(
  cd "$SRC_SHARED"
  find . -type f -name '*.ts' -print0
) | while IFS= read -r -d '' rel; do
  mkdir -p "$TMP/cli-shared/${rel%/*}"
  cp -p "$SRC_SHARED/$rel" "$TMP/cli-shared/$rel"
done
# ── 比对 ──
if [[ "$DRY_RUN" -eq 1 ]]; then
  if [[ ! -d "$DEST" ]]; then
    echo "❌ --dry-run：镜像目录不存在: $DEST（未同步或被删）"
    exit 1
  fi
  if [[ -e "$DEST/cases" ]]; then
    echo "❌ --dry-run：核心镜像仍包含业务 cases: $DEST/cases"
    exit 1
  fi
  if ! diff -r --no-dereference "$TMP/runtime" "$DEST/runtime" >/dev/null 2>&1; then
    echo "❌ --dry-run：runtime/ 镜像与源不一致"
    diff -r --no-dereference "$TMP/runtime" "$DEST/runtime" >&2 || true
    exit 1
  fi
  # CLI shared 镜像逐字节比对
  if [[ ! -d "$DEST_CLI_SHARED" ]]; then
    echo "❌ --dry-run：CLI shared 镜像目录不存在: $DEST_CLI_SHARED"
    exit 1
  fi
  if ! diff -r --no-dereference "$TMP/cli-shared" "$DEST_CLI_SHARED" >/dev/null 2>&1; then
    echo "❌ --dry-run：src/shared/ 镜像与源不一致"
    diff -r --no-dereference "$TMP/cli-shared" "$DEST_CLI_SHARED" >&2 || true
    exit 1
  fi
  echo "✅ --dry-run：runtime 与 shared 镜像零差异"
  exit 0
fi

# ── 实同步：用刚构建的镜像整目录替换，保证可重复 ──
rm -rf "$DEST"
mkdir -p "$DEST/runtime"
cp -a "$TMP/runtime/." "$DEST/runtime/"

# CLI shared 镜像
rm -rf "$DEST_CLI_SHARED"
mkdir -p "$DEST_CLI_SHARED"
cp -a "$TMP/cli-shared/." "$DEST_CLI_SHARED/"

# 同步后立即复验零差异
if ! diff -r --no-dereference "$TMP/runtime" "$DEST/runtime" >/dev/null 2>&1; then
  echo "❌ 同步后 runtime/ 仍有差异（脚本 bug）"
  diff -r --no-dereference "$TMP/runtime" "$DEST/runtime" >&2 || true
  exit 1
fi
if ! diff -r --no-dereference "$TMP/cli-shared" "$DEST_CLI_SHARED" >/dev/null 2>&1; then
  echo "❌ 同步后 src/shared/ 仍有差异（脚本 bug）"
  diff -r --no-dereference "$TMP/cli-shared" "$DEST_CLI_SHARED" >&2 || true
  exit 1
fi
RT_COUNT=$(find "$DEST/runtime" -type f | wc -l | tr -d ' ')
CS_COUNT=$(find "$DEST_CLI_SHARED" -type f | wc -l | tr -d ' ')
echo "✅ runtime 镜像同步: runtime/$RT_COUNT 文件, cli-shared/$CS_COUNT 文件"
