// The smallest module with a 64-bit memory: header, then a memory section whose limits flag 0x04
// marks i64 addressing. Browsers without Memory64 reject it.
const MEMORY64_MODULE = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x05, 0x03, 0x01, 0x04, 0x00]);

type Check = { name: string; ok: boolean; why: string };

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
    { name: "WebAssembly", ok: wasm, why: "Bun's transpiler, resolver and bundler run as WebAssembly." },
    {
      name: "WebAssembly Memory64",
      ok: wasm && memory64(),
      why: "Bun's crates are compiled to wasm64 (64-bit memory). Chrome 133+ and Firefox 134+ support it.",
    },
    {
      name: "Secure context",
      ok: window.isSecureContext,
      why: "Service workers only run on https:// or localhost.",
    },
    {
      name: "Service workers",
      ok: "serviceWorker" in navigator,
      why: "A service worker serves your modules and the Bun.serve preview. Private windows may disable it.",
    },
    { name: "Module workers", ok: moduleWorkers(), why: "Your program runs in a module Web Worker." },
  ];
}

/** Advice for the engine at hand when Memory64 is the missing piece. */
function engineHint(checks: Check[]): string {
  if (checks.find((c) => c.name === "WebAssembly Memory64")?.ok) return "";
  const ua = navigator.userAgent;
  const webkit = /AppleWebKit/.test(ua) && !/Chrome|Chromium|Edg\//.test(ua);
  if (/iPhone|iPad|iPod/.test(ua) || (webkit && navigator.maxTouchPoints > 1))
    return "On iOS and iPadOS every browser uses Safari's engine (WebKit), which hasn't shipped Memory64 yet (Safari 27 lacks it). Try a desktop with Chrome or Firefox.";
  if (webkit) return "Safari hasn't shipped Memory64 yet (Safari 27 lacks it; WebKit's development builds have it). Use Chrome 133+ or Firefox 134+.";
  return "Update your browser: Chrome 133+ and Firefox 134+ support it.";
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** Replaces the app with what's missing; nothing below main.ts's check can work without it. */
export function showUnsupported(checks: Check[]) {
  const box = document.createElement("div");
  box.className = "unsupported";
  const rows = checks
    .map((c) => `<li data-ok="${c.ok}"><strong>${c.ok ? "✓" : "✗"} ${esc(c.name)}</strong>${c.ok ? "" : ` <span>${esc(c.why)}</span>`}</li>`)
    .join("");
  const hint = engineHint(checks);
  box.innerHTML = `<h2>This browser can't run the playground</h2>
<ul>${rows}</ul>${hint ? `<p>${esc(hint)}</p>` : ""}
<p class="ua">${esc(navigator.userAgent)}</p>`;
  document.body.replaceChildren(box);
}
