import type { Semver } from "./semver";
import { gunzip, installFromBunLock, platformRestricted, untar } from "./lockfile";
import { fetchPackument, fetchTarball } from "./pkgCache";
import type { VFS } from "@runbun/vfs";

type Log = (level: "log" | "error", text: string) => void;
type Packument = {
  "dist-tags"?: Record<string, string>;
  versions: Record<string, {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    os?: unknown; cpu?: unknown; libc?: unknown; dist: { tarball: string } }>;
};

function pickVersion(doc: Packument, range: string, semver: Semver): string {
  const tags = doc["dist-tags"] ?? {};
  if (range in tags) return tags[range];
  if (range === "" || range === "*") return tags.latest;
  if (/^(npm|workspace|file|git|github|https?):/.test(range)) throw new Error(`unsupported range "${range}"`);
  let best: string | undefined;
  for (const v of Object.keys(doc.versions)) {
    if (!semver.satisfies(v, range)) continue;
    if (best === undefined || semver.order(v, best) > 0) best = v;
  }
  if (!best) throw new Error(`no version satisfies "${range}"`);
  return best;
}

export async function bunInstall(vfs: VFS, semver: Semver, log: Log): Promise<number> {
  const lock = vfs.readText("bun.lock");
  if (lock !== undefined) {
    log("log", "bun.lock found: installing locked versions");
    return installFromBunLock(vfs, lock, log);
  }
  const text = vfs.readText("package.json");
  if (!text) throw new Error("no package.json");
  const pkg = JSON.parse(text) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const seen = new Set<string>();
  let installed = 0;

  async function add(name: string, range: string, optional = false): Promise<void> {
    if (seen.has(name)) return;
    seen.add(name);
    if (vfs.files.has(`node_modules/${name}/package.json`)) return;
    try {
      const doc = (await fetchPackument(name)) as Packument;
      const version = pickVersion(doc, range, semver);
      const meta = doc.versions[version];
      if (optional && platformRestricted(meta)) return void log("log", `- ${name}@${version} (optional, unsupported platform)`);
      const tar = await fetchTarball(meta.dist.tarball);
      // Kept as bytes, text included (see INSTALLED_AS_BYTES in lockfile.ts).
      for (const { name: entry, data } of untar(await gunzip(tar))) {
        const rel = entry.split("/").slice(1).join("/");
        if (rel) vfs.write(`node_modules/${name}/${rel}`, data);
      }
      installed++;
      log("log", `+ ${name}@${version}`);
      await Promise.all(Object.entries(meta.dependencies ?? {}).filter(([n]) => !meta.optionalDependencies?.[n]).map(([n, r]) => add(n, r)));
      await Promise.all(Object.entries(meta.optionalDependencies ?? {}).map(([n, r]) => add(n, r, true)));
      // Like Bun, install required peers (Elysia 1.x needs @sinclair/typebox); a direct dependency wins via `seen`.
      await Promise.all(Object.entries(meta.peerDependencies ?? {}).filter(([n]) => !meta.peerDependenciesMeta?.[n]?.optional).map(([n, r]) => add(n, r)));
    } catch (e) {
      log("error", `install ${name}@${range}: ${e instanceof Error ? e.message : e}`);
    }
  }

  await Promise.all(Object.entries({ ...pkg.devDependencies, ...pkg.dependencies }).map(([n, r]) => add(n, r)));
  return installed;
}
