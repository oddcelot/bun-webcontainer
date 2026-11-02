# Shell tools the agents (and AGENTS.md) rely on; `brew bundle` installs them. Language toolchains are in .prototools.
brew "sd"          # find-and-replace that behaves the same on macOS and Linux (no BSD-sed quirks)
brew "ast-grep"    # structural search/rewrite for Rust, TS and TSX
brew "wasm-tools"  # inspect .wasm: imports/exports, sections, validation (wasm64 too)
brew "lychee"      # link checker for the built docs site (moon run docs:links)
brew "typos-cli"   # source-aware spell checker (`typos`)
brew "betterleaks" # secret scanner over the git history (moon run root:secrets; CI: .github/workflows/secrets.yml)
brew "hyperfine"   # command benchmarks
cargo "twiggy"         # what takes up space in a .wasm
cargo "cargo-machete"  # unused Cargo dependencies
