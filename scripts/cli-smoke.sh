#!/usr/bin/env bash
# CLI 冒烟：先单测 parse；若有 debug 二进制则跑 --cli help / discover --mock
set -euo pipefail
cd "$(dirname "$0")/.."
echo "== vitest cli =="
pnpm exec vitest run src/lib/cli/cli.test.ts

BIN="${CLI_BIN:-src-tauri/target/debug/egress-checker}"
if [[ ! -x "$BIN" ]]; then
  echo "SKIP binary smoke: $BIN not found (build with pnpm tauri build / cargo build)"
  exit 0
fi

echo "== $BIN --cli help --no-json =="
# CLI needs frontend assets; debug bin without vite may hang or show empty.
# Prefer invoking only if EGRESS_CLI_SMOKE=1 or release-like dist present.
if [[ "${EGRESS_CLI_SMOKE:-}" != "1" ]]; then
  echo "SKIP live binary smoke (set EGRESS_CLI_SMOKE=1 to run; needs vite or packaged frontend)"
  echo "Hint: EGRESS_CLI_SMOKE=1 pnpm tauri dev -- --cli discover --mock --json"
  exit 0
fi

timeout 90 "$BIN" --cli help --no-json | head -40
timeout 120 "$BIN" --cli discover --mock --json | head -c 2000
echo
