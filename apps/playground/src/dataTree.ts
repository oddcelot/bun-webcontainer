// The values of a YAML or TOML document from the tree resolve-wasm's `data_parse_c` writes (crates/resolve-wasm/src/data.rs).

type Value = null | boolean | number | string | [0, number] | [1, string] | [2, number, string];
type Node = { a: Value[] } | { o: [Value, Value][] };

/** `Temporal.*.from` per `E::TomlDateTimeKind`, as Bun makes TOML dates and times. */
const TEMPORAL = [, "Instant", "PlainDateTime", "PlainDate", "PlainTime"] as const;

export function fromDataTree(json: string): unknown {
  const { root, nodes } = JSON.parse(json) as { root: Value; nodes: Node[] };
  const made: unknown[] = nodes.map((n) => ("a" in n ? [] : {}));
  const value = (v: Value): unknown => {
    if (!Array.isArray(v)) return v;
    if (v[0] === 0) return made[v[1]];
    if (v[0] === 1) return Number(v[1]);
    const T = (globalThis as { Temporal?: Record<string, { from(s: string): unknown }> }).Temporal;
    if (!T) throw new TypeError("Date/time values require Temporal, which this browser doesn't have");
    return T[TEMPORAL[v[1]]!].from(v[2]);
  };
  // Arrays first: a YAML key that is a sequence becomes its `String()`, which needs its items (as Bun, which sets
  // such keys once the values exist). Properties are defined, not assigned, so `__proto__` is just a key.
  nodes.forEach((n, i) => {
    if ("a" in n) for (const v of n.a) (made[i] as unknown[]).push(value(v));
  });
  nodes.forEach((n, i) => {
    if ("o" in n) for (const [k, v] of n.o) Object.defineProperty(made[i], String(value(k)), { value: value(v), writable: true, enumerable: true, configurable: true });
  });
  return value(root);
}
