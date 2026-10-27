#!/bin/sh
# Writes the commits on bun/'s wasm-experiment branch to patches/bun/ as a patch series.
# Usage: scripts/export-bun-patches.sh [out-dir]   (default: patches/bun)
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
. "$root/scripts/bun-pins.sh"
out=${1:-$root/patches/bun}
bun="$root/bun"

[ -z "$(git -C "$bun" status --porcelain --untracked-files=no)" ] || {
  echo "export-bun-patches: bun/ has uncommitted changes; commit them on $BUN_BRANCH first" >&2
  exit 1
}

rm -rf "$out"
mkdir -p "$out"
# --no-numbered, --zero-commit and --no-signature keep each file byte-identical unless its own commit changed.
git -C "$bun" format-patch -q --no-numbered --zero-commit --no-signature -o "$out" "$BUN_COMMIT..$BUN_BRANCH"
ls "$out"
