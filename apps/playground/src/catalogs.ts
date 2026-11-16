/**
 * Catalogs: the root package.json's `catalog` (the default one) and `catalogs` (named ones), which `"dep": "catalog:"`
 * and `"dep": "catalog:name"` in the root and the workspaces take their range from. As Bun reads them (lockfile/
 * CatalogMap.rs): from the `workspaces` object when it has either key, else from the top level, and only when the root
 * has `workspaces` at all.
 */
export type Catalogs = { default: Record<string, string>; groups: Record<string, Record<string, string>> };

type Source = { workspaces?: unknown; catalog?: unknown; catalogs?: unknown };

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const entries = (v: unknown): Record<string, string> => Object.fromEntries(Object.entries(isObject(v) ? v : {}).filter((e): e is [string, string] => typeof e[1] === "string"));

export function catalogsOf(root: Source): Catalogs {
  const out: Catalogs = { default: {}, groups: {} };
  if (root.workspaces === undefined) return out;
  const inWorkspaces = isObject(root.workspaces) && ("catalog" in root.workspaces || "catalogs" in root.workspaces);
  const from = (inWorkspaces ? root.workspaces : root) as Source;
  out.default = entries(from.catalog);
  for (const [name, group] of Object.entries(isObject(from.catalogs) ? from.catalogs : {})) out.groups[name] = entries(group);
  return out;
}

/** The range catalog `name` (`""` for `catalog:`) gives `dep`, or undefined. `default` is both the `catalog` and `catalogs.default`. */
export function catalogRange(c: Catalogs, name: string, dep: string): string | undefined {
  if (name === "") return c.default[dep] ?? c.groups.default?.[dep];
  return c.groups[name]?.[dep] ?? (name === "default" ? c.default[dep] : undefined);
}

/** The names of the catalog entries whose range differs between `a` and `b` (or are in one only): `dep`, or `catalog/dep`. */
export function catalogChanges(a: Catalogs, b: Catalogs): string[] {
  const flat = (c: Catalogs) => {
    const out = new Map(Object.entries(c.default));
    for (const [name, group] of Object.entries(c.groups)) for (const [d, r] of Object.entries(group)) out.set(`${name}/${d}`, r);
    return out;
  };
  const [x, y] = [flat(a), flat(b)];
  return [...new Set([...x.keys(), ...y.keys()])].filter((k) => x.get(k) !== y.get(k));
}
