import { BASE } from "../base";
import { XHR } from "./xhr";
import { makeHTMLRewriter } from "./htmlRewriter";

// `HTMLRewriter`: lol-html compiled to wasm64 (crates/htmlrewriter-wasm), loaded on first use. `new HTMLRewriter()`
// and `transform()` are synchronous, so the module comes in with a synchronous XHR and compile, as the transpiler's
// does for `Bun.Transpiler#transformSync` (src/transpiler/index.ts). Workers only: a page may not compile it synchronously.
function loadModule(): WebAssembly.Module {
  const xhr = new XHR();
  xhr.open("GET", new URL(`${BASE}bun_htmlrewriter_wasm.wasm`, location.href), false);
  xhr.responseType = "arraybuffer";
  xhr.send();
  if (xhr.status !== 200) throw new Error(`failed to load HTMLRewriter: HTTP ${xhr.status}`);
  return new WebAssembly.Module(xhr.response as ArrayBuffer);
}

export const HTMLRewriter = makeHTMLRewriter(loadModule);
