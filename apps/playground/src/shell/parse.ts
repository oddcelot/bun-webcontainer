// Bun's shell grammar: a console line or a Bun.$ template to its AST, by Bun's own parser compiled to wasm64
// (crates/shell-wasm, bun/src/shell_parser). The template side mirrors Bun's `shell_cmd_from_js`
// (bun/src/runtime/shell/shell_body.rs): which values become script text, which go by reference.
import type { Script } from "./ast";

type Exports = {
  memory: WebAssembly.Memory;
  alloc(len: bigint): bigint;
  dealloc(ptr: bigint, len: bigint): void;
  shell_parse(src: bigint, srcLen: bigint, strings: bigint, stringsLen: bigint, jsobjs: number): number;
  shell_braces(word: bigint, len: bigint): number;
  result_ptr(): bigint;
  result_len(): bigint;
};

/** The script as Bun builds it from a template, and what its `\x08` references point at. */
export type Source = {
  script: string;
  /** Template strings that needed escaping (`\x08__bunstr_<i>\x08`): each is one word, as written. */
  strings: string[];
  /** Other values (`\x08__bun_<i>\x08`): buffers, Blobs and Responses for redirects. */
  objs: unknown[];
};

export type ShellWasm = {
  parse(src: Source | string): Script;
  /** Brace expansion, `{a,b}c` to `ac bc` (`$.braces`); a word without a group comes back as is. */
  braces(word: string): string[];
};

export class ShellSyntaxError extends Error {
  override name = "ShellError";
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** The parser over the compiled module (`bun_shell_wasm.wasm`). */
/**
 * The parser over the compiled module (`bun_shell_wasm.wasm`), instantiated on first use: each instance is a wasm64
 * memory, of which a tab gets only about 60 across the page and its workers (see resolver.ts), and most programs never
 * run `$`.
 */
export function shellWasm(module: WebAssembly.Module): ShellWasm {
  let real: ShellWasm | undefined;
  const get = () => (real ??= instantiate(module));
  return { parse: (src) => get().parse(src), braces: (word) => get().braces(word) };
}

function instantiate(module: WebAssembly.Module): ShellWasm {
  const w = new WebAssembly.Instance(module, {}).exports as unknown as Exports;
  const put = (bytes: Uint8Array) => {
    const len = BigInt(bytes.length);
    const ptr = w.alloc(len);
    new Uint8Array(w.memory.buffer, Number(ptr), bytes.length).set(bytes);
    return [ptr, len] as const;
  };
  const result = () => {
    const out = new Uint8Array(w.memory.buffer, Number(w.result_ptr()), Number(w.result_len()));
    const text = dec.decode(out.subarray(1));
    if (out[0] !== 0) throw new ShellSyntaxError(text);
    return text;
  };
  return {
    parse(src) {
      const { script, strings, objs } = typeof src === "string" ? { script: src, strings: [], objs: [] } : src;
      const [sp, sl] = put(enc.encode(script));
      const [tp, tl] = put(enc.encode(strings.join("\0")));
      try {
        w.shell_parse(sp, sl, tp, tl, objs.length);
        return JSON.parse(result()) as Script;
      } finally {
        w.dealloc(sp, sl);
        w.dealloc(tp, tl);
      }
    },
    braces(word) {
      const [p, l] = put(enc.encode(word));
      try {
        w.shell_braces(p, l);
        return result().split("\0");
      } finally {
        w.dealloc(p, l);
      }
    },
  };
}

// Characters that make a template value go by reference rather than as script text (parse.rs SPECIAL_CHARS).
const SPECIAL = new Set("~[]#;\n\t\r*?{,}`$=()0123456789|><&'\" \\\b");
const KEYWORDS = new Set(["if", "else", "elif", "then", "fi"]);
const needsEscape = (s: string) => s === "" || [...s].some((c) => SPECIAL.has(c)) || KEYWORDS.has(s);

/** A `Bun.file()` has its path under this key: in a template it stands for the path, as in Bun. */
export const FILE_PATH = Symbol.for("runbun.shell.filePath");

const isBufferLike = (v: unknown) => v instanceof ArrayBuffer || ArrayBuffer.isView(v) || (typeof SharedArrayBuffer !== "undefined" && v instanceof SharedArrayBuffer);

/** `$\`…\``'s script: the template's raw strings as written, its values escaped or referenced as Bun does. */
export function templateSource(raw: readonly string[], values: readonly unknown[]): Source {
  const out: Source = { script: "", strings: [], objs: [] };
  const ref = (v: unknown) => {
    out.script += `\b__bun_${out.objs.length}\b`;
    out.objs.push(v);
  };
  const str = (s: string) => {
    if (s.includes("\0")) throw new TypeError(`The shell argument must be a string without null bytes. Received ${JSON.stringify(s)}`);
    // After `$`, a plain word would join the variable's name (`$${x}`): a reference keeps it apart.
    if (needsEscape(s) || /\$[A-Za-z0-9_]*$/.test(out.script)) {
      out.script += `\b__bunstr_${out.strings.length}\b`;
      out.strings.push(s);
    } else out.script += s;
  };
  const value = (v: unknown, depth: number) => {
    if (isBufferLike(v)) return ref(v);
    const path = v !== null && typeof v === "object" ? (v as { [FILE_PATH]?: unknown })[FILE_PATH] : undefined;
    if (typeof path === "string") return str(path);
    if (typeof Blob !== "undefined" && v instanceof Blob) return ref(v);
    if (typeof ReadableStream !== "undefined" && v instanceof ReadableStream)
      throw new Error("ReadableStream is not supported as a shell redirect yet. Buffer it first, e.g. `< ${await new Response(stream).blob()}`, or use Bun.spawn({ stdin: stream })");
    if (typeof Response !== "undefined" && v instanceof Response) return ref(v);
    if (typeof v === "string") return str(v);
    if (Array.isArray(v)) {
      if (depth >= 100) throw new Error("Shell script template arrays cannot be nested more than 100 levels deep");
      v.forEach((item, i) => {
        value(item, depth + 1);
        if (i < v.length - 1) out.script += " ";
      });
      return;
    }
    if (v !== null && typeof v === "object") {
      const raw = (v as { raw?: unknown }).raw;
      if (raw) {
        const s = String(raw);
        if (s.includes("\0")) throw new TypeError(`The shell argument must be a string without null bytes. Received "${s}"`);
        out.script += s;
        return;
      }
      if (typeof (v as { toString?: unknown }).toString === "function" && (v as object).toString !== Object.prototype.toString) return str(String(v));
      throw new Error(`Invalid JS object used in shell: ${Object.prototype.toString.call(v)}, you might need to call \`.toString()\` on it`);
    }
    str(String(v));
  };
  raw.forEach((s, i) => {
    out.script += s;
    if (i < raw.length - 1) {
      if (i >= values.length) throw new Error("Shell script is missing JSValue arg");
      value(values[i], 0);
    }
  });
  return out;
}
