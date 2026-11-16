/**
 * `bun install` without a bun.lock: resolves package.json the way Bun does and writes the bun.lock Bun would, which
 * `installFromBunLock` then installs. Ported from bun/src/install: version choice (npm.rs `find_best_version`), reuse
 * of a resolved version (lockfile.rs `find_package_id`), hoisting (lockfile/Tree.rs `hoist_dependency`) and the text
 * format (lockfile/bun.lock.rs). Overrides, catalogs, patches and trustedDependencies are not covered.
 */
import type { Semver } from "./semver";
import { findWorkspaces, type Workspace } from "./workspaces";
import { catalogRange, catalogsOf, type Catalogs } from "./catalogs";
import { overridesOf } from "./overrides";

type Group = "dependencies" | "devDependencies" | "optionalDependencies" | "peerDependencies";
const GROUPS: Group[] = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

export type Manifest = {
  name?: string;
  workspaces?: string[] | { packages?: string[]; catalog?: Record<string, string>; catalogs?: Record<string, Record<string, string>> };
  catalog?: Record<string, string>;
  catalogs?: Record<string, Record<string, string>>;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  os?: unknown;
  cpu?: unknown;
  libc?: unknown;
  bin?: string | Record<string, string>;
  hasInstallScript?: boolean;
  scripts?: Record<string, string>;
  deprecated?: string;
  dist?: { tarball: string; integrity?: string };
};
type Packument = { "dist-tags"?: Record<string, string>; versions: Record<string, Manifest> };

export type ResolveHost = {
  semver: Semver;
  /** `range`: the first one asked for this name; the packument fetched for it serves every later range too. */
  packument(name: string, range?: string): Promise<Packument>;
  /** A tarball's bytes (gzipped) and its package.json. */
  tarball(url: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; manifest: Manifest }>;
  /** A folder's package.json in the project, or undefined. */
  folder(path: string): Manifest | undefined;
  /** Every folder of the project with a package.json (none under node_modules): where the root's `workspaces` look. */
  packageDirs(): string[];
  /** One version's full registry document: only it has `libc` (abbreviated packuments leave it out). */
  version(name: string, version: string): Promise<Manifest>;
};

/** Bun reads `libc` from the full document only for these (npm.rs `name_suggests_libc`). */
const nameSuggestsLibc = (name: string) => /linux|musl|glibc/.test(name);

/** `range` is what package.json says (bun.lock keeps it); `use`, when set, is the range a catalog gave it. */
type Dep = { name: string; range: string; use?: string; group: Group; optionalPeer: boolean };
type Pkg = {
  name: string;
  /** What follows `name@` in bun.lock: a version, a tarball URL, `file:<path>` or `workspace:<path>`. */
  resolution: string;
  kind: "npm" | "tarball" | "folder" | "workspace";
  version?: string;
  integrity?: string;
  manifest: Manifest;
  deps: Dep[];
  /** From the bun.lock there was: its dependents keep it. */
  locked?: boolean;
};
type Node = { pkg: Pkg | null; path: string; depth: number; parent: Node | null; placed: Map<string, Pkg> };

const BEHAVIOR_ORDER: Record<Group, number> = { devDependencies: 0, optionalDependencies: 1, dependencies: 2, peerDependencies: 3 };
const byBytes = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A package's dependencies in Bun's order (dev, optional, prod, peer; by name), an optional one only once. */
function depsOf(m: Manifest, root: boolean): Dep[] {
  const out: Dep[] = [];
  const optional = m.optionalDependencies ?? {};
  // An optional peer only named in peerDependenciesMeta is a peer on any version.
  const peers = { ...m.peerDependencies };
  for (const [name, meta] of Object.entries(m.peerDependenciesMeta ?? {})) if (meta?.optional && !(name in peers)) peers[name] = "*";
  for (const group of GROUPS) {
    if (group === "devDependencies" && !root) continue;
    for (const [name, range] of Object.entries(group === "peerDependencies" ? peers : (m[group] ?? {}))) {
      if (group === "dependencies" && name in optional) continue;
      // A package's own dependency of that name wins over its peer.
      if (group === "peerDependencies" && (name in (m.dependencies ?? {}) || name in optional)) continue;
      const optionalPeer = group === "peerDependencies" && !!m.peerDependenciesMeta?.[name]?.optional;
      out.push({ name, range, group, optionalPeer });
    }
  }
  const rank = (d: Dep) => (d.optionalPeer ? BEHAVIOR_ORDER.optionalDependencies : BEHAVIOR_ORDER[d.group]);
  return out.sort((a, b) => rank(a) - rank(b) || byBytes(a.name, b.name));
}

const isTarballUrl = (r: string) => /^https?:\/\//.test(r);
const exactVersion = (r: string) => /^=?v?\d+\.\d+\.\d+(?:[-+][\w.+-]*)?$/.test(r.trim());
const major = (v: string) => Number(v.split(".")[0]);
/** `npm:real@range`: the dependency's folder keeps its own name. */
const alias = (r: string) => (r.match(/^npm:((?:@[^/]+\/)?[^@]+)(?:@(.*))?$/) ?? undefined);

/** Why a range can't be resolved here, or undefined if it can. */
export function unsupportedRange(range: string): string | undefined {
  if (/^link:/.test(range)) return "link: dependencies";
  if (/^file:.*\.t(ar\.)?gz$/.test(range)) return "file: tarballs";
  if (/^(git\+|git:|github:|gitlab:|bitbucket:)/.test(range) || /^[\w.-]+\/[\w.-]+(#.*)?$/.test(range)) return "git dependencies";
}

function pickVersion(doc: Packument, range: string, semver: Semver): string | undefined {
  const tags = doc["dist-tags"] ?? {};
  if (range === "" || range === "*" || range === "latest") return tags.latest;
  if (range in tags) return tags[range];
  if (exactVersion(range)) {
    const v = range.trim().replace(/^=?v?/, "");
    return v in doc.versions ? v : undefined;
  }
  const pre = /\d-/.test(range);
  const latest = tags.latest;
  if (latest && doc.versions[latest] && !doc.versions[latest].deprecated && semver.satisfies(latest, range) && !pre) return latest;
  let best: string | undefined, deprecated: string | undefined;
  for (const [v, m] of Object.entries(doc.versions)) {
    if ((!pre && v.includes("-")) || !semver.satisfies(v, range)) continue;
    if (m.deprecated) {
      if (deprecated === undefined || semver.order(v, deprecated) > 0) deprecated = v;
    } else if (best === undefined || semver.order(v, best) > 0) best = v;
  }
  return best ?? deprecated;
}

export type Resolved = { root: Manifest; rootDeps: Dep[]; workspaces: Workspace[]; catalogs: Catalogs; overrides: Record<string, string>; tree: Node[]; problems: string[] };

/** A range npm would take from a registry, which a workspace of a version that satisfies it serves instead. */
const semverLike = (r: string) => /^[\s\d^~<>=*xX.|-]*$/.test(r);

/**
 * The packages of an existing bun.lock (`packages` of `parseBunLock`), which a dependency keeps when its range still
 * fits, as `bun install` does with a lockfile that package.json has moved past.
 */
export function lockedPackages(packages: Record<string, unknown[]>): Pkg[] {
  const out = new Map<string, Pkg>();
  for (const entry of Object.values(packages)) {
    const ident = entry[0];
    if (typeof ident !== "string") continue;
    const at = ident.indexOf("@", 1);
    const name = ident.slice(0, at), resolution = ident.slice(at + 1);
    const kind = /^\d/.test(resolution) ? "npm" : /^https?:\/\//.test(resolution) ? "tarball" : undefined;
    if (!kind || out.has(ident)) continue;
    const info = (entry.find((e) => !!e && typeof e === "object" && !Array.isArray(e)) ?? {}) as Manifest & { optionalPeers?: string[] };
    const manifest: Manifest = { ...info, peerDependenciesMeta: Object.fromEntries((info.optionalPeers ?? []).map((n) => [n, { optional: true }])) };
    const integrity = (kind === "npm" ? entry[3] : entry[2]) as string | undefined;
    out.set(ident, { name, resolution, kind, version: kind === "npm" ? resolution : undefined, integrity, manifest, deps: depsOf(manifest, false), locked: true });
  }
  return [...out.values()];
}

/** Resolves every dependency (queue order, like Bun), then builds Bun's hoisted node_modules tree. */
export async function resolveProject(root: Manifest, host: ResolveHost, locked: Pkg[] = []): Promise<Resolved> {
  const { semver } = host;
  /** A locked package this range keeps, if any. */
  const keep = (name: string, range: string) =>
    locked.find((p) => p.name === name && (p.kind === "tarball" ? p.resolution === range : p.version !== undefined && !isTarballUrl(range) && semver.satisfies(p.version, range)));
  const problems: string[] = [];
  const workspaces = findWorkspaces(root, host.packageDirs(), (dir) => host.folder(dir));
  const catalogs = catalogsOf(root);
  /** `catalog:` dependencies of the root and the workspaces take the range their catalog gives (`range`; the lock keeps the literal). */
  const catalogged = (deps: Dep[]): Dep[] =>
    deps.flatMap((d) => {
      if (!d.range.startsWith("catalog:")) return [d];
      const name = d.range.slice("catalog:".length).trim();
      const range = catalogRange(catalogs, name, d.name);
      if (range !== undefined) return [{ ...d, use: range }];
      const known = name === "" || name === "default" ? Object.keys(catalogs.default).length + Object.keys(catalogs.groups.default ?? {}).length > 0 : name in catalogs.groups;
      problems.push(
        root.workspaces === undefined
          ? `${d.name}@${d.range}: catalogs need a "workspaces" field in the root package.json`
          : known
            ? `${d.name}@${d.range}: not in catalog${name ? ` "${name}"` : ""}`
            : `${d.name}@${d.range}: there is no catalog named "${name}" in the root package.json`,
      );
      return [];
    });
  const overrides = overridesOf(root);
  for (const key of overrides.unsupported) problems.push(`"${key}" in overrides or resolutions: scoped rules don't work in the browser yet`);
  /** What each overridden name asks for instead (a `catalog:` value through its catalog). */
  const overridden = new Map<string, string>();
  for (const [name, value] of Object.entries(overrides.rules)) {
    const range = value.startsWith("catalog:") ? catalogRange(catalogs, value.slice("catalog:".length).trim(), name) : value;
    if (range === undefined) problems.push(`${name}@${value}: not in the catalog`);
    else overridden.set(name, range);
  }
  /** The range a dependency asks for: its override's, else its catalog's, else its own. */
  const eff = (d: Dep) => overridden.get(d.name) ?? d.use ?? d.range;
  const wsPkgs = new Map<string, Pkg>();
  for (const { path, manifest } of workspaces) {
    wsPkgs.set(manifest.name, { name: manifest.name, resolution: `workspace:${path}`, kind: "workspace", manifest, deps: catalogged(depsOf(manifest, true)) });
  }
  /** The workspace a dependency is: \`workspace:\` ones by name, others when the workspace's version satisfies the range. */
  const workspaceFor = (name: string, range: string, aliased: boolean): Pkg | undefined => {
    const pkg = wsPkgs.get(name);
    if (!pkg || aliased) return;
    if (range.startsWith("workspace:")) return pkg;
    const v = pkg.manifest.version;
    return v && semverLike(range) && semver.satisfies(v, range) ? pkg : undefined;
  };
  const byName = new Map<string, Pkg[]>();
  const byResolution = new Map<string, Pkg>();
  const pinned = new Set<string>();
  const docs = new Map<string, Promise<Packument>>();
  const refetched = new Set<string>();
  const doc = (name: string, range: string) => {
    let p = docs.get(name);
    if (!p) docs.set(name, (p = host.packument(name, range)));
    p.catch(() => {});
    return p;
  };
  /** Resolution per (dependent, dependency name). */
  const resolutions = new Map<Pkg | null, Map<string, Pkg>>();
  const resolvedAs = (from: Pkg | null) => {
    let m = resolutions.get(from);
    if (!m) resolutions.set(from, (m = new Map()));
    return m;
  };

  function add(pkg: Pkg): Pkg {
    const key = `${pkg.name}@${pkg.resolution}`;
    const have = byResolution.get(key);
    if (have) return have;
    byResolution.set(key, pkg);
    byName.set(pkg.name, [...(byName.get(pkg.name) ?? []), pkg]);
    return pkg;
  }

  async function resolve(dep: Dep, from: Pkg | null): Promise<Pkg | undefined> {
    const want = eff(dep);
    const a = alias(want);
    const realName = a ? a[1] : dep.name;
    const range = a ? (a[2] ?? "latest") : want;
    const ws = workspaceFor(realName, range, !!a);
    if (ws) {
      const want = range.replace(/^workspace:/, "");
      const v = ws.manifest.version;
      // `workspace:*`, `^` and `~` take whatever version the workspace has; an exact or ranged one must fit.
      if (v && !/^[*^~]?$/.test(want) && semverLike(want) && !semver.satisfies(v, want)) {
        problems.push(`${dep.name}@${dep.range}: workspace ${ws.name} is at ${v}`);
        return;
      }
      return ws;
    }
    if (range.startsWith("workspace:")) {
      problems.push(`${dep.name}@${dep.range}: no workspace named ${realName}`);
      return;
    }
    const why = unsupportedRange(range);
    if (why) {
      problems.push(`${dep.name}@${dep.range}: ${why} don't work in the browser`);
      return;
    }
    const kept = keep(realName, range);
    if (kept) return add(kept);
    if (isTarballUrl(range)) {
      const { bytes, manifest } = await host.tarball(range);
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-512", bytes));
      const integrity = `sha512-${btoa(String.fromCharCode(...digest))}`;
      return add({ name: manifest.name ?? dep.name, resolution: range, kind: "tarball", integrity, manifest, deps: depsOf(manifest, false) });
    }
    if (/^file:|^\.{0,2}\//.test(range)) {
      const path = normalizePath(range.replace(/^file:/, ""), from?.kind === "folder" ? from.resolution.slice(5) : "");
      const manifest = host.folder(path);
      if (!manifest) {
        problems.push(`${dep.name}@${dep.range}: no package.json at ${path}`);
        return;
      }
      return add({ name: manifest.name ?? dep.name, resolution: `file:${path}`, kind: "folder", manifest, deps: depsOf(manifest, false) });
    }
    let d = await doc(realName, range);
    let best = pickVersion(d, range, semver);
    // The packument may be a stale one an earlier exact version reused (pkgCache): once per name, asked for again
    // without a range, which fetches it when stale.
    if (!best && !refetched.has(realName)) {
      refetched.add(realName);
      const p = host.packument(realName);
      docs.set(realName, p);
      p.catch(() => {});
      d = await p;
      best = pickVersion(d, range, semver);
    }
    if (!best) {
      problems.push(`${dep.name}@${dep.range}: no version matches`);
      return;
    }
    if (exactVersion(range)) pinned.add(`${realName}@${best}`);
    const reuse = byName.get(realName)?.find((p) =>
      p.kind === "npm" && p.version !== undefined && (p.version === best ||
        (semver.satisfies(p.version, range) && (pinned.has(`${realName}@${p.version}`) || major(p.version) >= major(best)))),
    );
    if (reuse) return reuse;
    let manifest = d.versions[best];
    if (nameSuggestsLibc(realName) && manifest.libc === undefined) {
      const libc = await host.version(realName, best).then((m) => m.libc, () => undefined);
      if (libc !== undefined) manifest = { ...manifest, libc };
    }
    return add({ name: realName, resolution: best, kind: "npm", version: best, integrity: manifest.dist?.integrity, manifest, deps: depsOf(manifest, false) });
  }

  // Resolution, in queue order: a package's dependencies queue up behind everything already queued. Peers come after
  // the rest (a peer takes a version that something else already resolved, if it fits).
  const rootDeps = depsOf(root, true);
  const seen = new Set<Pkg>();
  const queue: [Dep, Pkg | null][] = [];
  const peers: [Dep, Pkg | null][] = [];
  /** Queues a dependency and starts fetching its packument, so the network runs ahead of the queue. */
  const enqueue = (d: Dep, from: Pkg | null) => {
    if (d.optionalPeer) return;
    (d.group === "peerDependencies" && from ? peers : queue).push([d, from]);
    const want = eff(d);
    const a = alias(want);
    const r = a ? (a[2] ?? "") : want;
    if (!workspaceFor(a ? a[1] : d.name, r, !!a) && !r.startsWith("workspace:") && !unsupportedRange(r) && !isTarballUrl(r) && !/^file:|^\.{0,2}\//.test(r) && !keep(a ? a[1] : d.name, a ? (a[2] ?? "latest") : r)) doc(a ? a[1] : d.name, a ? (a[2] ?? "latest") : r);
  };
  // Workspaces come first in the root's dependencies (Behavior::cmp), by name.
  const wsDeps: Dep[] = [...wsPkgs.keys()].sort(byBytes).map((name) => ({ name, range: `workspace:${wsPkgs.get(name)!.resolution.slice(10)}`, group: "dependencies", optionalPeer: false }));
  const topDeps = [...wsDeps, ...catalogged(rootDeps)];
  for (const d of topDeps) enqueue(d, null);
  while (queue.length || peers.length) {
    if (!queue.length) queue.push(...peers.splice(0));
    const [dep, from] = queue.shift()!;
    let pkg: Pkg | undefined;
    try {
      if (dep.group === "peerDependencies") {
        // A peer takes the version already resolved for that name, if one fits the range.
        pkg = byName.get(dep.name)?.find((p) => p.version !== undefined && semver.satisfies(p.version, eff(dep)));
      }
      pkg ??= await resolve(dep, from);
    } catch (e) {
      const msg = `${dep.name}@${dep.range}: ${e instanceof Error ? e.message : e}`;
      if (dep.group === "optionalDependencies") continue;
      problems.push(msg);
    }
    if (!pkg) continue;
    resolvedAs(from).set(dep.name, pkg);
    if (!seen.has(pkg)) {
      seen.add(pkg);
      for (const d of pkg.deps) enqueue(d, pkg);
    }
  }

  collapseVersions(resolutions, topDeps, semver, eff);

  // The tree: breadth first from the root. A dependency goes to the root unless a different package of that name is
  // already on the way up; then it stays in its dependent's node_modules.
  const rootNode: Node = { pkg: null, path: "", depth: 0, parent: null, placed: new Map() };
  const tree: Node[] = [rootNode];
  for (let i = 0; i < tree.length; i++) {
    const node = tree[i];
    const deps = node.pkg ? node.pkg.deps : topDeps;
    for (const dep of deps) {
      const pkg = resolutions.get(node.pkg)?.get(dep.name);
      if (!pkg) continue;
      let found: Pkg | undefined;
      for (let at: Node | null = node; at && !found; at = at.parent) found = at.placed.get(dep.name);
      const fits = found && (found === pkg || (dep.group === "peerDependencies" && found.version !== undefined && semver.satisfies(found.version, eff(dep))));
      if (fits || (found && node.placed.has(dep.name))) continue;
      const placeAt = found ? node : rootNode;
      placeAt.placed.set(dep.name, pkg);
      const path = placeAt.depth === 0 ? dep.name : `${placeAt.path}/${dep.name}`;
      tree.push({ pkg, path, depth: placeAt.depth + 1, parent: placeAt, placed: new Map() });
    }
  }
  return { root, rootDeps, workspaces, catalogs, overrides: overrides.rules, tree, problems };
}

/**
 * After resolution, like Bun's `collapse_appended` (dedupe.rs), moves dependencies onto as few versions of a package as
 * satisfy them all. The root's own dependencies and peers keep theirs. A greedy cover: the version that serves the most
 * remaining dependents first, the higher version on a tie. (Bun's pass is a fuller set cover; where they differ, the
 * lockfile is still valid and `bun install --frozen-lockfile` accepts it.)
 */
function collapseVersions(resolutions: Map<Pkg | null, Map<string, Pkg>>, rootDeps: Dep[], semver: Semver, eff: (d: Dep) => string) {
  type Edge = { from: Pkg | null; key: string; range: string; fixed: boolean };
  const edges = new Map<string, Edge[]>();
  const versions = new Map<string, Map<string, Pkg>>();
  for (const [from, deps] of resolutions) {
    for (const [key, pkg] of deps) {
      if (pkg.kind !== "npm") continue;
      const dep = (from ? from.deps : rootDeps).find((d) => d.name === key);
      if (!dep) continue;
      const want = eff(dep);
    const a = alias(want);
      const range = a ? (a[2] ?? "latest") : want;
      const fixed = !from || from.kind === "workspace" || pkg.locked || dep.group === "peerDependencies" || !/^[\s\d^~<>=*xX.|-]+$/.test(range);
      edges.set(pkg.name, [...(edges.get(pkg.name) ?? []), { from, key, range, fixed }]);
      let v = versions.get(pkg.name);
      if (!v) versions.set(pkg.name, (v = new Map()));
      v.set(pkg.version!, pkg);
    }
  }
  for (const [name, list] of edges) {
    const pkgs = versions.get(name)!;
    if (pkgs.size < 2) continue;
    const current = (e: Edge) => resolutions.get(e.from)!.get(e.key)!;
    const chosen = new Set(list.filter((e) => e.fixed).map((e) => current(e).version!));
    let open = list.filter((e) => !e.fixed);
    const assign = () => {
      open = open.filter((e) => {
        const fits = [...chosen].filter((v) => semver.satisfies(v, e.range));
        if (!fits.length) return true;
        const keep = fits.includes(current(e).version!) ? current(e).version! : fits.sort((a, b) => semver.order(b, a))[0];
        resolutions.get(e.from)!.set(e.key, pkgs.get(keep)!);
        return false;
      });
    };
    assign();
    while (open.length) {
      let best: string | undefined, served = -1;
      for (const v of pkgs.keys()) {
        const n = open.filter((e) => semver.satisfies(v, e.range)).length;
        if (n > served || (n === served && semver.order(v, best!) > 0)) (best = v), (served = n);
      }
      chosen.add(best!);
      assign();
    }
  }
}

function normalizePath(p: string, base: string): string {
  const parts: string[] = base ? base.split("/") : [];
  for (const s of p.split("/")) {
    if (s === "" || s === ".") continue;
    if (s === "..") parts.pop();
    else parts.push(s);
  }
  return parts.join("/");
}

// ─── bun.lock text ────────────────────────────────────────────────────────────────────────────────────────────────

const OS = ["aix", "linux", "sunos", "win32", "darwin", "android", "freebsd", "openbsd"];
const CPU = ["arm", "ppc", "x32", "x64", "ia32", "mips", "s390", "arm64", "ppc64", "s390x", "mipsel"];

/** npm's os/cpu list → Bun's bitset (`Negatable::apply` + `combine`), as a set of names; null = every value. */
function negatable(field: unknown, names: string[]): Set<string> | null {
  let added = new Set<string>(), removed = new Set<string>(), wildcard = false, unrecognized = false;
  for (const raw of [field ?? []].flat().map(String)) {
    if (!raw) continue;
    if (raw === "any") { wildcard = true; continue; }
    if (raw === "none") { unrecognized = true; continue; }
    const not = raw.startsWith("!");
    const name = not ? raw.slice(1) : raw;
    if (!names.includes(name)) {
      if (!not) unrecognized = true;
      continue;
    }
    (not ? removed : added).add(name);
    wildcard = unrecognized = false;
  }
  if (wildcard) added = new Set(names);
  if (!added.size && !removed.size) return unrecognized ? new Set() : null;
  const base = added.size ? added : new Set(names);
  return new Set(names.filter((n) => base.has(n) && !removed.has(n)));
}

/** `Negatable::to_json`: one name, or a list of the included (or the excluded, `!`-prefixed: whichever is shorter). */
function negatableJson(set: Set<string>, names: string[]): string {
  if (!set.size) return '"none"';
  const included = names.filter((n) => set.has(n));
  const removed = names.length - included.length;
  const printIncluded = removed > included.length;
  const items = printIncluded ? included.map((n) => `"${n}"`) : names.filter((n) => !set.has(n)).map((n) => `"!${n}"`);
  return items.length === 1 ? items[0] : `[ ${items.map((i) => `${i}, `).join("")}]`;
}

const q = (s: string) => JSON.stringify(s);

function binJson(bin: Manifest["bin"]): string | undefined {
  if (!bin) return;
  if (typeof bin === "string") return q(bin);
  const entries = Object.entries(bin);
  if (!entries.length) return;
  return `{ ${entries.map(([k, v]) => `${q(k)}: ${q(v)}`).join(", ")} }`;
}

function info(pkg: Pkg): string {
  const parts: string[] = [];
  const optionalPeers: string[] = [];
  const deps = [...pkg.deps].sort((a, b) => byBytes(a.name, b.name));
  for (const group of GROUPS) {
    const inGroup = deps.filter((d) => (d.optionalPeer ? group === "peerDependencies" : d.group === group));
    if (!inGroup.length) continue;
    if (group === "peerDependencies") optionalPeers.push(...inGroup.filter((d) => d.optionalPeer).map((d) => d.name));
    parts.push(`${q(group)}: { ${inGroup.map((d) => `${q(d.name)}: ${q(d.range)}`).join(", ")} }`);
  }
  if (optionalPeers.length) parts.push(`"optionalPeers": [${optionalPeers.map(q).join(", ")}]`);
  const m = pkg.manifest;
  const os = negatable(m.os, OS);
  if (os) parts.push(`"os": ${negatableJson(os, OS)}`);
  const cpu = negatable(m.cpu, CPU);
  if (cpu) parts.push(`"cpu": ${negatableJson(cpu, CPU)}`);
  const libc = [m.libc ?? []].flat().map(String).filter((l) => l === "glibc" || l === "musl");
  if (libc.length === 1) parts.push(`"libc": ${q(libc[0])}`);
  const scripts = m.scripts ?? {};
  if (m.hasInstallScript || scripts.preinstall || scripts.install || scripts.postinstall) parts.push(`"hasInstallScript": true`);
  const bin = binJson(m.bin);
  if (bin) parts.push(`"bin": ${bin}`);
  return parts.length ? `{ ${parts.join(", ")} }` : "{}";
}

function entry(pkg: Pkg): string {
  const ident = q(`${pkg.name}@${pkg.resolution}`);
  if (pkg.kind === "npm") return `[${ident}, "", ${info(pkg)}, ${q(pkg.integrity ?? "")}]`;
  if (pkg.kind === "workspace") return `[${ident}]`;
  if (pkg.kind === "tarball") return `[${ident}, ${info(pkg)}${pkg.integrity ? `, ${q(pkg.integrity)}` : ""}]`;
  return `[${ident}, ${info(pkg)}]`;
}

/** The bun.lock Bun writes for this tree. */
export function writeBunLock({ root, rootDeps, workspaces, catalogs, overrides, tree }: Resolved): string {
  const lines = ["{", '  "lockfileVersion": 2,', '  "configVersion": 1,', '  "workspaces": {'];
  /** One `"workspaces"` member: the root (`""`) or a workspace folder. */
  const member = (key: string, m: Manifest, deps: Dep[], workspace: boolean) => {
    const body: string[] = [];
    if (m.name) body.push(`      "name": ${q(m.name)}`);
    if (workspace && m.version) body.push(`      "version": ${q(m.version)}`);
    const bin = workspace && m.bin;
    if (bin && typeof bin === "string") body.push(`      "bin": ${q(bin)}`);
    else if (bin && Object.keys(bin).length) body.push(`      "bin": {\n${Object.entries(bin).map(([k, v]) => `        ${q(k)}: ${q(v)},\n`).join("")}      }`);
    const sorted = [...deps].sort((a, b) => byBytes(a.name, b.name));
    for (const group of GROUPS) {
      const inGroup = sorted.filter((d) => d.group === group);
      if (!inGroup.length) continue;
      body.push(`      ${q(group)}: {\n${inGroup.map((d) => `        ${q(d.name)}: ${q(d.range)},\n`).join("")}      }`);
    }
    lines.push(`    ${q(key)}: {`);
    if (body.length) lines.push(body.join(",\n") + ",");
    lines.push("    },");
  };
  member("", root, rootDeps, false);
  for (const w of workspaces) member(w.path, w.manifest, depsOf(w.manifest, true), true);
  lines.push("  },");
  if (Object.keys(overrides).length) lines.push('  "overrides": {', ...Object.keys(overrides).sort(byBytes).map((n) => `    ${q(n)}: ${q(overrides[n])},`), "  },");
  const group = (map: Record<string, string>, indent: string) => Object.keys(map).sort(byBytes).map((n) => `${indent}${q(n)}: ${q(map[n])},`);
  if (Object.keys(catalogs.default).length) lines.push('  "catalog": {', ...group(catalogs.default, "    "), "  },");
  const named = Object.keys(catalogs.groups).sort(byBytes);
  if (named.length) {
    lines.push('  "catalogs": {');
    for (const name of named) lines.push(`    ${q(name)}: {`, ...group(catalogs.groups[name], "      "), "    },");
    lines.push("  },");
  }

  // Nodes by depth, then path; each node's packages by name.
  const nodes = tree.slice(1).sort((a, b) => a.depth - b.depth || byBytes(a.parent!.path, b.parent!.path) || byBytes(a.path, b.path));
  const packages = nodes.map((n) => `    ${q(n.path)}: ${entry(n.pkg!)}`);
  if (packages.length) lines.push('  "packages": {', packages.join(",\n\n") + ",", "  }");
  else lines.push('  "packages": {}');
  lines.push("}");
  return lines.join("\n") + "\n";
}
