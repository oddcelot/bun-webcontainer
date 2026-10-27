#!/bin/sh
# Build crates for wasm64 and summarize errors. Usage: w64.sh [crate...]
cd "$(dirname "$0")/../bun" || exit 1
[ $# -eq 0 ] && set -- bun_semver
pkgs=""; for c in "$@"; do pkgs="$pkgs -p $c"; done
cargo +nightly-2026-09-15 build $pkgs -Zbuild-std=std,panic_abort \
  --target wasm64-unknown-unknown --message-format=short > /tmp/w64.log 2>&1
status=$?
grep -E "(error|warning)(\[|:)" /tmp/w64.log | grep -v "^warning: build failed" | head -${N:-60}
grep -E "could not compile|Finished" /tmp/w64.log
exit $status
