#!/bin/sh
# Recreates bun/: the pinned upstream commit with patches/bun/ applied as commits on the
# wasm-experiment branch, plus the vendored crates and generated files the wasm builds need.
# Usage: scripts/setup-bun.sh [dir]   (default: ./bun)
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
. "$root/scripts/bun-pins.sh"
dir=${1:-$root/bun}

if [ -e "$dir" ]; then
  echo "setup-bun: $dir already exists; remove it first" >&2
  exit 1
fi

git init -q "$dir"
git -C "$dir" remote add origin https://github.com/oven-sh/bun.git
git -C "$dir" fetch -q --depth 1 origin "$BUN_COMMIT"
git -C "$dir" checkout -q -b "$BUN_BRANCH" FETCH_HEAD
# Keep the series' authors and dates; fall back to a placeholder committer if git has no identity.
git -C "$dir" -c user.name="$(git config user.name || echo setup-bun)" -c user.email="$(git config user.email || echo setup-bun@localhost)" \
  am -q --committer-date-is-author-date "$root"/patches/bun/*.patch

"$root/scripts/bun-prepare.sh" "$dir"

echo "setup-bun: ready at $dir ($BUN_BRANCH = upstream $BUN_COMMIT + $(ls "$root"/patches/bun/*.patch | wc -l | tr -d ' ') patches)"
