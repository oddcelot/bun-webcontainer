---
title: Browsers
description: Which browsers run the playground and what they need.
sidebar:
  order: 1
---

| Browser | Status | Tested |
|---|---|---|
| Chrome / Edge 133+ | ✅ Works | Chrome 156 |
| Firefox 134+ | ✅ Works | Firefox 157 |
| Safari (macOS) | 🟡 Edit only: no WebAssembly Memory64 yet | Safari 26.5, Safari Technology Preview |
| Any browser on iOS / iPadOS | 🟡 Edit only: all use Safari's engine | |
| Chrome / Firefox on Android | ❔ Untested | |

"Edit only" means you get the editor, examples and sharing, but can't run code. WebKit's development builds have Memory64, so Safari should work once it ships there.

## What the browser needs

Without these, the playground opens in edit-only mode, with a banner naming what's missing. Run, Install and the preview request bar are disabled.

| Feature | Why | Chrome | Firefox | Safari |
|---|---|---|---|---|
| WebAssembly Memory64 | Bun's crates are compiled to wasm64. | ✅ | ✅ | ❌ |
| Secure context (HTTPS) | Required by service workers. | ✅ | ✅ | ✅ |
| Service workers | Serve your modules (`/__vfs/`) and the preview (`/__preview/`). Private windows may disable them. | ✅ | ✅ | ✅ |
| Module workers | Your code runs in a module Web Worker. | ✅ | ✅ | ✅ |

## Optional features

The playground uses these when the browser has them and works without them.

| Feature | Used for | Without it | Chrome | Firefox | Safari |
|---|---|---|---|---|---|
| Origin Private File System | Saves your projects. | Nothing is kept across reloads. | ✅ | ✅ | ✅ |
| `navigator.storage.persist()` | Asks the browser not to evict saved projects. | Saved projects can be cleared when disk space runs low. | ✅ | ✅ | ✅ |
| Web Locks | Only one tab saves a project at a time. | Two tabs with the same project overwrite each other's saves. | ✅ | ✅ | ✅ |
| Cross-origin isolation (`COEP: credentialless`) | The site sends `COOP: same-origin` and `COEP: credentialless`. | Safari ignores `credentialless` and isn't isolated; the playground still runs. | ✅ | ✅ | ❌ |

## Notes

- **Reload normally.** A hard refresh bypasses the service worker and leaves the page uncontrolled; reload again to recover.
- **Keep the playground tab open.** The preview, including one opened in its own tab, is served by the playground tab. Close it and the preview shows "The playground isn't open".
