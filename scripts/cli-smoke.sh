#!/usr/bin/env bash
# CLI 冒烟：单测 +（可选）debug 二进制 + 本地 Vite
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== vitest cli =="
pnpm exec vitest run src/lib/cli/cli.test.ts

if [[ "${EGRESS_CLI_SMOKE:-}" != "1" ]]; then
  echo "SKIP live binary smoke（需要前端）。完整自测："
  echo "  EGRESS_CLI_SMOKE=1 bash scripts/cli-smoke.sh"
  exit 0
fi

BIN="${CLI_BIN:-src-tauri/target/debug/egress-checker}"
if [[ ! -x "$BIN" ]]; then
  echo "building debug binary…"
  (cd src-tauri && cargo build)
fi

pkill -f 'egress-checker' 2>/dev/null || true
# ensure vite
if ! curl -sf -o /dev/null http://127.0.0.1:1420/; then
  echo "starting vite…"
  pnpm dev > /tmp/egress-vite-cli.log 2>&1 &
  echo $! > /tmp/egress-vite-cli.pid
  for i in $(seq 1 40); do
    curl -sf -o /dev/null http://127.0.0.1:1420/ && break
    sleep 1
  done
fi

run_to() { perl -e 'alarm shift; exec @ARGV' "$1" "${@:2}"; }

echo "== help --no-json =="
run_to 60 "$BIN" --cli help --no-json | head -20

echo "== discover --mock --json =="
out=$(run_to 60 "$BIN" --cli discover --mock --json)
echo "$out" | head -c 400
echo
echo "$out" | grep -q '"ok":true' 

echo "== gate --mock --json =="
out=$(run_to 90 "$BIN" --cli gate --mock --json)
echo "$out" | head -c 400
echo
echo "$out" | grep -q '"ok":true'

pkill -f 'egress-checker' 2>/dev/null || true
if [[ -f /tmp/egress-vite-cli.pid ]]; then
  kill "$(cat /tmp/egress-vite-cli.pid)" 2>/dev/null || true
  rm -f /tmp/egress-vite-cli.pid
fi
echo "OK cli smoke"
