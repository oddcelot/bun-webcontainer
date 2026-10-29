#!/bin/sh
# Keeps bun/ on Bun releases: the patch series in patches/bun/ follows release tags, not main.
#
#   scripts/bun-upgrade.sh --check [tag]   Is there a newer release (default: the latest), and do our patches apply
#                                          to it? Changes nothing. Exit: 0 up to date, 2 newer release and the
#                                          patches apply, 3 newer release but patches conflict, 1 error.
#   scripts/bun-upgrade.sh [tag]           Rebase bun/'s wasm-experiment branch onto the release, then --finish.
#   scripts/bun-upgrade.sh --finish        After resolving a rebase that stopped on a conflict (and
#                                          `git -C bun rebase --continue`): update the pins, vendored crates,
#                                          toolchains and the playground's version, export the patches, run the
#                                          wasm tests.
#   --no-test                              With an upgrade or --finish: skip the wasm builds and tests.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
. "$root/scripts/bun-pins.sh"
UPSTREAM=https://github.com/oven-sh/bun.git
bun="$root/bun"
target_file="$bun/.git/bun-upgrade-target"

say() { printf '%s\n' "$*"; }
die() { say "bun-upgrade: $*" >&2; exit 1; }

latest_tag() {
  git ls-remote --tags --refs "$UPSTREAM" 'bun-v*' | sed 's|.*refs/tags/||' |
    grep -E '^bun-v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1
}
# Whether version $1 is newer than $2.
newer() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" = "$1" ]; }
# A pinned commit in one of Bun's dependency scripts: dep_commit <file> <const name>.
dep_commit() { sed -n "s/.*$2 = \"\([0-9a-f]\{40\}\)\".*/\1/p" "$1" | head -1; }
channel() { sed -n 's/^channel = "\(.*\)"/\1/p' "$1" | head -1; }
# What a release changes besides the code: toolchain and vendored crates (<checkout dir>).
pin_changes() {
  t=$(channel "$1/rust-toolchain.toml")
  l=$(dep_commit "$1/scripts/build/deps/lolhtml.ts" LOLHTML_COMMIT)
  a=$(dep_commit "$1/scripts/build/deps/rust-argon2.ts" RUST_ARGON2_COMMIT)
  [ "$t" = "$TOOLCHAIN" ] || say "  toolchain: $TOOLCHAIN -> $t"
  [ "$l" = "$LOLHTML_COMMIT" ] || say "  lol-html: $LOLHTML_COMMIT -> $l"
  [ "$a" = "$ARGON2_COMMIT" ] || say "  rust-argon2: $ARGON2_COMMIT -> $a"
}
git_id() { git -c user.name="$(git config user.name || echo bun-upgrade)" -c user.email="$(git config user.email || echo bun-upgrade@localhost)" "$@"; }

check() {
  explicit=${1:-}
  tag=${explicit:-$(latest_tag)}
  [ -n "$tag" ] || die "no release tags found at $UPSTREAM"
  ver=${tag#bun-v}
  if [ -z "$explicit" ] && ! newer "$ver" "$BUN_VERSION"; then
    say "bun-upgrade: up to date (pinned ${BUN_TAG:-$BUN_COMMIT} is Bun $BUN_VERSION; latest release is $tag)"
    return 0
  fi
  if newer "$ver" "$BUN_VERSION"; then say "bun-upgrade: $tag is out (pinned: ${BUN_TAG:-$BUN_COMMIT}, Bun $BUN_VERSION)."; fi
  say "bun-upgrade: trying patches/bun on $tag…"

  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  git init -q "$tmp"
  # Borrow bun/'s objects when there is a checkout, so only what's new is downloaded.
  [ -d "$bun/.git/objects" ] && echo "$bun/.git/objects" > "$tmp/.git/objects/info/alternates"
  # The pinned commit too: `am -3` needs the blobs the patches were made against.
  git -C "$tmp" fetch -q --depth 1 "$UPSTREAM" "refs/tags/$tag:refs/tags/$tag" "$BUN_COMMIT"
  git -C "$tmp" -c advice.detachedHead=false checkout -q "$tag^{commit}"

  ok=0 bad=0
  for p in "$root"/patches/bun/*.patch; do
    if git_id -C "$tmp" am -q -3 "$p" >/dev/null 2>&1; then
      ok=$((ok + 1))
    else
      bad=$((bad + 1))
      files=$(git -C "$tmp" diff --name-only --diff-filter=U | tr '\n' ' ')
      say "  ✗ $(basename "$p"): ${files:-does not apply}"
      git -C "$tmp" am --skip >/dev/null 2>&1 || git -C "$tmp" am --abort >/dev/null 2>&1 || true
    fi
  done
  pin_changes "$tmp"
  if [ "$bad" -eq 0 ]; then
    say "bun-upgrade: all $ok patches apply to $tag. Upgrade with: scripts/bun-upgrade.sh $tag"
    return 2
  fi
  say "bun-upgrade: $bad of $((ok + bad)) patches conflict with $tag (later ones may only depend on an earlier conflict)."
  say "  Upgrade with: scripts/bun-upgrade.sh $tag, then resolve the rebase in bun/ and run --finish."
  return 3
}

upgrade() {
  [ -d "$bun/.git" ] || die "no bun/ checkout; run scripts/setup-bun.sh first"
  [ -z "$(git -C "$bun" status --porcelain --untracked-files=no)" ] || die "bun/ has uncommitted changes"
  [ "$(git -C "$bun" branch --show-current)" = "$BUN_BRANCH" ] || die "bun/ is not on $BUN_BRANCH"
  # Patches must match the branch, or the rebase would carry work patches/bun/ doesn't have.
  commits=$(git -C "$bun" rev-list --count "$BUN_COMMIT..$BUN_BRANCH")
  [ "$commits" = "$(ls "$root"/patches/bun/*.patch | wc -l | tr -d ' ')" ] ||
    die "bun/ has $commits commits but patches/bun/ doesn't match; run scripts/export-bun-patches.sh"

  tag=${1:-$(latest_tag)}
  if [ -z "${1:-}" ] && ! newer "${tag#bun-v}" "$BUN_VERSION"; then
    say "bun-upgrade: already on Bun $BUN_VERSION ($tag is the latest release)"
    return 0
  fi
  say "bun-upgrade: rebasing $BUN_BRANCH from ${BUN_TAG:-$BUN_COMMIT} onto $tag…"
  git -C "$bun" fetch -q --depth 1 origin "refs/tags/$tag:refs/tags/$tag"
  echo "$tag" > "$target_file"
  if ! git_id -C "$bun" rebase -q --onto "$tag^{commit}" "$BUN_COMMIT" "$BUN_BRANCH"; then
    say ""
    say "bun-upgrade: the rebase stopped on a conflict. In bun/: fix the files, \`git add\` them,"
    say "  \`git rebase --continue\` (repeat), then run: scripts/bun-upgrade.sh --finish"
    say "  To give up: git -C bun rebase --abort && rm $target_file"
    return 3
  fi
  finish
}

set_pin() { sed "s|^$1=[^ ]*|$1=$2|" "$root/scripts/bun-pins.sh" > "$root/scripts/bun-pins.sh.tmp" && mv "$root/scripts/bun-pins.sh.tmp" "$root/scripts/bun-pins.sh"; }

finish() {
  [ -f "$target_file" ] || die "no upgrade in progress"
  [ ! -d "$bun/.git/rebase-merge" ] && [ ! -d "$bun/.git/rebase-apply" ] || die "the rebase in bun/ isn't finished"
  tag=$(cat "$target_file")
  new=$(git -C "$bun" rev-parse "$tag^{commit}")
  git -C "$bun" merge-base --is-ancestor "$new" "$BUN_BRANCH" || die "$BUN_BRANCH isn't based on $tag"
  ver=${tag#bun-v}
  toolchain=$(channel "$bun/rust-toolchain.toml")

  set_pin BUN_COMMIT "$new"
  set_pin BUN_TAG "$tag"
  set_pin BUN_VERSION "$ver"
  set_pin LOLHTML_COMMIT "$(dep_commit "$bun/scripts/build/deps/lolhtml.ts" LOLHTML_COMMIT)"
  set_pin ARGON2_COMMIT "$(dep_commit "$bun/scripts/build/deps/rust-argon2.ts" RUST_ARGON2_COMMIT)"
  set_pin TOOLCHAIN "$toolchain"
  # The wrapper crates build with the same nightly as bun/.
  for f in "$root"/*-wasm/rust-toolchain.toml; do
    sed "s|^channel = \".*\"|channel = \"$toolchain\"|" "$f" > "$f.tmp" && mv "$f.tmp" "$f"
  done
  sed "s|BUN_VERSION = \".*\"|BUN_VERSION = \"$ver\"|" "$root/playground/src/worker/bunVersion.ts" > "$root/playground/src/worker/bunVersion.ts.tmp" &&
    mv "$root/playground/src/worker/bunVersion.ts.tmp" "$root/playground/src/worker/bunVersion.ts"

  "$root/scripts/bun-prepare.sh" "$bun"
  "$root/scripts/export-bun-patches.sh" > /dev/null
  rm -f "$target_file"
  say "bun-upgrade: bun/ is on $tag; pins, toolchains, version and patches/bun/ updated."

  if [ "$no_test" = 1 ]; then
    say "bun-upgrade: tests skipped (--no-test)"
  else
    run_tests "$toolchain"
  fi
  native=$(bun --version 2>/dev/null || echo none)
  [ "$native" = "$ver" ] || say "bun-upgrade: native bun is $native; \`bun upgrade\` to $ver so the tests compare like with like"
  say "bun-upgrade: review \`git status\`, then commit (e.g. \"bun: upgrade to $tag\")."
  [ "$tests_failed" = 0 ] || exit 1
}

run_tests() {
  W="-Zbuild-std=std,panic_abort --target wasm64-unknown-unknown --release"
  failed=""
  for d in semver-wasm transpile-wasm sys-wasm resolve-wasm bundle-wasm; do
    say "bun-upgrade: $d…"
    # shellcheck disable=SC2086
    if (cd "$root/$d" && cargo +"$1" build $W -q && node test.mjs > "/tmp/bun-upgrade-$d.log" 2>&1); then
      say "  ok"
    else
      failed="$failed $d"
      say "  FAILED (see /tmp/bun-upgrade-$d.log)"
    fi
  done
  if [ -z "$failed" ]; then say "bun-upgrade: all wasm tests pass"; else say "bun-upgrade: failing:$failed"; tests_failed=1; fi
}

no_test=0 tests_failed=0 mode=upgrade arg=""
for a in "$@"; do
  case "$a" in
    --check) mode=check ;;
    --finish) mode=finish ;;
    --no-test) no_test=1 ;;
    -*) die "unknown option $a" ;;
    *) arg=$a ;;
  esac
done
case "$mode" in
  check) check "$arg" ;;
  finish) finish ;;
  upgrade) upgrade "$arg" ;;
esac
