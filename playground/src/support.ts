// The smallest module with a 64-bit memory: header, then a memory section whose limits flag 0x04
// marks i64 addressing. Browsers without Memory64 reject it.
const MEMORY64_MODULE = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x05, 0x03, 0x01, 0x04, 0x00]);

export function supportsMemory64(): boolean {
  try {
    return WebAssembly.validate(MEMORY64_MODULE);
  } catch {
    return false;
  }
}

/** Replaces the app with an explanation; Bun's wasm modules cannot load without Memory64. */
export function showUnsupported() {
  const box = document.createElement("div");
  box.className = "unsupported";
  box.innerHTML = `<h2>This browser can't run the playground</h2>
<p>Bun's transpiler and semver run here as WebAssembly with 64-bit memory (Memory64),
which this browser doesn't support. Chrome 133+ and Firefox 134+ do; Safari didn't as of late 2025.</p>`;
  document.body.replaceChildren(box);
}
