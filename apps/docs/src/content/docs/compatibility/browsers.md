---
title: Browsers
description: "Running Bun in the browser needs WebAssembly Memory64: Chrome and Edge 133+ and Firefox 134+ run code, as does Safari Technology Preview; Safari and iOS are edit-only. What each browser feature is used for."
head:
  # The browser tab and search result title; the page heading stays `title`.
  - tag: title
    content: "Browser support: running Bun in Chrome, Firefox and Safari | Run Bun"
sidebar:
  order: 1
---

| Browser | Status | Tested |
|---|---|---|
| Chrome / Edge 133+ | ✅ Works | Chrome 156 |
| Firefox 134+ | ✅ Works | Firefox 157 |
| Safari (macOS) | 🟡 Edit only: no WebAssembly Memory64 yet | Safari 27.2 |
| Safari Technology Preview | ✅ Works: it has Memory64 | Safari Technology Preview (WebKit 27.0) |
| Any browser on iOS / iPadOS | 🟡 Edit only: all use Safari's engine | |
| Chrome / Firefox on Android | ❔ Untested | |

"Edit only" means you get the editor, examples and sharing, but can't run code. Safari Technology Preview already has Memory64 and runs code (the Elysia example installs and starts), so Safari should work once Memory64 ships there.

On a Mac, Safari can run code today through [local Bun](/guides/local-bun/): `bunx @runbun/connect --open` serves the playground and runs projects with the Bun installed on your machine. Checked in Safari 27.2 with the Elysia example and its preview.

## What the browser needs

Without these, the playground opens in edit-only mode, with a banner naming what's missing. Run, Install and the preview request bar are disabled.

| Feature | Why | Chrome | Firefox | Safari |
|---|---|---|---|---|
| WebAssembly Memory64 | Bun's crates are compiled to wasm64. | ✅ | ✅ | ❌ (Technology Preview: ✅) |
| Secure context (HTTPS) | Required by service workers. | ✅ | ✅ | ✅ |
| Service workers | Serve your modules (`/__vfs/`) and the preview (`/__preview/`), and keep the playground's own files (the wasm too) so a repeat visit downloads only what changed and the playground opens offline. Private windows may disable them. | ✅ | ✅ | ✅ |
| Module workers | Your code runs in a module Web Worker. | ✅ | ✅ | ✅ |

## Optional features

The playground uses these when the browser has them and works without them.

| Feature | Used for | Without it | Chrome | Firefox | Safari |
|---|---|---|---|---|---|
| Origin Private File System | Saves your projects. | Nothing is kept across reloads. | ✅ | ✅ | ✅ |
| File System Access (`showDirectoryPicker`) | Saves edits back to a folder opened from disk. | Opening a folder loads a copy. | ✅ | ❌ | ❌ |
| `FileSystemObserver` | Edits made to an opened folder in another editor show up in the playground. | Reopen the folder to see them. | ✅ | ❌ | ❌ |
| Storage Buckets | Keeps saved projects in their own bucket, which the browser evicts and persists apart from other site data. | Projects share the site's default storage, and the playground trims its caches to keep them small. | ✅ | ❌ | ❌ |
| `navigator.storage.persist()` | Asks the browser not to evict saved projects. | Saved projects can be cleared when disk space runs low. | ✅ | ✅ | ✅ |
| Web Locks | Only one tab saves a project at a time. | Two tabs with the same project overwrite each other's saves. | ✅ | ✅ | ✅ |
| Cross-origin isolation (`COEP: credentialless`) | The site sends `COOP: same-origin` and `COEP: credentialless`. | Safari ignores `credentialless` and isn't isolated; the playground still runs. | ✅ | ✅ | ❌ |

## Embeds

[Embeds](/guides/embedding/) run in the same browsers, with these differences.

| Case | Status | Notes |
|---|---|---|
| Chrome / Edge 133+, Firefox 134+ | ✅ Works | Every mode, the API, the modal and several embeds on one page; checked in Chrome and Firefox 160 from another origin. |
| Safari and iOS | 🟡 Edit only | The embed shows and edits the code but can't run it, and sends `unsupported`. |
| Vite / Rolldown projects in an iframe | 🟡 Partial | They need cross-origin isolation. It works only if the host page is isolated (`COOP: same-origin`, `COEP: credentialless`) and the iframe has `allow="cross-origin-isolated"`. Otherwise run them on runbun.dev. |
| Everything else in an iframe | ✅ Works | No isolation needed. |
| Storage | 🟡 Partial | The service worker and OPFS are partitioned per host site. The first visit on each site downloads the wasm again. |

## Notes

- **Reload normally.** A hard refresh bypasses the service worker and leaves the page uncontrolled; reload again to recover.
- **Keep the playground tab open.** The preview, including one opened in its own tab, is served by the playground tab. Close it and the preview shows "The playground isn't open".
