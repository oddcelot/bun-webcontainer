import hbWasm from "harfbuzzjs/hb.wasm";

// What Satori needs to load in a Worker, beyond its standalone build's `init()`. Its text shaper (HarfBuzz, an
// Emscripten module) starts when Satori's module is loaded, and takes a Worker for a web worker:
// - it reads `self.location.href` for the folder its files are in. A Worker has `location` as undefined, and the
//   shaper needs no folder, so it gets a stand-in while the module loads (card.ts takes it away right after);
// - it compiles its wasm from bytes inlined in Satori's bundle, which a Worker may not do: wasm comes as modules of the
//   Worker's own bundle. So compiling those bytes gives harfbuzzjs's hb.wasm instead, the same file (the shaper Satori
//   bundles: keep package.json's harfbuzzjs at the version satori depends on; scripts/worker-card.ts draws a card).
// card.ts imports this before Satori.

const had = Object.getOwnPropertyDescriptor(globalThis, "location");
if (!(globalThis as { location?: unknown }).location) Object.defineProperty(globalThis, "location", { value: { href: "https://worker.invalid/" }, configurable: true, writable: true });

/** hb.wasm's size: the bytes this stands in for. */
const HB_BYTES = 381964;
const instantiate = WebAssembly.instantiate.bind(WebAssembly) as (source: WebAssembly.Module | BufferSource, imports?: WebAssembly.Imports) => Promise<unknown>;
WebAssembly.instantiate = ((source: WebAssembly.Module | BufferSource, imports?: WebAssembly.Imports) =>
  !(source instanceof WebAssembly.Module) && source.byteLength === HB_BYTES
    ? instantiate(hbWasm, imports).then((instance) => ({ module: hbWasm, instance }))
    : instantiate(source, imports)) as typeof WebAssembly.instantiate;

/** Puts `location` back as it was, once Satori's module has loaded. */
export function restoreLocation() {
  if (had) Object.defineProperty(globalThis, "location", had);
  else delete (globalThis as { location?: unknown }).location;
}
