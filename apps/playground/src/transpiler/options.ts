// `Bun.Transpiler`'s options as transpile-wasm takes them: bits of `transpile_flags_c`'s `flags`, and the input of
// `options_c` (the define table and export replacements). No imports, so crates/transpile-wasm/test.ts can use it.

/** transpile-wasm's `flags` bits (crates/transpile-wasm/src/lib.rs). */
export const FLAGS = {
  RUNTIME_TRANSPILER: 8,
  IMPORT_META_REQUIRE: 16,
  MINIFY_WHITESPACE: 32,
  MINIFY_SYNTAX: 64,
  MINIFY_IDENTIFIERS: 128,
  TRIM_UNUSED_IMPORTS: 256,
  NO_DEAD_CODE_ELIMINATION: 512,
  TREE_SHAKING: 1024,
  INLINE: 2048,
  PACKAGE_TYPE_COMMONJS: 4096,
  PACKAGE_TYPE_MODULE: 8192,
  SYNC_ESM: 16384,
  SOURCE_MAP: 32768,
} as const;

/** transpile-wasm's loader numbers (`Loader::from_u32`), by `Bun.Transpiler` loader name. */
export const LOADER_NUMBERS: Record<string, number> = { js: 0, jsx: 1, ts: 2, tsx: 3, json: 4, jsonc: 5, json5: 6, toml: 7, yaml: 8, xml: 9, text: 10, md: 11 };

export type RuntimeOptions = {
  /** `flags` bits, without RUNTIME_TRANSPILER. */
  flags: number;
  /** `options_c`'s input. */
  options: Uint8Array;
  /** Options given that change the output in Bun but not here. */
  ignored: string[];
};

const enc = new TextEncoder();

/** A valid ECMAScript identifier (Bun's `js_lexer::is_identifier`). */
const isIdentifier = (s: string) => /^[\p{ID_Start}$_][\p{ID_Continue}$‌‍]*$/u.test(s);

/** `exports.replace`'s value encoding (transpile-wasm's `runtime::value_expr`), or undefined if it isn't one. */
function replacement(v: unknown): string | undefined {
  if (typeof v === "boolean") return v ? "b1" : "b0";
  if (typeof v === "number") return `n${v}`;
  if (v === null) return "l";
  if (v === undefined) return "u";
  if (typeof v === "string") return `s${v}`;
  return undefined;
}

/** Bun's quoting of `NODE_ENV` for its define (`defines_from_transform_options`): kept if quoted, else wrapped. */
function quoteNodeEnv(v: string | undefined): string {
  if (!v) return '"development"';
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v;
  return `"${v}"`;
}

/**
 * Validates and encodes `Bun.Transpiler`'s options as `JSTranspiler`'s `Config::from_js` reads them. `nodeEnv` is the
 * environment's `NODE_ENV` when the transpiler is made (Bun reads it from the process environment). Throws Bun's
 * TypeErrors for bad `define` and `exports` values.
 */
export function runtimeOptions(o: Record<string, unknown>, nodeEnv: string | undefined): RuntimeOptions {
  const fields: Uint8Array[] = [];
  const record = (...parts: string[]) => {
    for (const p of parts) {
      const b = enc.encode(p);
      const len = new Uint8Array(4);
      new DataView(len.buffer).setUint32(0, b.length, true);
      fields.push(len, b);
    }
  };
  const ignored: string[] = [];

  // define: the user's, then Bun's defaults for the keys they don't set.
  const defines = new Map<string, string>();
  if (o.define !== undefined && o.define !== null) {
    if (typeof o.define !== "object") throw new TypeError("define must be an object");
    for (const [k, v] of Object.entries(o.define as Record<string, unknown>)) {
      if (typeof v !== "string") throw new TypeError(`define "${k}" must be a JSON string`);
      defines.set(k, v === "" ? '""' : v);
    }
  }
  const target = typeof o.target === "string" && ["browser", "bun", "node", "bun_macro"].includes(o.target) ? o.target : "browser";
  const nodeEnvValue = quoteNodeEnv(nodeEnv);
  for (const [k, v] of [
    ["process.env.NODE_ENV", nodeEnvValue],
    ["process.env.BUN_ENV", nodeEnvValue],
    ["process.browser", target === "browser" ? "true" : "false"],
  ]) {
    if (!defines.has(k)) defines.set(k, v);
  }
  for (const [k, v] of defines) record("d", k, v);
  if (nodeEnv === "production") record("P");

  let flags = 0;
  const bool = (k: string) => (typeof o[k] === "boolean" ? (o[k] as boolean) : undefined);
  let [whitespace, syntax, identifiers] = [bool("minifyWhitespace") ?? false, false, false];
  // Bun's `BundleOptions` turn on `minify_syntax` for target bun (with tree shaking and inlining, which
  // `Bun.Transpiler` then sets back from its own options).
  if (target === "bun") {
    syntax = true;
    ignored.push('target "bun" (printed as for the browser)');
  }
  if (typeof o.minify === "boolean") [whitespace, syntax, identifiers] = [o.minify, o.minify, o.minify];
  else if (o.minify && typeof o.minify === "object") {
    const m = o.minify as Record<string, unknown>;
    if (typeof m.whitespace === "boolean") whitespace = m.whitespace;
    if (typeof m.syntax === "boolean") syntax = m.syntax;
    if (typeof m.identifiers === "boolean") identifiers = m.identifiers;
  }
  if (whitespace) flags |= FLAGS.MINIFY_WHITESPACE;
  if (syntax) flags |= FLAGS.MINIFY_SYNTAX;
  if (identifiers) flags |= FLAGS.MINIFY_IDENTIFIERS;
  // `replMode` turns dead code elimination off too, but is otherwise unsupported.
  if (bool("deadCodeElimination") === false) flags |= FLAGS.NO_DEAD_CODE_ELIMINATION;
  if (bool("inline")) flags |= FLAGS.INLINE;

  let treeShaking = bool("treeShaking");
  if (o.exports !== undefined && o.exports !== null && typeof o.exports === "object") {
    const { eliminate, replace } = o.exports as { eliminate?: unknown; replace?: unknown };
    let count = 0;
    if (eliminate !== undefined) {
      if (!Array.isArray(eliminate)) throw new TypeError("exports.eliminate must be an array");
      for (const name of eliminate) {
        if (typeof name === "string" && name) {
          record("e", name);
          count++;
        }
      }
    }
    if (replace !== undefined) {
      if (replace === null || typeof replace !== "object") throw new TypeError("replace must be an object");
      for (const [k, v] of Object.entries(replace)) {
        if (!isIdentifier(k)) throw new TypeError(`"${k}" is not a valid ECMAScript identifier`);
        const value = replacement(v);
        if (value !== undefined) record("r", k, value);
        else if (Array.isArray(v) && v.length === 2 && replacement(v[1]) !== undefined) {
          const name = String(v[0]);
          if (!isIdentifier(name)) throw new TypeError(`"${name}" is not a valid ECMAScript identifier`);
          record("i", k, name, replacement(v[1])!);
        } else throw new TypeError("exports.replace values can only be string, null, undefined, number or boolean");
        count++;
      }
    }
    treeShaking ??= count > 0;
  }
  if (treeShaking) flags |= FLAGS.TREE_SHAKING;
  if (bool("trimUnusedImports") ?? treeShaking) flags |= FLAGS.TRIM_UNUSED_IMPORTS;

  const options = new Uint8Array(fields.reduce((n, f) => n + f.length, 0));
  let at = 0;
  for (const f of fields) {
    options.set(f, at);
    at += f.length;
  }
  return { flags, options, ignored };
}
