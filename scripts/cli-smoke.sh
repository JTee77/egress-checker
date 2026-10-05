#!/usr/bin/env bash
# CLI 冒烟：单测 + 切回文案自检 +（可选）debug 二进制 + 本地 Vite
#   bash scripts/cli-smoke.sh                     # 只跑单测
#   EGRESS_CLI_SMOKE=1 bash scripts/cli-smoke.sh  # 再跑真实二进制（--mock，不切换节点）
# 注意：check current --mock 仍会经本机代理口做真实深测（含带宽抽样），会耗一定流量。
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== vitest cli + runner =="
pnpm exec vitest run src/lib/cli src/lib/runner

echo "== restore 文案自检 =="
node scripts/simulate-restore-fail.mjs

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

# 只结束本仓库编译出的 CLI 进程（不碰 Vite、不碰代理软件）。
kill_cli() { pkill -f 'target/(debug|release)/egress-checker' 2>/dev/null || true; }

STARTED_VITE=0
cleanup() {
  kill_cli
  if [[ "$STARTED_VITE" == "1" && -f /tmp/egress-vite-cli.pid ]]; then
    kill "$(cat /tmp/egress-vite-cli.pid)" 2>/dev/null || true
    rm -f /tmp/egress-vite-cli.pid
  fi
}
trap cleanup EXIT

kill_cli
# debug 二进制从 Vite 加载前端
if ! curl -sf -o /dev/null http://127.0.0.1:1420/; then
  echo "starting vite…"
  pnpm dev > /tmp/egress-vite-cli.log 2>&1 &
  echo $! > /tmp/egress-vite-cli.pid
  STARTED_VITE=1
  for _ in $(seq 1 40); do
    curl -sf -o /dev/null http://127.0.0.1:1420/ && break
    sleep 1
  done
fi

run_to() { perl -e 'alarm shift; exec @ARGV' "$1" "${@:2}"; }

# expect_cli <期望退出码> <期望 stdout 片段> <超时秒> <参数…>
expect_cli() {
  local want_code="$1" want_text="$2" to="$3"
  shift 3
  local out code
  set +e
  out=$(run_to "$to" "$BIN" --cli "$@")
  code=$?
  set -e
  echo "\$ egress-checker --cli $* → exit ${code}"
  echo "$out" | head -c 600
  echo
  if [[ "$code" != "$want_code" ]]; then
    echo "FAIL: 期望退出码 ${want_code}，实际 ${code}" >&2
    exit 1
  fi
  if ! grep -qF -- "$want_text" <<<"$out"; then
    echo "FAIL: 输出里没有：${want_text}" >&2
    exit 1
  fi
}

echo "== help =="
expect_cli 0 "Egress Checker CLI 0.1.16" 60 help --no-json

echo "== 未知命令 / 未知选项 / 非法 client → ok:false + exit 1 =="
expect_cli 1 '"code":"unknown_command"' 60 frobnicate
expect_cli 1 '"code":"unknown_option"' 60 discover --mock --verbose
expect_cli 1 '"code":"client_unsupported"' 60 discover --mock -c flclash
expect_cli 1 '"code":"client_required"' 60 gate

echo "== discover --mock =="
expect_cli 0 '"ok":true' 60 discover --mock --json

echo "== discover --mock --no-json（人类摘要）=="
expect_cli 0 "✓ discover 完成" 60 discover --mock --no-json

echo "== gate --mock =="
expect_cli 0 '"ok":true' 90 gate --mock --json

echo "== check current --mock =="
expect_cli 0 '"target":"current"' 180 check current --mock --json

echo "OK cli smoke"
