import type { LazyData, VFS } from "@runbun/vfs";
import { splitPackage } from "./pkgStore";
import { fetchTarball } from "./pkgCache";

type Log = (level: "log" | "error", text: string) => void;

const NPM = "https://registry.npmjs.org";

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
  packages: Record<string, unknown[]>;
};

type Deps = Record<string, string>;
type Manifest = { dependencies?: Deps; devDependencies?: Deps; optionalDependencies?: Deps; peerDependencies?: Deps };

const allDeps = (m?: Manifest): Deps => ({ ...m?.peerDependencies, ...m?.devDependencies, ...m?.optionalDependencies, ...m?.dependencies });

/** The dependencies whose range in package.json isn't the one bun.lock recorded: changed, added or removed. */
export function staleInLock(lock: BunLock, pkg: Manifest): string[] {
  const want = allDeps(pkg);
  const locked = allDeps(lock.workspaces?.[""]);
  return [...new Set([...Object.keys(want), ...Object.keys(locked)])].filter((n) => locked[n] !== want[n]);
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

export function* untar(buf: Uint8Array): Generator<{ name: string; data: Uint8Array }> {
  const dec = new TextDecoder();
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h[0] === 0) break;
    const str = (a: number, b: number) => dec.decode(h.subarray(a, b)).split("\0")[0];
    let name = str(0, 100);
    if (str(257, 262) === "ustar" && str(345, 500)) name = `${str(345, 500)}/${name}`;
    const size = parseInt(str(124, 136).trim() || "0", 8);
    const type = h[156] ? String.fromCharCode(h[156]) : "0";
    off += 512;
    if (type === "0") yield { name, data: buf.subarray(off, off + size) };
    off += Math.ceil(size / 512) * 512;
  }
}

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
 * Installs exactly what `bun.lock` lists: every package at its locked version and install path
 * (nested keys go to nested `node_modules`), each tarball checked against its integrity hash.
 * npm packages, tarball URLs and `file:` folders or tarballs; git, workspace and link entries are reported and skipped.
 */
export async function installFromBunLock(vfs: VFS, lockText: string, log: Log): Promise<number> {
  const lock = parseBunLock(lockText);
  if (lock.lockfileVersion > 2) log("error", `bun.lock: lockfileVersion ${lock.lockfileVersion} is newer than this installer knows`);

  const pkgText = vfs.readText("package.json");
  const stale = pkgText ? staleInLock(lock, JSON.parse(pkgText)) : [];
  if (stale.length) log("error", `bun.lock is out of date with package.json (${stale.join(", ")}); installing what the lockfile says`);

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
      const kind = /^\d/.test(res) ? "npm" : /^https?:\/\//.test(res) ? "tarball" : res.startsWith("file:") ? "file" : undefined;
      if (!kind) {
        const what = res.startsWith("workspace:") ? "workspaces" : res.startsWith("link:") ? "link: dependencies" : res.startsWith("root:") ? undefined : "git dependencies";
        if (what) log("error", `skip ${key}@${res}: ${what} are not supported in the browser`);
        return;
      }
      if (platformRestricted(meta) && optional.has(splitKey(key).at(-1)!)) {
        log("log", `- ${key}@${res} (optional, unsupported platform)`);
        return;
      }
      const dest = installPath(splitKey(key));
      try {
        if (kind === "file" && !/\.t(ar\.)?gz$/.test(res)) {
          // A folder in the project: its files, without its own node_modules.
          const from = res.slice(5).replace(/^\.\//, "").replace(/\/$/, "");
          const files = vfs.list(from).filter((p) => !p.slice(from.length + 1).split("/").includes("node_modules"));
          if (!files.some((p) => p === `${from}/package.json`)) throw new Error(`no package.json in ${from || "."}`);
          for (const p of files) vfs.write(`${dest}/${p.slice(from.length + 1)}`, vfs.read(p)!);
        } else {
          let tgz: Uint8Array, url: string;
          if (kind === "file") {
            url = res.slice(5).replace(/^\.\//, "");
            const bytes = vfs.readBytes(url);
            if (!bytes) throw new Error(`no file ${url}`);
            tgz = bytes;
          } else {
            const integrity = kind === "npm" ? (entry[3] as string) : (entry[2] as string | undefined);
            const verify = typeof integrity === "string" && integrity ? (b: Uint8Array<ArrayBuffer>) => checkIntegrity(b, integrity) : undefined;
            const registry = typeof entry[1] === "string" ? entry[1] : "";
            const base = (registry || NPM).replace(/\/$/, "");
            url = kind === "tarball" ? res : registry.endsWith(".tgz") ? registry : `${base}/${id.name}/-/${id.name.split("/").pop()}-${res}.tgz`;
            tgz = await fetchTarball(url, verify);
          }
          // Kept as bytes, text included (see INSTALLED_AS_BYTES).
          for (const { name, data } of packageFiles(await gunzip(tgz), url)) vfs.write(`${dest}/${name}`, data);
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
