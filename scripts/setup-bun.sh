#!/bin/sh
# Recreates the patched Bun checkout the wasm crates build against.
# Usage: scripts/setup-bun.sh [dir]   (default: ./bun)
set -eu

BUN_COMMIT=7942008688acad538e64933b82465dc614fe7536
LOLHTML_COMMIT=725ce499aa9b71e38b7a2d0a9fbb6d7294a4079e   # scripts/build/deps/lolhtml.ts
ARGON2_COMMIT=ed81866f163f0c7026aa6fd8388adf37242eb32a    # scripts/build/deps/rust-argon2.ts
TOOLCHAIN=nightly-2026-09-15                              # bun's rust-toolchain.toml

root=$(cd "$(dirname "$0")/.." && pwd)
dir=${1:-$root/bun}

if [ -e "$dir" ]; then
  echo "setup-bun: $dir already exists; remove it first" >&2
  exit 1
fi

git init -q "$dir"
git -C "$dir" remote add origin https://github.com/oven-sh/bun.git
git -C "$dir" fetch -q --depth 1 origin "$BUN_COMMIT"
git -C "$dir" checkout -q FETCH_HEAD
git -C "$dir" apply "$root/bun-wasm.patch"

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

echo "setup-bun: ready at $dir (bun $BUN_COMMIT + bun-wasm.patch)"
