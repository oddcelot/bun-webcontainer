// `Bun.Transpiler`: Bun's parser and printer (transpile-wasm, loaded on first use) as Bun's runtime transpiler runs
// them. js/jsx/ts/tsx only; the options the module can't honor are ignored with a warning.
import { codeError } from "./node/errors";
import { runtimeTranspile, TranspileError, type Diagnostic, type RuntimeOp, type TsconfigFlags } from "../transpiler";

type JsLoader = "js" | "jsx" | "ts" | "tsx";
const JS_LOADERS = ["js", "jsx", "ts", "tsx"];
const LOADERS = ["js", "jsx", "tsx", "ts", "css", "json", "jsonc", "json5", "toml", "yaml", "xml", "text", "wasm", "md"];

type Options = { loader?: string; target?: string; define?: Record<string, string>; tsconfig?: string | { compilerOptions?: Record<string, unknown> }; [option: string]: unknown };
type Code = string | ArrayBuffer | ArrayBufferView;

/** Options Bun's runtime transpiler has that this one ignores (it always behaves as if they were unset). */
const UNSUPPORTED = ["macro", "exports", "minifyWhitespace", "inline", "trimUnusedImports", "treeShaking", "deadCodeElimination", "jsxOptimizationInline", "autoImportJSX", "allowBunRuntime", "replMode", "reactFastRefresh"];
const warned = new Set<string>();
const warnOnce = (what: string) => {
  if (warned.has(what)) return;
  warned.add(what);
  console.warn(`Bun.Transpiler: ${what} is not supported in the playground and is ignored`);
};

/** Bun's `BuildMessage` (an Error): one parser message. */
class BuildMessage extends Error {
  constructor(
    d: Diagnostic,
    source: string,
    file: string,
    readonly level = d.severity,
  ) {
    super(d.text);
    this.name = "BuildMessage";
    const lines = source.split("\n");
    const line = d.line ?? 0;
    const offset = lines.slice(0, Math.max(line - 1, 0)).reduce((n, l) => n + l.length + 1, 0) + Math.max((d.column ?? 1) - 1, 0);
    this.position = d.line ? { lineText: lines[line - 1] ?? "", file, namespace: "file", line, column: d.column ?? 0, length: d.length ?? 0, offset } : null;
    this.notes = d.notes.map((n) => ({ text: n.text, location: n.line ? { line: n.line, column: n.column ?? 0, length: n.length ?? 0 } : null }));
  }
  readonly position: { lineText: string; file: string; namespace: string; line: number; column: number; length: number; offset: number } | null;
  readonly notes: { text: string; location: unknown }[];
  get line() {
    return this.position?.line ?? -1;
  }
  get column() {
    return this.position?.column ?? -1;
  }
}

const code = (c: Code): string =>
  typeof c === "string" ? c : new TextDecoder().decode(c instanceof ArrayBuffer ? c : new Uint8Array(c.buffer, c.byteOffset, c.byteLength));

function loaderOf(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !LOADERS.includes(v)) throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `invalid loader - must be ${LOADERS.slice(0, -1).join(", ")}, or md`);
  return v;
}

function tsconfigFlags(t: Options["tsconfig"]): TsconfigFlags {
  if (t === undefined || t === null) return {};
  let opts: Record<string, unknown> | undefined;
  try {
    opts = (typeof t === "string" ? (JSON.parse(t) as { compilerOptions?: Record<string, unknown> }) : t).compilerOptions;
  } catch {
    warnOnce("a tsconfig that isn't plain JSON");
  }
  for (const k of Object.keys(opts ?? {})) if (k !== "experimentalDecorators" && k !== "emitDecoratorMetadata") warnOnce(`tsconfig compilerOptions.${k}`);
  return { experimentalDecorators: opts?.experimentalDecorators === true, emitDecoratorMetadata: opts?.emitDecoratorMetadata === true };
}

export class Transpiler {
  readonly #loader: string;
  readonly #tsconfig: TsconfigFlags;

  constructor(options: Options = {}) {
    // Bun's default loader is jsx.
    this.#loader = loaderOf(options.loader) ?? "jsx";
    if (!JS_LOADERS.includes(this.#loader)) throw new Error("only JavaScript-like loaders supported for now");
    this.#tsconfig = tsconfigFlags(options.tsconfig);
    // `target` changes nothing a single file's transpiled output shows (it matters for bundling), so it's accepted.
    if (options.define && Object.keys(options.define).length) warnOnce("define");
    for (const k of UNSUPPORTED) if (options[k] !== undefined) warnOnce(k);
  }

  #run(op: RuntimeOp, source: Code, loader: unknown, message: string): string {
    const l = loaderOf(loader) ?? this.#loader;
    if (!JS_LOADERS.includes(l)) throw new Error(op === "scanImports" ? "Only JavaScript-like files support this fast path" : `Bun.Transpiler: the ${l} loader is not supported in the playground`);
    const text = code(source);
    try {
      return runtimeTranspile(op, text, l as JsLoader, this.#tsconfig);
    } catch (e) {
      if (!(e instanceof TranspileError)) throw e;
      throw new AggregateError(
        e.diagnostics.map((d) => new BuildMessage(d, text, `input.${l}`)),
        message,
      );
    }
  }

  /** JS for `code`, as Bun's runtime transpiler prints it. The third argument (macro context) is ignored. */
  transformSync(source: Code, loader?: string): string {
    return this.#run("transform", source, loader, "Parse error");
  }

  /** `transformSync`, as a Promise. */
  async transform(source: Code, loader?: string): Promise<string> {
    return this.#run("transform", source, loader, "Parse error");
  }

  /** The imports and exports of `code` (a full parse). */
  scan(source: Code, loader?: string): { exports: string[]; imports: { kind: string; path: string }[] } {
    const r = JSON.parse(this.#run("scan", source, loader, "Parse error")) as { imports: { kind: string; path: string }[]; exports: string[] };
    return { exports: r.exports, imports: r.imports };
  }

  /** The imports of `code`, from Bun's quicker scan pass (it lists `require()` calls too). */
  scanImports(source: Code, loader?: string): { kind: string; path: string }[] {
    return JSON.parse(this.#run("scanImports", source, loader, "Failed to scan imports")) as { kind: string; path: string }[];
  }
}
Object.defineProperty(Transpiler.prototype, Symbol.toStringTag, { value: "Transpiler" });
