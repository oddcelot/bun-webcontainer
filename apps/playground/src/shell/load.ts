// The shell's wasm (crates/shell-wasm) for the page and the worker: fetched and compiled once, on first use.
import { BASE } from "../base";
import { shellWasm, type ShellWasm } from "./parse";

let loading: Promise<ShellWasm> | undefined;

export function loadShellWasm(): Promise<ShellWasm> {
  return (loading ??= WebAssembly.compileStreaming(fetch(new URL(`${BASE}bun_shell_wasm.wasm`, location.href)))
    .then(shellWasm)
    .catch((e) => {
      loading = undefined;
      throw e;
    }));
}
