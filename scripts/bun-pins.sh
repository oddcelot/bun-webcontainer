# shellcheck shell=bash disable=SC2034  # sourced: the pins are read by the scripts that source this file
# Sourced by the bun scripts. Upstream Bun commit the patch series in patches/bun/ applies to.
# scripts/bun-upgrade.sh rewrites this file; follow releases (BUN_TAG), not main.
BUN_COMMIT=7942008688acad538e64933b82465dc614fe7536
BUN_TAG=                    # release tag BUN_COMMIT is (empty: a main commit after BUN_VERSION)
BUN_VERSION=1.4.4           # apps/playground/src/worker/bunVersion.ts
BUN_BRANCH=wasm-experiment
LOLHTML_COMMIT=725ce499aa9b71e38b7a2d0a9fbb6d7294a4079e   # bun/scripts/build/deps/lolhtml.ts
ARGON2_COMMIT=ed81866f163f0c7026aa6fd8388adf37242eb32a    # bun/scripts/build/deps/rust-argon2.ts
TOOLCHAIN=nightly-2026-09-15                              # bun/rust-toolchain.toml
