import { BASE } from "../base";

// tsrs's language service (TypeScript 7 ported to Rust) as a wasm32-wasip1 module; see ../../../tsrs-ls-wasm for
// its ABI. It reads no files through WASI (they come in through ls_set_files), so the WASI imports are a stub that
// only does stdout/stderr, clocks and randomness.

/** The tsrs release tsrs-ls-wasm/Cargo.toml builds from, and the TypeScript version it ports. */
export const TSRS_VERSION = "0.20.1";
export const TS_VERSION = "7.1.0-beta";

const EBADF = 8;
const ENOSYS = 52;

class Exit extends Error {}

function wasi(memory: () => WebAssembly.Memory) {
  const view = () => new DataView(memory().buffer);
  const dec = new TextDecoder();
  return {
    fd_write(fd: number, iovs: number, count: number, written: number) {
      const v = view();
      let text = "";
      let n = 0;
      for (let i = 0; i < count; i++) {
        const ptr = v.getUint32(iovs + i * 8, true);
        const len = v.getUint32(iovs + i * 8 + 4, true);
        text += dec.decode(new Uint8Array(memory().buffer, ptr, len));
        n += len;
      }
      if (fd === 1 || fd === 2) console.warn(`[tsrs] ${text.trimEnd()}`);
      v.setUint32(written, n, true);
      return 0;
    },
    random_get(ptr: number, len: number) {
      crypto.getRandomValues(new Uint8Array(memory().buffer, ptr, len));
      return 0;
    },
    clock_time_get(_id: number, _precision: bigint, out: number) {
      view().setBigUint64(out, BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6)), true);
      return 0;
    },
    environ_sizes_get(count: number, size: number) {
      view().setUint32(count, 0, true);
      view().setUint32(size, 0, true);
      return 0;
    },
    environ_get: () => 0,
    sched_yield: () => 0,
    proc_exit(code: number) {
      throw new Exit(`tsrs exited with ${code}`);
    },
    // No preopened directories: Rust's std stops asking at the first EBADF.
    fd_prestat_get: () => EBADF,
    fd_prestat_dir_name: () => EBADF,
    fd_close: () => EBADF,
    fd_fdstat_get: () => EBADF,
    fd_filestat_get: () => EBADF,
    fd_read: () => EBADF,
    path_open: () => ENOSYS,
  };
}

type Exports = {
  memory: WebAssembly.Memory;
  ls_input(len: number): number;
  ls_output(): number;
  ls_output_len(): number;
  ls_set_files(): void;
  ls_remove_files(): void;
  ls_hover(): void;
  ls_completion(): void;
  ls_completion_resolve(): void;
  ls_signature_help(): void;
  ls_diagnostics(): void;
};

let compiled: Promise<WebAssembly.Module> | undefined;

/** One instance: the project's files, kept between requests. Its memory never shrinks; see `memoryBytes`. */
export class TsrsLs {
  private constructor(private ex: Exports) {}

  static async create(): Promise<TsrsLs> {
    compiled ??= WebAssembly.compileStreaming(fetch(`${BASE}tsrs_ls_wasm.wasm`));
    let memory!: WebAssembly.Memory;
    const instance = await WebAssembly.instantiate(await compiled, { wasi_snapshot_preview1: wasi(() => memory) });
    const ex = instance.exports as unknown as Exports;
    memory = ex.memory;
    return new TsrsLs(ex);
  }

  get memoryBytes() {
    return this.ex.memory.buffer.byteLength;
  }

  private call(fn: "ls_set_files" | "ls_remove_files" | "ls_hover" | "ls_completion" | "ls_completion_resolve" | "ls_signature_help" | "ls_diagnostics", fields: string[]): string {
    const bytes = new TextEncoder().encode(fields.join("\0"));
    // ls_input may grow memory, which detaches the old buffer: take the pointer first.
    const ptr = this.ex.ls_input(bytes.length);
    new Uint8Array(this.ex.memory.buffer, ptr, bytes.length).set(bytes);
    this.ex[fn]();
    return new TextDecoder().decode(new Uint8Array(this.ex.memory.buffer, this.ex.ls_output(), this.ex.ls_output_len()));
  }

  setFiles(files: Iterable<[string, string]>) {
    const fields: string[] = [];
    for (const [path, text] of files) fields.push(path, text);
    if (fields.length) this.call("ls_set_files", fields);
  }

  removeFiles(paths: string[]) {
    if (paths.length) this.call("ls_remove_files", paths);
  }

  /** LSP Hover (markdown), or null. `line` and `character` are 0-based, UTF-16. */
  hover(config: string, path: string, line: number, character: number): LspHover | null {
    return JSON.parse(this.call("ls_hover", [config, path, String(line), String(character)]));
  }

  /** The completions at `line`/`character` (0-based, UTF-16), or null; `trigger` is the character just typed, if that's what asked. */
  completion(config: string, path: string, line: number, character: number, trigger = ""): LspCompletionList | null {
    return JSON.parse(this.call("ls_completion", [config, path, String(line), String(character), trigger]));
  }

  /** `item` (from `completion`) with its detail and documentation, or null. */
  resolveCompletion(config: string, item: LspCompletionItem): LspCompletionItem | null {
    return JSON.parse(this.call("ls_completion_resolve", [config, JSON.stringify(item)]));
  }

  /** The signatures of the call around `line`/`character` (0-based, UTF-16), or null; `retrigger` while they're showing. */
  signatureHelp(config: string, path: string, line: number, character: number, trigger = "", retrigger = false): LspSignatureHelp | null {
    return JSON.parse(this.call("ls_signature_help", [config, path, String(line), String(character), trigger, retrigger ? "1" : "0"]));
  }

  diagnostics(config: string, path: string): LspDiagnostic[] {
    return JSON.parse(this.call("ls_diagnostics", [config, path]));
  }
}

export type LspPosition = { line: number; character: number };
export type LspRange = { start: LspPosition; end: LspPosition };
/** 1 error, 2 warning, 3 information, 4 hint. */
export type LspDiagnostic = { range: LspRange; severity?: 1 | 2 | 3 | 4; code?: number | string; message: string };
export type LspHover = { contents: { kind: "markdown" | "plaintext"; value: string }; range?: LspRange };
type LspMarkup = { kind: "markdown" | "plaintext"; value: string };
export type LspTextEdit = { newText: string } & ({ range: LspRange } | { insert: LspRange; replace: LspRange });
/** `kind` is LSP's CompletionItemKind (1 text … 25 type parameter); `data` goes back unchanged to resolve it. */
export type LspCompletionItem = {
  label: string;
  labelDetails?: { detail?: string; description?: string };
  kind?: number;
  detail?: string;
  documentation?: string | LspMarkup;
  sortText?: string;
  filterText?: string;
  insertText?: string;
  textEdit?: LspTextEdit;
  data?: unknown;
};
export type LspCompletionList = { isIncomplete: boolean; items: LspCompletionItem[] };
/** A parameter's label is its text, or where it sits in the signature's label. */
export type LspSignature = {
  label: string;
  documentation?: string | LspMarkup;
  parameters?: { label: string | [number, number]; documentation?: string | LspMarkup }[];
  activeParameter?: number | null;
};
export type LspSignatureHelp = { signatures: LspSignature[]; activeSignature?: number };
