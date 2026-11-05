import { shareFiles, type VFS } from "@runbun/vfs";
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
  workspaces?: Record<string, { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>;
  packages: Record<string, unknown[]>;
};

/** `"a/@s/b/c"` → `["a", "@s/b", "c"]`: lockfile keys join the install path's package names with `/`. */
function splitKey(key: string): string[] {
  const parts = key.split("/");
  const names: string[] = [];
  for (let i = 0; i < parts.length; i++) names.push(parts[i].startsWith("@") ? `${parts[i]}/${parts[++i]}` : parts[i]);
  return names;
}

/** `cpu` of a wasm32 package: npm's `"wasm32"`, or `"none"` in bun.lock (no CPU Bun knows). */
const WASM32 = new Set(["wasm32", "none"]);

/**
 * No native binary runs in the browser, so any `os`/`cpu`/`libc` restriction means "doesn't match this host", except
 * wasm32 alone: napi-rs ships those bindings for exactly this.
 */
export const platformRestricted = (m?: { os?: unknown; cpu?: unknown; libc?: unknown }): boolean =>
  !!m && !!(m.os || m.libc || (m.cpu && ![m.cpu].flat().every((c) => WASM32.has(String(c)))));

function parseIdent(ident: string): { name: string; version: string } | null {
  const at = ident.lastIndexOf("@");
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
export function packageFiles(tar: Uint8Array): { name: string; data: Uint8Array }[] {
  const files: { name: string; data: Uint8Array }[] = [];
  for (const { name, data } of untar(tar)) {
    const rel = name.split("/").slice(1).join("/");
    if (rel) files.push({ name: rel, data });
  }
  return shareFiles(files);
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
 * Only npm-registry packages; git/tarball/workspace/file entries are reported and skipped.
 */
export async function installFromBunLock(vfs: VFS, lockText: string, log: Log): Promise<number> {
  const lock = parseBunLock(lockText);
  if (lock.lockfileVersion > 2) log("error", `bun.lock: lockfileVersion ${lock.lockfileVersion} is newer than this installer knows`);

  const pkgText = vfs.readText("package.json");
  if (pkgText) {
    const pkg = JSON.parse(pkgText) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const want = { ...pkg.devDependencies, ...pkg.dependencies };
    const root = lock.workspaces?.[""];
    const locked = { ...root?.devDependencies, ...root?.dependencies };
    const stale = Object.keys(want).filter((n) => locked[n] !== want[n]);
    if (stale.length) log("error", `bun.lock is out of date with package.json (${stale.join(", ")}); installing what the lockfile says`);
  }

  // Like Bun, only optional dependencies are dropped for a platform mismatch; a required one is still installed.
  const optional = new Set<string>();
  const addOpt = (o?: Record<string, string>) => Object.keys(o ?? {}).forEach((n) => optional.add(n));
  for (const w of Object.values(lock.workspaces ?? {})) addOpt((w as { optionalDependencies?: Record<string, string> }).optionalDependencies);
  for (const e of Object.values(lock.packages)) addOpt((e[2] as { optionalDependencies?: Record<string, string> } | undefined)?.optionalDependencies);

  let installed = 0;
  await Promise.all(
    Object.entries(lock.packages).map(async ([key, entry]) => {
      const [ident, registry, meta, integrity] = entry as [string, string, Parameters<typeof platformRestricted>[0], string];
      const id = typeof ident === "string" ? parseIdent(ident) : null;
      if (!id || typeof registry !== "string" || typeof integrity !== "string" || !/^\d/.test(id.version)) {
        log("error", `skip ${key}: only npm registry packages are supported (${String(ident)})`);
        return;
      }
      if (platformRestricted(meta) && optional.has(splitKey(key).at(-1)!)) {
        log("log", `- ${key}@${id.version} (optional, unsupported platform)`);
        return;
      }
      const dest = splitKey(key).map((n) => `node_modules/${n}`).join("/");
      try {
        const base = (registry || NPM).replace(/\/$/, "");
        const url = registry.endsWith(".tgz") ? registry : `${base}/${id.name}/-/${id.name.split("/").pop()}-${id.version}.tgz`;
        const tgz = await fetchTarball(url, (bytes) => checkIntegrity(bytes, integrity));
        // Kept as bytes, text included (see INSTALLED_AS_BYTES).
        for (const { name, data } of packageFiles(await gunzip(tgz))) vfs.write(`${dest}/${name}`, data);
        installed++;
        log("log", `+ ${key}@${id.version}`);
      } catch (e) {
        log("error", `install ${key}: ${e instanceof Error ? e.message : e}`);
      }
    }),
  );
  return installed;
}
