import type { Semver } from "./semver";
import { gunzip, installFromBunLock, installPath, packageFiles, parseBunLock, pruneNodeModules, splitKey, staleInLock, untar } from "./lockfile";
import { lockedPackages, resolveProject, writeBunLock, type Manifest, type ResolveHost } from "./lockfileWrite";
import { fetchPackument, fetchTarball, fetchVersion } from "./pkgCache";
import { packageDirs, vfsWorkspaces } from "./workspaces";
import type { VFS } from "@runbun/vfs";

type Log = (level: "log" | "error", text: string) => void;

/** True while an install writes bun.lock, so the embed tells its change from the reader's (embed/changes.ts). */
export let installWriting = false;
type Packument = { "dist-tags"?: Record<string, string>; versions: Record<string, Manifest> };

/**
 * The wasm32-wasi binding a napi-rs package leaves out of its per-platform optionalDependencies (oxc-parser does, where
 * rolldown lists it): `[name, range]` from the name and range of a native one, which is all this browser can't load.
 */
export function unlistedWasiBinding(optional: Record<string, string> | undefined): [string, string] | undefined {
  const names = Object.keys(optional ?? {});
  if (names.some((n) => n.endsWith("-wasm32-wasi"))) return;
  const native = names.find((n) => /-(?:darwin|linux|win32)-(?:x64|arm64)(?:-\w+)?$/.test(n));
  return native ? [native.replace(/-(?:darwin|linux|win32)-.*$/, "-wasm32-wasi"), optional![native]] : undefined;
}

function resolveHost(vfs: VFS, semver: Semver): ResolveHost {
  return {
    semver,
    packument: async (name, range) => (await fetchPackument(name, range)) as Packument,
    async tarball(url) {
      const bytes = await fetchTarball(url);
      for (const { name, data } of untar(await gunzip(bytes))) {
        if (/^[^/]+\/package\.json$/.test(name)) return { bytes, manifest: JSON.parse(new TextDecoder().decode(data)) };
      }
      throw new Error("no package.json in the tarball");
    },
    folder: (path) => {
      const text = vfs.readText(path ? `${path}/package.json` : "package.json");
      return text === undefined ? undefined : (JSON.parse(text) as Manifest);
    },
    version: async (name, version) => (await fetchVersion(name, version)) as Manifest,
    packageDirs: () => packageDirs(vfs),
  };
}

/**
 * The binding each installed package leaves unlisted (see `unlistedWasiBinding`), next to that package. Not in
 * bun.lock: native Bun doesn't install it, and doesn't need it.
 */
async function installWasiBindings(vfs: VFS, lockText: string, semver: Semver, log: Log): Promise<number> {
  let installed = 0;
  const lock = parseBunLock(lockText);
  await Promise.all(
    Object.entries(lock.packages).map(async ([key, entry]) => {
      const info = entry.find((e) => e && typeof e === "object" && !Array.isArray(e)) as Manifest | undefined;
      const wasi = unlistedWasiBinding(info?.optionalDependencies);
      if (!wasi) return;
      const [name, range] = wasi;
      const dest = installPath([...splitKey(key).slice(0, -1), name]);
      if (vfs.files.has(`${dest}/package.json`)) return;
      try {
        const doc = (await fetchPackument(name, range)) as Packument;
        const version = Object.keys(doc.versions).filter((v) => semver.satisfies(v, range)).sort((a, b) => semver.order(b, a))[0];
        if (!version) return;
        const url = doc.versions[version].dist!.tarball;
        for (const { name: file, data } of packageFiles(await gunzip(await fetchTarball(url)), url)) vfs.write(`${dest}/${file}`, data);
        installed++;
        log("log", `+ ${name}@${version} (browser build)`);
      } catch {
        // A guessed name: the package may not publish one.
      }
    }),
  );
  return installed;
}

/** Where bun.lock's packages go, and the browser's binding next to each that has one (`installWasiBindings`). */
function installedPaths(lock: ReturnType<typeof parseBunLock>): Set<string> {
  const keep = new Set<string>();
  for (const [key, entry] of Object.entries(lock.packages)) {
    const names = splitKey(key);
    keep.add(installPath(names));
    const info = entry.find((e) => e && typeof e === "object" && !Array.isArray(e)) as Manifest | undefined;
    const wasi = unlistedWasiBinding(info?.optionalDependencies);
    if (wasi) keep.add(installPath([...names.slice(0, -1), wasi[0]]));
  }
  return keep;
}

/**
 * `bun install`. With a bun.lock that matches package.json, what it lists. Without one, or with one package.json has
 * moved past, resolves package.json as Bun does (a dependency keeps its locked version while its range fits), writes
 * the bun.lock Bun would (native `bun install` takes it as is), and installs from that.
 */
export async function bunInstall(vfs: VFS, semver: Semver, log: Log): Promise<number> {
  let lock = vfs.readText("bun.lock");
  const text = vfs.readText("package.json");
  const pkg = text === undefined ? undefined : (JSON.parse(text) as Manifest);
  const old = lock === undefined ? undefined : parseBunLock(lock);
  const stale = old && pkg ? staleInLock(old, pkg, vfsWorkspaces(vfs, pkg)) : [];
  // Packages the lockfile no longer places are removed only once it holds every dependency.
  let complete = true;
  if (lock !== undefined && !stale.length) log("log", "Installing locked versions from bun.lock");
  else {
    if (!pkg) throw new Error("no package.json");
    log("log", stale.length ? `package.json changed ${stale.join(", ")}. Updating bun.lock` : "Resolving dependencies");
    const resolved = await resolveProject(pkg, resolveHost(vfs, semver), old ? lockedPackages(old.packages) : []);
    for (const p of resolved.problems) log("error", p);
    lock = writeBunLock(resolved);
    // A bun.lock without some of the dependencies would be wrong for native Bun too.
    complete = !resolved.problems.length;
    if (!complete) log("error", `couldn't ${old ? "update" : "save"} bun.lock, some dependencies didn't resolve`);
    else {
      installWriting = true;
      try {
        vfs.write("bun.lock", lock);
      } finally {
        installWriting = false;
      }
      log("log", "Saved bun.lock");
    }
  }
  const n = await installFromBunLock(vfs, lock, log);
  const total = n + (await installWasiBindings(vfs, lock, semver, log));
  if (complete) for (const dir of pruneNodeModules(vfs, installedPaths(parseBunLock(lock)))) log("log", `- ${dir.replace(/^node_modules\//, "").replaceAll("/node_modules/", "/")}`);
  return total;
}
