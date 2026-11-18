# bundle-wasm: `Bun.build` plugins

## How native Bun runs them

The bundler (bun/src/bundler/bundle_v2.rs) asks `JSBundlerPlugin__anyMatches` whether a filter matches an import or
file. If one does, it builds a `Resolve` / `Load` request and `dispatch`es it to the JS thread
(`enqueue_on_js_loop_for_plugins`), which calls `JSBundlerPlugin__matchOnResolve` / `__matchOnLoad` (C++, then
`runOnResolvePlugins` / `runOnLoadPlugins` in bun/src/js/builtins/BundlerPlugin.ts). The answer comes back via
`on_resolve_async` / `on_load_async`, which queue it on the bundle's own (Mini) loop, and `wait_for_parse` ticks that
loop until no work is left. Hooks run concurrently with parsing, and async hooks just answer later.

On wasm there is one thread and no JSC: no JS loop to hop to, and `BunString` needs C++.

## Design: inline requests, JSPI for async hooks

- bun patch `bundler: plugin hooks over byte slices, inline on wasm` (cfg `target_family = "wasm"`):
  - `Plugin::{has_any_matches, match_on_load, match_on_resolve}` call `JSBundlerPlugin__wasm*` with UTF-8 byte
    slices instead of `BunString`s;
  - `Resolve::dispatch` / `Load::dispatch` call `run_on_js_thread` right away instead of posting to a JS loop. The
    answer still goes through `on_*_async`, so it lands on the Mini loop's queue as on native;
  - `BundleV2::init` takes the plugins from `WASM_PLUGINS` (set by this crate around `generate_from_cli`).
- This crate (src/plugins.rs) implements `JSBundlerPlugin__wasm*` over `bun_plugin.*` imports: `any_matches`
  (synchronous, the filters are JS RegExps), `resolve` / `load` (return the answer's length) and `take` (copies it in).
- The host (apps/playground/src/worker/buildPlugins.ts) ports BundlerPlugin.ts: `setup`, `onStart`, the
  onResolve/onLoad chains with Bun's validation and messages, and `onEnd`. runtime.ts `build()` runs `setup` before
  reading the options (as `Config::from_js` does), and `onEnd` with the result.

Async hooks: options considered, in order of preference:

1. **JSPI (chosen).** `resolve` and `load` are `WebAssembly.Suspending` imports and `bundle_c` runs through
   `WebAssembly.promising`: an async hook suspends the bundler until it settles; a sync hook doesn't suspend at all.
   It needs no change to how the bundle is driven, keeps the plugins in the worker that owns them (functions can't be
   posted to another worker), and costs nothing when there are no plugins. Chrome/Edge 137+ have JSPI (Firefox: behind
   a pref, planned on by default). Without it, the imports are plain functions and a hook that returns a pending
   promise fails its request with an error naming JSPI.
2. A dedicated bundler worker blocking with `Atomics.wait` while the program's worker runs the hook (as spawnSync
   does). Works without JSPI but needs cross-origin isolation (no Safari, embeds without `allow`), a second copy of the
   VFS view, and the plugin hooks would still run in the program's worker: more moving parts for the same result.
3. An iterative pre-pass (bundle, collect unanswered requests, run hooks, rebundle): can't express onLoad results that
   import further plugin-matched modules without many passes, and changes ordering. Rejected.

## Differences from native

- Requests run one at a time, in the order the bundler meets them (native runs hooks in parallel with parsing). Output
  is the same; the order hooks are *called* in can differ.
- `onLoad`'s `.defer()` throws: with one request at a time there are no other loads to wait for.
  (`JSBundlerPlugin__drainDeferred` is a no-op for that reason.)
- No `onBeforeParse` (native addons). `build.resolve()` / `onDispose` throw as in Bun.

Tested by apps/playground/scripts/build-plugins.ts (`moon run playground:test-build-plugins`) against native Bun.
