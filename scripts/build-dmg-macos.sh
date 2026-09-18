#!/usr/bin/env bash
# Build unsigned arm64 .app / .dmg for Apple Silicon Macs.
# Must run on macOS (Apple Silicon). Linux CI cannot produce a real DMG.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: this script must run on macOS (Apple Silicon)." >&2
  echo "On Linux you can still run: pnpm typecheck && pnpm build (frontend only)." >&2
  exit 1
fi

ARCH="$(uname -m)"
if [[ "$ARCH" != "arm64" ]]; then
  echo "warning: host arch is $ARCH; product targets Apple Silicon (arm64) only." >&2
fi

command -v pnpm >/dev/null || { echo "pnpm required"; exit 1; }
command -v rustc >/dev/null || { echo "rustc/cargo required"; exit 1; }

pnpm install
pnpm tauri build

echo
echo "Artifacts (typical):"
echo "  src-tauri/target/release/bundle/macos/Egress Checker.app"
echo "  src-tauri/target/release/bundle/dmg/*.dmg"
echo
echo "Unsigned / not notarized: first open may need 右键 → 打开 (Right-click → Open)."
echo "Apple Silicon (arm64) only."
