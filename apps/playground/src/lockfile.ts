import type { LazyData, VFS } from "@runbun/vfs";
import { splitPackage } from "./pkgStore";
import { fetchTarball, registryOf } from "./pkgCache";
import { vfsWorkspaces } from "./workspaces";
import { catalogChanges, catalogsOf } from "./catalogs";
import { flattenOverrides, overridesInLock, overridesOf } from "./overrides";
import { lockedGitHub, tarballPath, type GitHubDep } from "./gitDeps";
import { links } from "./links";
import { BASE } from "./base";
import { untar } from "./tar";

type Log = (level: "log" | "error", text: string) => void;

/** `bun.lock` is JSON plus trailing commas. Strips commas before `}`/`]` outside strings. */
export function parseBunLock(text: string): BunLock {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      out += text.slice(start, i + 1);
    } else if (c === ",") {
      let j = i + 1;
      while (/\s/.test(text[j] ?? "")) j++;
      if (text[j] !== "}" && text[j] !== "]") out += c;
    } else out += c;
  }
  return JSON.parse(out) as BunLock;
}

type BunLock = {
  lockfileVersion: number;
  workspaces?: Record<string, Manifest>;
  catalog?: Deps;
  catalogs?: Record<string, Deps>;
  overrides?: Record<string, unknown>;
  trustedDependencies?: string[];
  packages: Record<string, unknown[]>;
};

type Deps = Record<string, string>;
type Manifest = { dependencies?: Deps; devDependencies?: Deps; optionalDependencies?: Deps; peerDependencies?: Deps; workspaces?: unknown; catalog?: unknown; catalogs?: unknown; overrides?: unknown; resolutions?: unknown; trustedDependencies?: string[] };

const allDeps = (m?: Manifest): Deps => ({ ...m?.peerDependencies, ...m?.devDependencies, ...m?.optionalDependencies, ...m?.dependencies });

/** The dependencies whose range in package.json isn't the one bun.lock recorded: changed, added or removed. */
export function staleInLock(lock: BunLock, pkg: Manifest, workspaces?: { path: string; manifest: Manifest }[]): string[] {
  const differs = (want: Deps, locked: Deps) => [...new Set([...Object.keys(want), ...Object.keys(locked)])].filter((n) => locked[n] !== want[n]);
  const stale = differs(allDeps(pkg), allDeps(lock.workspaces?.[""]));
  // An override added, removed or given another range.
  const rules = overridesInLock(overridesOf(pkg, workspaces?.map((w) => w.manifest)));
  stale.push(...differs(rules, flattenOverrides(lock.overrides)).map((n) => `override ${n}`));
  // A catalog entry added, removed or given another range (the workspaces keep the `catalog:` literal).
  for (const e of catalogChanges({ default: lock.catalog ?? {}, groups: lock.catalogs ?? {} }, catalogsOf(pkg))) stale.push(`catalog ${e}`);
  // A trusted package added or removed, among those bun.lock has (Bun writes only those).
  const names = new Set<string>();
  for (const [key, e] of Object.entries(lock.packages)) {
    const id = typeof e[0] === "string" ? parseIdent(e[0]) : null;
    if (id) names.add(resolutionKind(id.version) === "npm" ? id.name : splitKey(key).at(-1)!);
  }
  const trusted = Array.isArray(pkg.trustedDependencies) ? pkg.trustedDependencies.filter((n) => names.has(n)) : [];
  const lockedTrusted = lock.trustedDependencies ?? [];
  if (trusted.length !== lockedTrusted.length || trusted.some((n) => !lockedTrusted.includes(n))) stale.push("trustedDependencies");
  // A workspace added or removed, or one whose dependencies changed (named by its folder).
  if (!workspaces) return stale;
  const paths = new Set(workspaces.map((w) => w.path));
  for (const path of Object.keys(lock.workspaces ?? {})) if (path && !paths.has(path)) stale.push(path);
  for (const { path, manifest } of workspaces) {
    const locked = lock.workspaces?.[path];
    if (!locked) stale.push(path);
    else if (differs(allDeps(manifest), allDeps(locked)).length) stale.push(path);
  }
  return stale;
}

/** `"a/@s/b/c"` → `["a", "@s/b", "c"]`: lockfile keys join the install path's package names with `/`. */
export function splitKey(key: string): string[] {
  const parts = key.split("/");
  const names: string[] = [];
  for (let i = 0; i < parts.length; i++) names.push(parts[i].startsWith("@") ? `${parts[i]}/${parts[++i]}` : parts[i]);
  return names;
}

/** `["a", "@s/b"]` → `"node_modules/a/node_modules/@s/b"`. */
export const installPath = (names: string[]) => names.map((n) => `node_modules/${n}`).join("/");

/**
 * Removes the packages in node_modules that aren't at one of `keep`'s install paths (`node_modules/a`,
 * `node_modules/a/node_modules/@s/b`), as native `bun install` does with what the new bun.lock no longer places.
 * Folders starting with a dot (`.bin`, `.vite`, `.cache`) stay. Returns the folders removed.
 */
export function pruneNodeModules(vfs: Pick<VFS, "list" | "remove">, keep: Set<string>): string[] {
  const stale = new Set<string>();
  for (const file of vfs.list("node_modules")) {
    const parts = file.split("/");
    // Down the chain of node_modules/<pkg>/node_modules/<pkg>…: the first package that isn't kept goes, with all below it.
    for (let i = 0; parts[i] === "node_modules" && i + 1 < parts.length - 1; ) {
      const name = parts[i + 1]!;
      if (name.startsWith(".")) break;
      const end = name.startsWith("@") ? i + 3 : i + 2;
      if (end >= parts.length) break;
      const dir = parts.slice(0, end).join("/");
      if (!keep.has(dir)) {
        stale.add(dir);
        break;
      }
      i = end;
    }
  }
  for (const dir of stale) vfs.remove(dir);
  return [...stale];
}

/** `cpu` of a wasm32 package: npm's `"wasm32"`, or `"none"` in bun.lock (no CPU Bun knows). */
const WASM32 = new Set(["wasm32", "none"]);

/**
 * No native binary runs in the browser, so any `os`/`cpu`/`libc` restriction means "doesn't match this host", except
 * wasm32 alone: napi-rs ships those bindings for exactly this.
 */
export const platformRestricted = (m?: { os?: unknown; cpu?: unknown; libc?: unknown }): boolean =>
  !!m && !!(m.os || m.libc || (m.cpu && ![m.cpu].flat().every((c) => WASM32.has(String(c)))));

/** `name@resolution`; the resolution can hold an `@` itself (a scoped package's tarball URL). */
function parseIdent(ident: string): { name: string; version: string } | null {
  const at = ident.indexOf("@", 1);
  if (at <= 0) return null;
  return { name: ident.slice(0, at), version: ident.slice(at + 1) };
}

async function checkIntegrity(bytes: Uint8Array<ArrayBuffer>, integrity: string): Promise<boolean> {
  const [algo, expected] = integrity.split("-", 2);
  const name = { sha512: "SHA-512", sha384: "SHA-384", sha256: "SHA-256", sha1: "SHA-1" }[algo];
  if (!name || !expected) return false;
  const digest = new Uint8Array(await crypto.subtle.digest(name, bytes));
  return btoa(String.fromCharCode(...digest)) === expected;
}

export { untar };

/**
 * A package tarball's files (gunzipped), paths without the leading `package/`, as bytes in one block of shared memory
 * where there is one (`shareFiles`): the page and its workers then hold one copy of node_modules between them.
 */
export function packageFiles(tar: Uint8Array, url: string): { name: string; data: Uint8Array | LazyData }[] {
  const files: { name: string; data: Uint8Array }[] = [];
  for (const { name, data } of untar(tar)) {
    const rel = name.split("/").slice(1).join("/");
    if (rel) files.push({ name: rel, data });
  }
  // Large files to the package store, kept out of memory where workers can block on reading them (pkgStore.ts).
  return splitPackage(files, url);
}

const TARBALL = /\.t(ar\.)?gz$/;

/** The kind of a bun.lock resolution (what follows `name@`): a tarball in the project is written down by its path. */
export function resolutionKind(res: string): "npm" | "tarball" | "file" | "link" | "workspace" | "git" | "root" {
  if (/^\d/.test(res)) return "npm";
  if (/^https?:\/\//.test(res)) return "tarball";
  if (res.startsWith("workspace:")) return "workspace";
  if (res.startsWith("link:")) return "link";
  if (res.startsWith("root:")) return "root";
  if (res.startsWith("file:") || (TARBALL.test(res) && !/^(github:|git\+|git:)/.test(res))) return "file";
  return "git";
}

/** `a/./b/../c` → `a/c`. */
function normalize(path: string): string {
  const out: string[] = [];
  for (const s of path.split("/")) {
    if (s === "" || s === ".") continue;
    if (s === "..") out.pop();
    else out.push(s);
  }
  return out.join("/");
}

/** The tarball of a GitHub repository at a ref, through the playground's git proxy (worker/gitProxy.ts). */
export const githubTarballUrl = (dep: GitHubDep) => new URL(`${BASE}git-proxy/codeload.github.com/${tarballPath(dep)}`, location.href).href;

/**
 * INSTALLED_AS_BYTES: installed files go into the VFS as the tarball's bytes, not decoded to strings. V8 stores a
 * string with any character above U+00FF at 2 bytes per character, which made 249 MB of Next.js + MUI cost 390 MB in
 * the page and again in the run worker. Readers decode on demand (`readText`, `textOf`); bun_sys reads bytes anyway.
 */
export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * The tarball (gzipped) of a bun.lock package that comes as one, and the URL it is kept under: npm's or another
 * registry's, a tarball URL, GitHub's, or one in the project (by its path from the project, or from the `file:` folder
 * of `folders` that depends on it).
 */
async function packageTarball(vfs: Pick<VFS, "files" | "readBytes">, id: { name: string; version: string }, entry: unknown[], folders: string[]): Promise<{ tgz: Uint8Array; url: string }> {
  const res = id.version;
  const kind = resolutionKind(res);
  const gh = kind === "git" ? lockedGitHub(res) : undefined;
  if (kind === "file") {
    const path = res.replace(/^file:/, "");
    const url = [normalize(path), ...folders.map((dir) => normalize(`${dir}/${path}`))].find((p) => vfs.files.has(p)) ?? normalize(path);
    const bytes = vfs.readBytes(url);
    if (!bytes) throw new Error(`no file ${url}`);
    return { tgz: bytes, url };
  }
  if (gh) {
    const integrity = entry[3];
    const url = githubTarballUrl(gh);
    return { tgz: await fetchTarball(url, typeof integrity === "string" && integrity ? (b) => checkIntegrity(b, integrity) : undefined), url };
  }
  if (kind !== "npm" && kind !== "tarball") throw new Error(`${id.name}@${res} isn't a tarball`);
  const integrity = kind === "npm" ? (entry[3] as string) : (entry[2] as string | undefined);
  const verify = typeof integrity === "string" && integrity ? (b: Uint8Array<ArrayBuffer>) => checkIntegrity(b, integrity) : undefined;
  const registry = typeof entry[1] === "string" ? entry[1] : "";
  const base = (registry || registryOf(id.name)).replace(/\/$/, "");
  const url = kind === "tarball" ? res : registry.endsWith(".tgz") ? registry : `${base}/${id.name}/-/${id.name.split("/").pop()}-${res}.tgz`;
  return { tgz: await fetchTarball(url, verify), url };
}

/**
 * Installs exactly what `bun.lock` lists: every package at its locked version and install path
 * (nested keys go to nested `node_modules`), each tarball checked against its integrity hash.
 * npm packages, tarball URLs, GitHub tarballs, `file:` folders or tarballs, and workspaces and `link:` folders (copied
 * to node_modules); other git entries are reported and skipped.
 */
export async function installFromBunLock(vfs: VFS, lockText: string, log: Log): Promise<number> {
  const lock = parseBunLock(lockText);
  if (lock.lockfileVersion > 3) log("error", `bun.lock: lockfileVersion ${lock.lockfileVersion} isn't supported yet`);

  const pkgText = vfs.readText("package.json");
  const root = pkgText ? JSON.parse(pkgText) : undefined;
  const stale = root ? staleInLock(lock, root, vfsWorkspaces(vfs, root)) : [];
  // Where each workspace lives, by name: bun.lock keys a package that needs its own copy of a dependency by it.
  const workspaceAt = new Map<string, string>();
  for (const [key, entry] of Object.entries(lock.packages)) {
    const id = typeof entry[0] === "string" ? parseIdent(entry[0]) : null;
    if (id?.version.startsWith("workspace:")) workspaceAt.set(key, id.version.slice("workspace:".length));
  }
  if (stale.length) log("error", `bun.lock doesn't match package.json (${stale.join(", ")}). Installing the locked versions.`);
  // The `file:` folders: a tarball one of them depends on is written down by its path from that folder.
  const folders = Object.values(lock.packages).flatMap((e) => {
    const res = typeof e[0] === "string" ? parseIdent(e[0])?.version : undefined;
    return res?.startsWith("file:") && !TARBALL.test(res) ? [res.slice(5)] : [];
  });

  // Like Bun, only optional dependencies are dropped for a platform mismatch; a required one is still installed.
  const optional = new Set<string>();
  const addOpt = (o?: Record<string, string>) => Object.keys(o ?? {}).forEach((n) => optional.add(n));
  for (const w of Object.values(lock.workspaces ?? {})) addOpt((w as { optionalDependencies?: Record<string, string> }).optionalDependencies);
  for (const e of Object.values(lock.packages)) addOpt((e[2] as { optionalDependencies?: Record<string, string> } | undefined)?.optionalDependencies);

  let installed = 0;
  await Promise.all(
    Object.entries(lock.packages).map(async ([key, entry]) => {
      const id = typeof entry[0] === "string" ? parseIdent(entry[0]) : null;
      if (!id) return log("error", `skip ${key}: unreadable entry`);
      const meta = entry.find((e) => !!e && typeof e === "object" && !Array.isArray(e)) as Parameters<typeof platformRestricted>[0];
      const res = id.version;
      const kind = resolutionKind(res);
      if (kind === "root") return;
      const gh = kind === "git" ? lockedGitHub(res) : undefined;
      if (kind === "git" && !gh) return log("error", `skipped ${key}@${res}: git dependencies other than GitHub's need a git clone, which doesn't work in the browser`);
      if (platformRestricted(meta) && optional.has(splitKey(key).at(-1)!)) {
        log("log", `- ${key}@${res} (optional, not for this platform)`);
        return;
      }
      const names = splitKey(key);
      const dest = installPath(names);
      // A dependency a workspace needs its own copy of (`@m/lib/is-odd`) lives in the workspace's own node_modules, and
      // also in the copy of the workspace under node_modules, which is where the others import it from.
      const wsRoot = names.length > 1 ? workspaceAt.get(names[0]) : undefined;
      const also = wsRoot === undefined ? undefined : `${wsRoot}/${installPath(names.slice(1))}`;
      const put = (name: string, data: Parameters<VFS["write"]>[1]) => {
        vfs.write(`${dest}/${name}`, data);
        if (also) vfs.write(`${also}/${name}`, data);
      };
      try {
        if (kind === "workspace" || kind === "link" || (kind === "file" && !TARBALL.test(res))) {
          // A folder in the project: its files, without its own node_modules. Workspaces and links have no symlink in
          // the VFS: the copy is what `import "@m/lib"` finds.
          const linked = kind === "link" ? links(vfs)[res.slice(5)] : undefined;
          if (kind === "link" && linked === undefined) throw new Error(`package "${res.slice(5)}" is not linked (run \`bun link\` in its folder first)`);
          const from = (linked ?? res.slice(kind === "workspace" ? 10 : 5)).replace(/^\.\//, "").replace(/\/$/, "");
          const files = vfs.list(from).filter((p) => !p.slice(from.length + 1).split("/").includes("node_modules"));
          if (!files.some((p) => p === `${from}/package.json`)) throw new Error(`no package.json in ${from || "."}`);
          for (const p of files) put(p.slice(from.length + 1), vfs.read(p)!);
        } else {
          const { tgz, url } = await packageTarball(vfs, id, entry, folders);
          // Kept as bytes, text included (see INSTALLED_AS_BYTES).
          for (const { name, data } of packageFiles(await gunzip(tgz), url)) put(name, data);
        }
        installed++;
        log("log", `+ ${key}@${res}`);
      } catch (e) {
        log("error", `install ${key}: ${e instanceof Error ? e.message : e}`);
      }
    }),
  );
  return installed;
}
