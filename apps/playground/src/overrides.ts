/**
 * `overrides` (npm) and `resolutions` (yarn) in the root package.json, as Bun reads them (lockfile/OverrideMap.rs and
 * override_selector.rs).
 *
 * A flat rule `"name": "range"` makes every dependency on `name`, in any package, ask for `range` instead. A scoped one
 * only applies to the dependencies of one package (its parent) or to those that declare a range overlapping the key's:
 *   npm:   `{ "parent": { "child": "1.0.0", ".": "2.0.0" } }`, `"name@range": ...`, `"parent@range": { ... }`
 *   yarn:  `parent/child`, `**\/parent/child`, `parent/**\/child`
 *   pnpm:  `parent>child`, `parent@range>child@range`
 * Nested objects are read in `overrides` only (`resolutions` takes strings), one level deep. `resolutions` is read only
 * when there is no `overrides`; a value of `$name` is the range the root (else one workspace) declares for `name`;
 * empty values, `-` and `patch:` ones are skipped, as are keys and values Bun warns about and ignores.
 */
import type { Semver } from "./semver";

type Deps = Record<string, string> | undefined;
type Declares = { dependencies?: Deps; devDependencies?: Deps; optionalDependencies?: Deps; peerDependencies?: Deps };
type Root = Declares & { overrides?: unknown; resolutions?: unknown };

/** A package name with the range its key selects (`""`: any). */
export type Selector = { name: string; range: string };
export type Rule = { parent?: Selector; target: Selector; value: string };
/** The package a dependency is declared by: its name, and its version when it's an npm package or a workspace. */
export type Owner = { name: string; version?: string };

export type Overrides = {
  /** The flat rules: package name → the value as written (a `$name` already replaced by the root's range). */
  rules: Record<string, string>;
  /** The rules for one parent, or for the dependencies that declare a range, in the order they were written. */
  scoped: Rule[];
  /** Why the install fails (Bun errors on these), if it does. */
  errors: string[];
  /** The value of the rule that applies to a dependency of `owner`, if any. */
  lookup(dep: { name: string; range: string }, owner: Owner, semver: Semver): string | undefined;
};

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const byBytes = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// ─── selectors (override_selector.rs) ─────────────────────────────────────────────────────────────────────────────

/** `name@range` → [name, range], `@scope/name@range` too; the range is undefined when there is none. */
function splitNameAndMaybeVersion(s: string): [string, string | undefined] {
  const at = s.indexOf("@");
  if (at > 0) return [s.slice(0, at), at + 1 < s.length ? s.slice(at + 1) : undefined];
  if (at < 0) return [s, undefined];
  const second = s.indexOf("@", 1);
  if (second < 0) return [s, undefined];
  return [s.slice(0, second), second + 1 < s.length ? s.slice(second + 1) : undefined];
}

const isTarball = (t: string) => /\.(?:tgz|tar\.gz)$/.test(t);

/** Whether Bun reads `text` as an npm range (dependency.rs `Tag::infer`), the cases a selector can have. */
function infersNpm(text: string): boolean {
  const t = text.trimStart();
  if (!t) return false;
  const c = t[0];
  if ("=><^*|".includes(c)) return true;
  if (c === "~") return t[1] !== "/";
  if (c === "." || c === "/") return false;
  if (c >= "0" && c <= "9") return !isTarball(t) && (/[|+ \t\n\r]/.test(t) || /^\d+(?:\.(?:\d+|[xX*]))*(?:[-+]|$)/.test(t));
  if (c === "v") return t.length > 1 && /^v\d/.test(t) && !isTarball(t) && (/[|+ \t\n\r]/.test(t) || /^v\d+(?:\.(?:\d+|[xX*]))*(?:[-+]|$)/.test(t));
  if (c === "x" || c === "X") return t.length === 1 || t[1] === ".";
  if (c === "p") return t.startsWith("patch:");
  if (c === "n") {
    if (!t.startsWith("npm:")) return false;
    const [, version] = splitNpmAlias(t.slice(4));
    return version === undefined || infersNpm(version);
  }
  if ("fcghslw".includes(c)) return t.includes("|") && !/^(?:file|catalog|git|https?|ssh|link|workspace):/.test(t);
  return t.includes("|");
}

function splitNpmAlias(target: string): [string, string | undefined] {
  const scope = target.startsWith("@") ? 1 : 0;
  const at = target.indexOf("@", scope);
  return at < 0 ? [target, undefined] : [target.slice(0, at), target.slice(at + 1)];
}

/** What a range in a selector or a declared dependency is, as Bun parses it; null for a dist-tag, git URL and the like. */
type Version = { kind: "npm"; range: string; alias?: string } | { kind: "catalog"; name: string };

function parseVersion(text: string): Version | null {
  const t = text.trimStart();
  if (t.startsWith("npm:")) {
    const target = t.slice(4);
    const [name, version] = splitNpmAlias(target);
    // `npm:^1.0.0` and `npm:1.0.0` are ranges, `npm:x` and `npm:1` are aliases.
    if (version === undefined && (/[\^~><=*| ]/.test(target) || /^\d+\.\d+\.\d+(?:[-+].*)?$/.test(target)) && infersNpm(target)) return { kind: "npm", range: target };
    if (version !== undefined && !infersNpm(version)) return null;
    return { kind: "npm", range: version ?? "*", alias: name };
  }
  if (t.startsWith("catalog:")) return { kind: "catalog", name: t.slice("catalog:".length).trim() };
  return infersNpm(t) ? { kind: "npm", range: t } : null;
}

/** `foo@^1`, `foo@npm:^1` (a range) or `foo@npm:bar@^1` (an alias); null when Bun warns and skips the key. */
function parseSegment(segment: string): Selector | null {
  if (!segment) return null;
  const [name, rawRange] = splitNameAndMaybeVersion(segment);
  if (!name || (name.startsWith("@") && !name.includes("/"))) return null;
  let range = rawRange ?? "";
  if (range.startsWith("npm:")) {
    const rest = range.slice(4);
    if (rest === "" || infersNpm(rest)) range = rest;
  }
  if (!range && segment.length > name.length) return null;
  return { name, range };
}

/** pnpm's `parent>child` delimiter: the first `>` that doesn't come after a space, `|`, `@` or `:`. */
function pnpmDelimiter(key: string): number {
  let from = 1;
  while (from < key.length) {
    const i = key.indexOf(">", from);
    if (i < 0) return -1;
    if (" |@:".includes(key[i - 1])) from = i + 1;
    else return i;
  }
  return -1;
}

type Selected = { parent?: Selector; target: Selector };

/** The rule key `key` selects, or null when it is one Bun warns about and skips. */
function parseSelector(key: string): Selected | null {
  const d = pnpmDelimiter(key);
  if (d >= 0) {
    const parent = key.slice(0, d).trim();
    const name = key.slice(d + 1).trim();
    if (!name || pnpmDelimiter(name) >= 0) return null;
    const p = parseSegment(parent);
    const target = p && parseSegment(name);
    return p && target ? { parent: p, target } : null;
  }
  return parseYarnPath(key);
}

function parseYarnPath(key: string): Selected | null {
  const segments: string[] = [];
  const token = (pos: number): [string, number | undefined] => {
    const i = key.indexOf("/", pos);
    return i < 0 ? [key.slice(pos), undefined] : [key.slice(pos, i), i + 1];
  };
  let cursor: number | undefined = 0;
  while (cursor !== undefined) {
    const start: number = cursor;
    const [tok, next] = token(start);
    cursor = next;
    if (!tok) return null;
    if (tok === "**") {
      if (next === undefined) return null;
      continue;
    }
    let end = start + tok.length;
    if (tok.startsWith("@")) {
      if (next === undefined) return null;
      const [name, after] = token(next);
      cursor = after;
      if (!name) return null;
      end = next + name.length;
    }
    // In `name@npm:@scope/other@^1` the `/` is part of the alias target.
    if (key.slice(start, end).includes("@npm:@") && cursor !== undefined) {
      const [rest, after] = token(cursor);
      end = cursor + rest.length;
      cursor = after;
    }
    if (segments.length === 2) return null;
    segments.push(key.slice(start, end));
  }
  if (!segments.length) return null;
  const first = parseSegment(segments[0]);
  if (!first) return null;
  if (segments.length === 1) return { target: first };
  const target = parseSegment(segments[1]);
  return target ? { parent: first, target } : null;
}

// ─── parsing ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** A selector's range as the rule keeps it, or null when it isn't an npm range (nor a catalog, for a target). */
function checkRange(sel: Selector, target: boolean): boolean {
  if (!sel.range) return true;
  const v = parseVersion(sel.range);
  return !!v && (v.kind === "npm" ? target || !v.alias : target);
}

export function overridesOf(root: Root, workspaces: Declares[] = []): Overrides {
  const flat: Record<string, string> = {};
  const scoped: Rule[] = [];
  const errors: string[] = [];
  const out: Overrides = { rules: flat, scoped, errors, lookup: (dep, owner, semver) => lookupRule(flat, scoped, dep, owner, semver) };
  const which = root.overrides !== undefined ? "overrides" : root.resolutions !== undefined ? "resolutions" : undefined;
  if (!which) return out;
  const field = root[which];
  if (!isObject(field)) {
    errors.push(`"${which}" expects a map of package names to versions, e.g. { "${which}": { "react": "18.2.0" } }`);
    return out;
  }
  // The root's declared range for a name, in Bun's order of dependency kinds; else the one every workspace that declares it agrees on.
  const inRoot = (name: string) => [root.devDependencies, root.optionalDependencies, root.dependencies, root.peerDependencies].map((d) => d?.[name]).find((r) => typeof r === "string");
  const inWorkspaces = (name: string) => {
    const found = new Set<string>();
    for (const w of workspaces) {
      const r = [w.dependencies, w.devDependencies, w.optionalDependencies, w.peerDependencies].map((d) => d?.[name]).find((r) => typeof r === "string");
      if (r !== undefined) found.add(r);
    }
    return found.size === 1 ? [...found][0] : undefined;
  };
  const valueOf = (value: string): string | undefined => {
    if (value === "" || value === "-" || value.startsWith("patch:")) return undefined;
    if (!value.startsWith("$")) return value;
    const name = value.slice(1);
    return inRoot(name) ?? inWorkspaces(name);
  };
  const put = (parent: Selector | undefined, target: Selector, raw: string) => {
    const value = valueOf(raw);
    if (value === undefined || !checkRange(target, true)) return;
    if (!parent && !target.range) {
      flat[target.name] = value;
      return;
    }
    const same = (r: Rule) => r.target.name === target.name && r.target.range === target.range && r.parent?.name === parent?.name && r.parent?.range === parent?.range && !r.parent === !parent;
    const at = scoped.findIndex(same);
    const rule: Rule = { parent, target, value };
    if (at >= 0) scoped[at] = rule;
    else scoped.push(rule);
  };
  const string = (key: string, value: string) => {
    const s = parseSelector(key);
    if (!s || (s.parent && !checkRange(s.parent, false))) return;
    put(s.parent, s.target, value);
  };
  for (const [key, value] of Object.entries(field)) {
    if (key === "" || key.startsWith("//")) continue;
    if (typeof value === "string") string(key, value);
    else if (which === "overrides" && isObject(value)) {
      const group = parseSegment(key);
      if (!group || !checkRange(group, false)) continue;
      for (const [child, v] of Object.entries(value)) {
        if (child.startsWith("//") || typeof v !== "string") continue;
        if (child === ".") put(undefined, group, v);
        else {
          const s = parseSelector(child);
          if (s && !s.parent) put(group, s.target, v);
        }
      }
    }
  }
  return out;
}

// ─── lookup (OverrideMap::scoped_rule_for) ────────────────────────────────────────────────────────────────────────

/** Whether the key range `range` selects a dependency declared as `declared`: they share a version (`Selects::Overlapping`). */
function rangeSelects(range: string, declared: string, semver: Semver): boolean {
  const a = parseVersion(range), b = parseVersion(declared);
  if (!a || !b) return false;
  if (a.kind === "catalog" || b.kind === "catalog") {
    const norm = (n: string) => (n === "" ? "default" : n);
    return a.kind === "catalog" && b.kind === "catalog" && norm(a.name) === norm(b.name);
  }
  if (!!a.alias !== !!b.alias || (a.alias !== undefined && a.alias !== b.alias)) return false;
  return intersects(a.range, b.range, semver);
}

function lookupRule(flat: Record<string, string>, scoped: Rule[], dep: { name: string; range: string }, owner: Owner, semver: Semver): string | undefined {
  const declared = parseVersion(dep.range);
  const isAlias = declared?.kind === "npm" && !!declared.alias;
  let best: { rule: Rule; tier: number } | undefined;
  for (const rule of scoped) {
    if (rule.target.name !== dep.name || (!rule.target.range && isAlias)) continue;
    let tier = 0;
    if (rule.parent) {
      if (rule.parent.name !== owner.name) continue;
      if (rule.parent.range) {
        if (owner.version === undefined || !semver.satisfies(owner.version, rule.parent.range)) continue;
        tier = 4;
      } else tier = 2;
    }
    if (rule.target.range) {
      if (best && best.tier > tier + 1) continue;
      if (!rangeSelects(rule.target.range, dep.range, semver)) continue;
      tier += 1;
    }
    if (!best || tier > best.tier || (tier === best.tier && compareRangeText(rule, best.rule) < 0)) best = { rule, tier };
  }
  if (best) return best.rule.value;
  return isAlias ? undefined : Object.hasOwn(flat, dep.name) ? flat[dep.name] : undefined;
}

/** Between two rules of a tier: the parent range text, then the target range text, that sorts first wins. */
function compareRangeText(l: Rule, r: Rule): number {
  const byParent = l.parent?.range && r.parent?.range ? byBytes(l.parent.range, r.parent.range) : 0;
  return byParent || byBytes(l.target.range, r.target.range);
}

// ─── range intersection (semver/intersects.rs) ────────────────────────────────────────────────────────────────────

type Bound = { v: string; inc: boolean };
/** One `||` alternative: the bounds its comparators set, and the version when it is just one. */
type Alternative = { exact?: string; lows: Bound[]; highs: Bound[] };

type Partial3 = { M?: number; m?: number; p?: number; pre?: string };

function partial(s: string): Partial3 | undefined {
  const t = s.replace(/^[v=]+/, "").replace(/\+.*$/, "");
  const dash = t.indexOf("-");
  const main = dash < 0 ? t : t.slice(0, dash);
  const pre = dash < 0 ? undefined : t.slice(dash + 1);
  const parts = main.split(".");
  if (parts.length > 3) return undefined;
  const n = (x?: string) => (x === undefined || x === "" || /^[xX*]$/.test(x) ? undefined : /^\d+$/.test(x) ? Number(x) : NaN);
  const [M, m, p] = [n(parts[0]), n(parts[1]), n(parts[2])];
  if ([M, m, p].some(Number.isNaN)) return undefined;
  return { M, m, p, pre };
}

const floor = (x: Partial3) => `${x.M ?? 0}.${x.m ?? 0}.${x.p ?? 0}${x.pre ? `-${x.pre}` : ""}`;
/** The first version past everything `x` stands for (`1.2` is `1.3.0`); undefined when it stands for all of them. */
const ceil = (x: Partial3): string | undefined => (x.M === undefined ? undefined : x.m === undefined ? `${x.M + 1}.0.0` : x.p === undefined ? `${x.M}.${x.m + 1}.0` : undefined);

/** One comparator's bounds; `exact` when it names one version. */
function comparator(op: string, text: string): Alternative | undefined {
  const x = partial(text);
  if (!x) return undefined;
  const full = x.M !== undefined && x.m !== undefined && x.p !== undefined;
  const hi = ceil(x);
  const lows: Bound[] = [], highs: Bound[] = [];
  switch (op) {
    case "":
    case "=":
      if (full) return { exact: floor(x), lows: [{ v: floor(x), inc: true }], highs: [{ v: floor(x), inc: true }] };
      if (x.M !== undefined) lows.push({ v: floor(x), inc: true });
      if (hi) highs.push({ v: hi, inc: false });
      break;
    case ">":
      if (full) lows.push({ v: floor(x), inc: false });
      else if (hi) lows.push({ v: hi, inc: true });
      else highs.push({ v: "0.0.0-0", inc: false });
      break;
    case ">=":
      lows.push({ v: floor(x), inc: true });
      break;
    case "<":
      highs.push({ v: floor(x), inc: false });
      break;
    case "<=":
      highs.push(full || !hi ? { v: floor(x), inc: true } : { v: hi, inc: false });
      break;
    case "~":
      lows.push({ v: floor(x), inc: true });
      if (x.M !== undefined) highs.push({ v: x.m === undefined ? `${x.M + 1}.0.0` : `${x.M}.${x.m + 1}.0`, inc: false });
      break;
    case "^":
      lows.push({ v: floor(x), inc: true });
      if (x.M !== undefined) highs.push({ v: x.M > 0 || x.m === undefined ? `${x.M + 1}.0.0` : x.m > 0 || x.p === undefined ? `${x.M}.${x.m + 1}.0` : `${x.M}.${x.m}.${x.p + 1}`, inc: false });
      break;
    default:
      return undefined;
  }
  return { lows, highs };
}

function alternatives(range: string): Alternative[] | undefined {
  const out: Alternative[] = [];
  for (const alt of range.split("||")) {
    // `a - b` is `>=a <=b`; an operator apart from its version is joined to it.
    const tokens = alt.trim().replace(/\s+-\s+/g, " \0 ").replace(/([<>=~^]+)\s+/g, "$1").split(/\s+/).filter(Boolean);
    const items: [string, string][] = [];
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i + 1] === "\0") {
        items.push([">=", tokens[i]], ["<=", tokens[i + 2] ?? ""]);
        i += 2;
        continue;
      }
      const m = tokens[i].match(/^([<>=~^]*)(.*)$/)!;
      items.push([m[1], m[2] === "" ? "*" : m[2]]);
    }
    if (!items.length) items.push(["", "*"]);
    const parts = items.map(([op, v]) => comparator(op, v));
    if (parts.some((p) => !p)) return undefined;
    const all = parts as Alternative[];
    out.push({ exact: all.length === 1 ? all[0].exact : undefined, lows: all.flatMap((p) => p.lows), highs: all.flatMap((p) => p.highs) });
  }
  return out;
}

/** Whether some version lies above every lower bound and below every upper one. */
function overlap(lows: Bound[], highs: Bound[], semver: Semver): boolean {
  const lo = lows.reduce<Bound | undefined>((m, b) => (!m || semver.order(b.v, m.v) > 0 || (semver.order(b.v, m.v) === 0 && !b.inc) ? b : m), undefined);
  const hi = highs.reduce<Bound | undefined>((m, b) => (!m || semver.order(b.v, m.v) < 0 || (semver.order(b.v, m.v) === 0 && !b.inc) ? b : m), undefined);
  if (!lo || !hi) return true;
  const c = semver.order(lo.v, hi.v);
  return c < 0 || (c === 0 && lo.inc && hi.inc);
}

/** Whether some version satisfies both ranges: an exact version is checked against the other range, two ranges by their bounds. */
export function intersects(a: string, b: string, semver: Semver): boolean {
  const left = alternatives(a), right = alternatives(b);
  if (!left || !right) return false;
  if (left.some((x) => x.exact !== undefined && semver.satisfies(x.exact, b)) || right.some((y) => y.exact !== undefined && semver.satisfies(y.exact, a))) return true;
  for (const x of left.filter((x) => x.exact === undefined)) {
    if (!overlap(x.lows, x.highs, semver)) continue;
    for (const y of right.filter((y) => y.exact === undefined)) if (overlap([...x.lows, ...y.lows], [...x.highs, ...y.highs], semver)) return true;
  }
  return false;
}

// ─── bun.lock (lockfile/bun.lock.rs `write_override_rules`) ───────────────────────────────────────────────────────

/** The lines of the `"overrides"` section's body (the rules, indented four spaces), in the order Bun writes them. */
export function overrideLines(o: Overrides): string[] {
  const q = JSON.stringify;
  const key = (name: string, range: string) => (range ? `${name}@${range}` : name);
  const flat = Object.entries(o.rules).sort(([a], [b]) => byBytes(a, b));
  const solo = o.scoped.filter((r) => !r.parent).sort((a, b) => byBytes(a.target.name, b.target.name) || byBytes(a.target.range, b.target.range));
  const parented = o.scoped
    .filter((r) => r.parent)
    .sort((a, b) => byBytes(a.parent!.name, b.parent!.name) || byBytes(a.parent!.range, b.parent!.range) || byBytes(a.target.name, b.target.name) || byBytes(a.target.range, b.target.range));
  const order = (a: Selector, b: Selector) => byBytes(a.name, b.name) || byBytes(a.range, b.range);
  const lines: string[] = [];
  let f = 0, s = 0, g = 0;
  while (f < flat.length || s < solo.length || g < parented.length) {
    const soloKey = s < solo.length ? solo[s].target : undefined;
    const parentKey = g < parented.length ? parented[g].parent : undefined;
    const group = soloKey && parentKey ? (order(parentKey, soloKey) < 0 ? parentKey : soloKey) : (soloKey ?? parentKey);
    if (f < flat.length) {
      const c = group ? byBytes(flat[f][0], group.name) : -1;
      if (c < 0 || (c === 0 && group!.range !== "")) {
        lines.push(`    ${q(flat[f][0])}: ${q(flat[f][1])},`);
        f++;
        continue;
      }
    }
    if (!group) break;
    lines.push(`    ${q(key(group.name, group.range))}: {`);
    let dot: string | undefined;
    if (group.range === "") {
      if (f < flat.length && flat[f][0] === group.name) dot = flat[f++][1];
    } else if (s < solo.length && solo[s].target.name === group.name && solo[s].target.range === group.range) dot = solo[s++].value;
    if (dot !== undefined) lines.push(`      ".": ${q(dot)},`);
    while (g < parented.length && parented[g].parent!.name === group.name && parented[g].parent!.range === group.range) {
      lines.push(`      ${q(key(parented[g].target.name, parented[g].target.range))}: ${q(parented[g].value)},`);
      g++;
    }
    lines.push("    },");
  }
  return lines;
}

/** The rules as one flat map, a scoped one under `parent > child` (the same for what bun.lock holds), to tell which changed. */
export function flattenOverrides(rules: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rules ?? {})) {
    if (typeof v === "string") out[k] = v;
    else if (isObject(v)) for (const [c, cv] of Object.entries(v)) if (typeof cv === "string") out[c === "." ? k : `${k} > ${c}`] = cv;
  }
  return out;
}

/** What bun.lock's `overrides` holds for these rules, flattened the same way. */
export function overridesInLock(o: Overrides): Record<string, string> {
  const key = (s: Selector) => (s.range ? `${s.name}@${s.range}` : s.name);
  const out = { ...o.rules };
  for (const r of o.scoped) out[r.parent ? `${key(r.parent)} > ${key(r.target)}` : key(r.target)] = r.value;
  return out;
}
