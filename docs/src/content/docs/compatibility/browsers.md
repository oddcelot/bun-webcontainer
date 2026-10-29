---
title: Browsers
description: Which browsers run the playground and what they need.
sidebar:
  order: 1
---

| Browser | Status |
|---|---|
| Chrome / Edge 133+ | ✅ Supported, tested |
| Firefox 134+ | 🟡 Should work; testing in progress |
| Safari (macOS) | ❌ No WebAssembly Memory64 yet (Safari 27 lacks it) |
| Any browser on iOS / iPadOS | ❌ All use Safari's engine |

## What the browser needs

| Feature | Why |
|---|---|
| WebAssembly Memory64 | Bun's crates are compiled to wasm64. |
| Secure context (HTTPS) | Required by service workers and cross-origin isolation. |
| Service workers | Serve your modules (`/__vfs/`) and the preview (`/__preview/`). |
| Module workers | Your code runs in a module Web Worker. |
| Cross-origin isolation | The site sends `COOP: same-origin` and `COEP: credentialless`, needed for `SharedArrayBuffer` (the wasm `rolldown` uses threads). |
| Origin Private File System | Saves your projects. Without it the playground still runs, but nothing is kept across reloads. |

If a required feature is missing, you still get the editor, examples and sharing, with a banner explaining what's missing. Run, Install and the preview request bar are disabled.

## Notes

- **Reload normally.** A hard refresh bypasses the service worker and leaves the page uncontrolled; reload again to recover.
- **Keep the playground tab open.** The preview, including one opened in its own tab, is served by the playground tab. Close it and the preview shows "The playground isn't open".
