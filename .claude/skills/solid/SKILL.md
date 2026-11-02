---
name: solid
description:
  Use when writing or changing SolidJS 2 code in apps/playground/src/ui (any .tsx in the playground),
  or debugging Solid dev warnings, reactivity, stores, async boundaries, refs, or the Solid Vite
  plugin. Solid 2 is not 1.x and
  not React; read this before generating Solid code.
---

# Solid 2 in the playground

The playground interface is Solid 2 (moved from hand-built DOM in epic `bwc-k4r`). UI code lives in
`apps/playground/src/ui/`.

**Training data is mostly Solid 1.x and React. Both are wrong here.** Before writing code, read
[references/CHEATSHEET.md](references/CHEATSHEET.md) (its last section, the "footgun list", at
minimum). Check anything unclear against the references below, not memory.

## Versions and packages

Pinned exact (release candidate; the Solid docs ask for exact pins):

| Package                | Version          | Holds                                                                   |
| ---------------------- | ---------------- | ----------------------------------------------------------------------- |
| `solid-js`             | `2.0.0-rc.19`    | signals, memos, effects, stores, control flow, context, `action`, async |
| `@solidjs/web`         | `2.0.0-rc.19`    | `render`, `Portal`, `dynamic`, the JSX types (`JSX`, `ComponentProps`)  |
| `@solidjs/vite-plugin` | `3.0.0-next.52`  | Vite 8 plugin; compiles JSX with the Oxc-based `@solidjs/compiler`      |

`solid-js/web`, `solid-js/store`, `vite-plugin-solid` and `jsxImportSource: "solid-js"` are 1.x;
don't use them. `tsconfig.json` has `"jsx": "preserve"` and `"jsxImportSource": "@solidjs/web"`.
Bumping Solid: update all three together, re-vendor `references/` from the matching tag
(`documentation/solid-2.0/` and `packages/solid/CHEATSHEET.md` in solidjs/solid), and re-run the
checks below.

## The rules that bite most

- **Reads lag writes.** `setX(v); x()` still returns the old value until the microtask flush
  (or `flush()`). No `batch`. A later store setter's draft does see earlier unflushed writes, so
  derive the next state inside the setter, not from a read.
- **`createEffect(compute, apply)`** is the only form. Compute tracks and returns a value; apply
  does side effects and returns its cleanup. No `on()`, no single-function effect. Whatever
  apply returns is called as cleanup, so `v => list.push(v)` crashes the scheduler (`u is not a
  function`) on the next run: give apply a block body.
- **No writes in owned scope.** Setting a signal or store inside a memo, effect compute or
  component body throws in dev (`untrack` doesn't help), and so does setup code run inside
  `createRoot` (seed the initial value instead of calling a setter). Write from event handlers,
  `onSettled`, effect apply, or `action`s.
- **Props are values.** Pass `value={count()}`, not `value={count}`. Read `props.x`; never
  destructure props or read them at the top of a component body.
- **Lifecycle:** `onSettled(() => { ...; return cleanup })` replaces `onMount` + `onCleanup`.
  Ref callbacks are unowned: no `onCleanup` or primitives inside them.
- **Stores:** `setStore(s => { s.a.b = 1; s.list.push(x) })` (draft-first; `produce` is gone),
  `snapshot(store)` for plain values, `reconcile(data, "id")` to merge fetched data. Assigning a
  fresh object over an existing one (`t.response = card`) warns `IMMUTABLE_UPDATE_IN_STORE`; use
  `reconcile(card)(t.response)`.
- **Lists:** `<For each>` gives `(item, i)` with `item` a value and `i()` an accessor;
  `<For keyed={false}>` gives `item()` an accessor and `i` a number. `Index` is gone.
  Function children of `For`/`Show`/`Match` are owners, not tracking scopes: read accessors in JSX.
- **A throw in an effect's apply halts the whole page** (`REACTIVITY_HALTED`: no update runs
  again). createEffect's `error` option does not catch it; it only covers the compute step.
  Wrap applies that call into libraries with `guarded()` (`apps/playground/src/ui/guarded.ts`).
  Errors that were harmless in a click handler become fatal once they run in an effect.
- **Actions hold their frame.** Every write flushed together with an action's writes (including
  ones from a microtask that runs before Solid's flush) stays invisible until the action settles.
  For long work whose progress must show live (console counts during Run), start the action, call
  `flush()`, then start the work and hand the action its promise; see `task` in
  `apps/playground/src/ui/session.ts`.
- **Async:** a memo may return a Promise; wrap readers in `<Loading>`. `isPending(() => x())`
  for "updating…". `<Errored>` catches. No `createResource`, `Suspense`, `ErrorBoundary`.
- **DOM:** `class={["base", { active: on() }]}` (no `classList`, no string-building), lowercase
  attributes (`tabindex`), camelCase events bound once (`onClick={e => (c() ? a : b)(e)}` to
  switch), `ref={[a, b(opts)]}` directive factories (no `use:`), booleans are presence/absence.
- **Context is the provider:** `<Ctx value={...}>`. A default-less `createContext<T>()` makes
  `useContext` return `T` and throw without a provider; no `useX` wrapper hooks.

## Conventions for this codebase

- **Layout:** `src/ui/App.tsx` is the whole page, rendered once into `<body>` by `mountUI`
  (`src/ui/mount.tsx`), which first removes index.html's static header (kept for crawlers;
  `render()` appends). `main.ts` creates the stores (`session.ts`, `workspace.ts`, `previews.ts`)
  in a `createRoot` and passes them with its actions through `AppContext` (`context.ts`).
- **Engine stays plain TypeScript.** `VFS`, `Runner`, the worker, shell, install, share encoding
  are not UI; don't rewrite them as components. Bridge their events into Solid instead:
  - push events (`vfs.onChange`, runner logs, the theme controller): subscribe in `onSettled` and
    write into a store or signal, returning the unsubscribe. Avoid `createMemo(() => from(...))`
    for state that a click changes in several synchronous steps: the theme picker built that way
    showed a blank select after some picks (see `ui/ThemePicker.tsx`).
  - one-shot async (loading an example, fetching a repo): an `action(function* () {...})`, with
    `Loading`/`isPending` for UI state rather than hand-rolled status flags.
- **App state** (status, open tabs, console counts, theme) lives in a store created inside `App`
  and handed down with a default-less context, not at module scope.
- **Imperative islands** (xterm console, `@pierre/diffs` editors, `@pierre/trees`, the preview
  iframes): a component owns a `let el!: HTMLDivElement` ref, creates the instance in
  `onSettled` and returns its `dispose`; push reactive inputs with
  `createEffect(() => props.x, x => instance.set(x))`. Use a ref directive factory when the
  behavior is reused on several elements. See the project's `trees` and `diffs` skills for those
  APIs.
- **Icons and styles:** UnoCSS scans `.tsx`, so `<i class="i-lucide-play" aria-hidden="true" />`
  works as before. Keep the existing class names and `style.css`; this port changes structure,
  not the look.
- **Accessibility:** keep the roles, `aria-*`, `popover`/`popovertarget` and `hidden` semantics
  the current markup has.

## Checking work

```bash
(cd playground && bunx tsc --noEmit && bun run build)
(cd playground && bun run dev)   # port may not be 5173 if another server holds it; read the log
```

In Chrome: the page loads, Run starts the demo and the preview shows, and the console has no Solid
dev warnings or errors. Each diagnostic has a code; look it up in
[references/08-dev-diagnostics.md](references/08-dev-diagnostics.md) or in the repair guide
`solid-js` ships at `apps/playground/node_modules/solid-js/skills/reactivity-diagnostics/SKILL.md`
(the warnings link to it). A common one here: an imperative library callback fired from inside an
effect's apply (e.g. `tree.select()` → `onSelectionChange`) that reads a store is
`STRICT_READ_UNTRACKED`; keep the value the effect applied in a local and read that.

## References (vendored, rc.19)

| Topic                                              | File                                                                               |
| -------------------------------------------------- | ---------------------------------------------------------------------------------- |
| One-page API + 1.x corrections                     | [CHEATSHEET.md](references/CHEATSHEET.md)                                          |
| 1.x → 2.0 migration, rename/removal map            | [MIGRATION.md](references/MIGRATION.md)                                            |
| Batching, `flush`, split effects, `onSettled`      | [01-reactivity-batching-effects.md](references/01-reactivity-batching-effects.md) |
| Derived signals, ownership, `createRoot`, context  | [02-signals-derived-ownership.md](references/02-signals-derived-ownership.md)     |
| `For`/`Repeat`/`Show`/`Switch`/`Loading`/`Errored` | [03-control-flow.md](references/03-control-flow.md)                               |
| Stores, `reconcile`, `createProjection`, `deep`    | [04-stores.md](references/04-stores.md)                                           |
| Async memos, `isPending`, `latest`, `refresh`      | [05-async-data.md](references/05-async-data.md)                                   |
| `action`, `createOptimistic(Store)`, `affects`     | [06-actions-optimistic.md](references/06-actions-optimistic.md)                   |
| Attributes, events, `class`, refs, directives      | [07-dom.md](references/07-dom.md)                                                 |
| Dev warnings and their codes                       | [08-dev-diagnostics.md](references/08-dev-diagnostics.md)                         |
| JSX types and `jsxImportSource`                    | [09-typescript-jsx.md](references/09-typescript-jsx.md)                           |

Server functions, server components and SSR (RFCs 10–12) are left out: the playground is a
client-only app.
