# Changelog

Notable changes per release of runbun: the playground at runbun.dev, the Bun runtime and toolchain it runs in the
browser, its editor, and the docs at docs.runbun.dev. They release together at one version (`version` in the root
`package.json`, tagged `v<version>`), organised by part. `@runbun/astro` keeps its own changelog in
[packages/astro/CHANGELOG.md](./packages/astro/CHANGELOG.md).

## 0.1.0 — 2026-11-04

The first tagged release of runbun. The playground learns `bun --watch`: saving restarts the running program, a crash or
a half-typed line no longer stops it, and the preview waits through a restart instead of erroring. Embeds get resizable
panes and an expanded view with the whole playground's layout, shortcuts show as proper key caps, and the docs lose
their dead GitHub links. Nothing needs action.

### Playground

- **Added** — **Restart on save, like `bun --watch`.** A Watch switch next to Auto-save (an embed's `watch` feature)
  restarts the running program when you save and clears the console. A crash no longer ends it: the status says the next
  save reruns the program. A save that leaves a syntax error, as auto-save does mid-word, keeps the program running
  until the code parses again.
- **Added** — **Open a file from the console.** A location in an error or a stack trace, such as `index.ts:3:7`, is a
  link to that line in the editor.
- **Added** — **Resize an embed's panes in both directions at once.** Dragging the corner where the editor, preview and
  console meet moves both borders, in an embed and in its expanded view.
- **Changed** — **Shortcuts show as key caps.** Tooltips and the shortcuts dialog draw one cap per key, with icons for
  ⌘, ⌥, ⇧ and the other macOS symbols; other systems keep Ctrl, Alt and Shift. Shortcuts spelled out as text, like the
  Auto-save tooltip's, show as caps too, and that one follows your own binding for Save.
- **Fixed** — **Auto-height embeds no longer scroll their code.** An embed with `height="auto"` is as tall as its code
  again, on every tab and down to the half pixel, where a stacked one, or Chrome on a Retina screen, showed a scrollbar.
- **Fixed** — **An expanded embed has the whole playground's layout.** A stacked embed opens in its modal side by side,
  file tree included, and closing the modal brings back the inline view with its tabs as they were.

### Runtime

- **Fixed** — **The preview no longer errors while the server restarts.** A request made during a restart answered "No
  server running"; it now waits for the new server.

### Docs

- **Fixed** — **No more dead GitHub links in the docs.** The GitHub icon and the "Edit page" links led to a page readers
  couldn't open.
