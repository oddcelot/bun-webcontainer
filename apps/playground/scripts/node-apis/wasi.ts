// node:wasi: wasi.wasm (from wasi.wat) run with each of its modes, over files in a directory of its own.
import { WASI } from "node:wasi";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Case } from "./cases.ts";

/** The module's bytes: the file natively, its base64 in the playground (whose project files are text). */
function wasm() {
  const p = join(import.meta.dir, "wasi.wasm");
  return existsSync(p) ? readFileSync(p) : Buffer.from(readFileSync(`${p}.b64`, "utf8"), "base64");
}

class Exited {
  constructor(readonly code: number) {}
}

export async function wasiCases(t: Case, log: (line: string) => void) {
  const module = new WebAssembly.Module(wasm());
  rmSync("wasi-box", { recursive: true, force: true });
  mkdirSync("wasi-box");
  writeFileSync("wasi-box/in.txt", "hello from the host");

  /** Runs one mode; what it printed (stdout | stderr), or how it ended. */
  const run = (mode: string, options: Record<string, unknown> = {}) => {
    let out = "";
    let err = "";
    const dec = new TextDecoder();
    const wasi = new WASI({ version: "preview1", args: ["wasi", mode], sendStdout: (b: Uint8Array) => (out += dec.decode(b)), sendStderr: (b: Uint8Array) => (err += dec.decode(b)), ...options } as never);
    const instance = new WebAssembly.Instance(module, { wasi_snapshot_preview1: wasi.wasiImport } as never);
    // proc_exit is process.exit: caught here, as an exception through the module.
    const exit = process.exit;
    process.exit = ((code: number) => {
      throw new Exited(code);
    }) as never;
    let end = "";
    try {
      end = `returned ${wasi.start(instance)}`;
    } catch (e) {
      end = e instanceof Exited ? `exit ${e.code}` : `threw ${(e as Error).name} ${(e as Error).message}`;
    } finally {
      process.exit = exit;
    }
    return `${JSON.stringify(out)} | ${JSON.stringify(err)} | ${end}`;
  };

  t("wasi exports", () => [typeof WASI, typeof WASI.prototype.start, typeof (new WASI({}) as never as { wasiImport: object }).wasiImport.fd_write].join());
  t("wasi hello", () => run("hello"));
  t("wasi args env", () => run("args", { args: ["prog", "args", "two words", "ünï"], env: { B: "2", A: "x=y" } }));
  t("wasi no env", () => run("args"));
  t("wasi files", () => run("files", { preopens: { "/data": "wasi-box" } }));
  t("wasi files on disk", () => JSON.stringify([readFileSync("wasi-box/sub/out.txt", "utf8"), existsSync("wasi-box/missing.txt")]));
  t("wasi files nested preopen", () => (writeFileSync("wasi-box/sub/in.txt", "nested"), run("files", { preopens: { "/box": "wasi-box/sub" } })));
  t("wasi files nested on disk", () => JSON.stringify([readFileSync("wasi-box/sub/sub/out.txt", "utf8"), existsSync("wasi-box/sub/out.txt")]));
  t("wasi preopen missing", () => {
    try {
      new WASI({ preopens: { "/x": "wasi-box/nope" } });
      return "no error";
    } catch (e) {
      return `${(e as Error).message} ${(e as { code?: string }).code}`;
    }
  });
  t("wasi stdin", () => {
    const chunks = ["first ", "second\n"];
    return run("stdin", { getStdin: () => (chunks.length ? Buffer.from(chunks.shift()!) : undefined) });
  });
  t("wasi clock random", () => run("clock"));
  t("wasi exit", () => run("exit"));
  t("wasi trap", () => run("trap").replace(/\| threw RuntimeError .*/, "| threw RuntimeError"));
  t("wasi memory check", () => {
    try {
      new WASI({}).start({ exports: {} } as never);
      return "no error";
    } catch (e) {
      return (e as Error).message;
    }
  });
  t("wasi getImports", () => Object.keys(new WASI({}).getImports(module)).join());
  // stdout without sendStdout: the console (its lines are argv).
  const wasi = new WASI({ args: ["wasi console: stdout", "args"] });
  wasi.start(new WebAssembly.Instance(module, { wasi_snapshot_preview1: wasi.wasiImport } as never));
  log("wasi console: done");
  rmSync("wasi-box", { recursive: true, force: true });
}
