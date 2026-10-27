// CommonJS → ESM for modules served from /__vfs/. `require("x")` with a literal specifier becomes a hoisted
// static import, so dependencies load before the body runs; anything else throws at call time.

const ESM_SYNTAX = /(^|[\n;])\s*(import\s*[\w{*'"]|export\s+[\w{*]|export\s+default\b)/;
const REQUIRE = /\brequire\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g;

/** A `.cjs` file, or a `.js` file with no ESM syntax in a package that isn't `"type": "module"`. */
export function isCommonJS(path: string, source: string, packageType: string | undefined): boolean {
  if (path.endsWith(".cjs")) return true;
  if (path.endsWith(".mjs") || packageType === "module") return false;
  return path.endsWith(".js") && !ESM_SYNTAX.test(source);
}

/** Names a CommonJS module assigns on `exports`, as far as a static scan can tell (like cjs-module-lexer). */
function exportNames(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(/\b(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=[^=]/g)) names.add(m[1]);
  for (const m of source.matchAll(/Object\.defineProperty\(\s*(?:module\.)?exports\s*,\s*["']([A-Za-z_$][\w$]*)["']/g)) names.add(m[1]);
  const literal = source.match(/module\.exports\s*=\s*\{([^{}]*)\}/);
  if (literal) for (const m of literal[1].matchAll(/(?:^|,)\s*([A-Za-z_$][\w$]*)\s*(?=[:,]|$)/g)) names.add(m[1]);
  names.delete("default");
  names.delete("__esModule");
  return [...names];
}

export function wrapCommonJS(path: string, source: string): string {
  const specs = [...new Set([...source.matchAll(REQUIRE)].map((m) => m[2]))];
  const imports = specs.map((s, i) => `import * as __req${i} from ${JSON.stringify(s)};`).join("\n");
  const table = specs.map((s, i) => `${JSON.stringify(s)}: __req${i}`).join(", ");
  const names = exportNames(source);
  const dir = path.split("/").slice(0, -1).join("/");
  return `${imports}
const __required = { ${table} };
// A wrapped CommonJS module exports its module.exports as __cjs; anything else is an ES namespace.
const require = (id) => {
  if (!(id in __required)) throw new Error("require(" + JSON.stringify(id) + "): only literal require() calls are supported (in ${path})");
  const ns = __required[id];
  return "__cjs" in ns ? ns.__cjs : id.endsWith(".json") ? ns.default : ns;
};
const module = { exports: {} };
(function (exports, require, module, __filename, __dirname) {
${source}
}).call(module.exports, module.exports, require, module, ${JSON.stringify("/" + path)}, ${JSON.stringify("/" + dir)});
export const __cjs = module.exports;
export default module.exports && module.exports.__esModule && "default" in module.exports ? module.exports.default : module.exports;
${names.length ? `export const { ${names.join(", ")} } = module.exports;` : ""}
`;
}
