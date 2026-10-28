#!/bin/sh
# Fails when bun/ has changes that patches/bun/ doesn't record. No-op without a bun/ checkout.
set -eu
# A hook inherits the outer commit's git environment (`commit -a` sets GIT_INDEX_FILE to a temp index); bun/ is its own repo.
unset GIT_INDEX_FILE GIT_DIR GIT_WORK_TREE GIT_PREFIX
root=$(cd "$(dirname "$0")/.." && pwd)
. "$root/scripts/bun-pins.sh"
bun="$root/bun"
[ -d "$bun/.git" ] || exit 0

if [ -n "$(git -C "$bun" status --porcelain --untracked-files=normal -- src)" ]; then
  echo "check-bun-patches: bun/src has uncommitted changes. Commit them on $BUN_BRANCH, then run scripts/export-bun-patches.sh" >&2
  git -C "$bun" status --short -- src | head -10 >&2
  exit 1
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
"$root/scripts/export-bun-patches.sh" "$tmp" >/dev/null
if ! diff -rq "$tmp" "$root/patches/bun" >/dev/null 2>&1; then
  echo "check-bun-patches: patches/bun/ is out of date with bun/'s $BUN_BRANCH branch. Run scripts/export-bun-patches.sh" >&2
  diff -rq "$tmp" "$root/patches/bun" >&2 || true
  exit 1
fi
