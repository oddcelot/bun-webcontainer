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

# cargo resolves the whole workspace, so these path dependencies must exist even though
# nothing we build uses them. Bun's own build also applies patches to them; we don't need those.
mkdir -p "$dir/vendor/lolhtml" "$dir/vendor/rust-argon2"
curl -fsSL "https://github.com/oven-sh/lol-html/archive/$LOLHTML_COMMIT.tar.gz" | tar xz --strip-components=1 -C "$dir/vendor/lolhtml"
curl -fsSL "https://github.com/sru-systems/rust-argon2/archive/$ARGON2_COMMIT.tar.gz" | tar xz --strip-components=1 -C "$dir/vendor/rust-argon2"

# Generated inputs that `bun bd --configure-only` would write.
mkdir -p "$dir/build/debug/codegen"
cp "$root/build_options.rs" "$dir/build/debug/codegen/"
(cd "$dir" && bun -e '
import { generateJsonByteClass } from "./scripts/build/jsonByteClass.ts";
import { generateXmlByteClass } from "./scripts/build/xmlByteClass.ts";
const cfg = { codegenDir: process.cwd() + "/build/debug/codegen" };
generateJsonByteClass(cfg);
generateXmlByteClass(cfg);')

# Minimal install; letting rust-toolchain.toml auto-install pulls ~11 cross targets, miri and clippy.
rustup toolchain list | grep -q "^$TOOLCHAIN" || rustup toolchain install "$TOOLCHAIN" --profile minimal -c rust-src

echo "setup-bun: ready at $dir ($BUN_BRANCH = upstream $BUN_COMMIT + $(ls "$root"/patches/bun/*.patch | wc -l | tr -d ' ') patches)"
