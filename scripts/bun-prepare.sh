#!/bin/sh
# Adds what the wasm builds need to a bun/ checkout that git doesn't track: the vendored crates cargo resolves,
# the generated inputs `bun bd --configure-only` would write, and the pinned toolchain. Run by setup-bun.sh and
# bun-upgrade.sh; safe to run again (vendored crates are refetched when their pinned commit changed).
# Usage: scripts/bun-prepare.sh [dir]   (default: ./bun)
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
. "$root/scripts/bun-pins.sh"
dir=${1:-$root/bun}

# cargo resolves the whole workspace, so these path dependencies must exist even though
# nothing we build uses them. Bun's own build also applies patches to them; we don't need those.
vendor() { # name repo commit
  [ "$(cat "$dir/vendor/$1/.pinned" 2>/dev/null)" = "$3" ] && return
  rm -rf "$dir/vendor/$1"
  mkdir -p "$dir/vendor/$1"
  curl -fsSL "https://github.com/$2/archive/$3.tar.gz" | tar xz --strip-components=1 -C "$dir/vendor/$1"
  echo "$3" > "$dir/vendor/$1/.pinned"
}
vendor lolhtml oven-sh/lol-html "$LOLHTML_COMMIT"
vendor rust-argon2 sru-systems/rust-argon2 "$ARGON2_COMMIT"

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
