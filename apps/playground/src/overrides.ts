/**
 * `overrides` (npm) and `resolutions` (yarn) in the root package.json: a rule `"name": "range"` makes every dependency
 * on `name`, in any package, ask for `range` instead. Only the flat rules (a package name, or yarn's `**\/name`) are
 * read here; Bun's scoped ones (`parent>child`, `parent/child`, nested objects, `name@range` keys) are `unsupported`.
 * As Bun reads them (lockfile/OverrideMap.rs): `resolutions` only when there is no `overrides`; a value of `$name` is
 * the range the root declares for `name`; empty values, `-` and `patch:` ones are skipped.
 */
type Deps = Record<string, string> | undefined;
type Root = { overrides?: unknown; resolutions?: unknown; dependencies?: Deps; devDependencies?: Deps; optionalDependencies?: Deps; peerDependencies?: Deps };

export type Overrides = {
  /** Package name → the value as written (a `$name` already replaced by the root's range). */
  rules: Record<string, string>;
  /** Keys that are scoped rules, which this install doesn't apply. */
  unsupported: string[];
};

const NAME = /^(?:@[^/@\s>]+\/)?[^/@\s>]+$/;

export function overridesOf(root: Root): Overrides {
  const out: Overrides = { rules: {}, unsupported: [] };
  const field = root.overrides !== undefined ? root.overrides : root.resolutions;
  if (!field || typeof field !== "object" || Array.isArray(field)) return out;
  // The root's declared range for a name, in Bun's order of dependency kinds.
  const declared = (name: string) => [root.devDependencies, root.optionalDependencies, root.dependencies, root.peerDependencies].map((d) => d?.[name]).find((r) => r !== undefined);
  for (const [key, value] of Object.entries(field as Record<string, unknown>)) {
    if (key.startsWith("//") || key === "") continue;
    if (typeof value !== "string") {
      if (value && typeof value === "object") out.unsupported.push(key);
      continue;
    }
    const name = key.replace(/^(?:\*\*\/)+/, "");
    if (!NAME.test(name)) {
      out.unsupported.push(key);
      continue;
    }
    if (value === "" || value === "-" || value.startsWith("patch:")) continue;
    const range = value.startsWith("$") ? declared(value.slice(1)) : value;
    if (range !== undefined) out.rules[name] = range;
  }
  return out;
}
