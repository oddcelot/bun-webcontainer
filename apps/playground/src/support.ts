// The smallest module with a 64-bit memory: header, then a memory section whose limits flag 0x04
// marks i64 addressing. Browsers without Memory64 reject it.
const MEMORY64_MODULE = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x05, 0x03, 0x01, 0x04, 0x00]);

export type Check = { name: string; ok: boolean; why: string };

function memory64(): boolean {
  try {
    return WebAssembly.validate(MEMORY64_MODULE);
  } catch {
    return false;
  }
}

/** `new Worker(url, { type: "module" })`: older engines ignore `type` and never read the option. */
function moduleWorkers(): boolean {
  let read = false;
  try {
    new Worker("data:text/javascript,", {
      get type() {
        read = true;
        return "module" as const;
      },
    }).terminate();
  } catch {
    // A rejected URL still read the option first.
  }
  return read;
}

/** What the playground needs from the browser; the first failing one is what to tell the user about. */
export function checkSupport(): Check[] {
  const wasm = typeof WebAssembly === "object";
  return [
    { name: "WebAssembly", ok: wasm, why: "Needs WebAssembly." },
    {
      name: "WebAssembly Memory64",
      ok: wasm && memory64(),
      why: "Needs WebAssembly Memory64 (Chrome 133+, Firefox 134+).",
    },
    {
      name: "Secure context",
      ok: window.isSecureContext,
      why: "Needs https:// or localhost.",
    },
    {
      name: "Service workers",
      ok: "serviceWorker" in navigator,
      why: "Needs service workers. Private windows may block them.",
    },
    { name: "Module workers", ok: moduleWorkers(), why: "Needs module Web Workers." },
  ];
}

/** Advice for the engine at hand when Memory64 is the missing piece. */
export function engineHint(checks: Check[]): string {
  if (checks.find((c) => c.name === "WebAssembly Memory64")?.ok) return "";
  const ua = navigator.userAgent;
  const webkit = /AppleWebKit/.test(ua) && !/Chrome|Chromium|Edg\//.test(ua);
  if (/iPhone|iPad|iPod/.test(ua) || (webkit && navigator.maxTouchPoints > 1))
    return "Every iOS and iPadOS browser uses Safari's engine, which has no WebAssembly Memory64 yet. Use Chrome or Firefox on a desktop.";
  if (webkit) return "Safari has no WebAssembly Memory64 yet. Use Chrome 133+ or Firefox 134+.";
  return "Update your browser. Chrome 133+ and Firefox 134+ support Memory64.";
}
