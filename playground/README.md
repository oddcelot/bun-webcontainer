# Bun playground

Primitive in-browser "Bun" playground: user code runs in a module Web Worker with a shimmed `Bun` global.

## Run

    bun install
    bun run dev        # copies ../semver-wasm .wasm into public/, starts Vite on :5173
    bunx tsc --noEmit

Open http://localhost:5173 (Chrome; Memory64 wasm needed). The demo is a Bun fullstack app: `Bun.serve({ routes })` with an HTML import (`import homepage from "./index.html"`) whose `client.ts` imports `canvas-confetti` (installed automatically on load). Run restarts the worker and reloads the preview; "bun install" installs `package.json` deps into the VFS, or exactly what `bun.lock` lists when there is one. "Open folder" loads a project from disk (skipping `node_modules`); try `fixtures/lockfile-demo`, which needs nested installs and prints `width: 13` like real Bun.

## Architecture

    src/main.ts           UI: file tree, CodeMirror, console pane, buttons, SW registration
    src/vfs.ts            in-memory Map FS (read/write/list/exists/mkdir)
    src/demo.ts           seed project (index.ts, util.ts, package.json)
    src/runner.ts         owns the worker; bridges SW messages and worker RPC
    src/moduleServer.ts   VFS path -> JS: transpile TS/JSX, rewrite relative + bare specifiers to /__vfs/...
    src/transpiler/       Bun's transpiler as wasm64 (../transpile-wasm): transpile(source, path) => Promise<string>
    src/editors/          swappable editor (header "Editor" switch, remembered in localStorage):
                            codemirror.ts (default) and pierre.ts (@pierre/diffs File + edit-mode Editor, lazy-loaded)
    src/fileTree.ts       @pierre/trees file tree over the VFS (search, icons, One Dark theme); selecting a file opens it
    src/install.ts        no lockfile: registry fetch, semver pick (wasm), flat node_modules
    src/lockfile.ts       bun.lock (text format; tested with lockfileVersion 2 from Bun 1.4.4): locked versions, nested node_modules, sha512 integrity check
    src/semver.ts         loader for public/bun_semver_wasm.wasm (wasm64, BigInt pointers)
    src/worker/runtime.ts worker: Bun shim (serve, file, write, version, semver), console forwarding
    public/sw.js          service worker: /__vfs/*, /__preview/*, and absolute requests made by the preview page (so `fetch("/api/x")` reaches Bun.serve)

Data flow:

- Module: worker `import("/__vfs/index.ts")` -> SW -> (MessageChannel) page -> `serveModule` (transpile + import rewrite) -> SW -> worker.
- Preview: iframe `/__preview/x` -> SW -> page -> port transferred to worker -> `routes` match (exact, `:param`, `*`; HTML imports are served with their `<script src>`/`<link href>` pointed at /__vfs/), else user `fetch(Request)` -> Response serialized back on the same port.
- `Bun.file`/`Bun.write` -> RPC to page VFS. `console.*` -> postMessage -> console pane.

Bare imports use `node_modules/<pkg>/package.json` (`exports` with import/browser/module/default conditions, then `module`, `main`).

## Verification

Checked in Chrome only (via chrome-devtools MCP): Memory64 wasm instantiates and works. Safari and Firefox were NOT checked.

## Known limitations

- ESM-only packages; no CJS interop, no `node:` polyfills, no `exports` patterns (`./*`).
- Import rewriting is regex-based (can touch import-like text inside strings).
- Pierre editor: renders every line (no virtualization yet; `VirtualizedFile` would be needed for very large files) and has no autocomplete; undo history resets when switching files or editors.
- HTML imports are not bundled: each script/stylesheet loads as its own module from /__vfs/ (CSS is served as plain CSS; no CSS imports from JS).
- Install without a lockfile: root `dependencies`/`devDependencies` only, flat, first version wins; it doesn't write a `bun.lock`.
- Install from `bun.lock`: npm-registry packages only (git/tarball/workspace/file entries are skipped with an error); binary `bun.lockb` is not supported.
- No install scripts, no pax/GNU long tar names.
- Single tab only (SW picks one page); no persistence, HMR, or type checking in the editor.
- A hard refresh (bypassing the SW) leaves the page uncontrolled; reload normally.
- Dev only was exercised; `vite build` not tried.
