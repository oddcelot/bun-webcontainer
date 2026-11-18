import type { Semver } from "./semver";
import { githubTarballUrl, gunzip, installFromBunLock, installPath, packageFiles, parseBunLock, pruneNodeModules, splitKey, staleInLock, untar } from "./lockfile";
import { lockedPackages, resolveProject, writeBunLock, type Manifest, type ResolveHost } from "./lockfileWrite";
import { cacheTarball, fetchPackument, fetchTarball, fetchVersion, setNpmrc } from "./pkgCache";
import { tarballRoot } from "./gitDeps";
import { gitCheckout } from "./gitClone";
import { links } from "./links";
import { parseNpmrc } from "./npmrc";
import { packageDirs, vfsWorkspaces } from "./workspaces";
import type { VFS } from "@runbun/vfs";
import { blockedMessage, runDependencyScripts, runRootScripts, scriptedPackages, type ScriptRunner } from "./lifecycle";

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
    file: (path) => {
      const bytes = vfs.readBytes(path);
      return bytes && new Uint8Array(bytes);
    },
    link: (name) => links(vfs)[name],
    async github(dep) {
      const res = await fetch(githubTarballUrl(dep)).catch((e) => {
        throw new Error(`couldn't reach GitHub through the playground's git proxy: ${e instanceof Error ? e.message : e}`);
      });
      if (!res.ok) throw new Error((await res.text()).trim() || `GitHub answered ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      // Kept as the commit's tarball, which the install fetches next.
      const root = tarballRoot(await gunzip(bytes));
      if (root) await cacheTarball(githubTarballUrl({ ...dep, ref: root.commit }), bytes);
      return bytes;
    },
    async git(dep, name) {
      const { commit, files } = await gitCheckout(dep.clone, dep.ref, name);
      const pkg = files.get("package.json");
      return { commit, manifest: pkg && (JSON.parse(new TextDecoder().decode(pkg)) as Manifest) };
    },
    gunzip,
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
 * What the console passes along: `ignoreScripts` (`--ignore-scripts`); `trusted`: the packages `bun pm trust` just
 * trusted, whose scripts run although they are installed already.
 */
export type InstallFlags = { ignoreScripts?: boolean; trusted?: string[] };
/** `run`: how lifecycle scripts run (a worker each, runner.ts `exec`); without one (this browser can't run code) they are skipped. */
export type InstallOptions = InstallFlags & { run?: ScriptRunner };

/**
 * `bun install`. With a bun.lock that matches package.json, what it lists. Without one, or with one package.json has
 * moved past, resolves package.json as Bun does (a dependency keeps its locked version while its range fits), writes
 * the bun.lock Bun would (native `bun install` takes it as is), and installs from that. Then the lifecycle scripts
 * (lifecycle.ts) through `run`, unless `ignoreScripts`.
 */
export async function bunInstall(vfs: VFS, semver: Semver, log: Log, { run, ignoreScripts, trusted = [] }: InstallOptions = {}): Promise<number> {
  // The registries and credentials of the project's .npmrc, for every fetch below.
  const npmrc = parseNpmrc(vfs.readText(".npmrc"));
  for (const w of npmrc.warnings) log("error", w);
  setNpmrc(npmrc);
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
    const lockedRoot = old?.workspaces?.[""] as Record<string, Record<string, string> | undefined> | undefined;
    const lockedRanges = { ...lockedRoot?.devDependencies, ...lockedRoot?.optionalDependencies, ...lockedRoot?.dependencies };
    const resolved = await resolveProject(pkg, resolveHost(vfs, semver), old ? lockedPackages(old.packages) : [], lockedRanges);
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
  const scripts = ignoreScripts ? undefined : run;
  // The root's preinstall comes first, as in Bun; one that fails stops the install.
  if (scripts && !(await runRootScripts(scripts, vfs, "before", log))) return 0;
  // A dependency's scripts run when it is installed, not again for one that already was.
  const placed = installedPaths(parseBunLock(lock));
  const before = new Set([...placed].filter((dir) => vfs.files.has(`${dir}/package.json`)));
  const n = await installFromBunLock(vfs, lock, log);
  const total = n + (await installWasiBindings(vfs, lock, semver, log));
  if (complete) for (const dir of pruneNodeModules(vfs, placed)) log("log", `- ${dir.replace(/^node_modules\//, "").replaceAll("/node_modules/", "/")}`);
  if (scripts) {
    const { ok, blocked } = await runDependencyScripts(scripts, vfs, lock, new Set([...placed].filter((dir) => !before.has(dir) || trusted.includes(dir.split("node_modules/").pop()!))), log);
    if (ok) await runRootScripts(scripts, vfs, "after", log);
    if (blocked) log("log", blockedMessage(blocked));
  } else if (!ignoreScripts && scriptedPackages(vfs, lock).length) log("error", "lifecycle scripts skipped: this browser can't run code");
  return total;
}
