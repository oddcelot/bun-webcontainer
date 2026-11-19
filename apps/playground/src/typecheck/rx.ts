import type { FileContents, VFS } from "@runbun/vfs";
import rxcUrl from "@reactivescript/language-server/src/rxc.wasm?url";
import type { EditorDiagnostic } from "../editors/types";

// Types for ReactiveScript (.rx) files, as its language server gets them: the compiler's analysis build (rxc.wasm, the
// one @reactivescript/language-server ships) projects a module to TSX and says which spans of the two texts are the
// same, the type checker reads the projection as `<file>.rx.tsx` (what `import … from "./file.rx"` resolves to), and
// positions are mapped between the two. The same call gives the checker's own errors (writes to an equation, an
// unhandled failure, …), which need no types.

/** A ReactiveScript module (not a `.d.rx` declaration file, which the compiler reads beside the module importing it). */
export const RX = /(?<!\.d)\.rx$/;
const RX_INPUT = /\.rx$/;
const IN_MODULES = /(?:^|\/)node_modules\//;

/** Where the projection's helpers are declared: under node_modules, so their import of Solid's JSX types resolves. */
const PRELUDE = "/node_modules/.reactivescript/prelude";
/** A projection's first line: Solid's JSX types, whatever the project's `jsx` setting says. Offsets into it shift by its length. */
const PRAGMA = "/** @jsxImportSource @solidjs/web */\n";
/** A parameter without a type is `any` in ReactiveScript (spec/13), which `strict` reports in the projection. */
const IMPLICIT_ANY = new Set([7005, 7006, 7019, 7026, 7031, 7034]);

type Position = { line: number; character: number };
type RxDiagnostic = {
  code: string;
  rule: string;
  message: string;
  line: number;
  /** Lines 1-based, columns 0-based UTF-16. */
  range?: { start: { line: number; column: number }; end: { line: number; column: number } };
};
/** `analyze`'s answer. Offsets are UTF-16. */
type Analysis = {
  code?: string;
  /** Spans copied from the module as they are: [projection offset, module offset, length]. */
  mappings?: [number, number, number][];
  /** The expression or statement a stretch of the projection came from: [projection offset, length, module offset, length]. */
  ranges?: [number, number, number, number][];
  diagnostics?: RxDiagnostic[];
  error?: string;
};

type Read = (path: string) => FileContents | undefined;
type Rxc = { call<T>(method: string, params: unknown, read: Read): T };
type Exports = { memory: WebAssembly.Memory; rx_alloc(n: number): number; rx_free(ptr: number, n: number): void; rx_call(ptr: number, len: number): number };

let rxc: Promise<Rxc> | undefined;

/** rxc.wasm: a request is JSON in memory from `rx_alloc`, the answer `[u32 length][JSON]`; it reads files through `env.rx_read` (0: no such file). */
function load(): Promise<Rxc> {
  rxc ??= (async () => {
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    let read: Read = () => undefined;
    let x!: Exports;
    const env = {
      rx_read(ptr: number, len: number) {
        const data = read(dec.decode(new Uint8Array(x.memory.buffer, ptr, len)));
        if (data === undefined) return 0;
        const bytes = typeof data === "string" ? enc.encode(data) : data;
        const out = x.rx_alloc(bytes.length + 4);
        new DataView(x.memory.buffer).setUint32(out, bytes.length, true);
        new Uint8Array(x.memory.buffer).set(bytes, out + 4);
        return out;
      },
    };
    const { instance } = await WebAssembly.instantiateStreaming(fetch(rxcUrl), { env });
    x = instance.exports as unknown as Exports;
    return {
      call(method, params, r) {
        read = r;
        const req = enc.encode(JSON.stringify({ method, params }));
        const ptr = x.rx_alloc(req.length);
        new Uint8Array(x.memory.buffer).set(req, ptr);
        // It frees the request itself.
        const out = x.rx_call(ptr, req.length);
        const n = new DataView(x.memory.buffer).getUint32(out, true);
        const text = dec.decode(new Uint8Array(x.memory.buffer, out + 4, n));
        x.rx_free(out, n + 4);
        return JSON.parse(text);
      },
    };
  })();
  // A failed download is tried again by the next request.
  rxc.catch(() => (rxc = undefined));
  return rxc;
}

/** The offset each line of `text` starts at. */
function lineStarts(text: string): number[] {
  const out = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) out.push(i + 1);
  return out;
}

function positionAt(starts: number[], offset: number): Position {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo, character: offset - starts[lo] };
}

/** One module and its projection: positions from one to the other. */
export class RxView {
  private readonly srcLines: number[];
  private readonly srcEnd: number;
  private readonly tsxLines: number[];
  private readonly mappings: [number, number, number][];
  private readonly ranges: [number, number, number, number][];

  constructor(
    private readonly src: string,
    /** What the type checker reads: PRAGMA, then the projection. */
    readonly tsx: string,
    private readonly analysis: Analysis,
  ) {
    this.srcLines = lineStarts(src);
    this.srcEnd = src.length;
    this.tsxLines = lineStarts(tsx);
    this.mappings = analysis.mappings ?? [];
    this.ranges = analysis.ranges ?? [];
  }

  /** The compiler's own errors: the rules a program has to keep, by their number in the spec. */
  diagnostics(): EditorDiagnostic[] {
    return (this.analysis.diagnostics ?? []).map((d) => {
      const start = d.range?.start ?? { line: d.line, column: 0 };
      const end = d.range?.end ?? start;
      const length = end.line === start.line ? end.column - start.column : 0;
      // "At the end of the line" is past its last character, where a marker has nothing to sit on: it takes that character.
      const width = (this.srcLines[start.line] ?? this.srcEnd + 1) - 1 - (this.srcLines[start.line - 1] ?? 0);
      const column = length === 0 && start.column >= width && width > 0 ? width - 1 : start.column;
      return { severity: "error", message: d.message, source: `rx(${d.rule || d.code})`, line: start.line, column: column + 1, length };
    });
  }

  /** The projection's position (0-based) for a 1-based line and column of the module; null where the module's text isn't in it as written. */
  toProjection(line: number, column: number): Position | null {
    let at = (this.srcLines[line - 1] ?? 0) + column - 1;
    // The editor asks at the start of the token under the pointer, and the grammar's token can open with punctuation
    // (`<button`, ` = count`): the name is what was meant.
    while (at < this.src.length && !/[\w$\n]/.test(this.src[at])) at++;
    // The end of a name counts when no other span starts there.
    const m = this.mappings.find(([, s, n]) => s <= at && at < s + n) ?? this.mappings.find(([, s, n]) => s <= at && at <= s + n);
    return m ? positionAt(this.tsxLines, PRAGMA.length + m[0] + at - m[1]) : null;
  }

  /**
   * Where a range of the projection is in the module (1-based): the same text when it lies in a copied span, else
   * the smallest expression or statement around it; null for text the compiler added.
   */
  toModule(range: { start: Position; end: Position }): { line: number; column: number; length: number } | null {
    const a = (this.tsxLines[range.start.line] ?? 0) + range.start.character - PRAGMA.length;
    const b = Math.max(a, (this.tsxLines[range.end.line] ?? 0) + range.end.character - PRAGMA.length);
    let span: [number, number] | undefined;
    const exact = this.mappings.find(([g, , n]) => g <= a && b <= g + n);
    if (exact) span = [exact[1] + a - exact[0], exact[1] + b - exact[0]];
    else {
      let best: [number, number, number, number] | undefined;
      for (const r of this.ranges) if (r[0] <= a && b <= r[0] + r[1] && (!best || r[1] < best[1])) best = r;
      if (best) span = [best[2], best[2] + best[3]];
    }
    if (!span) return null;
    const start = positionAt(this.srcLines, span[0]);
    const end = positionAt(this.srcLines, span[1]);
    return { line: start.line + 1, column: start.character + 1, length: end.line === start.line ? span[1] - span[0] : 0 };
  }

  /** Whether the type checker's error `code` is one the projection causes, not the module. */
  static ignores(code: unknown): boolean {
    return IMPLICIT_ANY.has(Number(code));
  }
}

type Projected = { stamp: (FileContents | undefined)[]; view: RxView };
/** Each module's projection, by VFS path, and what it was made from: every .rx file of the project (a module's analysis reads the ones it imports). */
const projected = new Map<string, Projected>();
let prelude: string | undefined;

/** The projection the type checker has for the module at VFS `path`, if it is one. */
export const rxView = (path: string): RxView | undefined => projected.get(path)?.view;

/**
 * Adds the project's .rx modules to `files` (what the type checker gets) as `<path>.tsx`, with the declarations their
 * projections import. `text` is `path`'s contents, unsaved edits included. Nothing is added for a project without .rx.
 */
export async function projectRx(vfs: VFS, files: Map<string, FileContents>, path: string, text: string): Promise<void> {
  const inputs = [...vfs.files.keys()].filter((p) => RX_INPUT.test(p) && !IN_MODULES.test(p));
  if (RX_INPUT.test(path) && !inputs.includes(path)) inputs.push(path);
  const modules = inputs.filter((p) => RX.test(p));
  for (const p of [...projected.keys()]) if (!modules.includes(p)) projected.delete(p);
  if (!modules.length) return;
  await vfs.ensure(inputs.filter((p) => p !== path));
  const compiler = await load();
  const data = (p: string) => (p === path ? text : vfs.data(p));
  const stamp = inputs.sort().map(data);
  prelude ??= compiler.call<string>("prelude", {}, () => undefined);
  files.set(`${PRELUDE}.d.ts`, prelude);
  // It asks for the modules a module imports, their `.d.rx` and the package.json of a package it imports from.
  const read: Read = (abs) => data(abs.slice(1));
  const decoder = new TextDecoder();
  for (const p of modules) {
    let hit = projected.get(p);
    if (!hit || hit.stamp.length !== stamp.length || hit.stamp.some((d, i) => d !== stamp[i])) {
      const contents = data(p) ?? "";
      const src = typeof contents === "string" ? contents : decoder.decode(contents);
      const analysis = compiler.call<Analysis>("analyze", { file: `/${p}`, overlays: { [`/${p}`]: src }, prelude: PRELUDE }, read);
      // A module that doesn't parse has no projection: the modules importing it keep the last one that did.
      const parsed = !!analysis.mappings?.length || !analysis.diagnostics?.length;
      // `export default component App` is projected as the function `App`; what imports the module wants the default.
      const component = /^export\s+default\s+component\s+([A-Za-z_$][\w$]*)/m.exec(src)?.[1];
      const tsx = parsed || !hit ? PRAGMA + (analysis.code ?? "") + (parsed && component ? `\nexport { ${component} as default };\n` : "") : hit.view.tsx;
      hit = { stamp, view: new RxView(src, tsx, analysis) };
      projected.set(p, hit);
    }
    files.set(`/${p}.tsx`, hit.view.tsx);
  }
}

/**
 * The compiler's analysis of the module at VFS `path` with `text` as its contents: its projection, and the errors it
 * has. For the formatter (rxFormat.ts), which compares a module's analysis before and after.
 */
export async function analyzeRx(vfs: VFS, path: string, text: string): Promise<Analysis> {
  const compiler = await load();
  try {
    return compiler.call<Analysis>("analyze", { file: `/${path}`, overlays: { [`/${path}`]: text }, prelude: PRELUDE }, (abs) => (abs === `/${path}` ? text : vfs.data(abs.slice(1))));
  } catch (e) {
    // A trap leaves the instance as it stopped: the next call gets a new one.
    rxc = undefined;
    throw e;
  }
}
