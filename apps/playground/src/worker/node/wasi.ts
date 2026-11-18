// node:wasi over the project's VFS: the WASI host git.wasm runs on (git/wasi.ts), with Bun's `WASI` around it. Preopens
// map a guest path to a project directory, stdout/stderr reach the console, `proc_exit` ends the program as Bun's
// does (process.exit) unless `returnOnExit` is set. Files a program writes are in the VFS (and the page's file tree)
// once it closes them, exits or `start` returns. Bun's options (`getStdin`, `sendStdout`, `sendStderr`) and Node's
// (`version`, `stdin`/`stdout`/`stderr` fds, `returnOnExit`, `getImportObject`, `initialize`) both work.
import { createWasi, Exit } from "../../git/wasi";
import { codeError, fsError } from "./errors";
import fs, { wasiFs } from "./fs";
import path from "./path";

type Any = any;
type Options = {
  version?: "preview1" | "unstable";
  args?: string[];
  env?: Record<string, string>;
  preopens?: Record<string, string>;
  returnOnExit?: boolean;
  stdin?: number;
  stdout?: number;
  stderr?: number;
  getStdin?: () => Uint8Array | undefined;
  sendStdout?: (data: Uint8Array) => void;
  sendStderr?: (data: Uint8Array) => void;
};
type Instance = { exports: Record<string, unknown> };

const memoryOf = (instance: Instance, memory?: WebAssembly.Memory) => {
  const exports = instance?.exports;
  if (exports === null || typeof exports !== "object") throw new Error(`instance.exports must be an Object. Received ${exports}.`);
  const m = memory ?? exports.memory;
  if (!(m instanceof WebAssembly.Memory)) throw new Error(`instance.exports.memory must be a WebAssembly.Memory. Recceived ${m}.`);
  return m;
};

export class WASI {
  declare wasiImport: Record<string, (...a: Any[]) => Any>;
  declare memory: WebAssembly.Memory;
  #flush: () => void;
  #namespace: string;
  #returnOnExit: boolean;

  constructor(options: Options = {}) {
    if (options === null || typeof options !== "object") throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "options" argument must be of type object. Received ${options === null ? "null" : `type ${typeof options}`}`);
    const { vfs, keyOf } = wasiFs();
    const preopens: [string, string][] = [];
    for (const [guest, host] of Object.entries(options.preopens ?? {})) {
      const key = keyOf(String(host));
      if (vfs.files.has(key)) throw fsError("ENOTDIR", "open", host);
      if (!vfs.isDir(key) && !vfs.exists(key)) throw fsError("ENOENT", "open", host);
      preopens.push([guest, key]);
    }
    this.#namespace = options.version === "unstable" ? "wasi_unstable" : "wasi_snapshot_preview1";
    this.#returnOnExit = options.returnOnExit === true;
    const out = (fd: number, send?: (d: Uint8Array) => void) => (bytes: Uint8Array) => (send ? send(bytes) : fs.writeSync(fd, bytes));
    let pending: Uint8Array | undefined;
    const readStdin = options.getStdin
      ? (into: Uint8Array) => {
          pending ??= options.getStdin!.call(this) ?? undefined;
          if (!pending?.length) return (pending = undefined), 0;
          const n = Math.min(into.length, pending.length);
          into.set(pending.subarray(0, n));
          pending = n === pending.length ? undefined : pending.subarray(n);
          return n;
        }
      : options.stdin !== undefined && options.stdin !== 0
        ? (into: Uint8Array) => fs.readSync(options.stdin!, into)
        : () => 0; // the playground's stdin can't be read synchronously: the end
    const host = createWasi(
      vfs,
      {
        args: (options.args ?? []).map(String),
        env: options.env ?? {},
        preopens,
        stdout: out(options.stdout ?? 1, options.sendStdout),
        stderr: out(options.stderr ?? 2, options.sendStderr),
        readStdin,
      },
      () => this.memory,
    );
    this.#flush = host.flushAll;
    const imports = host.imports as Record<string, Record<string, (...a: Any[]) => Any>>;
    const ns = imports.wasi_snapshot_preview1;
    // proc_exit ends the program, as Bun's (process.exit), the files written so far flushed first.
    const procExit = (code: number) => {
      this.#flush();
      if (this.#returnOnExit) throw new Exit(code);
      (globalThis as Any).process.exit(code);
    };
    this.wasiImport = new Proxy(ns, { get: (t, k) => (k === "proc_exit" ? procExit : t[k as string]) });
  }

  /** Bun's: the memory the imports read and write, when the instance doesn't export it. */
  setMemory(memory: WebAssembly.Memory) {
    this.memory = memory;
  }

  /** Node's: the import object for `WebAssembly.instantiate`. */
  getImportObject() {
    return { [this.#namespace]: this.wasiImport };
  }

  /** Bun's: the import object for a module, under the WASI namespace it imports. */
  getImports(module: WebAssembly.Module) {
    const imp = WebAssembly.Module.imports(module).find((i) => i.kind === "function" && i.module.startsWith("wasi_"));
    if (imp?.module === "wasi_unstable" || imp?.module === "wasi_snapshot_preview1") return { [imp.module]: this.wasiImport };
    throw new Error(
      "No WASI namespace found. Only wasi_unstable and wasi_snapshot_preview1 are supported.\n\nList of imports:\n\n" +
        WebAssembly.Module.imports(module)
          .map(({ name, kind, module }) => `${module}:${name} (${kind})`)
          .join("\n") +
        "\n",
    );
  }

  /** Runs the command's `_start`. With `returnOnExit`, returns the exit code; else `proc_exit` ends the program. */
  start(instance: Instance, memory?: WebAssembly.Memory) {
    this.memory = memoryOf(instance, memory);
    return this.#run(instance.exports._start);
  }

  /** Node's: runs a reactor's `_initialize`, if it has one. */
  initialize(instance: Instance, memory?: WebAssembly.Memory) {
    this.memory = memoryOf(instance, memory);
    if (typeof instance.exports._start === "function") throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", 'The "instance.exports._start" property must be undefined.');
    this.#run(instance.exports._initialize);
  }

  #run(fn: unknown) {
    try {
      if (typeof fn === "function") fn();
      return this.#returnOnExit ? 0 : undefined;
    } catch (e) {
      if (e instanceof Exit) return e.code;
      throw e;
    } finally {
      this.#flush();
    }
  }
}

void path;
export default { WASI };
